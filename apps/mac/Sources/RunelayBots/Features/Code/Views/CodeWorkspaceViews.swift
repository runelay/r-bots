import AppKit
import SwiftUI

struct CodeStrip: View {
    let store: ConversationStore
    let workspaces: [CodeWorkspace]
    let running: Bool
    let openChanges: (CodeWorkspace) -> Void

    var body: some View {
        Group {
            if workspaces.count > 1 {
                CodeRepoStack(store: store, workspaces: workspaces, running: running, openChanges: openChanges)
                    .transition(.opacity)
            } else if let workspace = workspaces.first {
                CodeRepoPill(store: store, workspace: workspace, running: running) {
                    openChanges(workspace)
                }
                .transition(.opacity.combined(with: .scale(scale: 0.94)))
            }
        }
        .springAnimation(value: workspaces.count > 1)
        .frame(maxWidth: .infinity)
        .padding(.top, Spacing.s)
    }
}

private enum CodePillMetrics {
    static let height: CGFloat = 28
    static let rowPitch: CGFloat = height + Spacing.s
    static let peek: CGFloat = 5
    static let visibleLayers = 3
    static let exitDelay: Duration = .milliseconds(220)
}

private struct CodeRepoPill: View {
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
            CodeRepoPillLabel(workspace: workspace, running: running)
                .codeRepoPillChrome(running: running, lifted: hovering || showsPopover)
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { hovering = $0 }
        .help(CodeRepoPillLabel.helpText(workspace))
        .glassPopup(isPresented: $showsPopover) {
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
    }
}

private struct CodeRepoStack: View {
    let store: ConversationStore
    let workspaces: [CodeWorkspace]
    let running: Bool
    let openChanges: (CodeWorkspace) -> Void
    @Environment(\.appReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool
    @State private var topID: String?
    @State private var hovering = false
    @State private var suppressed = false
    @State private var highlightedID: String?
    @State private var showsPopover = false
    @State private var widths: [String: CGFloat] = [:]
    @State private var exitTask: Task<Void, Never>?

    private var ordered: [CodeWorkspace] {
        let preferred = topID ?? store.codeState?.workspace?.id
        guard let top = workspaces.first(where: { $0.id == preferred }) ?? workspaces.first else { return workspaces }
        return [top] + workspaces.filter { $0.id != top.id }
    }

    private var expanded: Bool {
        (hovering || focused) && !suppressed && !showsPopover
    }

    private var topWidth: CGFloat? {
        ordered.first.flatMap { widths[$0.id] }
    }

    private var columnWidth: CGFloat? {
        let measured = ordered.compactMap { widths[$0.id] }
        return measured.count == ordered.count ? measured.max() : nil
    }

    private var stackHeight: CGFloat {
        let count = ordered.count
        if expanded {
            return CGFloat(count) * CodePillMetrics.rowPitch - Spacing.s
        }
        return CodePillMetrics.height + CGFloat(min(count, CodePillMetrics.visibleLayers) - 1) * CodePillMetrics.peek
    }

    var body: some View {
        let items = ordered
        ZStack(alignment: .top) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, workspace in
                layer(workspace, depth: index, total: items.count)
            }
        }
        .frame(width: expanded ? columnWidth : topWidth, height: stackHeight, alignment: .top)
        .contentShape(Rectangle())
        .background(alignment: .top) {
            Color.clear
                .frame(width: topWidth ?? 0, height: CodePillMetrics.height)
                .allowsHitTesting(false)
                .glassPopup(isPresented: $showsPopover) {
                    if let workspace = items.first {
                        CodeWorkspacePopover(store: store, workspace: workspace) {
                            showsPopover = false
                            openChanges(workspace)
                        } close: {
                            showsPopover = false
                        }
                    }
                }
        }
        .onHover(perform: hover)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onChange(of: focused) { _, isFocused in
            if isFocused {
                suppressed = false
                highlightedID = highlightedID ?? items.first?.id
            } else if !hovering {
                highlightedID = nil
            }
        }
        .onKeyPress(.downArrow) { move(by: 1) }
        .onKeyPress(.upArrow) { move(by: -1) }
        .onKeyPress(.return) {
            guard let id = highlightedID ?? items.first?.id else { return .ignored }
            open(id, fromKeyboard: true)
            return .handled
        }
        .onKeyPress(.escape) {
            guard expanded else { return .ignored }
            suppressed = true
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(items.count) repositórios")
        .springAnimation(value: expanded)
        .springAnimation(value: items.map(\.id))
        .springAnimation(value: highlightedID)
        .springAnimation(value: running)
        .onDisappear { exitTask?.cancel() }
    }

