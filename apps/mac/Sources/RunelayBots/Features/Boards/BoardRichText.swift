import AppKit
import CryptoKit
import SwiftUI

enum BoardRichSegment: Hashable, Identifiable {
    case text(String)
    case image(url: String, alt: String)

    var id: String {
        switch self {
        case .text(let text): "t:\(text.hashValue)"
        case .image(let url, _): "i:\(url)"
        }
    }
}

enum BoardRichParser {
    private static let markdownImage = try? NSRegularExpression(pattern: #"!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)"#)
    private static let htmlImage = try? NSRegularExpression(pattern: #"<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>"#, options: [.caseInsensitive])
    private static let htmlAlt = try? NSRegularExpression(pattern: #"\balt=["']([^"']*)["']"#, options: [.caseInsensitive])
    private static let linearBlock = try? NSRegularExpression(pattern: #"<linear-([\w-]+)>([\s\S]*?)</linear-\1>"#, options: [.caseInsensitive])
    private static let leftoverTag = try? NSRegularExpression(pattern: #"</?(?:linear-[\w-]+|picture|source|details|summary|p|div|br|span|a)\b[^>]*>"#, options: [.caseInsensitive])

    private static let linkedImage = try? NSRegularExpression(pattern: #"\[(!\[[^\]]*\]\([^)]+\))\]\([^)]+\)"#)

    static func segments(_ raw: String) -> [BoardRichSegment] {
        var text = normalizeLinearBlocks(raw)
        if let linkedImage {
            text = linkedImage.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "$1")
        }
        let ns = text as NSString
        var hits: [(NSRange, BoardRichSegment)] = []
        for match in markdownImage?.matches(in: text, range: NSRange(location: 0, length: ns.length)) ?? [] {
            let alt = ns.substring(with: match.range(at: 1))
            let url = ns.substring(with: match.range(at: 2)).trimmingCharacters(in: CharacterSet(charactersIn: "<>"))
            if isImageURL(url) { hits.append((match.range, .image(url: url, alt: alt))) }
        }
        for match in htmlImage?.matches(in: text, range: NSRange(location: 0, length: ns.length)) ?? [] {
            let tag = ns.substring(with: match.range)
            let url = ns.substring(with: match.range(at: 1))
            let alt = htmlAlt?.firstMatch(in: tag, range: NSRange(location: 0, length: (tag as NSString).length))
                .map { (tag as NSString).substring(with: $0.range(at: 1)) } ?? ""
            hits.append((match.range, .image(url: url, alt: alt)))
        }
        hits.sort { $0.0.location < $1.0.location }
        var segments: [BoardRichSegment] = []
        var cursor = 0
        for (range, image) in hits where range.location >= cursor {
            appendText(ns.substring(with: NSRange(location: cursor, length: range.location - cursor)), to: &segments)
            segments.append(image)
            cursor = range.location + range.length
        }
        appendText(ns.substring(from: cursor), to: &segments)
        return segments
    }

    private static func appendText(_ chunk: String, to segments: inout [BoardRichSegment]) {
        var cleaned = chunk
        if let leftoverTag {
            cleaned = leftoverTag.stringByReplacingMatches(in: cleaned, range: NSRange(location: 0, length: (cleaned as NSString).length), withTemplate: "")
        }
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        segments.append(.text(trimmed))
    }

    private static func normalizeLinearBlocks(_ text: String) -> String {
        guard let linearBlock else { return text }
        let ns = text as NSString
        var output = ""
        var cursor = 0
        for match in linearBlock.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            output += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            output += replacement(tag: ns.substring(with: match.range(at: 1)).lowercased(), inner: ns.substring(with: match.range(at: 2)))
            cursor = match.range.location + match.range.length
        }
        output += ns.substring(from: cursor)
        return output
    }

    private static func replacement(tag: String, inner: String) -> String {
        guard let data = inner.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            let plain = inner.trimmingCharacters(in: .whitespacesAndNewlines)
            return plain.hasPrefix("{") ? "" : plain
        }
        let attrs = object["attrs"] as? [String: Any] ?? [:]
        let title = (attrs["title"] as? String ?? attrs["alt"] as? String ?? attrs["label"] as? String ?? "")
            .replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: "")
        if let src = attrs["src"] as? String, tag == "image" || isImageURL(src) || (object["type"] as? String) == "image" {
            return "\n\n![\(title)](\(src))\n\n"
        }
        if let href = attrs["src"] as? String ?? attrs["href"] as? String ?? attrs["url"] as? String {
            return "[\(title.isEmpty ? tag : title)](\(href))"
        }
        return title
    }

    static func isImageURL(_ raw: String) -> Bool {
        guard let url = URL(string: raw), let host = url.host?.lowercased() else { return false }
        if host == "uploads.linear.app" { return true }
        if host.hasSuffix("githubusercontent.com") { return true }
        if host == "github.com", url.path.contains("/assets/") { return true }
        return ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].contains(url.pathExtension.lowercased())
    }
}

struct BoardRichText: View {
    let text: String
    let fontSize: CGFloat
    var lineSpacing: CGFloat = 3

