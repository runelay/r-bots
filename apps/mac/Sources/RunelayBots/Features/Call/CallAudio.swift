import AVFoundation
import Foundation

enum CallAudioError: LocalizedError {
    case noInput
    case format

    var errorDescription: String? {
        switch self {
        case .noInput: tr("Nenhum microfone disponível.")
        case .format: tr("Não deu para preparar o áudio da chamada.")
        }
    }
}

struct CallAudioStats: Sendable {
    var buffers = 0
    var chunks = 0
    var peak: Float = 0
    var inputFormat = ""
    var engineRunning = false
    var echoCancelled = false
    var restarts = 0
    var gated = 0
}

final class CallAudio: @unchecked Sendable {
    private var engine = AVAudioEngine()
    private var captureEngine: AVAudioEngine?
    private var player = AVAudioPlayerNode()
    private let playbackFormat: AVAudioFormat
    private let captureFormat: AVAudioFormat
    private let chunkBytes: Int
    private let usesMicrophone: Bool
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var pending = Data()
    private var muted = false
    private var gate: Float = 0
    private var gateOpenUntil = Date.distantPast
    private var voiceGate = VoiceGate()
    private var voiceGateEnabled = true
    private var talkOpen = true
    private var preroll = Data()
    private let prerollBytes: Int
    private var scheduled = 0
    private var generation = 0
    private var running = false
    private var stats = CallAudioStats()
    private var configurationObserver: NSObjectProtocol?
    private(set) var echoCancelled = false

    var onChunk: (@Sendable (Data) -> Void)?
    var onInputLevel: (@Sendable (Float) -> Void)?
    var onVoiceFrame: (@Sendable (VoiceFrame) -> Void)?
    var onOutputLevel: (@Sendable (Float) -> Void)?
    var onPlaybackIdle: (@Sendable () -> Void)?
    var onEvent: (@Sendable (String) -> Void)?

