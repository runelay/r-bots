import AppKit
import SwiftUI

extension NSAttributedString.Key {
    static let noteLink = NSAttributedString.Key("runelay.noteLink")
    static let noteTask = NSAttributedString.Key("runelay.noteTask")
    static let noteQuote = NSAttributedString.Key("runelay.noteQuote")
    static let noteCode = NSAttributedString.Key("runelay.noteCode")
    static let noteHighlight = NSAttributedString.Key("runelay.noteHighlight")
}

@MainActor
enum NoteFonts {
    static func sans(_ size: CGFloat, weight: NSFont.Weight = .regular, italic: Bool = false) -> NSFont {
        var traits: [NSFontDescriptor.TraitKey: Any] = [.weight: weight]
        if italic {
            traits[.symbolic] = NSFontDescriptor.SymbolicTraits.italic.rawValue
        }
        let descriptor = NSFontDescriptor(fontAttributes: [.family: BrandFonts.sansFamily, .traits: traits])
        if let font = NSFont(descriptor: descriptor, size: size), font.familyName == BrandFonts.sansFamily {
            if italic {
                return NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
            }
            return font
        }
        let system = NSFont.systemFont(ofSize: size, weight: weight)
        return italic ? NSFontManager.shared.convert(system, toHaveTrait: .italicFontMask) : system
    }

    static func mono(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        let descriptor = NSFontDescriptor(fontAttributes: [.family: BrandFonts.monoFamily, .traits: [NSFontDescriptor.TraitKey.weight: weight]])
        if let font = NSFont(descriptor: descriptor, size: size), font.familyName == BrandFonts.monoFamily {
            return font
        }
        return NSFont.monospacedSystemFont(ofSize: size, weight: weight)
    }
}

@MainActor
struct NoteStyler {
    static let bodySize: CGFloat = 15

    let primary = NSColor(Theme.textPrimary)
    let secondary = NSColor(Theme.textSecondary)
    let tertiary = NSColor(Theme.textTertiary)
    let accent = NSColor(Theme.brandText)
    let codeBackground = NSColor(Theme.surface)

    var baseAttributes: [NSAttributedString.Key: Any] {
        [.font: NoteFonts.sans(Self.bodySize), .foregroundColor: primary, .paragraphStyle: paragraph(spacing: 4)]
    }

