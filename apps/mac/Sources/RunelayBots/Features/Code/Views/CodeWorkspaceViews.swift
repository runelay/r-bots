import AppKit
import SwiftUI

struct CodeStrip: View {
    let store: ConversationStore
    let workspace: CodeWorkspace
    let running: Bool
    let openChanges: () -> Void
    @State private var hovering = false
    @State private var showsPopover = false

    var body: some View {
        Button {
            showsPopover.toggle()
        } label: {
            HStack(spacing: Spacing.s) {
                ZStack {
                    if running {
                        ProgressView().controlSize(.mini)
                            .transition(.opacity)
                    } else {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                            .transition(.opacity)
                    }
                }
                .frame(width: 14)
                Text(workspace.repoName)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                if let counts {
                    HStack(spacing: Spacing.xs) {
                        Text("\(counts.files)")
                            .foregroundStyle(Theme.textSecondary)
                        Text("·").foregroundStyle(Theme.textTertiary)
                        ChangeCount(added: counts.added, removed: counts.removed)
                    }
                    .font(TypeScale.counter)
                    .contentTransition(.numericText())
                }
                if let pr = workspace.pr {
                    PullRequestPillBadge(pr: pr)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 28)
            .overlay {
                if running {
                    GlassShimmer()
                        .clipShape(Capsule())
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            .glassSurface(Capsule(), interactive: true, fallback: hovering || showsPopover ? Theme.surfaceRaised : Theme.surface)
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { hovering = $0 }
        .help("\(workspace.repoName) · \(workspace.branch)\(counts.map { " · \($0.files) arquivo\($0.files == 1 ? "" : "s") alterado\($0.files == 1 ? "" : "s")" } ?? "")\(workspace.pr.map { " · " + PullRequestPillBadge(pr: $0).helpText } ?? "")")
        .popover(isPresented: $showsPopover, arrowEdge: .bottom) {
            CodeWorkspacePopover(store: store, workspace: workspace) {
                showsPopover = false
                openChanges()
            } close: {
                showsPopover = false
            }
        }
        .springAnimation(value: workspace.files)
        .springAnimation(value: workspace.added)
        .springAnimation(value: workspace.pr)
        .springAnimation(value: running)
        .frame(maxWidth: .infinity)
        .padding(.top, Spacing.s)
    }

    private var counts: (files: Int, added: Int, removed: Int)? {
        if let pr = workspace.pr, pr.status == .merged || pr.status == .closed {
            return pr.files > 0 ? (pr.files, pr.additions, pr.deletions) : nil
        }
        return workspace.files > 0 ? (workspace.files, workspace.added, workspace.removed) : nil
    }
}

private struct GlassShimmer: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var start = Date()

    var body: some View {
        if reduceMotion {
            Color.clear
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !AppActivity.shared.isLive)) { context in
                GeometryReader { geometry in
                    let period = 1.8
                    let progress = context.date.timeIntervalSince(start).truncatingRemainder(dividingBy: period) / period
                    let width = geometry.size.width
                    LinearGradient(colors: [.clear, Theme.brandAccent.opacity(0.16), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: width * 0.45)
                        .offset(x: -width * 0.45 + (width * 1.45) * progress)
                }
            }
        }
    }
}

struct CodeEditorApp: Identifiable {
    let id: String
    let name: String
    let appURL: URL

    @MainActor
    var icon: NSImage {
        let source = id == "dev.zed.Zed" ? BrandIconStore.shared.icon(slug: "zedindustries")?.image : nil
        let image = (source ?? NSWorkspace.shared.icon(forFile: appURL.path)).copy() as? NSImage ?? NSImage()
        image.size = NSSize(width: 16, height: 16)
        return image
    }

    @MainActor
    static var installed: [CodeEditorApp] {
        [("dev.zed.Zed", "Zed"), ("com.microsoft.VSCode", "VS Code")].compactMap { bundleID, name in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID).map { CodeEditorApp(id: bundleID, name: name, appURL: $0) }
        }
    }

    @MainActor
    func open(absolutePath: String) {
        if id == "dev.zed.Zed" {
            if CodeActions.openInZed(absolutePath: absolutePath) { return }
            if let url = URL(string: "ssh://\(CodeActions.editorHost)\(absolutePath)") {
                NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
            }
        } else {
            CodeActions.openInVSCode(absolutePath: absolutePath)
        }
    }
}

private enum PopoverMetrics {
    static let inset = Spacing.m
    static let row: CGFloat = 30
    static let icon: CGFloat = 16
}

struct CodeWorkspacePopover: View {
    @Environment(AppModel.self) private var model
    let store: ConversationStore
    let workspace: CodeWorkspace
    let openChanges: () -> Void
    let close: () -> Void
    @State private var copied: String?
    @State private var problem: String?

