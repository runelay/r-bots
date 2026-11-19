import Foundation

struct CodeHunk: Hashable, Sendable {
    let oldStart: Int
    let oldLines: Int
    let newStart: Int
    let newLines: Int
    let section: String?
    let lines: [String]

    init?(_ value: JSONValue) {
        guard let lines = value["lines"]?.arrayValue?.compactMap(\.stringValue) else { return nil }
        section = value["section"]?.stringValue
        oldStart = value["oldStart"]?.intValue ?? 0
        oldLines = value["oldLines"]?.intValue ?? 0
        newStart = value["newStart"]?.intValue ?? 0
        newLines = value["newLines"]?.intValue ?? 0
        self.lines = lines
    }

    static func list(_ value: JSONValue?) -> [CodeHunk] {
        value?.arrayValue?.compactMap(CodeHunk.init) ?? []
    }
}

struct CodeEdit: Identifiable, Hashable, Sendable {
    let id: String
    let callID: String?
    let path: String
    let before: String?
    let after: String?
    let hunks: [CodeHunk]
    let added: Int
    let removed: Int
    let created: Bool
    let deleted: Bool
    let outside: Bool

    init?(_ data: JSONValue, id: String) {
        guard let path = data["path"]?.stringValue else { return nil }
        self.id = id
        callID = data["callId"]?.stringValue
        self.path = path
        before = data["before"]?.stringValue
        after = data["after"]?.stringValue
        hunks = CodeHunk.list(data["hunks"])
        added = data["added"]?.intValue ?? 0
        removed = data["removed"]?.intValue ?? 0
        created = data["created"]?.boolValue ?? false
        deleted = data["deleted"]?.boolValue ?? false
        outside = data["outside"]?.boolValue ?? false
    }

    init(path: String, before: String?, after: String?, hunks: [CodeHunk], added: Int, removed: Int, created: Bool, deleted: Bool) {
        id = "file-\(path)"
        callID = nil
        self.path = path
        self.before = before
        self.after = after
        self.hunks = hunks
        self.added = added
        self.removed = removed
        self.created = created
        self.deleted = deleted
        outside = false
    }
}

struct CodeFileChange: Identifiable, Hashable, Sendable {
    let path: String
    let status: String
    let added: Int
    let removed: Int
    let binary: Bool

    var id: String { path }

    init?(_ value: JSONValue) {
        guard let path = value["path"]?.stringValue else { return nil }
        self.path = path
        status = value["status"]?.stringValue ?? "modified"
        added = value["added"]?.intValue ?? 0
        removed = value["removed"]?.intValue ?? 0
        binary = value["binary"]?.boolValue ?? false
    }

    var statusLabel: String {
        switch status {
        case "added", "untracked": "novo"
        case "deleted": "apagado"
        case "renamed": "renomeado"
        default: ""
        }
    }
}

struct CodeDevServer: Identifiable, Hashable, Sendable {
    let id: String
    let port: Int
    let url: String
    let command: String
    let previewPath: String?
    let status: String

    init?(_ value: JSONValue) {
        guard let port = value["port"]?.intValue else { return nil }
        id = value["id"]?.stringValue ?? "port-\(port)"
        self.port = port
        url = value["url"]?.stringValue ?? "http://localhost:\(port)"
        command = value["command"]?.stringValue ?? ""
        previewPath = value["previewPath"]?.stringValue
        status = value["status"]?.stringValue ?? "running"
    }
}

struct CodeCheckpoint: Identifiable, Hashable, Sendable {
    let turnID: String
    let at: Date?
    var request: String? = nil

    var id: String { turnID }
}

struct CodeWorkspace: Hashable, Sendable {
    let id: String
    let repoName: String
    let path: String
    let branch: String
    let base: String
    var files: Int
    var added: Int
    var removed: Int
    let installStatus: String?
    let installError: String?
    var pr: PullRequestInfo?

