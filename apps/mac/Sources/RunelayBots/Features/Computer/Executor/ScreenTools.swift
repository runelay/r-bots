import AppKit
import CoreMedia
@preconcurrency import ScreenCaptureKit

enum ScreenTools {
    static let maxLongSide: CGFloat = 1568

    static func screenshot(display: Int?, region: CGRect?) async throws -> JSONValue {
        guard CGPreflightScreenCaptureAccess() else {
            ComputerPermissionsSnapshot.registerOnce(.screenRecording)
            throw ToolFailure.missing(.screenRecording)
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw ToolFailure(403, code: "permission_denied", "O macOS não deixou ler a tela: \(error.localizedDescription)")
        }
        let (index, target) = try pick(display, in: content)
        let bounds = CGDisplayBounds(target.displayID)
        var source = CGRect(origin: .zero, size: bounds.size)
        if let region {
            source = region.offsetBy(dx: -bounds.minX, dy: -bounds.minY).intersection(source)
            guard !source.isNull, source.width >= 1, source.height >= 1 else {
                throw ToolFailure.badArgs("A região está fora da tela \(index).")
            }
        }
        let scale = min(1, maxLongSide / max(source.width, source.height))
        let configuration = SCStreamConfiguration()
        configuration.sourceRect = source
        configuration.width = max(1, Int((source.width * scale).rounded()))
        configuration.height = max(1, Int((source.height * scale).rounded()))
        configuration.showsCursor = true
        let filter = SCContentFilter(display: target, excludingWindows: [])
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            throw ToolFailure(500, code: "capture_failed", "Não deu para tirar o print: \(error.localizedDescription)")
        }
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            throw ToolFailure(500, code: "capture_failed", "Não deu para gerar a imagem do print.")
        }
        let origin = CGPoint(x: bounds.minX + source.minX, y: bounds.minY + source.minY)
        return .object([
            "imageBase64": .string(data.base64EncodedString()),
            "mimeType": .string("image/jpeg"),
            "scale": .number(Double(scale)),
            "width": .int(image.width),
            "height": .int(image.height),
            "display": .int(index),
            "displayCount": .int(content.displays.count),
            "origin": .object(["x": .point(origin.x), "y": .point(origin.y)]),
            "coordinates": .string("Para clicar: x = origin.x + pixelX / scale, y = origin.y + pixelY / scale (pontos globais da tela)."),
        ])
    }

    static func pick(_ display: Int?, in content: SCShareableContent) throws -> (Int, SCDisplay) {
        let displays = content.displays.sorted { lhs, rhs in
            if lhs.displayID == CGMainDisplayID() { return true }
            if rhs.displayID == CGMainDisplayID() { return false }
            return lhs.displayID < rhs.displayID
        }
        guard !displays.isEmpty else { throw ToolFailure(500, code: "no_display", "Nenhuma tela disponível.") }
        let index = display ?? 0
        guard displays.indices.contains(index) else {
            throw ToolFailure.badArgs("A tela \(index) não existe. Há \(displays.count) tela(s), de 0 a \(displays.count - 1).")
        }
        return (index, displays[index])
    }
}

@MainActor
final class ScreenRecorder: NSObject {
    private var stream: SCStream?
    private var output: SCRecordingOutput?
    private var delegateBox: RecordingDelegate?
    private(set) var fileURL: URL?
    private(set) var startedAt: Date?
    private(set) var botName: String?
    private var finished: CheckedContinuation<Void, Never>?
    private var failure: String?

    var isRecording: Bool { stream != nil }