    var body: some View {
        let segments = BoardRichParser.segments(text)
        VStack(alignment: .leading, spacing: Spacing.m) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let chunk):
                    MarkdownView(text: chunk, fontSize: fontSize, lineSpacing: lineSpacing)
                        .textSelection(.enabled)
                case .image(let url, let alt):
                    BoardInlineImage(source: url, alt: alt)
                }
            }
        }
    }
}

actor BoardImageCache {
    static let shared = BoardImageCache()
    private var pending: [String: Task<URL, Error>] = [:]

    private var directory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("runelay bots/board-images", isDirectory: true)
    }

    static func key(for source: String) -> String {
        var stable = source
        if let components = URLComponents(string: source), components.host == "uploads.linear.app" {
            var copy = components
            copy.query = nil
            stable = copy.string ?? source
        }
        return SHA256.hash(data: Data(stable.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
    }

    func file(for source: String, request: URLRequest) async throws -> URL {
        let key = Self.key(for: source)
        if let existing = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .first(where: { $0.deletingPathExtension().lastPathComponent == key }) {
            return existing
        }
        if let running = pending[key] { return try await running.value }
        let folder = directory
        let task = Task<URL, Error> {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), !data.isEmpty else {
                throw URLError(.badServerResponse)
            }
            let type = http.value(forHTTPHeaderField: "Content-Type") ?? ""
            let ext = type.contains("png") ? "png" : type.contains("gif") ? "gif" : type.contains("webp") ? "webp" : type.contains("svg") ? "svg" : type.contains("mp4") ? "mp4" : "jpg"
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = folder.appendingPathComponent("\(key).\(ext)")
            try data.write(to: target, options: .atomic)
            return target
        }
        pending[key] = task
        defer { pending[key] = nil }
        return try await task.value
    }
}

struct BoardInlineImage: View {
    let source: String
    let alt: String

    @Environment(AppModel.self) private var model
    @State private var file: URL?
    @State private var image: NSImage?
    @State private var failed = false
    @State private var hovering = false

    private var aspect: CGFloat {
        guard let image, image.size.width > 0, image.size.height > 0 else { return 16 / 9 }
        return image.size.width / image.size.height
    }

    var body: some View {
        Group {
            if let image {
                Button {
                    if let file { QuickLookPanel.shared.show([file], selected: file) }
                } label: {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(aspect, contentMode: .fit)
                        .frame(maxWidth: min(image.size.width, 640), alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                        .softElevation(lifted: hovering)
                        .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                }
                .buttonStyle(PressableButtonStyle())
                .onHover { hovering = $0 }
                .springAnimation(value: hovering)
                .help(alt.isEmpty ? "Abrir a imagem" : alt)
                .transition(.opacity)
            } else if failed {
                Button {
                    BoardLinks.open(source)
                } label: {
                    Label(alt.isEmpty ? "Abrir a imagem" : alt, systemImage: "photo")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, Spacing.m)
                        .frame(height: 30)
                        .background(Theme.surface, in: Capsule())
                }
                .buttonStyle(.plain)
                .clickable()
            } else {
                ShimmerBlock(height: 140, radius: Radius.medium)
                    .frame(maxWidth: 420)
            }
        }
        .animation(Motion.crossFade, value: image != nil)
        .task(id: source) { await load() }
    }

    private func load() async {
        guard let request = try? model.client.boardImageRequest(source) else {
            failed = true
            return
        }
        do {
            let local = try await BoardImageCache.shared.file(for: source, request: request)
            guard let loaded = NSImage(contentsOf: local) else {
                failed = true
                return
            }
            file = local
            image = loaded
        } catch {
            failed = true
        }
    }
}

struct BoardFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 480
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += line + spacing
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
        }
        return CGSize(width: width, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += line + spacing
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
