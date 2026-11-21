import Foundation
import Observation
import UniformTypeIdentifiers

#if canImport(AppKit)
    import AppKit
#endif

enum AttachmentKind: String, Sendable, Equatable {
    case image
    case video
    case audio
    case file

    static func guess(for url: URL) -> AttachmentKind {
        guard let type = UTType(filenameExtension: url.pathExtension.lowercased()) else { return .file }
        if type.conforms(to: .svg) { return .file }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .movie) || type.conforms(to: .video) { return .video }
        if type.conforms(to: .audio) { return .audio }
        return .file
    }
}

struct AttachmentRef: Identifiable, Equatable, Hashable, Sendable {
    let id: String
    let name: String
    let mime: String
    let size: Int
    let kind: AttachmentKind
    let url: String
    let thumbURL: String?
    let width: Int?
    let height: Int?
    let duration: Double?
    let waveform: [Double]
    let fromBot: Bool

    init?(json: JSONValue) {
        guard let id = json["uploadId"]?.stringValue, let url = json["url"]?.stringValue else { return nil }
        self.id = id
        self.url = url
        name = json["name"]?.stringValue ?? "arquivo"
        mime = json["mime"]?.stringValue ?? "application/octet-stream"
        size = json["size"]?.intValue ?? 0
        kind = AttachmentKind(rawValue: json["kind"]?.stringValue ?? "") ?? .file
        thumbURL = json["thumbUrl"]?.stringValue
        width = json["width"]?.intValue
        height = json["height"]?.intValue
        duration = json["duration"]?.doubleValue
        waveform = json["waveform"]?.arrayValue?.compactMap(\.doubleValue) ?? []
        fromBot = json["source"]?.stringValue == "bot"
    }

    static func list(in data: JSONValue?) -> [AttachmentRef] {
        (data?.arrayValue ?? []).compactMap(AttachmentRef.init(json:))
    }

    var aspectRatio: CGFloat {
        guard let width, let height, width > 0, height > 0 else { return 16 / 10 }
        return CGFloat(width) / CGFloat(height)
    }

    var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }
}

enum AttachmentFormat {
    static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

enum AttachmentUploadState: Equatable {
    case uploading(Double)
    case ready(AttachmentRef)
    case failed(String)
}

@MainActor
@Observable
final class ComposerAttachment: Identifiable {
    let id = UUID()
    let fileURL: URL
    let name: String
    let kind: AttachmentKind
    let byteCount: Int
    var state: AttachmentUploadState = .uploading(0)
    @ObservationIgnored var task: Task<Void, Never>?
    @ObservationIgnored let ownsFile: Bool

    init(fileURL: URL, name: String? = nil, ownsFile: Bool = false) {
        self.fileURL = fileURL
        self.name = name ?? fileURL.lastPathComponent
        kind = AttachmentKind.guess(for: fileURL)
        byteCount = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        self.ownsFile = ownsFile
    }

    var ref: AttachmentRef? {
        if case .ready(let ref) = state { return ref }
        return nil
    }

    var isUploading: Bool {
        if case .uploading = state { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(ref?.size ?? byteCount), countStyle: .file)
    }

    func discardFile() {
        guard ownsFile else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}

enum AttachmentPasteboard {
    #if os(macOS)
        static let imageTypes: [NSPasteboard.PasteboardType] = [.png, .tiff]

        static func fileURLs(from pasteboard: NSPasteboard) -> [URL] {
            let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
            return (pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL]) ?? []
        }

        static func hasImage(_ pasteboard: NSPasteboard) -> Bool {
            let types = pasteboard.types ?? []
            guard types.contains(where: imageTypes.contains) else { return false }
            return !types.contains(.rtf) && !types.contains(.rtfd)
        }

        static func imageFile(from pasteboard: NSPasteboard) -> URL? {
            let data: Data?
            if let png = pasteboard.data(forType: .png) {
                data = png
            } else if let tiff = pasteboard.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) {
                data = rep.representation(using: .png, properties: [:])
            } else {
                data = nil
            }
            guard let data else { return nil }
            return writeTemporary(data, name: "Imagem colada.png")
        }
    #endif

    static func writeTemporary(_ data: Data, name: String) -> URL? {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("runelay-attachments", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(name)
            try data.write(to: url)
            return url
        } catch {
            return nil
        }
    }
}

final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}

actor AttachmentFileCache {
    static let shared = AttachmentFileCache()
    private var pending: [String: Task<URL, Error>] = [:]

    private var directory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("runelay bots/attachments", isDirectory: true)
    }

    func localFile(for ref: AttachmentRef, remote: URL) async throws -> URL {
        let folder = directory.appendingPathComponent(ref.id, isDirectory: true)
        let target = folder.appendingPathComponent(ref.name)
        if FileManager.default.fileExists(atPath: target.path) {
            return target
        }
        if let running = pending[ref.id] {
            return try await running.value
        }
        let task = Task<URL, Error> {
            var request = URLRequest(url: remote)
            request.timeoutInterval = 120
            AuthStore.authorize(&request)
            let (temporary, response) = try await URLSession.shared.download(for: request)
            AuthStore.reportUnauthorized(response)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse, userInfo: ["status": (response as? HTTPURLResponse)?.statusCode ?? 0])
            }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: temporary, to: target)
            return target
        }
        pending[ref.id] = task
        defer { pending[ref.id] = nil }
        return try await task.value
    }
}