    init?(_ value: JSONValue?) {
        guard let value, let id = value["id"]?.stringValue else { return nil }
        self.id = id
        repoName = value["repoName"]?.stringValue ?? "repositório"
        path = value["path"]?.stringValue ?? ""
        branch = value["branch"]?.stringValue ?? ""
        base = value["base"]?.stringValue ?? ""
        files = value["files"]?.intValue ?? 0
        added = value["added"]?.intValue ?? 0
        removed = value["removed"]?.intValue ?? 0
        installStatus = value["install"]?["status"]?.stringValue
        installError = value["install"]?["error"]?.stringValue
        pr = PullRequestInfo(value["pr"])
    }
}

struct CodeState: Hashable, Sendable {
    var workspace: CodeWorkspace?
    var files: [CodeFileChange]
    var servers: [CodeDevServer]
    var checkpoints: [CodeCheckpoint]

    init(_ value: JSONValue) {
        workspace = CodeWorkspace(value["workspace"])
        files = value["files"]?.arrayValue?.compactMap(CodeFileChange.init) ?? []
        servers = value["servers"]?.arrayValue?.compactMap(CodeDevServer.init) ?? []
        checkpoints = value["checkpoints"]?.arrayValue?.compactMap { item in
            item["turnId"]?.stringValue.map { CodeCheckpoint(turnID: $0, at: item["at"]?.stringValue.flatMap(ISODate.parse), request: item["request"]?.stringValue) }
        } ?? []
    }
}

struct CodeBadge: Hashable, Sendable {
    let repoName: String
    let branch: String
    let files: Int
    let running: Bool

    init?(_ value: JSONValue?) {
        guard let value, let repoName = value["repoName"]?.stringValue else { return nil }
        self.repoName = repoName
        branch = value["branch"]?.stringValue ?? ""
        files = value["files"]?.intValue ?? 0
        running = value["running"]?.boolValue ?? false
    }
}

struct RepoInfo: Identifiable, Hashable, Sendable {
    let name: String
    let path: String
    let location: String
    let branch: String?

    var id: String { path }

    init?(_ value: JSONValue) {
        guard let name = value["name"]?.stringValue, let path = value["path"]?.stringValue else { return nil }
        self.name = name
        self.path = path
        location = value["location"]?.stringValue ?? ""
        branch = value["branch"]?.stringValue
    }
}

enum CodeLineKind: Hashable {
    case context
    case added
    case removed
}

struct CodeLine: Identifiable, Hashable {
    let id: Int
    let kind: CodeLineKind
    let oldNumber: Int?
    let newNumber: Int?
    let text: String
    var emphasis: [Range<Int>] = []
}

enum CodeRow: Identifiable, Hashable {
    case line(CodeLine)
    case gap(id: String, lines: [CodeLine])

    var id: String {
        switch self {
        case .line(let line): "l\(line.id)"
        case .gap(let id, _): id
        }
    }
}

enum DiffBlock: Identifiable, Hashable {
    case hunk(id: String, title: String, section: String?, rows: [CodeRow])
    case gap(id: String, lines: [CodeLine])

    var id: String {
        switch self {
        case .hunk(let id, _, _, _): id
        case .gap(let id, _): id
        }
    }

    var rowCount: Int {
        switch self {
        case .hunk(_, _, _, let rows): rows.count
        case .gap: 1
        }
    }
}

enum CodeDiffLayout {
    static let keepContext = 3

