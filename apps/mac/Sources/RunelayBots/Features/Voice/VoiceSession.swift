import AVFoundation
import Foundation
import Speech

enum VoiceSessionError: Error {
    case recognizerUnavailable
    case noInputDevice
}

protocol VoiceBackend: AnyObject, Sendable {
    func append(_ buffer: AVAudioPCMBuffer)
    func finish() async
    func cancel()
}

final class VoiceSession: @unchecked Sendable {
    let levels: AsyncStream<Float>
    let texts: AsyncStream<String>
    private let levelContinuation: AsyncStream<Float>.Continuation
    private let textContinuation: AsyncStream<String>.Continuation
    private let engine = AVAudioEngine()
    private let locale: Locale
    private var backend: VoiceBackend?
    private let peakLock = NSLock()
    private var loudest: Float = 0

    var peak: Float {
        peakLock.withLock { loudest }
    }

    init(locale: Locale) {
        self.locale = locale
        (levels, levelContinuation) = AsyncStream.makeStream(of: Float.self, bufferingPolicy: .bufferingNewest(8))
        (texts, textContinuation) = AsyncStream.makeStream(of: String.self, bufferingPolicy: .bufferingNewest(4))
    }

    func start() async throws {
        let input = engine.inputNode
        _ = Microphones.apply(to: input, voiceProcessing: false)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw VoiceSessionError.noInputDevice
        }
        let textContinuation = textContinuation
        let onText: @Sendable (String) -> Void = { text in
            textContinuation.yield(text)
        }
        let backend = try await Self.makeBackend(locale: locale, inputFormat: format, onText: onText)
        self.backend = backend
        let levelContinuation = levelContinuation
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            levelContinuation.yield(Self.level(of: buffer))
            let peak = Microphones.peak(of: buffer)
            self?.peakLock.withLock {
                if peak > self?.loudest ?? 0 { self?.loudest = peak }
            }
            backend.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            backend.cancel()
            throw error
        }
    }

    func finish() async {
        stopCapture()
        await backend?.finish()
        backend = nil
        textContinuation.finish()
    }

    func cancel() {
        stopCapture()
        backend?.cancel()
        backend = nil
        textContinuation.finish()
    }

    private func stopCapture() {
        if engine.isRunning {
            engine.stop()
        }
        engine.inputNode.removeTap(onBus: 0)
        levelContinuation.finish()
    }

    private static func makeBackend(locale: Locale, inputFormat: AVAudioFormat, onText: @escaping @Sendable (String) -> Void) async throws -> VoiceBackend {
        if #available(macOS 26.0, *) {
            if let backend = try? await AnalyzerBackend.make(locale: locale, inputFormat: inputFormat, onText: onText) {
                return backend
            }
        }
        return try RecognizerBackend(locale: locale, onText: onText)
    }

    private static func level(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for index in 0..<count {
            let sample = channel[index]
            sum += sample * sample
        }
        let rms = sqrt(sum / Float(count))
        let decibels = 20 * log10(max(rms, 0.000_01))
        return min(max((decibels + 55) / 40, 0), 1)
    }
}

enum TranscriptJoiner {
    static func join(_ head: String, _ tail: String) -> String {
        let trimmedTail = tail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTail.isEmpty else { return head }
        guard !head.isEmpty else { return trimmedTail }
        if head.last?.isWhitespace == true {
            return head + trimmedTail
        }
        return head + " " + trimmedTail
    }
}

@available(macOS 26.0, *)
final class AnalyzerBackend: VoiceBackend, @unchecked Sendable {
    private let analyzer: SpeechAnalyzer
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let targetFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private var resultsTask: Task<Void, Never>?

    private init(analyzer: SpeechAnalyzer, continuation: AsyncStream<AnalyzerInput>.Continuation, targetFormat: AVAudioFormat) {
        self.analyzer = analyzer
        self.continuation = continuation
        self.targetFormat = targetFormat
    }

    static func make(locale: Locale, inputFormat: AVAudioFormat, onText: @escaping @Sendable (String) -> Void) async throws -> AnalyzerBackend? {
        guard SpeechTranscriber.isAvailable,
            let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
        else {
            return nil
        }
        let transcriber = SpeechTranscriber(
            locale: supported,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: inputFormat) else {
            return nil
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        try await analyzer.prepareToAnalyze(in: format)
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let backend = AnalyzerBackend(analyzer: analyzer, continuation: continuation, targetFormat: format)
        backend.resultsTask = Task {
            var finalized = ""
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if result.isFinal {
                        finalized = TranscriptJoiner.join(finalized, text)
                        onText(finalized)
                    } else {
                        onText(TranscriptJoiner.join(finalized, text))
                    }
                }
            } catch {
                return
            }
        }
        try await analyzer.start(inputSequence: stream)
        return backend
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let converted = convert(buffer) else { return }
        continuation.yield(AnalyzerInput(buffer: converted))
    }

    func finish() async {
        continuation.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
    }

    func cancel() {
        continuation.finish()
        resultsTask?.cancel()
        let analyzer = analyzer
        Task {
            await analyzer.cancelAndFinishNow()
        }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format == targetFormat {
            return buffer
        }
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: targetFormat)
            converter?.primeMethod = .none
        }
        guard let converter else { return nil }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, error == nil, output.frameLength > 0 else { return nil }
        return output
    }
}

final class RecognizerBackend: VoiceBackend, @unchecked Sendable {
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private let completion: AsyncStream<Void>
    private let completionContinuation: AsyncStream<Void>.Continuation

    init(locale: Locale, onText: @escaping @Sendable (String) -> Void) throws {
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw VoiceSessionError.recognizerUnavailable
        }
        (completion, completionContinuation) = AsyncStream.makeStream(of: Void.self)
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.addsPunctuation = true
        let completionContinuation = completionContinuation
        task = recognizer.recognitionTask(with: request) { result, error in
            if let result {
                onText(result.bestTranscription.formattedString)
                if result.isFinal {
                    completionContinuation.finish()
                }
            }
            if error != nil {
                completionContinuation.finish()
            }
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        request.append(buffer)
    }

    func finish() async {
        request.endAudio()
        let completion = completion
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                for await _ in completion {}
            }
            group.addTask {
                try? await Task.sleep(for: .milliseconds(1500))
            }
            await group.next()
            group.cancelAll()
        }
        task?.cancel()
    }

    func cancel() {
        request.endAudio()
        task?.cancel()
        completionContinuation.finish()
    }
}
