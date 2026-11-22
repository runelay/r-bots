import AVFoundation
import Foundation
import Observation

@MainActor
@Observable
final class AudioRecorder {
    enum Phase: Equatable {
        case idle
        case recording
        case denied
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var startedAt: Date?
    private(set) var levels: [CGFloat] = Array(repeating: 0, count: 32)

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var meterTask: Task<Void, Never>?

    var isRecording: Bool { phase == .recording }

    func start() async {
        guard phase != .recording else { return }
        guard await AVAudioApplication.requestRecordPermission() else {
            phase = .denied
            return
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("rbots-audio", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let file = url.appendingPathComponent(tr("Mensagem de áudio") + ".m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: file, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
            self.recorder = recorder
            startedAt = Date()
            phase = .recording
            meter()
        } catch {
            phase = .failed(tr("Não deu para gravar agora."))
        }
    }

    func finish() -> URL? {
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        let url = recorder.url
        reset()
        guard duration >= 0.6 else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return url
    }

    func cancel() {
        guard let recorder else { return }
        recorder.stop()
        recorder.deleteRecording()
        reset()
    }

    func dismissFailure() {
        if phase != .recording { phase = .idle }
    }

    private func reset() {
        meterTask?.cancel()
        meterTask = nil
        recorder = nil
        startedAt = nil
        levels = Array(repeating: 0, count: levels.count)
        phase = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func meter() {
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let recorder = self.recorder else { return }
                recorder.updateMeters()
                let power = recorder.averagePower(forChannel: 0)
                let level = CGFloat(min(max((power + 55) / 55, 0.04), 1))
                self.levels.removeFirst()
                self.levels.append(level)
                try? await Task.sleep(for: .milliseconds(70))
            }
        }
    }
}