    init(captureRate: Double, playbackRate: Double, usesMicrophone: Bool = true) throws {
        guard let playback = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: playbackRate, channels: 1, interleaved: false),
            let capture = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: captureRate, channels: 1, interleaved: true)
        else { throw CallAudioError.format }
        playbackFormat = playback
        captureFormat = capture
        chunkBytes = Int(captureRate / 10) * 2
        prerollBytes = Int(captureRate * 0.3) * 2
        self.usesMicrophone = usesMicrophone
    }

    var isPlaying: Bool {
        lock.withLock { scheduled > 0 }
    }

    func setMuted(_ value: Bool) {
        lock.withLock { muted = value }
    }

    func setPlaybackGate(_ level: Float) {
        lock.withLock { gate = level }
    }

    func setVoiceGate(enabled: Bool) {
        lock.withLock {
            voiceGateEnabled = enabled
            voiceGate.reset()
        }
    }

    func setTalkOpen(_ value: Bool) {
        lock.withLock { talkOpen = value }
    }

    var noiseFloor: Float {
        lock.withLock { voiceGate.floor }
    }

    func takeStats() -> CallAudioStats {
        lock.withLock {
            var snapshot = stats
            snapshot.engineRunning = engine.isRunning && (captureEngine?.isRunning ?? true)
            snapshot.echoCancelled = echoCancelled
            stats.buffers = 0
            stats.chunks = 0
            stats.peak = 0
            stats.gated = 0
            return snapshot
        }
    }

    func start() throws {
        if !usesMicrophone {
            try configure(voiceProcessing: false)
        } else if Microphones.chosen() != nil {
            try configure(voiceProcessing: false)
            echoCancelled = false
        } else {
            do {
                try configure(voiceProcessing: true)
                echoCancelled = true
            } catch {
                onEvent?("voice processing falhou: \(error.localizedDescription)")
                reset()
                try configure(voiceProcessing: false)
                echoCancelled = false
            }
        }
        lock.withLock { running = true }
        observeConfiguration()
    }

    func restart(voiceProcessing: Bool) throws {
        let wasRunning = lock.withLock { running }
        guard wasRunning else { return }
        lock.withLock {
            generation += 1
            scheduled = 0
            stats.restarts += 1
            pending.removeAll()
            preroll.removeAll()
            voiceGate.reset()
        }
        reset()
        let wanted = voiceProcessing && usesMicrophone && Microphones.chosen() == nil
        do {
            try configure(voiceProcessing: wanted)
            echoCancelled = wanted
        } catch {
            reset()
            try configure(voiceProcessing: false)
            echoCancelled = false
        }
        observeConfiguration()
    }

    private func observeConfiguration() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
        }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            guard let self, self.lock.withLock({ self.running }) else { return }
            self.onEvent?("engine mudou de configuração, reiniciando")
            try? self.restart(voiceProcessing: self.echoCancelled)
        }
    }

    private func configure(voiceProcessing: Bool) throws {
        engine = AVAudioEngine()
        player = AVAudioPlayerNode()
        if usesMicrophone, !voiceProcessing, let chosen = Microphones.chosen() {
            let capture = AVAudioEngine()
            onEvent?(Microphones.use(chosen.id, on: capture.inputNode, voiceProcessing: false, name: chosen.name).log + " captura separada")
            captureEngine = capture
        }
        _ = engine.mainMixerNode
        _ = engine.outputNode
        if usesMicrophone {
            let input = (captureEngine ?? engine).inputNode
            if voiceProcessing {
                try input.setVoiceProcessingEnabled(true)
                if !engine.outputNode.isVoiceProcessingEnabled {
                    try engine.outputNode.setVoiceProcessingEnabled(true)
                }
                if #available(macOS 14.0, *) {
                    input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: true, duckingLevel: .min)
                }
            }
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw CallAudioError.noInput }
            onEvent?(
                "voice processing: entrada=\(input.isVoiceProcessingEnabled) saída=\(engine.outputNode.isVoiceProcessingEnabled) bypass=\(input.isVoiceProcessingBypassed) agc=\(input.isVoiceProcessingAGCEnabled) canais=\(format.channelCount)"
            )
            lock.withLock { stats.inputFormat = "\(Int(format.sampleRate)) Hz · \(format.channelCount) canal(is) · vp \(voiceProcessing)" }
            input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
                self?.capture(buffer)
            }
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        engine.prepare()
        if let captureEngine {
            captureEngine.prepare()
            try captureEngine.start()
        }
        try engine.start()
        player.play()
    }

    private func reset() {
        player.stop()
        let separate = captureEngine
        if let separate {
            separate.inputNode.removeTap(onBus: 0)
            separate.stop()
            captureEngine = nil
        } else if usesMicrophone {
            engine.inputNode.removeTap(onBus: 0)
        }
        engine.mainMixerNode.removeTap(onBus: 0)
        engine.stop()
        if usesMicrophone, separate == nil, engine.inputNode.isVoiceProcessingEnabled {
            try? engine.inputNode.setVoiceProcessingEnabled(false)
        }
        engine.reset()
        lock.withLock { converter = nil }
    }

    func stop() {
        let wasRunning = lock.withLock {
            let value = running
            running = false
            generation += 1
            scheduled = 0
            return value
        }
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        guard wasRunning else { return }
        reset()
    }

    func play(pcm16 data: Data) {
        let frames = data.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(frames)),
            let channel = buffer.floatChannelData?[0]
        else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<frames {
                channel[index] = Float(Int16(littleEndian: samples[index])) / 32_768
            }
        }
        let current: Int? = lock.withLock {
            guard running else { return nil }
            scheduled += 1
            return generation
        }
        guard let current else { return }
        queueOutputLevels(channel: channel, frames: frames)
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            let idle = self.lock.withLock { () -> Bool in
                guard self.generation == current, self.scheduled > 0 else { return false }
                self.scheduled -= 1
                return self.scheduled == 0
            }
            if idle {
                self.onPlaybackIdle?()
            }
        }
        if !player.isPlaying, lock.withLock({ running }) {
            player.play()
        }
    }

    private var outputLevels: [Float] = []
    private var levelTimer: DispatchSourceTimer?
    private static let levelSegment = 0.05

    private func queueOutputLevels(channel: UnsafeMutablePointer<Float>, frames: Int) {
        let step = max(1, Int(playbackFormat.sampleRate * Self.levelSegment))
        var levels: [Float] = []
        var start = 0
        while start < frames {
            let count = min(step, frames - start)
            var sum: Float = 0
            for index in start..<(start + count) {
                sum += channel[index] * channel[index]
            }
            let rms = sqrt(sum / Float(count))
            let decibels = 20 * log10(max(rms, 0.000_01))
            levels.append(min(max((decibels + 55) / 40, 0), 1))
            start += count
        }
        let needsTimer = lock.withLock { () -> Bool in
            outputLevels.append(contentsOf: levels)
            return levelTimer == nil
        }
        if needsTimer {
            startLevelTimer()
        }
    }

    private func startLevelTimer() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInteractive))
        timer.schedule(deadline: .now(), repeating: Self.levelSegment)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let next = self.lock.withLock { () -> Float? in
                guard !self.outputLevels.isEmpty else {
                    self.levelTimer?.cancel()
                    self.levelTimer = nil
                    return nil
                }
                return self.outputLevels.removeFirst()
            }
            self.onOutputLevel?(next ?? 0)
        }
        lock.withLock { levelTimer = timer }
        timer.resume()
    }

    func stopPlayback() {
        lock.withLock { outputLevels.removeAll() }
        let active = lock.withLock {
            generation += 1
            scheduled = 0
            return running
        }
        guard active else { return }
        player.stop()
        player.play()
    }

    func ingest(_ buffer: AVAudioPCMBuffer) {
        capture(buffer)
    }

    private func capture(_ buffer: AVAudioPCMBuffer) {
        let isMuted = lock.withLock { muted }
        let level = Self.level(of: buffer)
        let peak = Self.peak(of: buffer)
        lock.withLock {
            stats.buffers += 1
            stats.peak = max(stats.peak, peak)
        }
        onInputLevel?(isMuted ? 0 : level)
        let seconds = buffer.format.sampleRate > 0 ? Double(buffer.frameLength) / buffer.format.sampleRate : 0
        let decibels = Self.decibels(of: buffer)
        let (frame, playbackGated, wasOpen) = lock.withLock { () -> (VoiceFrame, Bool, Bool) in
            let wasOpen = !voiceGateEnabled || voiceGate.isOpen
            var frame = voiceGate.feed(decibels, seconds: seconds)
            if !voiceGateEnabled {
                frame.open = true
                frame.voiced = frame.voiced || frame.snr >= voiceGate.margin
            }
            if !talkOpen {
                frame.open = false
                frame.voiced = false
            }
            guard gate > 0, scheduled > 0 else {
                gateOpenUntil = .distantPast
                return (frame, false, wasOpen)
            }
            let now = Date()
            if level >= gate {
                gateOpenUntil = now.addingTimeInterval(0.4)
            }
            if now <= gateOpenUntil {
                return (frame, false, wasOpen)
            }
            stats.gated += 1
            return (frame, true, wasOpen)
        }
        if !isMuted {
            onVoiceFrame?(frame)
        }
        guard let converted = convert(buffer) else { return }
        let count = Int(converted.frameLength) * 2
        guard count > 0, let source = converted.int16ChannelData?[0] else { return }
        let real = Data(bytes: source, count: count)
        let passes = !isMuted && !playbackGated && frame.open
        var chunks: [Data] = []
        lock.withLock {
            var bytes = passes ? real : Data(count: count)
            if passes, !wasOpen, !preroll.isEmpty {
                bytes = preroll + real
                preroll.removeAll()
            } else if !passes {
                if !isMuted, talkOpen {
                    preroll.append(real)
                    if preroll.count > prerollBytes {
                        preroll.removeFirst(preroll.count - prerollBytes)
                    }
                } else {
                    preroll.removeAll()
                }
                stats.gated += frame.open ? 0 : 1
            }
            pending.append(bytes)
            while pending.count >= chunkBytes {
                chunks.append(Data(pending.prefix(chunkBytes)))
                pending.removeFirst(chunkBytes)
            }
            stats.chunks += chunks.count
        }
        for chunk in chunks {
            onChunk?(chunk)
        }
    }

    private static func firstChannel(of buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        guard buffer.format.channelCount > 1,
            buffer.format.commonFormat == .pcmFormatFloat32,
            let source = buffer.floatChannelData?[0],
            let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false),
            let output = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
            let target = output.floatChannelData?[0]
        else { return buffer }
        let stride = buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1
        for frame in 0..<Int(buffer.frameLength) {
            target[frame] = source[frame * stride]
        }
        output.frameLength = buffer.frameLength
        return output
    }

    private func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let buffer = Self.firstChannel(of: input)
        let converter: AVAudioConverter? = lock.withLock {
            if let existing = self.converter, existing.inputFormat == buffer.format {
                return existing
            }
            guard let fresh = AVAudioConverter(from: buffer.format, to: captureFormat) else { return nil }
            fresh.downmix = true
            fresh.primeMethod = .none
            self.converter = fresh
            return fresh
        }
        guard let converter else { return nil }
        let ratio = captureFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let output = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity) else { return nil }
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
        guard status != .error, error == nil else { return nil }
        return output
    }

    static func peak(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        var result: Float = 0
        for channel in 0..<Int(buffer.format.channelCount) {
            for index in 0..<Int(buffer.frameLength) {
                result = max(result, abs(channels[channel][index]))
            }
        }
        return result
    }

    static func decibels(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -100 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for index in 0..<count {
            sum += channel[index] * channel[index]
        }
        return 20 * log10(max(sqrt(sum / Float(count)), 0.000_01))
    }

    static func level(of buffer: AVAudioPCMBuffer) -> Float {
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
