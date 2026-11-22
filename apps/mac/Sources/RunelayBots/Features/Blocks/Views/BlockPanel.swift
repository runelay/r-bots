import SwiftUI

struct BlockStage: View {
    let reserved: CGFloat

    @Environment(\.appReduceMotion) private var reduceMotion

    private var presentation: BlockPresentation { .shared }
    private var center: ArtifactCenter { .shared }

    var body: some View {
        GeometryReader { geometry in
            let available = max(0, geometry.size.width - reserved)
            let fullScreen = presentation.fullScreen
            ZStack(alignment: .trailing) {
                if let ref = center.current, !center.presenting {
                    HStack(spacing: 0) {
                        if !fullScreen {
                            BlockSplitHandle(available: available)
                                .zIndex(1)
                        }
                        Group {
                            if ServerStore.isPaneKind(ref.kind) {
                                Group {
                                    if ref.kind == SideThread.panelKind {
                                        SideThreadPanel(ref: ref)
                                    } else if ref.kind == SimulatorStore.panelKind {
                                        SimulatorPanel(ref: ref)
                                    } else if ref.kind == TestStore.panelKind {
                                        TestPanel(ref: ref)
                                    } else if ref.kind == WebPageStore.panelKind {
                                        WebPagePanel(ref: ref)
                                    } else {
                                        ServerPanel(ref: ref)
                                    }
                                }
                                .id("\(ref.kind)-\(ref.id)")
                                .background { BlockPanelShortcuts() }
                            } else if center.isBlock {
                                BlockPanel(ref: ref)
                            } else {
                                ArtifactPanel(ref: ref)
                                    .background { BlockPanelShortcuts() }
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.background)
                    }
                    .frame(width: fullScreen ? geometry.size.width : presentation.panelWidth(available: available))
                    .transition(Motion.panel(reduceMotion: reduceMotion))
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .trailing)
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: presentation.isOpen)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: presentation.fullScreen)
        .onChange(of: presentation.isOpen) { _, open in
            if !open {
                presentation.exitFullScreen()
            }
        }
    }
}

struct BlockSplitHandle: View {
    let available: CGFloat

    @State private var hovering = false

    private var presentation: BlockPresentation { .shared }

    var body: some View {
        let active = hovering || presentation.dragging
        Rectangle()
            .fill(active ? Theme.textTertiary : Theme.paneDivider)
            .frame(width: active ? 2 : 1)
            .frame(maxHeight: .infinity)
            .overlay {
                Color.clear
                    .frame(width: 10)
                    .contentShape(Rectangle())
                    .pointerStyle(.columnResize)
                    .onHover { hovering = $0 }
                    .gesture(
                        DragGesture(minimumDistance: 1, coordinateSpace: .global)
                            .onChanged { value in
                                presentation.drag(by: value.translation.width, available: available)
                            }
                            .onEnded { _ in
                                presentation.endDrag()
                            }
                    )
            }
            .frame(width: 1)
            .springAnimation(value: active)
            .accessibilityHidden(true)
    }
}

struct BlockPanel: View {
    let ref: ArtifactRef

    private var center: BlockCenter { .shared }
    private var presentation: BlockPresentation { .shared }