    private static let inlinePatterns: [(NSRegularExpression, InlineKind)] = {
        let specs: [(String, InlineKind)] = [
            (#"`([^`\n]+)`"#, .code),
            (#"\[\[([^\]\n]+)\]\]"#, .wikiLink),
            (#"\*\*([^*\n]+)\*\*"#, .bold),
            (#"__([^_\n]+)__"#, .bold),
            (#"(?<![*\w])\*([^*\n]+)\*(?!\*)"#, .italic),
            (#"(?<![_\w])_([^_\n]+)_(?!\w)"#, .italic),
            (#"~~([^~\n]+)~~"#, .strike),
            (#"\[([^\]\n]+)\]\((https?://[^)\s]+)\)"#, .link),
            (#"(?<![\w#])#([\p{L}\d_/-]+)"#, .tag),
        ]
        return specs.compactMap { pattern, kind in
            (try? NSRegularExpression(pattern: pattern)).map { ($0, kind) }
        }
    }()

    enum InlineKind {
        case code
        case wikiLink
        case bold
        case italic
        case strike
        case link
        case tag
    }

    func paragraph(spacing: CGFloat, before: CGFloat = 0, indent: CGFloat = 0) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = spacing
        style.paragraphSpacingBefore = before
        style.headIndent = indent
        return style
    }

    static func fenceRanges(in text: NSString) -> [NSRange] {
        var ranges: [NSRange] = []
        var openStart: Int?
        var location = 0
        while location < text.length {
            let line = text.lineRange(for: NSRange(location: location, length: 0))
            let content = text.substring(with: line).trimmingCharacters(in: .whitespacesAndNewlines)
            if content.hasPrefix("```") {
                if let start = openStart {
                    ranges.append(NSRange(location: start, length: NSMaxRange(line) - start))
                    openStart = nil
                } else {
                    openStart = line.location
                }
            }
            location = NSMaxRange(line)
        }
        if let start = openStart {
            ranges.append(NSRange(location: start, length: text.length - start))
        }
        return ranges
    }

    func style(_ storage: NSTextStorage, in range: NSRange, caretLine: NSRange?, fences: [NSRange]) {
        let text = storage.string as NSString
        guard text.length > 0 else { return }
        let target = text.paragraphRange(for: NSRange(location: min(range.location, text.length), length: min(range.length, text.length - min(range.location, text.length))))
        storage.beginEditing()
        storage.setAttributes(baseAttributes, range: target)
        var location = target.location
        var previousWasTableHeader = false
        while location < NSMaxRange(target) {
            let line = text.lineRange(for: NSRange(location: location, length: 0))
            let reveal = caretLine.map { NSIntersectionRange($0, line).length > 0 || $0.location == line.location } ?? false
            if fences.contains(where: { NSIntersectionRange($0, line).length > 0 }) {
                styleCode(storage, line: line, text: text, isFence: (text.substring(with: line).trimmingCharacters(in: .whitespacesAndNewlines)).hasPrefix("```"))
            } else {
                previousWasTableHeader = styleLine(storage, line: line, text: text, reveal: reveal, nextIsSeparator: isTableSeparator(after: line, text: text), previousWasTableHeader: previousWasTableHeader)
            }
            location = NSMaxRange(line)
            if line.length == 0 { break }
        }
        storage.endEditing()
    }

    private func isTableSeparator(after line: NSRange, text: NSString) -> Bool {
        guard NSMaxRange(line) < text.length else { return false }
        let next = text.lineRange(for: NSRange(location: NSMaxRange(line), length: 0))
        let content = text.substring(with: next).trimmingCharacters(in: .whitespacesAndNewlines)
        return content.hasPrefix("|") && content.allSatisfy { "|-: ".contains($0) }
    }

    private func styleCode(_ storage: NSTextStorage, line: NSRange, text: NSString, isFence: Bool) {
        storage.addAttributes([
            .font: NoteFonts.mono(13),
            .foregroundColor: isFence ? tertiary : primary,
            .noteCode: true,
            .paragraphStyle: paragraph(spacing: 2),
        ], range: line)
    }

    private func hide(_ storage: NSTextStorage, _ range: NSRange, reveal: Bool) {
        guard range.length > 0 else { return }
        if reveal {
            storage.addAttribute(.foregroundColor, value: tertiary, range: range)
        } else {
            storage.addAttributes([.font: NSFont.systemFont(ofSize: 0.01), .foregroundColor: NSColor.clear], range: range)
        }
    }

    private func styleLine(_ storage: NSTextStorage, line: NSRange, text: NSString, reveal: Bool, nextIsSeparator: Bool, previousWasTableHeader: Bool) -> Bool {
        let content = text.substring(with: line)
        let trimmedEnd = content.trimmingCharacters(in: .newlines)
        let leading = trimmedEnd.prefix { $0 == " " || $0 == "\t" }.count
        let body = String(trimmedEnd.dropFirst(leading))
        var contentStart = line.location + leading

        if let level = headingLevel(body) {
            let sizes: [CGFloat] = [26, 21, 18, 16, 15, 15]
            let size = sizes[min(level, 6) - 1]
            storage.addAttributes([
                .font: NoteFonts.sans(size, weight: .semibold),
                .paragraphStyle: paragraph(spacing: 2, before: level == 1 ? 6 : 10),
            ], range: line)
            hide(storage, NSRange(location: contentStart, length: level + 1), reveal: reveal)
            contentStart += level + 1
            styleInline(storage, range: NSRange(location: contentStart, length: max(0, line.location + (trimmedEnd as NSString).length - contentStart)), reveal: reveal, baseSize: size)
            return false
        }

        if body.hasPrefix("|") {
            storage.addAttributes([.font: NoteFonts.mono(13, weight: nextIsSeparator ? .semibold : .regular), .paragraphStyle: paragraph(spacing: 2)], range: line)
            let isSeparator = body.allSatisfy { "|-: ".contains($0) }
            if isSeparator {
                storage.addAttribute(.foregroundColor, value: tertiary, range: line)
            } else {
                let ns = trimmedEnd as NSString
                for index in 0..<ns.length where ns.character(at: index) == 124 {
                    storage.addAttribute(.foregroundColor, value: tertiary, range: NSRange(location: line.location + index, length: 1))
                }
            }
            return nextIsSeparator
        }

        if body.hasPrefix(">") {
            let markerLength = body.hasPrefix("> ") ? 2 : 1
            storage.addAttributes([.foregroundColor: secondary, .noteQuote: true, .paragraphStyle: paragraph(spacing: 4, indent: 14)], range: line)
            hide(storage, NSRange(location: contentStart, length: markerLength), reveal: reveal)
            styleInline(storage, range: NSRange(location: contentStart + markerLength, length: max(0, (trimmedEnd as NSString).length - leading - markerLength)), reveal: reveal, baseSize: Self.bodySize)
            return false
        }

        if body == "---" || body == "***" || body == "___" {
            storage.addAttribute(.foregroundColor, value: tertiary, range: line)
            return false
        }

        if let task = taskMarker(body) {
            let markerRange = NSRange(location: contentStart, length: 2)
            let boxRange = NSRange(location: contentStart + 2, length: 3)
            if reveal {
                storage.addAttribute(.foregroundColor, value: tertiary, range: NSRange(location: contentStart, length: 6))
            } else {
                hide(storage, markerRange, reveal: false)
                storage.addAttributes([.foregroundColor: NSColor.clear, .noteTask: task.done, .font: NoteFonts.mono(Self.bodySize)], range: boxRange)
            }
            let textStart = contentStart + 6
            let textRange = NSRange(location: textStart, length: max(0, line.location + (trimmedEnd as NSString).length - textStart))
            if task.done, textRange.length > 0 {
                storage.addAttributes([.foregroundColor: tertiary, .strikethroughStyle: NSUnderlineStyle.single.rawValue, .strikethroughColor: tertiary], range: textRange)
            }
            styleInline(storage, range: textRange, reveal: reveal, baseSize: Self.bodySize)
            return false
        }

        if let marker = listMarkerLength(body) {
            storage.addAttribute(.foregroundColor, value: tertiary, range: NSRange(location: contentStart, length: marker))
            styleInline(storage, range: NSRange(location: contentStart + marker, length: max(0, (trimmedEnd as NSString).length - leading - marker)), reveal: reveal, baseSize: Self.bodySize)
            return false
        }

        styleInline(storage, range: NSRange(location: line.location, length: (trimmedEnd as NSString).length), reveal: reveal, baseSize: Self.bodySize)
        return false
    }

    private func styleInline(_ storage: NSTextStorage, range: NSRange, reveal: Bool, baseSize: CGFloat) {
        guard range.length > 0, NSMaxRange(range) <= storage.length else { return }
        let string = storage.string
        var taken: [NSRange] = []
        for (regex, kind) in Self.inlinePatterns {
            for match in regex.matches(in: string, range: range) {
                let whole = match.range
                if taken.contains(where: { NSIntersectionRange($0, whole).length > 0 }) { continue }
                taken.append(whole)
                let inner = match.range(at: 1)
                let open = NSRange(location: whole.location, length: inner.location - whole.location)
                switch kind {
                case .code:
                    storage.addAttributes([.font: NoteFonts.mono(baseSize - 2), .backgroundColor: codeBackground], range: inner)
                    hide(storage, open, reveal: reveal)
                    hide(storage, NSRange(location: NSMaxRange(inner), length: NSMaxRange(whole) - NSMaxRange(inner)), reveal: reveal)
                case .wikiLink:
                    let target = (string as NSString).substring(with: inner)
                    let name = target.split(separator: "|").first.map(String.init) ?? target
                    storage.addAttributes([.foregroundColor: accent, .noteLink: name.split(separator: "#").first.map(String.init) ?? name], range: inner)
                    if let pipe = target.firstIndex(of: "|"), !reveal {
                        let aliasOffset = target.distance(from: target.startIndex, to: pipe) + 1
                        hide(storage, NSRange(location: inner.location, length: aliasOffset), reveal: false)
                    }
                    hide(storage, open, reveal: reveal)
                    hide(storage, NSRange(location: NSMaxRange(inner), length: 2), reveal: reveal)
                case .bold:
                    storage.addAttribute(.font, value: NoteFonts.sans(baseSize, weight: .semibold), range: inner)
                    hide(storage, open, reveal: reveal)
                    hide(storage, NSRange(location: NSMaxRange(inner), length: NSMaxRange(whole) - NSMaxRange(inner)), reveal: reveal)
                case .italic:
                    storage.addAttribute(.font, value: NoteFonts.sans(baseSize, italic: true), range: inner)
                    hide(storage, open, reveal: reveal)
                    hide(storage, NSRange(location: NSMaxRange(inner), length: NSMaxRange(whole) - NSMaxRange(inner)), reveal: reveal)
                case .strike:
                    storage.addAttributes([.strikethroughStyle: NSUnderlineStyle.single.rawValue, .foregroundColor: secondary], range: inner)
                    hide(storage, open, reveal: reveal)
                    hide(storage, NSRange(location: NSMaxRange(inner), length: NSMaxRange(whole) - NSMaxRange(inner)), reveal: reveal)
                case .link:
                    let url = (string as NSString).substring(with: match.range(at: 2))
                    storage.addAttributes([.foregroundColor: accent, .link: url], range: inner)
                    hide(storage, open, reveal: reveal)
                    hide(storage, NSRange(location: NSMaxRange(inner), length: NSMaxRange(whole) - NSMaxRange(inner)), reveal: reveal)
                case .tag:
                    storage.addAttribute(.foregroundColor, value: accent, range: whole)
                }
            }
        }
    }

    private func headingLevel(_ body: String) -> Int? {
        let hashes = body.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), body.dropFirst(hashes).first == " " else { return nil }
        return hashes
    }

    private func taskMarker(_ body: String) -> (done: Bool, Void)? {
        guard body.count >= 5 else { return nil }
        let prefix = String(body.prefix(6))
        if prefix.hasPrefix("- [ ]") || prefix.hasPrefix("* [ ]") { return (false, ()) }
        if prefix.hasPrefix("- [x]") || prefix.hasPrefix("- [X]") || prefix.hasPrefix("* [x]") { return (true, ()) }
        return nil
    }

    private func listMarkerLength(_ body: String) -> Int? {
        if body.hasPrefix("- ") || body.hasPrefix("* ") || body.hasPrefix("+ ") { return 2 }
        let digits = body.prefix { $0.isNumber }.count
        if digits > 0, digits < 4 {
            let rest = body.dropFirst(digits)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") { return digits + 2 }
        }
        return nil
    }

    static func exportAttributed(_ markdown: String) -> NSAttributedString {
        let storage = NSTextStorage(string: markdown)
        let styler = NoteStyler()
        let fences = fenceRanges(in: markdown as NSString)
        styler.style(storage, in: NSRange(location: 0, length: storage.length), caretLine: nil, fences: fences)
        let output = NSMutableAttributedString(attributedString: storage)
        output.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: output.length)) { value, range, _ in
            if (value as? NSColor) == NSColor.clear {
                output.addAttribute(.foregroundColor, value: NSColor.clear, range: range)
            } else {
                output.addAttribute(.foregroundColor, value: NSColor.black, range: range)
            }
        }
        output.enumerateAttribute(.noteTask, in: NSRange(location: 0, length: output.length), options: .reverse) { value, range, _ in
            guard let done = value as? Bool else { return }
            output.replaceCharacters(in: range, with: NSAttributedString(string: done ? "☑" : "☐", attributes: [.font: NoteFonts.sans(bodySize), .foregroundColor: NSColor.black]))
        }
        var location = 0
        while location < output.length {
            var effective = NSRange(location: 0, length: 0)
            let color = output.attribute(.foregroundColor, at: location, effectiveRange: &effective) as? NSColor
            if color == NSColor.clear {
                output.deleteCharacters(in: effective)
            } else {
                location = NSMaxRange(effective)
            }
        }
        return output
    }
}
