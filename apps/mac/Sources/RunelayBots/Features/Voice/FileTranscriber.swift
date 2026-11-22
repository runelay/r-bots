import Foundation
import Speech

enum FileTranscriber {
    enum Failure: LocalizedError {
        case unauthorized
        case unavailable
        case empty

        var errorDescription: String? {
            switch self {
            case .unauthorized: tr("Sem permissão de reconhecimento de fala no Mac.")
            case .unavailable: tr("O reconhecimento de fala em português não está disponível no Mac.")
            case .empty: tr("Não reconheci fala no áudio.")
            }
        }
    }

    static func transcribe(base64: String, name: String, locale: String) async throws -> String {
        guard let data = Data(base64Encoded: base64) else { throw Failure.empty }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("runelay-transcribe-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent(name.isEmpty ? "audio.mp3" : name)
        try data.write(to: url)
        return try await transcribe(url: url, locale: Locale(identifier: locale))
    }

    static func transcribe(url: URL, locale: Locale) async throws -> String {
        guard await authorized() else { throw Failure.unauthorized }
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else { throw Failure.unavailable }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        let gate = ResumeGate()
        let holder = TaskHolder()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                holder.task = recognizer.recognitionTask(with: request) { result, error in
                    if let result, result.isFinal {
                        let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                        if gate.claim() {
                            continuation.resume(returning: text)
                        }
                    } else if let error {
                        if gate.claim() {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            }
        } onCancel: {
            holder.task?.cancel()
        }
    }

    private static func authorized() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .notDetermined:
            let status = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            return status == .authorized
        default:
            return false
        }
    }
}

private final class ResumeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var used = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !used else { return false }
        used = true
        return true
    }
}

private final class TaskHolder: @unchecked Sendable {
    var task: SFSpeechRecognitionTask?
}
