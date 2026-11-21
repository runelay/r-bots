import AppKit
import Foundation

enum DownloadsFolder {
    static func save(_ data: Data, as name: String) throws -> URL {
        let target = try destination(for: name)
        try data.write(to: target, options: .atomic)
        return target
    }

    static func copy(_ file: URL, as name: String) throws -> URL {
        let target = try destination(for: name)
        try FileManager.default.copyItem(at: file, to: target)
        return target
    }

    static func reveal(_ file: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }

    static func destination(for name: String, in folder: URL? = nil) throws -> URL {
        let base = try folder ?? FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let cleaned = cleanName(name)
        let stem = (cleaned as NSString).deletingPathExtension
        let ext = (cleaned as NSString).pathExtension
        var candidate = base.appendingPathComponent(cleaned)
        var copy = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            let numbered = ext.isEmpty ? "\(stem) \(copy)" : "\(stem) \(copy).\(ext)"
            candidate = base.appendingPathComponent(numbered)
            copy += 1
        }
        return candidate
    }

    static func cleanName(_ name: String) -> String {
        let cleaned =
            name
            .components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>\n\r\t"))
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "arquivo" : String(cleaned.prefix(140))
    }
}