    private var state: CodeState? { store.codeState }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            divider
            PopoverRow(symbol: copied == "branch" ? "checkmark" : "arrow.triangle.branch", title: workspace.branch, mono: true, trailingSymbol: "doc.on.doc") {
                copy(workspace.branch, tag: "branch")
            }
            .help("Copiar o nome da branch\(workspace.base.isEmpty ? "" : " · saiu de \(workspace.base)")")
            divider
            if let pr = workspace.pr {
                PullRequestRow(store: store, pr: pr) {
                    finish(pr)
                }
                divider
            }
            changesRow
            if let server = state?.servers.first, let path = server.previewPath, let url = model.client.previewURL(path: path) {
                PopoverRow(symbol: "safari", title: "Abrir o app", detail: "porta \(server.port)") {
                    NSWorkspace.shared.open(url)
                }
            }
            if let checkpoints = state?.checkpoints.filter({ !($0.request ?? "").isEmpty }), !checkpoints.isEmpty {
                divider
                history(checkpoints)
            }
            divider
            Button {
                if let pr = workspace.pr, pr.status == .merged || pr.status == .closed {
                    finish(pr)
                    return
                }
                Task {
                    try? await store.closeRepository()
                    close()
                }
            } label: {
                Text("Fechar o repositório")
                    .font(workspace.pr?.status == .merged ? TypeScale.captionStrong : TypeScale.caption)
                    .foregroundStyle(workspace.pr?.status == .merged ? Theme.merged : Theme.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, PopoverMetrics.inset)
                    .frame(height: PopoverMetrics.row)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            .help(workspace.pr?.status == .merged || workspace.pr?.status == .closed ? "Remove a worktree. A branch continua no GitHub" : "Sai do repositório nesta conversa. A branch e a pasta continuam guardadas")
            if let problem {
                Text(problem)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, PopoverMetrics.inset)
                    .padding(.bottom, Spacing.xs)
            }
        }
        .padding(.vertical, Spacing.xs)
        .frame(width: 300)
        .springAnimation(value: copied)
        .task {
            await store.refreshCode()
            if workspace.pr != nil {
                await store.refreshPullRequest()
            }
        }
    }

    private func finish(_ pr: PullRequestInfo) {
        let merged = pr.status == .merged
        guard CodeActions.confirm(
            "Fechar o repositório?",
            message: merged ? "O PR #\(pr.number) já foi mergeado. A worktree sai do disco; a branch continua no GitHub." : "O PR #\(pr.number) foi fechado sem merge. A worktree sai do disco; a branch continua no GitHub.",
            action: "Fechar"
        ) else { return }
        problem = nil
        Task {
            do {
                try await store.finishRepository()
                close()
            } catch BotsClient.ClientError.http(_, let message) {
                problem = message ?? "Não consegui fechar o repositório agora."
            } catch {
                problem = "Não consegui fechar o repositório agora."
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Theme.paneDivider)
            .frame(height: 1)
            .padding(.horizontal, PopoverMetrics.inset)
            .padding(.vertical, Spacing.xs)
    }

    private var header: some View {
        HStack(spacing: Spacing.xs) {
            Text(workspace.repoName)
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: Spacing.s)
            RoundIconButton(systemImage: copied == "path" ? "checkmark" : "doc.on.doc", help: "Copiar o caminho", size: 26) {
                copy(workspace.path, tag: "path")
            }
            Menu {
                ForEach(CodeEditorApp.installed) { editor in
                    Button {
                        editor.open(absolutePath: workspace.path)
                    } label: {
                        Label {
                            Text(editor.name)
                        } icon: {
                            Image(nsImage: editor.icon)
                        }
                    }
                }
                Divider()
                Button("Copiar caminho") { copy(workspace.path, tag: "path") }
            } label: {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .clickable()
            .help("Abrir no editor")
        }
        .padding(.leading, PopoverMetrics.inset)
        .padding(.trailing, PopoverMetrics.inset - 5)
        .frame(height: 36)
    }

    private var changesRow: some View {
        let files = workspace.files
        return PopoverRow(
            symbol: "plusminus",
            title: "Mudanças",
            added: files == 0 ? nil : workspace.added,
            removed: files == 0 ? nil : workspace.removed,
            trailingSymbol: "chevron.right",
            action: openChanges
        )
        .disabled(files == 0)
        .help(files == 0 ? "Nada mudou ainda" : "\(files) arquivo\(files == 1 ? "" : "s") · abrir o diff")
    }

    private func history(_ checkpoints: [CodeCheckpoint]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.s) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: PopoverMetrics.icon)
                Text("Histórico")
            }
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textTertiary)
            .padding(.horizontal, PopoverMetrics.inset)
            .frame(height: 26)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(checkpoints.reversed()) { checkpoint in
                        CodeHistoryRow(
                            text: checkpoint.request ?? "",
                            date: checkpoint.at,
                            enabled: store.phase != .working && store.phase != .awaitingInput
                        ) {
                            rewind(checkpoint.turnID)
                        }
                    }
                }
            }
            .frame(maxHeight: 190)
            .fixedSize(horizontal: false, vertical: true)
            .scrollEdgesHidden()
        }
    }

    private func copy(_ text: String, tag: String) {
        CodeActions.copy(text)
        copied = tag
        Task {
            try? await Task.sleep(for: .seconds(1.4))
            if copied == tag { copied = nil }
        }
    }

    private func rewind(_ turnID: String) {
        guard CodeActions.confirm("Voltar para antes deste pedido?", message: "Os arquivos e a conversa voltam para antes dele. O que veio depois também sai.", action: "Voltar") else { return }
        Task { try? await store.rewind(turnID: turnID) }
    }

}

