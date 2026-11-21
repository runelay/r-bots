#if canImport(AppKit)
import AppKit
#endif
import SwiftUI
import UniformTypeIdentifiers

enum ComposerToken: Hashable, Codable {
    case file(UUID)
    case skill(SkillSummary)

    static let glyph: Unicode.Scalar = "\u{FFFC}"
    static let glyphString = String(Character(glyph))

    static func glyphCount<S: StringProtocol>(in text: S) -> Int {
        text.unicodeScalars.reduce(0) { $0 + ($1 == glyph ? 1 : 0) }
    }

    static func stripped(_ text: String) -> String {
        text.replacingOccurrences(of: glyphString, with: "")
    }
}

enum InlineMarker {
    static func file(_ name: String) -> String { "[arquivo: \(name)]" }
    static func skill(_ slug: String) -> String { "/\(slug)" }
}

enum FileTokenKind: Equatable {
    case sheet
    case image
    case video
    case audio
    case pdf
    case code
    case generic

    private static let sheetExtensions: Set<String> = ["csv", "tsv", "xls", "xlsx", "xlsm", "numbers", "ods"]
    private static let codeExtensions: Set<String> = [
        "swift", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp",
        "hpp", "m", "mm", "cs", "php", "sh", "zsh", "bash", "sql", "yml", "yaml", "toml", "xml", "html", "css", "scss",
        "vue", "svelte", "lua", "dart", "ex", "exs", "md",
    ]

    init(name: String) {
        let ext = (name as NSString).pathExtension.lowercased()
        if Self.sheetExtensions.contains(ext) {
            self = .sheet
            return
        }
        if Self.codeExtensions.contains(ext) {
            self = .code
            return
        }
        guard let type = UTType(filenameExtension: ext) else {
            self = .generic
            return
        }
        if type.conforms(to: .spreadsheet) {
            self = .sheet
        } else if type.conforms(to: .pdf) {
            self = .pdf
        } else if type.conforms(to: .image) {
            self = .image
        } else if type.conforms(to: .movie) || type.conforms(to: .video) {
            self = .video
        } else if type.conforms(to: .audio) {
            self = .audio
        } else if type.conforms(to: .sourceCode) || type.conforms(to: .script) {
            self = .code
        } else {
            self = .generic
        }
    }

    var systemImage: String {
        switch self {
        case .sheet: "tablecells"
        case .image: "photo"
        case .video: "film"
        case .audio: "waveform"
        case .pdf: "doc.richtext"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .generic: "doc"
        }
    }

    var color: Color {
        switch self {
        case .sheet: Theme.success
        case .image: Theme.accent("blue")
        case .video: Theme.accent("pink")
        case .audio: Theme.accent("teal")
        case .pdf: Theme.danger
        case .code: Theme.attention
        case .generic: Theme.textSecondary
        }
    }
}

enum SkillTokenStyle {
    static let systemImage = "cube"
    static let color = Theme.merged
}

enum InlineSegment: Equatable {
    case text(String)
    case file(AttachmentRef)
    case skill(SkillSummary)
}

enum InlineTokens {
    private struct Candidate {
        let pattern: String
        let segment: InlineSegment
        let isCommand: Bool
    }

    static func segments(in text: String, attachments: [AttachmentRef], skills: [SkillSummary]) -> [InlineSegment]? {
        guard !attachments.isEmpty || !skills.isEmpty else { return nil }
        var candidates: [Candidate] = attachments.map {
            Candidate(pattern: InlineMarker.file($0.name), segment: .file($0), isCommand: false)
        }
        for skill in skills {
            for label in Set([skill.slug, skill.name]) where !label.isEmpty {
                candidates.append(Candidate(pattern: InlineMarker.skill(label), segment: .skill(skill), isCommand: true))
            }
        }
        let source = text as NSString
        var result: [InlineSegment] = []
        var cursor = 0
        var found = false
        while cursor < source.length {
            var best: (range: NSRange, segment: InlineSegment)?
            for candidate in candidates {
                guard let range = firstMatch(of: candidate, in: source, from: cursor) else { continue }
                if let current = best,
                    current.range.location < range.location
                        || (current.range.location == range.location && current.range.length >= range.length)
                {
                    continue
                }
                best = (range, candidate.segment)
            }
            guard let best else { break }
            if best.range.location > cursor {
                result.append(.text(source.substring(with: NSRange(location: cursor, length: best.range.location - cursor))))
            }
            result.append(best.segment)
            found = true
            cursor = best.range.location + best.range.length
        }
        guard found else { return nil }
        if cursor < source.length {
            result.append(.text(source.substring(from: cursor)))
        }
        return result
    }

    private static func firstMatch(of candidate: Candidate, in source: NSString, from start: Int) -> NSRange? {
        var location = start
        let options: NSString.CompareOptions = candidate.isCommand ? [.caseInsensitive] : []
        while location < source.length {
            let range = source.range(of: candidate.pattern, options: options, range: NSRange(location: location, length: source.length - location))
            guard range.location != NSNotFound else { return nil }
            if !candidate.isCommand || isCommandBoundary(range, in: source) {
                return range
            }
            location = range.location + 1
        }
        return nil
    }

    private static func isCommandBoundary(_ range: NSRange, in source: NSString) -> Bool {
        let before = range.location == 0 || isSeparator(source.character(at: range.location - 1), opening: true)
        let end = range.location + range.length
        let after = end >= source.length || isSeparator(source.character(at: end), opening: false)
        return before && after
    }

    private static func isSeparator(_ unit: unichar, opening: Bool) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        if CharacterSet.whitespacesAndNewlines.contains(scalar) {
            return true
        }
        return opening ? scalar == "(" : ".,;:!?)".unicodeScalars.contains(scalar)
    }
}
