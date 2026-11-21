import AppKit
import SwiftUI

enum CodePalette {
    static let addedBackground = Theme.success.opacity(0.16)
    static let removedBackground = Theme.danger.opacity(0.16)
    static let addedEmphasis = Theme.success.opacity(0.34)
    static let removedEmphasis = Theme.danger.opacity(0.32)
    static let addedText = Theme.success
    static let removedText = Theme.danger
    static let gutter = Theme.textTertiary

    static func color(_ token: CodeSyntax.Token) -> Color {
        switch token {
        case .plain: Theme.textPrimary
        case .keyword: Theme.accent("violet")
        case .string: Theme.accent("teal")
        case .comment: Theme.textTertiary
        case .number: Theme.accent("orange")
        case .type: Theme.accent("blue")
        }
    }
}

@MainActor
enum CodeActions {
    static let editorHostKey = "codeEditorHost"

    static func confirm(_ title: String, message: String, action: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancelar")
        return alert.runModal() == .alertFirstButtonReturn
    }

    static func rewind(store: ConversationStore, entryID: String) {
        guard confirm("Desfazer este pedido?", message: "Os arquivos e a conversa voltam para antes dele. O que veio depois também sai.", action: "Desfazer") else { return }
        Task {
            do {
                try await store.rewind(entryID: entryID)
            } catch {
                NSSound.beep()
            }
        }
    }

    static var editorHost: String {
        UserDefaults.standard.string(forKey: editorHostKey)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    @discardableResult
    static func openInZed(absolutePath: String) -> Bool {
        guard !editorHost.isEmpty else { return false }
        for candidate in ["/usr/local/bin/zed", "/opt/homebrew/bin/zed", "\(NSHomeDirectory())/.local/bin/zed"] where FileManager.default.isExecutableFile(atPath: candidate) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: candidate)
            process.arguments = ["ssh://\(editorHost)\(absolutePath)"]
            if (try? process.run()) != nil {
                return true
            }
        }
        return false
    }

    @discardableResult
    static func openInVSCode(absolutePath: String) -> Bool {
        guard !editorHost.isEmpty,
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") != nil,
            let url = URL(string: "vscode://vscode-remote/ssh-remote+\(editorHost)\(absolutePath)")
        else { return false }
        return NSWorkspace.shared.open(url)
    }

    static func openInEditor(absolutePath: String) {
        if openInZed(absolutePath: absolutePath) || openInVSCode(absolutePath: absolutePath) {
            return
        }
        copy(absolutePath)
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

struct CodeSystemLine: View {
    let text: String
    let symbol: String

    var body: some View {
        if let link = SystemLink.parse(text) {
            SystemLinkLine(link: link, symbol: symbol)
        } else {
            HStack(spacing: Spacing.s) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .semibold))
                Text(text)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
            }
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.xs)
        }
    }
}

struct FilePathLabel: View {
    let path: String

    var body: some View {
        let name = (path as NSString).lastPathComponent
        let folder = (path as NSString).deletingLastPathComponent
        HStack(spacing: Spacing.xs) {
            Text(name)
                .font(BrandFonts.sans(13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            if !folder.isEmpty {
                Text(folder)
                    .font(BrandFonts.sans(11))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
    }
}

struct ChangeCount: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Text("+\(added)").foregroundStyle(CodePalette.addedText)
            Text("−\(removed)").foregroundStyle(CodePalette.removedText)
        }
        .font(TypeScale.counter)
    }
}

struct CodeBulkLine: View {
    @Environment(AppModel.self) private var model
    let bulk: CodeBulk

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
            Text("\(bulk.files) arquivos mudaram de uma vez")
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
            ChangeCount(added: bulk.added, removed: bulk.removed)
            if let botID = model.selectedBot?.id {
                RoundIconButton(systemImage: "arrow.up.left.and.arrow.down.right", help: "Ver no visualizador de mudanças", size: 24) {
                    model.activeSheet = .changes(botID)
                }
            }
        }
        .help(bulk.paths.prefix(12).joined(separator: "\n"))
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xs)
    }
}