    static func blocks(for edit: CodeEdit) -> [DiffBlock] {
        let afterLines = edit.after.map(splitLines)
        var blocks: [DiffBlock] = []
        var counter = 0
        var nextNew = 1
        var nextOld = 1
        func contextLines(fromNew start: Int, oldStart: Int, count: Int) -> [CodeLine] {
            guard let afterLines, count > 0 else { return [] }
            var result: [CodeLine] = []
            for offset in 0..<count {
                let index = start - 1 + offset
                guard index >= 0, index < afterLines.count else { break }
                counter += 1
                result.append(CodeLine(id: counter, kind: .context, oldNumber: oldStart + offset, newNumber: start + offset, text: expand(afterLines[index])))
            }
            return result
        }
        for (hunkIndex, hunk) in edit.hunks.enumerated() {
            let gapCount = hunk.newStart - nextNew
            if gapCount > 0 {
                let hidden = contextLines(fromNew: nextNew, oldStart: nextOld, count: gapCount)
                if !hidden.isEmpty {
                    blocks.append(.gap(id: "gap-\(hunkIndex)", lines: hidden))
                }
            }
            var oldNumber = hunk.oldStart
            var newNumber = hunk.newStart
            var buffer: [CodeLine] = []
            for raw in hunk.lines {
                counter += 1
                let marker = raw.first
                let text = expand(String(raw.dropFirst()))
                switch marker {
                case "+":
                    buffer.append(CodeLine(id: counter, kind: .added, oldNumber: nil, newNumber: newNumber, text: text))
                    newNumber += 1
                case "-":
                    buffer.append(CodeLine(id: counter, kind: .removed, oldNumber: oldNumber, newNumber: nil, text: text))
                    oldNumber += 1
                default:
                    buffer.append(CodeLine(id: counter, kind: .context, oldNumber: oldNumber, newNumber: newNumber, text: text))
                    oldNumber += 1
                    newNumber += 1
                }
            }
            blocks.append(.hunk(id: "hunk-\(hunkIndex)", title: title(for: hunk), section: hunk.section, rows: collapse(emphasize(buffer), key: "h\(hunkIndex)")))
            nextNew = newNumber
            nextOld = oldNumber
        }
        if let afterLines, nextNew <= afterLines.count, !edit.hunks.isEmpty {
            let tail = contextLines(fromNew: nextNew, oldStart: nextOld, count: afterLines.count - nextNew + 1)
            if !tail.isEmpty {
                blocks.append(.gap(id: "gap-end", lines: tail))
            }
        }
        return blocks
    }

    static func chunked(_ blocks: [DiffBlock], size: Int) -> [DiffBlock] {
        var result: [DiffBlock] = []
        for block in blocks {
            guard case .hunk(let id, let title, let section, let rows) = block, rows.count > size else {
                result.append(block)
                continue
            }
            var start = 0
            var part = 0
            while start < rows.count {
                let end = min(rows.count, start + size)
                result.append(.hunk(id: part == 0 ? id : "\(id)-\(part)", title: part == 0 ? title : "\(title) · continua", section: part == 0 ? section : nil, rows: Array(rows[start..<end])))
                start = end
                part += 1
            }
        }
        return result
    }

    static func limited(_ blocks: [DiffBlock], rows limit: Int) -> (blocks: [DiffBlock], hidden: Int) {
        var used = 0
        var result: [DiffBlock] = []
        var hidden = 0
        for block in blocks {
            if used >= limit {
                if case .hunk(_, _, _, let rows) = block { hidden += rows.count }
                continue
            }
            if case .hunk(let id, let title, let section, let rows) = block, used + rows.count > limit {
                let keep = limit - used
                result.append(.hunk(id: id, title: title, section: section, rows: Array(rows.prefix(keep))))
                hidden += rows.count - keep
                used = limit
                continue
            }
            result.append(block)
            used += block.rowCount
        }
        return (result, hidden)
    }

    private static func title(for hunk: CodeHunk) -> String {
        let start = hunk.newLines == 0 ? hunk.oldStart : hunk.newStart
        let count = hunk.newLines == 0 ? hunk.oldLines : hunk.newLines
        let end = start + max(count, 1) - 1
        return end > start ? "linhas \(start)–\(end)" : "linha \(start)"
    }

    private static func expand(_ text: String) -> String {
        text.replacingOccurrences(of: "\t", with: "    ")
    }

    private static func emphasize(_ lines: [CodeLine]) -> [CodeLine] {
        var result = lines
        var index = 0
        while index < result.count {
            guard result[index].kind == .removed else {
                index += 1
                continue
            }
            var removedEnd = index
            while removedEnd < result.count, result[removedEnd].kind == .removed { removedEnd += 1 }
            var addedEnd = removedEnd
            while addedEnd < result.count, result[addedEnd].kind == .added { addedEnd += 1 }
            let pairs = min(removedEnd - index, addedEnd - removedEnd)
            for offset in 0..<pairs {
                let old = index + offset
                let new = removedEnd + offset
                if let change = WordDiff.changes(old: result[old].text, new: result[new].text) {
                    result[old].emphasis = change.old
                    result[new].emphasis = change.new
                }
            }
            index = max(addedEnd, index + 1)
        }
        return result
    }