    @ViewBuilder
    private func layer(_ workspace: CodeWorkspace, depth: Int, total: Int) -> some View {
        let hidden = !expanded && depth >= CodePillMetrics.visibleLayers
        let peeking = !expanded && depth > 0
        let falloff = CGFloat(min(depth, CodePillMetrics.visibleLayers - 1))
        let highlighted = expanded && highlightedID == workspace.id
        Button {
            open(workspace.id, fromKeyboard: false)
        } label: {
            HStack(spacing: Spacing.s) {
                CodeRepoPillLabel(workspace: workspace, running: running, padded: false)
                if depth == 0, total > 1 {
                    Text("+\(total - 1)")
                        .font(TypeScale.counter)
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, Spacing.xs + Spacing.xxs)
                        .frame(height: 18)
                        .background(Theme.hover, in: Capsule())
                        .opacity(expanded ? 0 : 1)
                        .help("\(total) repositórios abertos")
                }
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: CodePillMetrics.height)
            .fixedSize()
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.width
            } action: { width in
                widths[workspace.id] = width
            }
            .opacity(peeking ? 0 : 1)
            .frame(width: (expanded ? columnWidth : topWidth) ?? widths[workspace.id])
            .background {
                if highlighted {
                    Capsule().fill(Theme.hover)
                }
            }
            .codeRepoPillChrome(running: running && !peeking, lifted: highlighted || (depth == 0 && showsPopover))
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .help(CodeRepoPillLabel.helpText(workspace))
        .onHover { inside in
            if inside, expanded {
                highlightedID = workspace.id
            }
        }
        .allowsHitTesting(expanded || depth == 0)
        .accessibilityHidden(hidden)
        .scaleEffect(peeking && !reduceMotion ? 1 - 0.05 * falloff : 1, anchor: .top)
        .offset(y: expanded ? CGFloat(depth) * CodePillMetrics.rowPitch : falloff * CodePillMetrics.peek)
        .opacity(hidden ? 0 : peeking ? 1 - 0.28 * falloff : 1)
        .zIndex(Double(total - depth))
    }

    private func hover(_ inside: Bool) {
        exitTask?.cancel()
        if inside {
            if !hovering {
                suppressed = false
            }
            hovering = true
            return
        }
        exitTask = Task { @MainActor in
            try? await Task.sleep(for: CodePillMetrics.exitDelay)
            guard !Task.isCancelled else { return }
            hovering = false
            if !focused {
                highlightedID = nil
            }
        }
    }

    private func move(by step: Int) -> KeyPress.Result {
        let ids = ordered.map(\.id)
        guard !ids.isEmpty else { return .ignored }
        suppressed = false
        let current = highlightedID.flatMap { ids.firstIndex(of: $0) } ?? (step > 0 ? -1 : ids.count)
        highlightedID = ids[(current + step + ids.count) % ids.count]
        return .handled
    }

    private func open(_ id: String, fromKeyboard: Bool) {
        exitTask?.cancel()
        if !fromKeyboard {
            focused = false
        }
        topID = id
        highlightedID = id
        suppressed = true
        showsPopover = true
    }
}

private struct CodeRepoPillLabel: View {
    let workspace: CodeWorkspace
    let running: Bool
    var padded = true

    var body: some View {
        if padded {
            content
                .padding(.horizontal, Spacing.m)
                .frame(height: CodePillMetrics.height)
        } else {
            content
        }
    }