@MainActor
enum DiffCardCache {
    private static var blocks: [String: (signature: Int, limited: (blocks: [DiffBlock], hidden: Int))] = [:]

    static func layout(for edit: CodeEdit) -> (blocks: [DiffBlock], hidden: Int) {
        let signature = edit.hashValue
        if let cached = blocks[edit.id], cached.signature == signature {
            return cached.limited
        }
        let all = CodeDiffLayout.blocks(for: edit).filter { block in
            if case .gap = block { return false }
            return true
        }
        let limited = CodeDiffLayout.limited(all, rows: 40)
        if blocks.count > 400 {
            blocks.removeAll(keepingCapacity: true)
        }
        blocks[edit.id] = (signature, (limited.blocks, limited.hidden))
        return (limited.blocks, limited.hidden)
    }
}

struct DiffCard: View, Equatable {
    @Environment(AppModel.self) private var model
    let edit: CodeEdit

    nonisolated static func == (lhs: DiffCard, rhs: DiffCard) -> Bool {
        lhs.edit == rhs.edit
    }

    var body: some View {
        let limited = DiffCardCache.layout(for: edit)
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                Image(systemName: edit.created ? "doc.badge.plus" : edit.deleted ? "doc.badge.minus" : "pencil")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
                FilePathLabel(path: edit.path)
                Spacer(minLength: Spacing.s)
                ChangeCount(added: edit.added, removed: edit.removed)
                if let botID = model.selectedBot?.id {
                    RoundIconButton(systemImage: "arrow.up.left.and.arrow.down.right", help: "Ver no visualizador de mudanças", size: 24) {
                        model.codeFocusPath = edit.path
                        model.activeSheet = .changes(botID)
                    }
                }
            }
            .padding(.horizontal, Spacing.xs)

            TranscriptDiffBlocks(blocks: limited.blocks, language: CodeSyntax.language(for: edit.path))

            if limited.hidden > 0, let botID = model.selectedBot?.id {
                Button {
                    model.codeFocusPath = edit.path
                    model.activeSheet = .changes(botID)
                } label: {
                    Text("Ver tudo (\(limited.hidden) linha\(limited.hidden == 1 ? "" : "s") a mais)")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.brandText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Spacing.xs)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .clickable()
            }
        }
        .frame(height: model.selectedBot == nil ? nil : Self.height(blocks: limited.blocks, hidden: limited.hidden), alignment: .top)
        .frame(maxWidth: Metrics.transcriptWidth, alignment: .leading)
    }

    static func height(blocks: [DiffBlock], hidden: Int) -> CGFloat? {
        guard !blocks.isEmpty else { return nil }
        var total: CGFloat = 24
        for block in blocks {
            guard case .hunk(_, _, _, let rows) = block else { return nil }
            for row in rows {
                guard case .line = row else { return nil }
            }
            total += Spacing.s + 24 + CGFloat(rows.count) * 19 + Spacing.xs
        }
        if hidden > 0 {
            total += Spacing.s + 15 + Spacing.xs * 2
        }
        return total
    }
}

struct DiffBlocksView: View {
    let blocks: [DiffBlock]
    let language: String
    @State private var openGaps: Set<String> = []

    var body: some View {
        LazyVStack(alignment: .leading, spacing: Spacing.s) {
            ForEach(blocks) { block in
                switch block {
                case .hunk(_, let title, let section, let rows):
                    HunkCard(title: title, section: section, rows: rows, language: language)
                case .gap(let id, let lines):
                    if openGaps.contains(id), let first = lines.first, let last = lines.last {
                        HunkCard(title: "linhas \(first.newNumber ?? 0)–\(last.newNumber ?? 0)", section: nil, rows: lines.map(CodeRow.line), language: language)
                            .transition(.opacity)
                    } else {
                        GapSeparator(count: lines.count) {
                            openGaps.insert(id)
                        }
                    }
                }
            }
        }
        .springAnimation(value: openGaps)
    }
}