    static var folder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "Movies/runelay bots", directoryHint: .isDirectory)
    }

    func status() -> JSONValue {
        guard isRecording, let fileURL, let startedAt else {
            return .object(["recording": .bool(false), "folder": .string(Self.folder.path(percentEncoded: false))])
        }
        return .object([
            "recording": .bool(true),
            "path": .string(fileURL.path(percentEncoded: false)),
            "startedAt": .string(ISO8601DateFormatter().string(from: startedAt)),
            "seconds": .int(Int(Date().timeIntervalSince(startedAt))),
            "bot": botName.map(JSONValue.string) ?? .null,
        ])
    }

    func start(display: Int?, window: String?, region: CGRect?, botName: String) async throws -> JSONValue {
        guard CGPreflightScreenCaptureAccess() else {
            ComputerPermissionsSnapshot.registerOnce(.screenRecording)
            throw ToolFailure.missing(.screenRecording)
        }
        guard !isRecording else {
            throw ToolFailure(409, code: "already_recording", "Já tem uma gravação em andamento. Use record_stop antes.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let configuration = SCStreamConfiguration()
        if let window {
            let query = window.lowercased()
            let match = content.windows.first { candidate in
                guard candidate.windowLayer == 0, candidate.frame.width > 1 else { return false }
                let title = candidate.title?.lowercased() ?? ""
                let app = candidate.owningApplication?.applicationName.lowercased() ?? ""
                return title.contains(query) || app.contains(query)
            }
            guard let match else { throw ToolFailure(404, code: "window_not_found", "Não achei janela com \"\(window)\".") }
            filter = SCContentFilter(desktopIndependentWindow: match)
        } else {
            let (_, target) = try ScreenTools.pick(display, in: content)
            filter = SCContentFilter(display: target, excludingWindows: [])
            if let region {
                let bounds = CGDisplayBounds(target.displayID)
                let source = region.offsetBy(dx: -bounds.minX, dy: -bounds.minY).intersection(CGRect(origin: .zero, size: bounds.size))
                guard !source.isNull, source.width >= 2, source.height >= 2 else { throw ToolFailure.badArgs("A região está fora da tela.") }
                configuration.sourceRect = source
            }
        }
        let pixelScale = CGFloat(filter.pointPixelScale)
        let size = configuration.sourceRect.isEmpty ? filter.contentRect.size : configuration.sourceRect.size
        configuration.width = Int(size.width * pixelScale) / 2 * 2
        configuration.height = Int(size.height * pixelScale) / 2 * 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.showsCursor = true

        try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd 'às' HH.mm.ss"
        let safeName = botName.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let url = Self.folder.appending(path: "\(safeName) \(formatter.string(from: Date())).mov")

        let recordingConfiguration = SCRecordingOutputConfiguration()
        recordingConfiguration.outputURL = url
        recordingConfiguration.outputFileType = .mov
        recordingConfiguration.videoCodecType = .h264
        let delegate = RecordingDelegate(recorder: self)
        let output = SCRecordingOutput(configuration: recordingConfiguration, delegate: delegate)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        do {
            try stream.addRecordingOutput(output)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                stream.startCapture { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            }
        } catch {
            throw ToolFailure(500, code: "record_failed", "Não deu para começar a gravar: \(error.localizedDescription)")
        }
        self.stream = stream
        self.output = output
        self.delegateBox = delegate
        self.fileURL = url
        self.startedAt = Date()
        self.botName = botName
        self.failure = nil
        return status()
    }

    func stop() async throws -> JSONValue {
        guard let stream, let fileURL, let startedAt else {
            throw ToolFailure(409, code: "not_recording", "Não tem gravação em andamento.")
        }
        let seconds = Int(Date().timeIntervalSince(startedAt))
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            finished = continuation
            stream.stopCapture { [weak self] _ in
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(5))
                    self?.resolveFinished()
                }
            }
        }
        self.stream = nil
        self.output = nil
        self.delegateBox = nil
        self.fileURL = nil
        self.startedAt = nil
        self.botName = nil
        if let failure {
            throw ToolFailure(500, code: "record_failed", "A gravação falhou: \(failure)")
        }
        return .object([
            "recording": .bool(false),
            "path": .string(fileURL.path(percentEncoded: false)),
            "seconds": .int(seconds),
        ])
    }

    func stopIfRecording() {
        guard isRecording else { return }
        Task { _ = try? await stop() }
    }

    fileprivate func resolveFinished(error: String? = nil) {
        if let error {
            failure = error
        }
        finished?.resume()
        finished = nil
    }
}

private final class RecordingDelegate: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    private weak var recorder: ScreenRecorder?

    init(recorder: ScreenRecorder) {
        self.recorder = recorder
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        Task { @MainActor [weak recorder] in
            recorder?.resolveFinished()
        }
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: any Error) {
        let message = error.localizedDescription
        Task { @MainActor [weak recorder] in
            recorder?.resolveFinished(error: message)
        }
    }
}