    var body: some View {
        VStack(spacing: 0) {
            BlockPanelHeader()
                .zIndex(1)
            Group {
                switch center.route {
                case .files:
                    if let store = center.filesStore {
                        BlockFilesView(store: store)
                            .frame(maxWidth: presentation.fullScreen ? Metrics.transcriptWidth : .infinity)
                    }
                case .note:
                    if let store = center.noteEditor {
                        NoteEditorView(store: store)
                            .id(store.noteID)
                    }
                case .sheet:
                    if let store = center.sheetEditor {
                        SheetEditorView(store: store)
                            .id(store.sheetID)
                    }
                case .agenda:
                    if let store = center.agendaStore {
                        AgendaView(store: store)
                    }
                case nil:
                    Color.clear
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background {
            BlockPanelShortcuts()
        }
    }
}

struct BlockPanelShortcuts: View {
    private var center: BlockCenter { .shared }
    private var presentation: BlockPresentation { .shared }

    var body: some View {
        ZStack {
            Button("Tela cheia") {
                presentation.toggleFullScreen()
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            Button("Voltar") {
                center.goBack()
            }
            .keyboardShortcut("[", modifiers: .command)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct BlockPanelHeader: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingDelete = false

    private var center: BlockCenter { .shared }
    private var presentation: BlockPresentation { .shared }

    var body: some View {
        HStack(spacing: Spacing.xs) {
            if isNote {
                BlockHeaderButton(
                    systemImage: "sidebar.left",
                    help: presentation.treeVisible ? tr("Esconder pastas") : tr("Mostrar pastas"),
                    isActive: presentation.treeVisible,
                    tipEdge: .leading
                ) {
                    presentation.treeVisible.toggle()
                }
                .padding(.trailing, Spacing.xs)
            }
            if let agenda = agendaStore {
                AgendaHeaderControls(store: agenda)
            } else {
                BlockBreadcrumb(folders: folders, title: title)
            }
            Spacer(minLength: Spacing.m)
            if let status {
                Text(status)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.trailing, Spacing.xs)
                    .transition(.opacity)
            }
            if let kind = exportKind {
                exportMenu(kind)
                    .padding(.trailing, Spacing.xs)
            }
            if let agenda = agendaStore {
                AgendaModeSwitch(store: agenda)
                    .padding(.trailing, Spacing.xs)
            }
            BlockHeaderButton(
                systemImage: presentation.fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                help: presentation.fullScreen ? tr("Voltar ao painel  ⇧⌘F") : tr("Tela cheia  ⇧⌘F"),
                isActive: presentation.fullScreen
            ) {
                presentation.toggleFullScreen()
            }
            moreMenu
            BlockHeaderButton(systemImage: "xmark", help: tr("Fechar")) {
                presentation.close()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 44)
        .springAnimation(value: status)
    }

    private var agendaStore: AgendaStore? {
        if case .agenda = center.route { return center.agendaStore }
        return nil
    }

    private var isNote: Bool {
        if case .note = center.route { return true }
        return false
    }

    private var title: String {
        guard let route = center.route else { return "" }
        if case .files = route { return tr("Arquivos") }
        return center.title(for: route)
    }

    private var folders: [String] {
        guard isNote, let folder = center.noteEditor?.note?.folder else { return [] }
        return folder.split(separator: "/").map(String.init)
    }

    private var status: String? {
        if let status = center.status {
            return status
        }
        switch center.route {
        case .note:
            guard let editor = center.noteEditor else { return nil }
            if editor.failed != nil { return tr("Não consegui salvar") }
            if editor.saving || editor.dirty { return tr("Salvando…") }
            if let edited = editor.remoteEditedAt, Date().timeIntervalSince(edited) < 60 { return tr("O bot acabou de editar") }
            return nil
        case .sheet:
            guard let text = center.sheetEditor?.statusText else { return nil }
            return text == tr("Salvo") || text == tr("Planilha") || text.hasPrefix(tr("Aba %@", "")) ? nil : text
        case .agenda:
            guard let agenda = center.agendaStore else { return nil }
            let edited = agenda.remoteEditedAt.map { Date().timeIntervalSince($0) < 60 } ?? false
            return agenda.failed != nil || (!agenda.loading && edited) ? agenda.statusText : nil
        default:
            return nil
        }
    }

    private var exportKind: BlockKind? {
        switch center.route {
        case .note: .note
        case .sheet: .sheet
        default: nil
        }
    }

    private var deletable: (kind: String, id: String)? {
        switch center.route {
        case .note(_, let id): ("notes", id)
        case .sheet(_, let id): ("sheets", id)
        default: nil
        }
    }

    private var deleteTitle: String {
        if case .sheet = center.route { return tr("Apagar esta planilha?") }
        return tr("Apagar esta nota?")
    }

    private func delete() {
        guard let target = deletable, let botID = center.route?.botID else { return }
        let client = model.client
        presentation.close()
        Task {
            do {
                var request = try client.request(path: "/bots/\(botID)/\(target.kind)/\(target.id)")
                request.httpMethod = "DELETE"
                let (_, response) = try await URLSession.shared.data(for: request)
                AuthStore.reportUnauthorized(response)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw BotsClient.ClientError.invalidResponse
                }
            } catch {
                BlockCenter.shared.flash(tr("Não consegui apagar"))
            }
        }
    }

    private var moreMenu: some View {
        GlassMenuButton(edge: .trailing, help: tr("Mais"), items: { moreItems }) { isOpen in
            BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen || confirmingDelete)
        }
        .fixedSize()
        .blockTooltip(tr("Mais"))
        .glassPopup(isPresented: $confirmingDelete, edge: .trailing) {
            GlassConfirm(title: deleteTitle, message: tr("Vai para a lixeira do bot."), confirmTitle: tr("Apagar"), destructive: true) {
                delete()
            }
        }
    }

    private var moreItems: [GlassMenuItem] {
        var items: [GlassMenuItem] = []
        if let botID = center.route?.botID {
            if case .files = center.route {
            } else {
                items.append(
                    GlassMenuItem(tr("Todos os arquivos"), systemImage: "square.stack") {
                        center.navigate(to: .files(botID: botID))
                    })
            }
        }
        if deletable != nil {
            items.append(
                GlassMenuItem(tr("Apagar"), systemImage: "trash", destructive: true) {
                    confirmingDelete = true
                })
        }
        return items
    }

    private func exportMenu(_ kind: BlockKind) -> some View {
        GlassMenuButton(
            edge: .trailing, help: tr("Baixar como arquivo"),
            items: {
                ExportFormat.formats(for: kind).map { format in
                    GlassMenuItem(format.label, systemImage: "arrow.down.doc") {
                        center.export(format: format)
                    }
                }
            }
        ) { _ in
            HStack(spacing: Spacing.xs) {
                if center.exporting {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "arrow.down.to.line")
                        .font(.system(size: 11, weight: .semibold))
                }
                Text("Exportar")
                    .font(TypeScale.captionStrong)
                    .lineLimit(1)
                    .fixedSize()
            }
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, Spacing.m)
            .frame(height: 28)
            .glassSurface(Capsule(), interactive: true)
        }
        .fixedSize()
        .disabled(center.exporting)
        .blockTooltip(tr("Baixar como arquivo"))
    }
}

struct BlockBreadcrumb: View {
    let folders: [String]
    let title: String

    var body: some View {
        HStack(spacing: Spacing.xs) {
            if !folders.isEmpty {
                Text(folders.joined(separator: " › ") + " ›")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Text(title)
                .font(TypeScale.rowSubtitle.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
                .contentTransition(.opacity)
        }
        .help((folders + [title]).joined(separator: " › "))
    }
}

struct BlockHeaderIcon: View {
    let systemImage: String
    let isActive: Bool
    var hovering = false

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 13, weight: .regular))
            .foregroundStyle(isActive || hovering ? Theme.textPrimary : Theme.textSecondary)
            .frame(width: 28, height: 28)
            .background(isActive ? Theme.selection : hovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
    }
}

struct BlockHeaderButton: View {
    let systemImage: String
    let help: String
    var isActive = false
    var tipEdge: HorizontalEdge = .trailing
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            BlockHeaderIcon(systemImage: systemImage, isActive: isActive, hovering: hovering)
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .blockTooltip(help, edge: tipEdge)
        .accessibilityLabel(help)
    }
}

struct BlockTooltip: ViewModifier {
    let text: String
    let edge: HorizontalEdge

