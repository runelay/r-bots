import SwiftUI

struct ReadableResult: View {
    let call: ToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let error = call.errorMessage {
                Text(Self.friendlyError(error))
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let output = call.output, let files = Self.files(in: output) {
                FileListResult(entries: files.entries, hiddenCount: files.hidden)
            } else if let output = call.output {
                ForEach(Array(Self.lines(for: output).enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                        if let key = line.key {
                            Text(key)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                                .frame(minWidth: 72, alignment: .leading)
                        }
                        Text(line.value)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(line.key == nil ? 6 : 2)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Text(call.status.isActive ? "Ainda rodando…" : "Sem resultado para mostrar.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    struct Line {
        let key: String?
        let value: String
    }

    static func plainText(_ value: JSONValue) -> String {
        lines(for: value).map { line in
            line.key.map { "\($0): \(line.value)" } ?? line.value
        }
        .joined(separator: "\n")
    }

    static func friendlyError(_ message: String) -> String {
        if message.contains("TOOL_EXECUTION_DENIED") || message.contains("denied") {
            return tr("Você não permitiu esta ação.")
        }
        return message.count > 280 ? String(message.prefix(279)) + "…" : message
    }

    static func embeddedJSON(_ text: String) -> JSONValue? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{") || trimmed.hasPrefix("[") else { return nil }
        return JSONValue.parse(trimmed)
    }

    static func files(in value: JSONValue) -> (entries: [FileEntry], hidden: Int)? {
        let resolved: JSONValue
        if case .string(let text) = value, let nested = embeddedJSON(text) {
            resolved = nested
        } else {
            resolved = value
        }
        var items: [JSONValue]?
        if case .array(let list) = resolved {
            items = list
        } else if let object = resolved.objectValue {
            for key in ["entries", "files", "items", "children"] {
                if case .array(let list)? = object[key] {
                    items = list
                    break
                }
            }
        }
        guard let items, !items.isEmpty else { return nil }
        let kinds: Set<String> = ["file", "dir", "directory", "folder", "symlink"]
        var entries: [FileEntry] = []
        var hidden = 0
        for item in items {
            guard let object = item.objectValue, let name = object["name"]?.stringValue,
                let type = object["type"]?.stringValue, kinds.contains(type)
            else { return nil }
            if object["hidden"] == .bool(true) || name.hasPrefix(".") {
                hidden += 1
                continue
            }
            let size: Int64? = {
                if case .number(let value)? = object["size"] { return Int64(value) }
                return nil
            }()
            entries.append(FileEntry(name: name, isFolder: type != "file" && type != "symlink", size: size))
        }
        entries.sort { lhs, rhs in
            lhs.isFolder != rhs.isFolder ? lhs.isFolder : lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
        return (entries, hidden)
    }

    static func lines(for value: JSONValue) -> [Line] {
        switch value {
        case .string(let text):
            if let nested = Self.embeddedJSON(text) {
                return lines(for: nested)
            }
            return [Line(key: nil, value: String(text.prefix(600)))]
        case .array(let items):
            return listLines(items)
        case .object(let object):
            if object.count == 1, let only = object.values.first, case .array(let items) = only {
                return listLines(items)
            }
            let hidden: Set<String> = ["screenshot", "image", "imageBase64", "updatedAt", "snapshot", "mimeType"]
            var result: [Line] = []
            for key in object.keys.sorted() where !hidden.contains(key) {
                guard let item = object[key] else { continue }
                switch item {
                case .array(let items):
                    result.append(Line(key: humanKey(key), value: items.count == 1 ? tr("1 item") : tr("%lld itens", items.count)))
                    result.append(contentsOf: listLines(items).prefix(3))
                case .object(let nested):
                    if let title = headline(of: nested) {
                        result.append(Line(key: humanKey(key), value: title))
                    }
                case .null:
                    continue
                default:
                    if let text = item.inlineDescription, !text.isEmpty {
                        result.append(Line(key: humanKey(key), value: text))
                    }
                }
                if result.count >= 8 { break }
            }
            return result.isEmpty ? [Line(key: nil, value: tr("Concluído."))] : result
        case .null:
            return [Line(key: nil, value: tr("Concluído."))]
        default:
            return [Line(key: nil, value: value.inlineDescription ?? "")]
        }
    }

    private static func listLines(_ items: [JSONValue]) -> [Line] {
        guard !items.isEmpty else { return [Line(key: nil, value: tr("Nenhum item."))] }
        var result = items.prefix(5).map { item -> Line in
            if let object = item.objectValue {
                return Line(key: nil, value: "• " + (headline(of: object) ?? summary(of: object)))
            }
            return Line(key: nil, value: "• " + (item.inlineDescription ?? ""))
        }
        if items.count > 5 {
            result.append(Line(key: nil, value: tr("e mais %lld", items.count - 5)))
        }
        return result
    }

    private static func headline(of object: [String: JSONValue]) -> String? {
        for key in ["title", "name", "subject", "summary", "label", "text", "message", "email", "id"] {
            if let value = object[key]?.stringValue, !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private static func summary(of object: [String: JSONValue]) -> String {
        object.keys.sorted().prefix(3).compactMap { key in
            object[key]?.inlineDescription.map { "\(humanKey(key)): \($0)" }
        }
        .joined(separator: " · ")
    }

    private static func humanKey(_ key: String) -> String {
        var spaced = ""
        for character in key {
            if character.isUppercase, !spaced.isEmpty {
                spaced.append(" ")
            }
            spaced.append(character == "_" ? " " : Character(character.lowercased()))
        }
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}

struct FileEntry: Hashable {
    let name: String
    let isFolder: Bool
    let size: Int64?
}

struct FileListResult: View {
    let entries: [FileEntry]
    let hiddenCount: Int
    @State private var showsAll = false

    private static let limit = 12

    var body: some View {
        let visible = showsAll ? entries : Array(entries.prefix(Self.limit))
        VStack(alignment: .leading, spacing: 2) {
            if entries.isEmpty {
                Text("Pasta vazia.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
            ForEach(visible, id: \.self) { entry in
                HStack(spacing: Spacing.s) {
                    Image(systemName: entry.isFolder ? "folder.fill" : "doc")
                        .font(.system(size: 11))
                        .foregroundStyle(entry.isFolder ? Theme.brandText : Theme.textTertiary)
                        .frame(width: 16)
                    Text(entry.name)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: Spacing.m)
                    if let size = entry.size, !entry.isFolder {
                        Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .frame(height: 22)
            }
            if entries.count > Self.limit || hiddenCount > 0 {
                HStack(spacing: Spacing.s) {
                    if entries.count > Self.limit {
                        Button(showsAll ? "Mostrar menos" : "Mostrar mais \(entries.count - Self.limit)") {
                            showsAll.toggle()
                        }
                        .buttonStyle(.plain)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.brandText)
                        .clickable()
                    }
                    if hiddenCount > 0 {
                        Text(hiddenCount == 1 ? "1 arquivo oculto" : "\(hiddenCount) arquivos ocultos")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .padding(.top, Spacing.xs)
            }
        }
        .springAnimation(value: showsAll)
    }
}