    private var content: some View {
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
            if let counts = Self.counts(workspace) {
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
    }

    static func counts(_ workspace: CodeWorkspace) -> (files: Int, added: Int, removed: Int)? {
        if let pr = workspace.pr, pr.status == .merged || pr.status == .closed {
            return pr.files > 0 ? (pr.files, pr.additions, pr.deletions) : nil
        }
        return workspace.files > 0 ? (workspace.files, workspace.added, workspace.removed) : nil
    }

    static func helpText(_ workspace: CodeWorkspace) -> String {
        let files = counts(workspace).map { " · " + ($0.files == 1 ? tr("1 arquivo alterado") : tr("%lld arquivos alterados", $0.files)) } ?? ""
        let pr = workspace.pr.map { " · " + PullRequestPillBadge(pr: $0).helpText } ?? ""
        return "\(workspace.repoName) · \(workspace.branch)\(files)\(pr)"
    }
}

extension View {
    fileprivate func codeRepoPillChrome(running: Bool, lifted: Bool) -> some View {
        overlay {
            if running {
                GlassShimmer()
                    .clipShape(Capsule())
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .glassSurface(Capsule(), interactive: true, fallback: lifted ? Theme.surfaceRaised : Theme.surface)
        .contentShape(Capsule())
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
        guard !CodeActions.editorHost.isEmpty else {
            CodeActions.copy(absolutePath)
            return
        }
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
            .help(workspace.base.isEmpty ? tr("Copiar o nome da branch") : tr("Copiar o nome da branch · saiu de %@", workspace.base))
            divider
            if let pr = workspace.pr {
                PullRequestRow(store: store, workspaceID: workspace.id, pr: pr) {
                    finish(pr)
                }
                divider
            }
            changesRow
            if let server = workspace.servers.first, let path = server.previewPath, let url = model.client.previewURL(path: path) {
                PopoverRow(symbol: "safari", title: tr("Abrir o app"), detail: tr("porta %lld", server.port)) {
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
                    try? await store.closeRepository(workspaceID: workspace.id)
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
            .help(
                workspace.pr?.status == .merged || workspace.pr?.status == .closed
                    ? "Remove a worktree. A branch continua no GitHub" : "Sai do repositório nesta conversa. A branch e a pasta continuam guardadas")
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
                await store.refreshPullRequest(workspaceID: workspace.id)
            }
        }
    }

    private func finish(_ pr: PullRequestInfo) {
        let merged = pr.status == .merged
        guard
            CodeActions.confirm(
                tr("Fechar o repositório?"),
                message: merged
                    ? tr("O PR #%lld já foi mergeado. A worktree sai do disco; a branch continua no GitHub.", pr.number)
                    : tr("O PR #%lld foi fechado sem merge. A worktree sai do disco; a branch continua no GitHub.", pr.number),
                action: tr("Fechar")
            )
        else { return }
        problem = nil
        Task {
            do {
                try await store.finishRepository(workspaceID: workspace.id)
                close()
            } catch BotsClient.ClientError.http(_, let message) {
                problem = message ?? tr("Não consegui fechar o repositório agora.")
            } catch {
                problem = tr("Não consegui fechar o repositório agora.")
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
            RoundIconButton(systemImage: copied == "path" ? "checkmark" : "doc.on.doc", help: tr("Copiar o caminho"), size: 26) {
                copy(workspace.path, tag: "path")
            }
            GlassMenuIconButton(systemImage: "chevron.left.forwardslash.chevron.right", help: tr("Abrir no editor"), iconSize: 11, size: 26, weight: .semibold, edge: .trailing) {
                CodeEditorApp.installed.map { editor in
                    GlassMenuItem(
                        editor.name,
                        leading: AnyView(Image(nsImage: editor.icon).resizable().frame(width: 18, height: 18))
                    ) {
                        editor.open(absolutePath: workspace.path)
                    }
                } + [
                    GlassMenuItem(tr("Copiar caminho"), systemImage: "doc.on.doc", startsSection: !CodeEditorApp.installed.isEmpty) {
                        copy(workspace.path, tag: "path")
                    }
                ]
            }
        }
        .padding(.leading, PopoverMetrics.inset)
        .padding(.trailing, PopoverMetrics.inset - 5)
        .frame(height: 36)
    }

    private var changesRow: some View {
        let files = workspace.files
        return PopoverRow(
            symbol: "plusminus",
            title: tr("Mudanças"),
            added: files == 0 ? nil : workspace.added,
            removed: files == 0 ? nil : workspace.removed,
            trailingSymbol: "chevron.right",
            action: openChanges
        )
        .disabled(files == 0)
        .help(files == 0 ? "Nada mudou ainda" : files == 1 ? "1 arquivo · abrir o diff" : "\(files) arquivos · abrir o diff")
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
        guard CodeActions.confirm(tr("Voltar para antes deste pedido?"), message: tr("Os arquivos e a conversa voltam para antes dele. O que veio depois também sai."), action: tr("Voltar")) else {
            return
        }
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

    private static var relative: RelativeDateTimeFormatter {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = LanguageStore.shared.locale
        formatter.unitsStyle = .short
        return formatter
    }

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
        .help(enabled ? text + "\n\n" + tr("Clique para voltar para antes deste pedido") : text)
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

    private var workspace: CodeWorkspace? { store?.changesWorkspace }

    private var changes: [CodeFileChange] {
        (workspace?.changes ?? []).filter { $0.binary || $0.added + $0.removed > 0 }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if workspace != nil {
                HStack(spacing: 0) {
                    fileList(changes)
                        .frame(width: 240)
                        .background(Theme.panelBackground)
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                Spacer(minLength: 0)
                PanelEmptyState(
                    systemImage: "arrow.triangle.branch", title: tr("Nenhum repositório aberto"), message: tr("Peça ao bot para mexer num repositório ou use “Trabalhar num repositório…” no +."))
                Spacer(minLength: 0)
            }
        }
        .task {
            await store?.refreshCode()
            if let path = model.codeFocusPath, let store, let state = store.codeState,
                workspace?.changes.contains(where: { $0.path == path }) != true,
                let owner = state.workspaces.first(where: { $0.changes.contains { $0.path == path } })
            {
                store.changesWorkspaceID = owner.id
            }
            await selectFirst(focus: model.codeFocusPath)
            model.codeFocusPath = nil
        }
    }

    private func selectFirst(focus path: String?) async {
        let files = changes.filter { !$0.binary }
        if let path, let focus = files.first(where: { $0.path == path }) {
            await select(focus.path)
        } else if !isHuge(files), let first = files.first {
            await select(first.path)
        } else {
            selected = nil
            diff = nil
            blocks = []
        }
    }

    private func show(_ next: CodeWorkspace) {
        guard let store, next.id != workspace?.id else { return }
        store.changesWorkspaceID = next.id
        selected = nil
        diff = nil
        blocks = []
        Task { await selectFirst(focus: nil) }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "plusminus")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
            Text("Mudanças")
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
            if let workspace, workspace.files > 0 {
                ChangeCount(added: workspace.added, removed: workspace.removed)
                    .help(workspace.files == 1 ? "1 arquivo em \(workspace.repoName) · \(workspace.branch)" : "\(workspace.files) arquivos em \(workspace.repoName) · \(workspace.branch)")
            }
            Spacer(minLength: 0)
            if let all = store?.codeState?.workspaces, all.count > 1 {
                HStack(spacing: 2) {
                    ForEach(all, id: \.id) { item in
                        RepoTab(title: item.repoName, selected: item.id == workspace?.id) {
                            show(item)
                        }
                    }
                }
            }
            RoundIconButton(systemImage: "xmark", help: tr("Fechar (Esc)"), size: 26) {
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
                    RoundIconButton(systemImage: "chevron.left.forwardslash.chevron.right", help: tr("Abrir no editor"), size: 26) {
                        openInEditor(diff.path)
                    }
                    RoundIconButton(systemImage: "arrow.uturn.backward", help: tr("Desfazer arquivo"), size: 26) {
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
        } else if isHuge(changes) {
            summary(changes)
        } else {
            PanelEmptyState(systemImage: "doc.text.magnifyingglass", title: tr("Escolha um arquivo"), message: tr("O diff completo aparece aqui."))
        }
    }

    private func select(_ path: String) async {
        guard let store else { return }
        selected = path
        loading = diff == nil
        defer { loading = false }
        let loaded = try? await model.client.fileDiff(botID: botID, sessionID: store.sessionId, workspaceID: workspace?.id, path: path)
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
        guard let store, CodeActions.confirm(tr("Desfazer %@?", (path as NSString).lastPathComponent), message: tr("O arquivo volta a ser como era antes da tarefa."), action: tr("Desfazer")) else {
            return
        }
        Task {
            try? await store.revertFile(path, workspaceID: workspace?.id)
            diff = nil
            blocks = []
            if let next = changes.first(where: { !$0.binary }) {
                await select(next.path)
            } else {
                selected = nil
            }
        }
    }

    private func openInEditor(_ path: String) {
        guard let workspace else { return }
        CodeActions.openInEditor(absolutePath: "\(workspace.path)/\(path)")
    }
}

private struct RepoTab: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(TypeScale.captionStrong)
                .foregroundStyle(selected ? Theme.textPrimary : Theme.textTertiary)
                .lineLimit(1)
                .padding(.horizontal, Spacing.s)
                .frame(height: 24)
                .background(selected ? Theme.selection : hovering ? Theme.hover : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: selected)
    }
}