    @State private var hovering = false
    @State private var visible = false

    func body(content: Content) -> some View {
        content
            .onHover { hovering = $0 }
            .overlay(alignment: edge == .leading ? .bottomLeading : .bottomTrailing) {
                if visible {
                    Text(text)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Spacing.s)
                        .frame(height: 24)
                        .glassSurface(Capsule(), fallback: Theme.surfaceRaised)
                        .softElevation()
                        .alignmentGuide(.bottom) { dimension in dimension[.top] - Spacing.s }
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            .springAnimation(value: visible)
            .task(id: hovering) {
                guard hovering else {
                    visible = false
                    return
                }
                try? await Task.sleep(for: .milliseconds(550))
                guard !Task.isCancelled else { return }
                visible = true
            }
    }
}

extension View {
    func blockTooltip(_ text: String, edge: HorizontalEdge = .trailing) -> some View {
        modifier(BlockTooltip(text: text, edge: edge))
    }
}

struct BlockFilesView: View {
    @Bindable var store: BlockFilesStore

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(spacing: Spacing.s) {
                PillTabs(tabs: BlockFilesStore.Tab.allCases, selection: $store.tab) { $0.title }
                Spacer(minLength: Spacing.s)
                if store.tab != .agenda {
                    Button {
                        Task {
                            if store.tab == .notes {
                                await store.createNote()
                            } else {
                                await store.createSheet()
                            }
                        }
                    } label: {
                        Label(store.tab == .notes ? "Nova nota" : "Nova planilha", systemImage: "plus")
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.horizontal, Spacing.m)
                            .frame(height: 30)
                            .background(Theme.surface, in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(PressableButtonStyle())
                }
            }
            if store.tab != .agenda {
                BlockSearchField(text: $store.query, prompt: store.tab == .notes ? tr("Buscar nas notas") : tr("Buscar planilhas"))
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Spacing.xxs) {
                    switch store.tab {
                    case .notes:
                        ForEach(store.notes) { note in
                            BlockFileRow(symbol: BlockKind.note.symbol, title: note.title, subtitle: noteSubtitle(note)) {
                                BlockCenter.shared.noteTitleChanged(botID: store.botID, id: note.id, title: note.title)
                                BlockCenter.shared.navigate(to: .note(botID: store.botID, id: note.id))
                            }
                        }
                        if store.notes.isEmpty, !store.loading {
                            PanelEmptyState(
                                systemImage: "doc.text", title: store.query.isEmpty ? tr("Nenhuma nota ainda") : tr("Nada encontrado"),
                                message: store.query.isEmpty ? tr("Peça ao bot para anotar algo ou crie uma nota.") : tr("Tente outras palavras."))
                        }
                    case .sheets:
                        ForEach(store.sheets) { sheet in
                            BlockFileRow(symbol: BlockKind.sheet.symbol, title: sheet.title, subtitle: sheetSubtitle(sheet)) {
                                BlockCenter.shared.noteTitleChanged(botID: store.botID, id: sheet.id, title: sheet.title)
                                BlockCenter.shared.navigate(to: .sheet(botID: store.botID, id: sheet.id))
                            }
                        }
                        if store.sheets.isEmpty, !store.loading {
                            PanelEmptyState(
                                systemImage: "tablecells", title: store.query.isEmpty ? tr("Nenhuma planilha ainda") : tr("Nada encontrado"),
                                message: store.query.isEmpty ? tr("Peça ao bot para montar uma planilha ou crie uma.") : tr("Tente outras palavras."))
                        }
                    case .agenda:
                        BlockFileRow(symbol: BlockKind.agenda.symbol, title: tr("Agenda"), subtitle: tr("Semana com as suas contas do Google")) {
                            BlockCenter.shared.navigate(to: .agenda(botID: store.botID))
                        }
                    }
                    if store.nextCursor != nil {
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity)
                            .padding(Spacing.m)
                            .task { await store.loadMore() }
                    }
                }
            }
            .scrollEdgesHidden()
            if let failed = store.failed {
                Text(failed)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
        .padding(.horizontal, Spacing.l)
        .padding(.bottom, Spacing.l)
    }

    private func noteSubtitle(_ note: NoteSummary) -> String {
        var parts: [String] = []
        if !note.folder.isEmpty {
            parts.append(note.folder.replacingOccurrences(of: "/", with: " › "))
        }
        parts.append(BlockDates.relative(note.updatedAt))
        return parts.joined(separator: " · ")
    }

    private func sheetSubtitle(_ sheet: SheetSummary) -> String {
        let tabs = sheet.tabs.count == 1 ? tr("1 aba") : tr("%lld abas", sheet.tabs.count)
        return "\(tabs) · \(BlockDates.relative(sheet.updatedAt))"
    }
}

struct BlockFileRow: View {
    let symbol: String
    let title: String
    let subtitle: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.m) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 32, height: 32)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(title)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(Spacing.s)
            .background(hovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }
}

struct BlockSearchField: View {
    @Binding var text: String
    let prompt: String

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textTertiary)
                }
                .buttonStyle(.plain)
                .clickable()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 32)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }
}