struct HunkCard: View {
    let title: String
    let section: String?
    let rows: [CodeRow]
    let language: String
    @State private var openGaps: Set<String> = []
    @State private var width: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.s) {
                Text(title)
                    .font(BrandFonts.sans(11, weight: .medium))
                    .foregroundStyle(Theme.textTertiary)
                if let section, !section.isEmpty {
                    Text(section)
                        .font(BrandFonts.mono(10.5))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 24)

            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        switch row {
                        case .line(let line):
                            DiffLineView(line: line, language: language, minWidth: width)
                        case .gap(let id, let lines):
                            if openGaps.contains(id) {
                                ForEach(lines) { line in
                                    DiffLineView(line: line, language: language, minWidth: width)
                                }
                            } else {
                                Button {
                                    openGaps.insert(id)
                                } label: {
                                    Text("⋯ \(lines.count) linha\(lines.count == 1 ? "" : "s") oculta\(lines.count == 1 ? "" : "s")")
                                        .font(BrandFonts.sans(11))
                                        .foregroundStyle(Theme.textTertiary)
                                        .lineLimit(1)
                                        .fixedSize()
                                        .padding(.leading, 53)
                                        .frame(minWidth: width, alignment: .leading)
                                        .frame(height: 20)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .clickable()
                                .help("Mostrar as linhas escondidas")
                            }
                        }
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
                .textSelection(.enabled)
            }
            .padding(.bottom, Spacing.xs)
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { value in
            width = value
        }
        .springAnimation(value: openGaps)
    }
}

struct GapSeparator: View {
    let count: Int
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: Spacing.s) {
                Rectangle().fill(Theme.paneDivider).frame(height: 1)
                Text("⋯ \(count) linha\(count == 1 ? "" : "s") oculta\(count == 1 ? "" : "s")")
                    .font(BrandFonts.sans(11))
                    .foregroundStyle(hovering ? Theme.textSecondary : Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                Rectangle().fill(Theme.paneDivider).frame(height: 1)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .help("Mostrar as linhas escondidas")
    }
}

struct DiffLineView: View {
    let line: CodeLine
    let language: String
    var minWidth: CGFloat = 0

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(bar)
                .frame(width: 3)
            Text(line.kind == .removed ? (line.oldNumber.map(String.init) ?? "") : (line.newNumber.map(String.init) ?? ""))
                .font(BrandFonts.mono(10.5))
                .foregroundStyle(Theme.textTertiary.opacity(0.75))
                .frame(width: 34, alignment: .trailing)
                .padding(.trailing, Spacing.s)
            Text(line.kind == .added ? "+" : line.kind == .removed ? "−" : " ")
                .fontWeight(.bold)
                .foregroundStyle(line.kind == .added ? CodePalette.addedText : line.kind == .removed ? CodePalette.removedText : Color.clear)
                .frame(width: 14, alignment: .leading)
            Text(highlighted)
                .padding(.trailing, Spacing.l)
        }
        .font(TypeScale.monoInline)
        .lineLimit(1)
        .frame(height: 19)
        .frame(minWidth: max(minWidth, 600), maxWidth: .infinity, alignment: .leading)
        .background(Rectangle().fill(background))
    }

    private var bar: Color {
        switch line.kind {
        case .added: CodePalette.addedText
        case .removed: CodePalette.removedText
        case .context: .clear
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: CodePalette.addedBackground
        case .removed: CodePalette.removedBackground
        case .context: .clear
        }
    }

    private var highlighted: AttributedString {
        HighlightCache.shared.highlighted(line, language: language)
    }
}

final class HighlightCache: @unchecked Sendable {
    static let shared = HighlightCache()
    private let lock = NSLock()
    private var values: [String: AttributedString] = [:]
    private var order: [String] = []
    private let capacity = 6000

    private func key(_ line: CodeLine, _ language: String) -> String {
        "\(language)|\(line.kind)|\(line.emphasis.map { "\($0.lowerBound)-\($0.upperBound)" }.joined(separator: ","))|\(line.text)"
    }