private struct PopoverRow: View {
    let symbol: String
    let title: String
    var detail: String? = nil
    var mono = false
    var added: Int? = nil
    var removed: Int? = nil
    var trailingSymbol: String? = nil
    var rotation: Double = 0
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.s) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: PopoverMetrics.icon)
                Text(title)
                    .font(mono ? TypeScale.monoInline : TypeScale.captionStrong)
                    .foregroundStyle(isEnabled ? Theme.textPrimary : Theme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let detail {
                    Text(detail)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: Spacing.s)
                if let added, let removed {
                    ChangeCount(added: added, removed: removed)
                }
                if let trailingSymbol {
                    Image(systemName: trailingSymbol)
                        .font(.system(size: trailingSymbol.hasPrefix("chevron") ? 8 : 10, weight: .bold))
                        .foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(rotation))
                        .opacity(trailingSymbol.hasPrefix("chevron") || hovering ? 1 : 0)
                }
            }
            .padding(.horizontal, PopoverMetrics.inset)
            .frame(height: PopoverMetrics.row)
            .background(hovering && isEnabled ? Theme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }
}

struct CodeHistoryRow: View {
    let text: String
    let date: Date?
    let enabled: Bool
    let rewind: () -> Void
    @State private var hovering = false

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "pt_BR")
        formatter.unitsStyle = .short
        return formatter
    }()

    var body: some View {
        Button(action: rewind) {
            HStack(spacing: Spacing.s) {
                Text(text.replacingOccurrences(of: "\n", with: " "))
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: Spacing.s)
                ZStack(alignment: .trailing) {
                    if let date {
                        Text(Self.relative.localizedString(for: date, relativeTo: Date()))
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                            .fixedSize()
                            .opacity(hovering && enabled ? 0 : 1)
                    }
                    if hovering && enabled {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.brandText)
                            .transition(.opacity)
                    }
                }
            }
            .padding(.horizontal, PopoverMetrics.inset)
            .frame(height: 28)
            .background(hovering && enabled ? Theme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .disabled(!enabled)
        .onHover { hovering = $0 }
        .help(enabled ? "\(text)\n\nClique para voltar para antes deste pedido" : text)
        .springAnimation(value: hovering)
    }
}

struct ChangeGroup: Identifiable {
    let id: String
    let count: Int
    let added: Int
    let removed: Int

    var name: String { id }