    private static func collapse(_ lines: [CodeLine], key: String) -> [CodeRow] {
        var rows: [CodeRow] = []
        var run: [CodeLine] = []
        var runIndex = 0
        func flush() {
            let limit = keepContext * 2 + 2
            if run.count > limit {
                rows.append(contentsOf: run.prefix(keepContext).map(CodeRow.line))
                rows.append(.gap(id: "\(key)-\(runIndex)", lines: Array(run.dropFirst(keepContext).dropLast(keepContext))))
                rows.append(contentsOf: run.suffix(keepContext).map(CodeRow.line))
            } else {
                rows.append(contentsOf: run.map(CodeRow.line))
            }
            runIndex += 1
            run = []
        }
        for line in lines {
            if line.kind == .context {
                run.append(line)
            } else {
                flush()
                rows.append(.line(line))
            }
        }
        flush()
        return rows
    }

    static func splitLines(_ text: String) -> [String] {
        var lines = text.components(separatedBy: "\n")
        if lines.last == "" {
            lines.removeLast()
        }
        return lines
    }
}

enum WordDiff {
    static func tokens(_ text: String) -> [String] {
        var result: [String] = []
        var current = ""
        var currentKind = -1
        for character in text {
            let kind = character.isLetter || character.isNumber || character == "_" ? 0 : character.isWhitespace ? 1 : 2
            if kind == currentKind, kind != 2 {
                current.append(character)
            } else {
                if !current.isEmpty { result.append(current) }
                current = String(character)
                currentKind = kind
            }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    static func changes(old: String, new: String) -> (old: [Range<Int>], new: [Range<Int>])? {
        let a = tokens(old)
        let b = tokens(new)
        guard !a.isEmpty, !b.isEmpty, a.count * b.count <= 160_000 else { return nil }
        let width = b.count + 1
        var table = [Int32](repeating: 0, count: (a.count + 1) * width)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i * width + j] = a[i] == b[j] ? table[(i + 1) * width + j + 1] + 1 : max(table[(i + 1) * width + j], table[i * width + j + 1])
            }
        }
        var keepA = [Bool](repeating: false, count: a.count)
        var keepB = [Bool](repeating: false, count: b.count)
        var i = 0
        var j = 0
        while i < a.count, j < b.count {
            if a[i] == b[j] {
                keepA[i] = true
                keepB[j] = true
                i += 1
                j += 1
            } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        let oldRanges = ranges(a, keep: keepA)
        let newRanges = ranges(b, keep: keepB)
        let oldChanged = oldRanges.reduce(0) { $0 + $1.count }
        let newChanged = newRanges.reduce(0) { $0 + $1.count }
        guard oldChanged + newChanged > 0 else { return nil }
        if Double(oldChanged) > Double(old.count) * 0.7 && Double(newChanged) > Double(new.count) * 0.7 { return nil }
        return (oldRanges, newRanges)
    }

    private static func ranges(_ tokens: [String], keep: [Bool]) -> [Range<Int>] {
        var result: [Range<Int>] = []
        var offset = 0
        for (index, token) in tokens.enumerated() {
            let length = token.count
            let isSpace = token.allSatisfy(\.isWhitespace)
            if !keep[index], !(isSpace && result.isEmpty) {
                if let last = result.last, last.upperBound == offset {
                    result[result.count - 1] = last.lowerBound..<(offset + length)
                } else {
                    result.append(offset..<(offset + length))
                }
            } else if keep[index], isSpace, let last = result.last, last.upperBound == offset,
                      index + 1 < tokens.count, !keep[index + 1] {
                result[result.count - 1] = last.lowerBound..<(offset + length)
            }
            offset += length
        }
        return result
    }
}

enum CodeSyntax {
    enum Token: Hashable {
        case plain
        case keyword
        case string
        case comment
        case number
        case type
    }

