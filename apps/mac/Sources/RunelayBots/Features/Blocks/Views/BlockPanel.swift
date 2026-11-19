import SwiftUI

struct BlockDock: View {
    let ref: ArtifactRef

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                BlockPanel(ref: ref)
                    .frame(width: width(for: geometry.size.width))
                    .frame(maxHeight: .infinity)
                    .background(Theme.inspectorBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .softElevation(lifted: true)
            }
            .padding(.top, FrameMetrics.stripHeight + 44 + Spacing.s)
            .padding(.trailing, FrameMetrics.panelInset + Spacing.s)
            .padding(.bottom, FrameMetrics.panelInset + Spacing.s)
        }
    }

    private func width(for total: CGFloat) -> CGFloat {
        let preferred = max(total * 0.54, 600)
        return max(min(preferred, total - 460), min(560, total - 24))
    }
}

struct BlockPanel: View {
    let ref: ArtifactRef

    private var center: BlockCenter { .shared }

    var body: some View {
        VStack(spacing: 0) {
            BlockPanelHeader()
            Group {
                switch center.route {
                case .files:
                    if let store = center.filesStore {
                        BlockFilesView(store: store)
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
    }
}

struct BlockPanelHeader: View {
    private var center: BlockCenter { .shared }

    var body: some View {
        HStack(spacing: Spacing.s) {
            if !center.backStack.isEmpty {
                RoundIconButton(systemImage: "chevron.left", help: "Voltar", size: 28) {
                    center.goBack()
                }
            }
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 30, height: 30)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title)
                    .font(TypeScale.panelTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(caption)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                    .springAnimation(value: caption)
            }
            Spacer(minLength: Spacing.m)
            if let kind = exportKind {
                exportMenu(kind)
            }
            if center.route.map({ if case .files = $0 { return false } else { return true } }) == true, let botID = center.route?.botID {
                RoundIconButton(systemImage: "square.stack", help: "Arquivos do bot", size: 30) {
                    center.navigate(to: .files(botID: botID))
                }
            }
            RoundIconButton(systemImage: "xmark", help: "Fechar", size: 30) {
                ArtifactCenter.shared.close()
            }
        }
        .padding(.horizontal, Spacing.l)
        .frame(height: Metrics.headerHeight)
    }

    private var title: String {
        guard let route = center.route else { return "" }
        return center.title(for: route)
    }

    private var symbol: String {
        switch center.route {
        case .files, nil: "square.stack"
        case .note: BlockKind.note.symbol
        case .sheet: BlockKind.sheet.symbol
        case .agenda: BlockKind.agenda.symbol
        }
    }

    private var caption: String {
        if let status = center.status {
            return status
        }
        switch center.route {
        case .files: return "Notas, planilhas e agenda deste bot"
        case .note: return center.noteEditor?.statusText ?? "Nota"
        case .sheet: return center.sheetEditor?.statusText ?? "Planilha"
        case .agenda: return center.agendaStore?.statusText ?? "Agenda"
        case nil: return ""
        }
    }

    private var exportKind: BlockKind? {
        switch center.route {
        case .note: .note
        case .sheet: .sheet
        default: nil
        }
    }

    private func exportMenu(_ kind: BlockKind) -> some View {
        Menu {
            ForEach(ExportFormat.formats(for: kind)) { format in
                Button(format.label) {
                    center.export(format: format)
                }
            }
        } label: {
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
            .frame(height: 30)
            .glassSurface(Capsule(), interactive: true)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .clickable()
        .disabled(center.exporting)
        .help("Baixar como arquivo")
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
                BlockSearchField(text: $store.query, prompt: store.tab == .notes ? "Buscar nas notas" : "Buscar planilhas")
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
                            PanelEmptyState(systemImage: "doc.text", title: store.query.isEmpty ? "Nenhuma nota ainda" : "Nada encontrado", message: store.query.isEmpty ? "Peça ao bot para anotar algo ou crie uma nota." : "Tente outras palavras.")
                        }
                    case .sheets:
                        ForEach(store.sheets) { sheet in
                            BlockFileRow(symbol: BlockKind.sheet.symbol, title: sheet.title, subtitle: sheetSubtitle(sheet)) {
                                BlockCenter.shared.noteTitleChanged(botID: store.botID, id: sheet.id, title: sheet.title)
                                BlockCenter.shared.navigate(to: .sheet(botID: store.botID, id: sheet.id))
                            }
                        }
                        if store.sheets.isEmpty, !store.loading {
                            PanelEmptyState(systemImage: "tablecells", title: store.query.isEmpty ? "Nenhuma planilha ainda" : "Nada encontrado", message: store.query.isEmpty ? "Peça ao bot para montar uma planilha ou crie uma." : "Tente outras palavras.")
                        }
                    case .agenda:
                        BlockFileRow(symbol: BlockKind.agenda.symbol, title: "Agenda", subtitle: "Semana com as suas contas do Google") {
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
        let tabs = sheet.tabs.count == 1 ? "1 aba" : "\(sheet.tabs.count) abas"
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