    static func group(_ files: [CodeFileChange]) -> [ChangeGroup] {
        var totals: [String: (count: Int, added: Int, removed: Int)] = [:]
        for file in files {
            let key = file.path.split(separator: "/").first.map(String.init) ?? file.path
            let current = totals[key] ?? (0, 0, 0)
            totals[key] = (current.count + 1, current.added + file.added, current.removed + file.removed)
        }
        let groups = totals.map { key, value in
            ChangeGroup(id: key, count: value.count, added: value.added, removed: value.removed)
        }
        return groups.sorted { $0.added + $0.removed > $1.added + $1.removed }
    }
}

struct CodeChangesView: View {
    @Environment(AppModel.self) private var model
    let botID: String
    @State private var selected: String?
    @State private var diff: CodeEdit?
    @State private var blocks: [DiffBlock] = []
    @State private var tooBig = false
    @State private var loading = false

    private static let maxFiles = 200
    private static let maxLines = 5000

    private var store: ConversationStore? { model.conversation(for: botID) }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let state = store?.codeState, state.workspace != nil {
                HStack(spacing: 0) {
                    fileList(state.files.filter { $0.binary || $0.added + $0.removed > 0 })
                        .frame(width: 240)
                        .background(Theme.panelBackground)
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                Spacer(minLength: 0)
                PanelEmptyState(systemImage: "arrow.triangle.branch", title: "Nenhum repositório aberto", message: "Peça ao bot para mexer num repositório ou use “Trabalhar num repositório…” no +.")
                Spacer(minLength: 0)
            }
        }
        .task {
            await store?.refreshCode()
            let files = (store?.codeState?.files ?? []).filter { !$0.binary && $0.added + $0.removed > 0 }
            let focus = model.codeFocusPath.flatMap { path in files.first { $0.path == path } }
            model.codeFocusPath = nil
            if let focus {
                await select(focus.path)
            } else if !isHuge(files), let first = files.first {
                await select(first.path)
            }
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "plusminus")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
            Text("Mudanças")
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
            if let workspace = store?.codeState?.workspace, workspace.files > 0 {
                ChangeCount(added: workspace.added, removed: workspace.removed)
                    .help("\(workspace.files) arquivo\(workspace.files == 1 ? "" : "s") em \(workspace.repoName) · \(workspace.branch)")
            }
            Spacer(minLength: 0)
            RoundIconButton(systemImage: "xmark", help: "Fechar (Esc)", size: 26) {
                model.dismissSheet()
            }
        }
        .padding(.horizontal, Spacing.l)
        .padding(.top, Spacing.m)
        .padding(.bottom, Spacing.s)
    }

    private func fileList(_ files: [CodeFileChange]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(files) { file in
                    Button {
                        guard !file.binary else { return }
                        Task { await select(file.path) }
                    } label: {
                        HStack(spacing: Spacing.s) {
                            Text((file.path as NSString).lastPathComponent)
                                .font(TypeScale.caption.weight(.medium))
                                .foregroundStyle(file.status == "deleted" || file.binary ? Theme.textTertiary : Theme.textPrimary)
                                .strikethrough(file.status == "deleted")
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .layoutPriority(1)
                            Spacer(minLength: Spacing.xs)
                            if file.binary {
                                Text("binário")
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textTertiary)
                                    .fixedSize()
                            } else {
                                ChangeCount(added: file.added, removed: file.removed)
                                    .fixedSize()
                            }
                        }
                        .padding(.horizontal, Spacing.s)
                        .frame(height: 28)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(selected == file.path ? Theme.selection : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .help(file.statusLabel.isEmpty ? file.path : "\(file.path) · \(file.statusLabel)")
                    .buttonStyle(.plain)
                    .clickable()
                }
                if files.isEmpty {
                    Text("Nada mudou ainda.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(Spacing.m)
                }
            }
            .padding(Spacing.s)
        }
        .scrollEdgesHidden()
    }

    private func isHuge(_ files: [CodeFileChange]) -> Bool {
        files.count > Self.maxFiles || files.reduce(0) { $0 + $1.added + $1.removed } > Self.maxLines
    }

    private func summary(_ files: [CodeFileChange]) -> some View {
        let groups = ChangeGroup.group(files)
        return ScrollView {
            VStack(alignment: .leading, spacing: Spacing.m) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text("\(files.count) arquivos mudaram")
                        .font(TypeScale.sectionTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text("É mudança demais para mostrar tudo de uma vez. Escolha um arquivo na lista para ver o diff dele.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(groups.prefix(40))) { group in
                        HStack(spacing: Spacing.s) {
                            Image(systemName: "folder")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textTertiary)
                            Text(group.name)
                                .font(TypeScale.caption.weight(.medium))
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            Text("\(group.count)")
                                .font(TypeScale.counter)
                                .foregroundStyle(Theme.textTertiary)
                            Spacer(minLength: Spacing.s)
                            ChangeCount(added: group.added, removed: group.removed)
                                .fixedSize()
                        }
                        .frame(height: 26)
                    }
                }
            }
            .padding(Spacing.l)
        }
        .scrollEdgesHidden()
    }

    @ViewBuilder
    private var detail: some View {
        if loading {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let diff {
            VStack(spacing: 0) {
                HStack(spacing: Spacing.s) {
                    FilePathLabel(path: diff.path)
                    ChangeCount(added: diff.added, removed: diff.removed)
                    Spacer(minLength: 0)
                    RoundIconButton(systemImage: "chevron.left.forwardslash.chevron.right", help: "Abrir no editor", size: 26) {
                        openInEditor(diff.path)
                    }
                    RoundIconButton(systemImage: "arrow.uturn.backward", help: "Desfazer arquivo", size: 26) {
                        revert(diff.path)
                    }
                }
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.s)
                if tooBig {
                    VStack(spacing: Spacing.m) {
                        Spacer(minLength: 0)
                        Text("\(diff.added + diff.removed) linhas mudaram neste arquivo")
                            .font(TypeScale.sectionTitle)
                            .foregroundStyle(Theme.textPrimary)
                        Text("Para não travar o app, o diff só aparece se você pedir.")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                        Button("Mostrar mesmo assim") {
                            tooBig = false
                        }
                        .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                        .clickable()
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        DiffBlocksView(blocks: blocks, language: CodeSyntax.language(for: diff.path))
                            .id(diff.path)
                            .padding(.horizontal, Spacing.m)
                            .padding(.bottom, Spacing.l)
                    }
                    .scrollEdgesHidden()
                }
            }
            .transition(.opacity)
        } else if let files = store?.codeState?.files.filter({ $0.binary || $0.added + $0.removed > 0 }), isHuge(files) {
            summary(files)
        } else {
            PanelEmptyState(systemImage: "doc.text.magnifyingglass", title: "Escolha um arquivo", message: "O diff completo aparece aqui.")
        }
    }

    private func select(_ path: String) async {
        guard let store else { return }
        selected = path
        loading = diff == nil
        defer { loading = false }
        let loaded = try? await model.client.fileDiff(botID: botID, sessionID: store.sessionId, path: path)
        guard selected == path else { return }
        guard let loaded else {
            diff = nil
            blocks = []
            return
        }
        let language = CodeSyntax.language(for: loaded.path)
        let built = await Task.detached(priority: .userInitiated) {
            let chunked = CodeDiffLayout.chunked(CodeDiffLayout.blocks(for: loaded), size: 150)
            let preview = chunked.prefix(3).flatMap { block -> [CodeLine] in
                guard case .hunk(_, _, _, let rows) = block else { return [] }
                return rows.compactMap { row in
                    if case .line(let line) = row { return line }
                    return nil
                }
            }
            HighlightCache.shared.prewarm(Array(preview.prefix(400)), language: language)
            return chunked
        }.value
        guard selected == path else { return }
        tooBig = loaded.added + loaded.removed > Self.maxLines
        blocks = built
        diff = loaded
        Task.detached(priority: .utility) {
            let rest = built.dropFirst(3).flatMap { block -> [CodeLine] in
                guard case .hunk(_, _, _, let rows) = block else { return [] }
                return rows.compactMap { row in
                    if case .line(let line) = row { return line }
                    return nil
                }
            }
            HighlightCache.shared.prewarm(Array(rest.prefix(6000)), language: language)
        }
    }

    private func revert(_ path: String) {
        guard let store, CodeActions.confirm("Desfazer \((path as NSString).lastPathComponent)?", message: "O arquivo volta a ser como era antes da tarefa.", action: "Desfazer") else { return }
        Task {
            try? await store.revertFile(path)
            diff = nil
            blocks = []
            if let next = store.codeState?.files.first(where: { !$0.binary && $0.added + $0.removed > 0 }) {
                await select(next.path)
            } else {
                selected = nil
            }
        }
    }

    private func openInEditor(_ path: String) {
        guard let workspace = store?.codeState?.workspace else { return }
        CodeActions.openInEditor(absolutePath: "\(workspace.path)/\(path)")
    }
}