    static func language(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "ts", "tsx", "js", "jsx", "mjs", "cjs": return "ts"
        case "swift": return "swift"
        case "sql": return "sql"
        case "css", "scss": return "css"
        case "json", "jsonc": return "json"
        case "py": return "py"
        case "sh", "bash", "zsh": return "sh"
        default: return ""
        }
    }

    private static let keywords: [String: Set<String>] = [
        "ts": ["import", "export", "from", "const", "let", "var", "function", "return", "if", "else", "for", "while", "await", "async", "new", "class", "extends", "interface", "type", "default", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "of", "in", "as", "satisfies", "true", "false", "null", "undefined", "this", "typeof", "void", "enum", "readonly", "private", "public", "static", "yield"],
        "swift": ["import", "struct", "class", "enum", "func", "let", "var", "return", "if", "else", "guard", "for", "while", "in", "switch", "case", "default", "break", "continue", "true", "false", "nil", "self", "Self", "private", "fileprivate", "public", "static", "extension", "protocol", "some", "any", "async", "await", "throws", "try", "init", "where", "@MainActor", "@Observable", "@State", "@Environment", "@Binding", "@Bindable"],
        "sql": ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "add", "column", "drop", "index", "on", "join", "left", "right", "inner", "outer", "group", "by", "order", "limit", "as", "null", "is", "in", "with", "returning", "primary", "key", "references", "default", "unique", "if", "exists", "begin", "commit"],
        "css": ["@media", "@import", "@layer", "@theme", "@apply", "!important"],
        "json": ["true", "false", "null"],
        "py": ["def", "class", "import", "from", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "None", "True", "False", "with", "as", "try", "except", "raise", "async", "await", "lambda", "self"],
        "sh": ["if", "then", "else", "fi", "for", "do", "done", "case", "esac", "while", "function", "export", "local", "return"],
    ]

    static func tokens(_ line: String, language: String) -> [(String, Token)] {
        guard !language.isEmpty, line.count < 400 else { return [(line, .plain)] }
        let words = keywords[language] ?? []
        let caseInsensitive = language == "sql"
        let commentPrefix = language == "sql" ? "--" : (language == "py" || language == "sh") ? "#" : "//"
        var result: [(String, Token)] = []
        var current = ""
        func push(_ token: Token) {
            if !current.isEmpty {
                result.append((current, token))
                current = ""
            }
        }
        let chars = Array(line)
        let commentChars = Array(commentPrefix)
        let blockComments = language != "py" && language != "sh" && language != "sql"
        func startsWith(_ prefix: [Character], at offset: Int) -> Bool {
            guard offset + prefix.count <= chars.count else { return false }
            for step in 0..<prefix.count where chars[offset + step] != prefix[step] {
                return false
            }
            return true
        }
        var index = 0
        while index < chars.count {
            let char = chars[index]
            if startsWith(commentChars, at: index) || (blockComments && startsWith(["/", "*"], at: index)) {
                push(.plain)
                result.append((String(chars[index...]), .comment))
                return result
            }
            if char == "\"" || char == "'" || char == "`" {
                push(.plain)
                var end = index + 1
                while end < chars.count && chars[end] != char {
                    if chars[end] == "\\" { end += 1 }
                    end += 1
                }
                let stop = min(end, chars.count - 1)
                result.append((String(chars[index...stop]), .string))
                index = stop + 1
                continue
            }
            if char.isLetter || char == "_" || char == "@" || char == "$" || char == "!" {
                var end = index
                while end < chars.count && (chars[end].isLetter || chars[end].isNumber || chars[end] == "_" || chars[end] == "@" || chars[end] == "$" || chars[end] == "!") {
                    end += 1
                }
                let word = String(chars[index..<end])
                push(.plain)
                let lookup = caseInsensitive ? word.lowercased() : word
                if words.contains(lookup) {
                    result.append((word, .keyword))
                } else if let first = word.first, first.isUppercase, language != "sql", language != "css" {
                    result.append((word, .type))
                } else {
                    result.append((word, .plain))
                }
                index = end
                continue
            }
            if char.isNumber {
                var end = index
                while end < chars.count && (chars[end].isNumber || chars[end] == "." || chars[end] == "_") {
                    end += 1
                }
                push(.plain)
                result.append((String(chars[index..<end]), .number))
                index = end
                continue
            }
            current.append(char)
            index += 1
        }
        push(.plain)
        return result
    }
}
