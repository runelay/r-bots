import Foundation

enum MarkdownAlignment: Hashable, Sendable {
    case leading
    case center
    case trailing
}

struct MarkdownListItem: Hashable, Sendable {
    let level: Int
    let marker: String
    let text: String
}

struct MarkdownTable: Hashable, Sendable {
    let headers: [String]
    let alignments: [MarkdownAlignment]
    let rows: [[String]]
}

indirect enum MarkdownBlock: Hashable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case list([MarkdownListItem])
    case quote([MarkdownBlock])
    case code(language: String, text: String)
    case rule
    case table(MarkdownTable)
}

@MainActor
enum MarkdownCache {
    private static var blocks: [String: [MarkdownBlock]] = [:]
    private static var inline: [String: AttributedString] = [:]
    private static let limit = 400

    static func blocks(for source: String) -> [MarkdownBlock] {
        if let cached = blocks[source] {
            return cached
        }
        let parsed = MarkdownParser.parse(source)
        if blocks.count >= limit {
            blocks.removeAll(keepingCapacity: true)
        }
        blocks[source] = parsed
        return parsed
    }

    static func attributed(_ source: String) -> AttributedString {
        if let cached = inline[source] {
            return cached
        }
        let value = MarkdownText.attributed(source)
        if inline.count >= limit * 4 {
            inline.removeAll(keepingCapacity: true)
        }
        inline[source] = value
        return value
    }
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        return parse(lines: lines, lastLineTerminated: source.hasSuffix("\n"))
    }

    private static func parse(lines: [String], lastLineTerminated: Bool) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var index = 0

        func isTerminated(_ line: Int) -> Bool {
            line < lines.count - 1 || lastLineTerminated
        }

        func flushParagraph() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(.paragraph(text))
            }
            paragraph.removeAll()
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if let fence = fenceMarker(trimmed) {
                flushParagraph()
                let language = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
                let indent = leadingSpaces(line)
                var body: [String] = []
                index += 1
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    if candidate.hasPrefix(fence), candidate.allSatisfy({ $0 == fence.first }) {
                        index += 1
                        break
                    }
                    body.append(dropIndent(lines[index], upTo: indent))
                    index += 1
                }
                blocks.append(.code(language: language, text: body.joined(separator: "\n")))
                continue
            }

            if let level = headingLevel(trimmed) {
                flushParagraph()
                let text = String(trimmed.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)
                blocks.append(.heading(level: min(level, 3), text: text))
                index += 1
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                index += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var inner: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard candidate.hasPrefix(">") else { break }
                    var stripped = candidate.dropFirst()
                    if stripped.first == " " {
                        stripped = stripped.dropFirst()
                    }
                    inner.append(String(stripped))
                    index += 1
                }
                let terminated = index < lines.count || lastLineTerminated
                blocks.append(.quote(parse(lines: inner, lastLineTerminated: terminated)))
                continue
            }

            if listMarker(line) != nil {
                flushParagraph()
                var items: [MarkdownListItem] = []
                var indents: [Int] = []
                while index < lines.count {
                    let candidate = lines[index]
                    let candidateTrimmed = candidate.trimmingCharacters(in: .whitespaces)
                    if let marker = listMarker(candidate) {
                        let indent = leadingSpaces(candidate)
                        while let last = indents.last, indent < last {
                            indents.removeLast()
                        }
                        if indents.last.map({ indent > $0 }) ?? true {
                            indents.append(indent)
                        }
                        items.append(MarkdownListItem(level: indents.count - 1, marker: marker.marker, text: marker.text))
                        index += 1
                        continue
                    }
                    if candidateTrimmed.isEmpty {
                        let next = lines[(index + 1)...].first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                        if let next, listMarker(next) != nil {
                            index += 1
                            continue
                        }
                        break
                    }
                    if fenceMarker(candidateTrimmed) != nil || headingLevel(candidateTrimmed) != nil || isRule(candidateTrimmed) || candidateTrimmed.hasPrefix(">") {
                        break
                    }
                    if let last = items.popLast() {
                        items.append(MarkdownListItem(level: last.level, marker: last.marker, text: last.text + "\n" + candidateTrimmed))
                    }
                    index += 1
                }
                blocks.append(.list(items))
                continue
            }

            if line.contains("|"), index + 1 < lines.count, isTerminated(index + 1),
                let alignments = delimiterAlignments(lines[index + 1])
            {
                let headers = cells(line)
                if headers.count == alignments.count {
                    flushParagraph()
                    let headerHasEdgePipe = trimmed.hasSuffix("|")
                    var rows: [[String]] = []
                    index += 2
                    while index < lines.count {
                        let rowLine = lines[index]
                        let rowTrimmed = rowLine.trimmingCharacters(in: .whitespaces)
                        guard !rowTrimmed.isEmpty, rowLine.contains("|") else { break }
                        let rowCells = cells(rowLine)
                        if !isTerminated(index) {
                            let complete = headerHasEdgePipe ? rowTrimmed.hasSuffix("|") && rowTrimmed.count > 1 : rowCells.count >= headers.count
                            if !complete { break }
                        }
                        rows.append(normalized(rowCells, count: headers.count))
                        index += 1
                    }
                    blocks.append(.table(MarkdownTable(headers: headers, alignments: alignments, rows: rows)))
                    continue
                }
            }

            paragraph.append(line)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    private static func fenceMarker(_ trimmed: String) -> String? {
        for fence in ["```", "~~~"] where trimmed.hasPrefix(fence) {
            let char = fence.first!
            return String(trimmed.prefix(while: { $0 == char }))
        }
        return nil
    }

    private static func headingLevel(_ trimmed: String) -> Int? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let rest = trimmed.dropFirst(hashes)
        guard rest.isEmpty || rest.first == " " else { return nil }
        return hashes
    }

    private static func isRule(_ trimmed: String) -> Bool {
        let compact = trimmed.filter { $0 != " " }
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func listMarker(_ line: String) -> (marker: String, text: String)? {
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        if let first = trimmed.first, "-*+".contains(first), trimmed.dropFirst().first == " " {
            return ("•", String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces))
        }
        let digits = trimmed.prefix(while: { $0.isASCII && $0.isNumber })
        guard (1...9).contains(digits.count) else { return nil }
        let rest = trimmed.dropFirst(digits.count)
        guard let punctuation = rest.first, punctuation == "." || punctuation == ")", rest.dropFirst().first == " " else { return nil }
        return ("\(digits).", String(rest.dropFirst(2)).trimmingCharacters(in: .whitespaces))
    }

    private static func leadingSpaces(_ line: String) -> Int {
        var count = 0
        for char in line {
            if char == " " {
                count += 1
            } else if char == "\t" {
                count += 4
            } else {
                break
            }
        }
        return count
    }

    private static func dropIndent(_ line: String, upTo indent: Int) -> String {
        var removed = 0
        var result = Substring(line)
        while removed < indent, result.first == " " {
            result = result.dropFirst()
            removed += 1
        }
        return String(result)
    }

    private static func delimiterAlignments(_ line: String) -> [MarkdownAlignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.allSatisfy({ "|:- ".contains($0) }) else { return nil }
        var parts = trimmed.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if trimmed.hasPrefix("|") { parts.removeFirst() }
        if trimmed.hasSuffix("|"), !parts.isEmpty { parts.removeLast() }
        guard !parts.isEmpty else { return nil }
        var result: [MarkdownAlignment] = []
        for part in parts {
            let dashes = part.filter { $0 == "-" }
            guard !dashes.isEmpty else { return nil }
            let left = part.hasPrefix(":")
            let right = part.hasSuffix(":")
            result.append(left && right ? .center : right ? .trailing : .leading)
        }
        return result
    }

    private static func cells(_ line: String) -> [String] {
        var trimmed = Substring(line.trimmingCharacters(in: .whitespaces))
        if trimmed.hasPrefix("|") { trimmed = trimmed.dropFirst() }
        if trimmed.hasSuffix("|"), !trimmed.hasSuffix("\\|") { trimmed = trimmed.dropLast() }
        var result: [String] = []
        var current = ""
        var inCode = false
        var escaped = false
        for char in trimmed {
            if escaped {
                current.append(char)
                escaped = false
                continue
            }
            switch char {
            case "\\":
                escaped = true
                current.append(char)
            case "`":
                inCode.toggle()
                current.append(char)
            case "|" where !inCode:
                result.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            default:
                current.append(char)
            }
        }
        result.append(current.trimmingCharacters(in: .whitespaces))
        return result.map { $0.replacingOccurrences(of: "\\|", with: "|") }
    }

    private static func normalized(_ cells: [String], count: Int) -> [String] {
        if cells.count >= count {
            return Array(cells.prefix(count))
        }
        return cells + Array(repeating: "", count: count - cells.count)
    }

    static func isNumeric(_ cell: String) -> Bool {
        let stripped =
            cell
            .replacingOccurrences(of: "R$", with: "")
            .filter { !" `*_$€£%+-−~≈x×()".contains($0) }
        guard !stripped.isEmpty else { return false }
        return stripped.allSatisfy { $0.isNumber || $0 == "." || $0 == "," } && stripped.contains(where: \.isNumber)
    }
}