    func highlighted(_ line: CodeLine, language: String) -> AttributedString {
        let key = key(line, language)
        lock.lock()
        if let hit = values[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        let value = Self.render(line, language: language)
        lock.lock()
        if values[key] == nil {
            values[key] = value
            order.append(key)
            if order.count > capacity {
                let drop = order.prefix(capacity / 4)
                for old in drop {
                    values[old] = nil
                }
                order.removeFirst(drop.count)
            }
        }
        lock.unlock()
        return value
    }

    func prewarm(_ lines: [CodeLine], language: String) {
        for line in lines {
            _ = highlighted(line, language: language)
        }
    }

    private static func render(_ line: CodeLine, language: String) -> AttributedString {
        var result = AttributedString()
        for (text, token) in CodeSyntax.tokens(line.text, language: language) {
            var part = AttributedString(text)
            part.foregroundColor = CodePalette.color(token)
            result += part
        }
        guard !line.emphasis.isEmpty else { return result }
        let emphasis = line.kind == .added ? CodePalette.addedEmphasis : CodePalette.removedEmphasis
        let total = result.characters.count
        for range in line.emphasis where range.lowerBound < total {
            let start = result.characters.index(result.startIndex, offsetBy: range.lowerBound)
            let end = result.characters.index(result.startIndex, offsetBy: min(range.upperBound, total))
            result[start..<end].backgroundColor = emphasis
        }
        return result
    }
}

struct RepoPickerView: View {
    @Environment(AppModel.self) private var model
    let botID: String
    @State private var query = ""
    @State private var repos: [RepoInfo] = []
    @State private var opening: String?
    @State private var errorText: String?
    @FocusState private var focused: Bool

    private var filtered: [RepoInfo] {
        let term = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !term.isEmpty else { return repos }
        return repos.filter { $0.name.lowercased().contains(term) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Trabalhar num repositório")
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
                RoundIconButton(systemImage: "xmark", help: "Fechar (Esc)", size: 28) {
                    model.dismissSheet()
                }
            }
            .padding(.horizontal, Spacing.xl)
            .padding(.top, Spacing.xl)

            TextField("Procurar", text: $query)
                .textFieldStyle(.plain)
                .font(TypeScale.body)
                .focused($focused)
                .padding(.horizontal, Spacing.l)
                .frame(height: 38)
                .glassSurface(Capsule(), interactive: true, fallback: Theme.surface)
                .padding(.horizontal, Spacing.xl)
                .padding(.vertical, Spacing.m)
                .onSubmit {
                    if let first = filtered.first { open(first) }
                }

            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(filtered) { repo in
                        Button {
                            open(repo)
                        } label: {
                            HStack(spacing: Spacing.m) {
                                Image(systemName: "folder")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(Theme.textSecondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(repo.name)
                                        .font(TypeScale.rowTitle)
                                        .foregroundStyle(Theme.textPrimary)
                                    Text(repo.branch.map { "\(repo.location) · \($0)" } ?? repo.location)
                                        .font(TypeScale.caption)
                                        .foregroundStyle(Theme.textTertiary)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if opening == repo.path {
                                    ProgressView().controlSize(.small)
                                }
                            }
                            .padding(.horizontal, Spacing.m)
                            .padding(.vertical, Spacing.s)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressableButtonStyle())
                        .clickable()
                        .disabled(opening != nil)
                    }
                }
                .padding(.horizontal, Spacing.l)
            }
            .scrollEdgesHidden()

            if let errorText {
                Text(errorText)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(Spacing.m)
            }
            Text("Cada conversa ganha a sua branch e a sua pasta. Dá para escrever @nome-do-repo na mensagem também.")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .multilineTextAlignment(.center)
                .padding(Spacing.l)
        }
        .task {
            focused = true
            repos = (try? await model.client.repos()) ?? []
        }
    }

    private func open(_ repo: RepoInfo) {
        guard let store = model.conversation(for: botID) else { return }
        opening = repo.path
        errorText = nil
        Task {
            defer { opening = nil }
            do {
                try await store.openRepository(repo)
                model.dismissSheet()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}
