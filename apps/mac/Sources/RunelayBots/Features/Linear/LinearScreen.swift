import AppKit
import SwiftUI

struct LinearScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var searchText = LinearStore.shared.query

    private var store: LinearStore { .shared }

    var body: some View {
        VStack(spacing: 0) {
            LinearHeader(searchText: $searchText)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.background)
        .overlay(alignment: .trailing) {
            if store.selectedID != nil {
                HStack(spacing: 0) {
                    Rectangle().fill(Theme.paneDivider).frame(width: 1)
                    LinearIssueInspector()
                        .frame(maxHeight: .infinity)
                        .background(Theme.inspectorBackground)
                }
                .frame(width: 460)
                .softElevation(lifted: true)
                .transition(Motion.panel(reduceMotion: reduceMotion))
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = store.notice {
                BoardNoticeView(notice: notice) { store.dismissNotice() }
                    .padding(.bottom, Spacing.xl)
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
                    .id(notice.id)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.selectedID)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.notice)
        .background {
            Button("") { Task { await store.load(refresh: true) } }
                .keyboardShortcut("r", modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
            if store.selectedID != nil {
                Button("") { store.select(nil) }
                    .keyboardShortcut(.cancelAction)
                    .disabled(model.launcherPresented)
                    .opacity(0)
                    .accessibilityHidden(true)
            }
            BoardBackShortcuts(escapes: store.selectedID == nil)
        }
        .task {
            store.attach(model.client)
            await store.start()
        }
        .task { await store.poll() }
        .task(id: searchText) {
            guard searchText != store.query else { return }
            await store.search(searchText)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .failed(let message) where store.cards.isEmpty:
            let notConnected = message.localizedCaseInsensitiveContains("conect")
            BoardInlineNotice(
                systemImage: notConnected ? "circle.dashed" : "exclamationmark.icloud",
                title: notConnected ? "O Linear não está conectado" : "Não deu para falar com o Linear",
                message: message,
                actionTitle: notConnected ? "Abrir Conectores" : "Tentar de novo"
            ) {
                if notConnected {
                    model.section = .connectors
                } else {
                    Task {
                        await store.loadViews(refresh: true)
                        await store.load(refresh: true)
                    }
                }
            }
        case .loading, .idle:
            LinearBoardSkeleton()
                .transition(.opacity)
        default:
            if store.cards.isEmpty {
                BoardInlineNotice(
                    systemImage: store.query.isEmpty ? "tray" : "magnifyingglass",
                    title: store.query.isEmpty ? "Nenhuma issue aqui" : "Nada encontrado",
                    message: store.query.isEmpty ? "Essa visão está vazia. Escolha outra no topo." : "Tente outras palavras."
                )
            } else {
                LinearBoardView()
            }
        }
    }
}

private struct LinearHeader: View {
    @Binding var searchText: String

    private var store: LinearStore { .shared }

    var body: some View {
        HStack(spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                BrandMarkImage(mark: .linear, size: 18)
                    .foregroundStyle(BrandMark.linearColor)
                    .frame(width: 22, height: 22)
                Text("Linear")
                    .font(BrandFonts.sans(18, weight: .semibold))
                    .tracking(-0.18)
                    .foregroundStyle(Theme.textPrimary)
            }
            if !store.views.isEmpty {
                Text("/")
                    .font(BrandFonts.sans(16, weight: .regular))
                    .foregroundStyle(Theme.textTertiary)
                viewPicker
            }
            if !store.projectViewActive, !store.projects.isEmpty {
                projectPicker
            }
            if !store.labels.isEmpty {
                labelPicker
            }
            if store.phase == .loaded {
                Text(countText)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .contentTransition(.numericText())
                    .padding(.leading, Spacing.xs)
                    .fixedSize()
            }
            Spacer(minLength: Spacing.m)
            BoardSearchField(text: $searchText, prompt: store.searchable ? "Buscar issues" : "Busca fora de visão salva", isEnabled: store.searchable)
                .frame(maxWidth: 220)
            if store.nextCursor != nil {
                Button {
                    Task { await store.loadMore() }
                } label: {
                    BoardQuietFace(title: "Carregar mais", systemImage: "arrow.down", isBusy: store.loadingMore)
                }
                .buttonStyle(PressableButtonStyle())
            }
            ReviewButton(view: store.viewID, project: store.activeProject) { store.show($0) }
            if let url = store.currentView?.url {
                BoardIconButton(systemImage: "arrow.up.right.square", help: "Abrir no Linear") {
                    BoardLinks.open(url)
                }
            }
            BoardIconButton(systemImage: "arrow.clockwise", help: "Atualizar (⌘R)", spinning: store.refreshing) {
                Task {
                    await store.loadCatalogs()
                    await store.load(refresh: true)
                }
            }
        }
        .padding(.horizontal, Spacing.xl)
        .padding(.top, Spacing.l)
        .padding(.bottom, Spacing.m)
    }

    private var viewPicker: some View {
        GlassMenuButton(help: "Escolher a visão", minWidth: 280, items: { viewItems }) { isOpen in
            BoardQuietFace(
                title: store.currentView?.name ?? "Visão",
                leading: store.currentView.map { AnyView(LinearViewIcon(view: $0, size: 16)) },
                isActive: isOpen,
                showsChevron: true
            )
        }
    }

    private var projectPicker: some View {
        let selected = store.projects.first { $0.id == store.projectFilter }
        return GlassMenuButton(help: "Filtrar por projeto", minWidth: 260, items: { projectItems }) { isOpen in
            BoardQuietFace(
                title: selected?.name ?? "Projeto",
                systemImage: "square.grid.2x2",
                leading: selected.map { AnyView(LinearEntityIcon(icon: $0.icon, color: $0.color, name: $0.name, size: 14)) },
                isActive: isOpen || selected != nil,
                showsChevron: true
            )
        }
    }

    private var labelPicker: some View {
        let selected = store.labelFilter
        return GlassMenuButton(help: "Filtrar por etiqueta", minWidth: 220, items: { labelItems }) { isOpen in
            BoardQuietFace(
                title: selected ?? "Etiqueta",
                systemImage: "tag",
                leading: selected.map { AnyView(Circle().fill(store.labelColor($0) ?? Theme.textTertiary).frame(width: 8, height: 8)) },
                isActive: isOpen || selected != nil,
                showsChevron: true
            )
        }
    }

    private var countText: String {
        let count = store.cards.count
        let base = count == 1 ? "1 issue" : "\(count) issues"
        return store.nextCursor == nil ? base : "\(base) carregadas"
    }

    private var viewItems: [GlassMenuItem] {
        var items: [GlassMenuItem] = []
        var lastKind = ""
        for view in store.views {
            let starts = !items.isEmpty && view.kind != lastKind
            lastKind = view.kind
            items.append(
                GlassMenuItem(
                    view.name,
                    id: view.id,
                    subtitle: view.kind == "view" ? (view.description ?? view.team?.name) : view.kind == "team" ? view.team?.key : view.kind == "project" ? view.description : nil,
                    isOn: view.id == store.viewID,
                    startsSection: starts,
                    leading: AnyView(LinearViewIcon(view: view, size: 16))
                ) {
                    store.choose(view.id)
                }
            )
        }
        return items
    }

    private var projectItems: [GlassMenuItem] {
        [GlassMenuItem("Todos os projetos", id: "all", isOn: store.projectFilter == nil) { store.setProjectFilter(nil) }]
            + store.projects.enumerated().map { index, project in
                GlassMenuItem(
                    project.name,
                    id: project.id,
                    subtitle: project.state,
                    isOn: project.id == store.projectFilter,
                    startsSection: index == 0,
                    leading: AnyView(LinearEntityIcon(icon: project.icon, color: project.color, name: project.name, size: 16))
                ) {
                    store.setProjectFilter(project.id)
                }
            }
    }

    private var labelItems: [GlassMenuItem] {
        [GlassMenuItem("Todas as etiquetas", id: "all", isOn: store.labelFilter == nil) { store.setLabelFilter(nil) }]
            + store.labels.enumerated().map { index, label in
                GlassMenuItem(
                    label.name,
                    id: label.id,
                    isOn: label.name == store.labelFilter,
                    startsSection: index == 0,
                    leading: AnyView(Circle().fill(LinearPalette.color(hex: label.color) ?? Theme.textTertiary).frame(width: 9, height: 9).frame(width: 16))
                ) {
                    store.setLabelFilter(label.name)
                }
            }
    }
}

private struct LinearBoardSkeleton: View {
    var body: some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            ForEach(0..<4, id: \.self) { column in
                VStack(alignment: .leading, spacing: Spacing.s) {
                    ShimmerBlock(width: 110, height: 12)
                        .padding(.bottom, Spacing.xs)
                    ForEach(0..<(4 - column % 2), id: \.self) { _ in
                        VStack(alignment: .leading, spacing: Spacing.s) {
                            ShimmerBlock(width: 54, height: 8)
                            ShimmerBlock(height: 11)
                            ShimmerBlock(width: 150, height: 11)
                            ShimmerBlock(width: 70, height: 16, radius: 8)
                        }
                        .padding(Spacing.m)
                        .background(Theme.hover, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                    }
                    Spacer(minLength: 0)
                }
                .frame(width: 284)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.xl)
    }
}

private struct LinearBoardView: View {
    private var store: LinearStore { .shared }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: Spacing.m) {
                ForEach(store.columns) { column in
                    LinearColumnView(column: column)
                }
            }
            .padding(.horizontal, Spacing.xl)
            .padding(.trailing, store.selectedID == nil ? 0 : 460)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .scrollEdgesHidden()
    }
}

private struct LinearColumnView: View {
    let column: LNColumn

    @State private var targeted = false
    @Environment(\.appReduceMotion) private var reduceMotion

    private var store: LinearStore { .shared }

    var body: some View {
        let cards = store.cards(in: column)
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                StateIcon(type: column.type, name: column.name, size: 13)
                Text(column.name)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text("\(column.count)")
                    .font(TypeScale.counter)
                    .foregroundStyle(Theme.textTertiary)
                    .contentTransition(.numericText())
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 28)
            ScrollView {
                LazyVStack(spacing: Spacing.s) {
                    ForEach(cards) { card in
                        LinearCardView(card: card, isSelected: store.selectedID == card.id)
                            .transition(Motion.insertion(reduceMotion: reduceMotion))
                    }
                    if cards.isEmpty {
                        Text(targeted ? "Solte aqui" : "Vazio")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .frame(maxWidth: .infinity, minHeight: 64)
                    }
                }
                .padding(.bottom, Spacing.xl)
                .animation(Motion.animation(reduceMotion: reduceMotion), value: cards.map(\.id))
            }
            .scrollEdgesHidden()
        }
        .padding(Spacing.xs)
        .frame(width: 284)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(targeted ? Theme.selection : Theme.hover.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.large + 2, style: .continuous))
        .springAnimation(value: targeted)
        .dropDestination(for: String.self) { items, _ in
            guard let id = items.first else { return false }
            Task { await store.move(id, to: column.key) }
            return true
        } isTargeted: { targeted = $0 }
    }
}

private struct LinearCardView: View {
    let card: LNCard
    let isSelected: Bool

    @State private var hovering = false
    @Environment(\.colorScheme) private var colorScheme

    private var store: LinearStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
                HStack(spacing: 6) {
                    Text(card.id)
                        .font(BrandFonts.mono(10.5))
                        .foregroundStyle(Theme.textTertiary)
                    if let team = card.team, let view = store.views.first(where: { $0.kind == "team" && $0.name == team }) {
                        LinearViewIcon(view: view, size: 12)
                            .help(team)
                    }
                    Spacer(minLength: 0)
                    PriorityIcon(priority: card.priority)
                }
                Text(card.title)
                    .font(BrandFonts.sans(13.5, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                BoardFlow(spacing: 5) {
                    if let project = card.project, !store.projectViewActive {
                        LinearProjectTag(name: project, project: store.project(named: project))
                    }
                    ForEach(card.labels.prefix(3), id: \.self) { label in
                        LinearLabelTag(name: label, color: store.labelColor(label), compact: true)
                    }
                    if let estimate = card.estimate {
                        HStack(spacing: 3) {
                            Image(systemName: "triangle")
                                .font(.system(size: 8, weight: .semibold))
                            Text(estimate.formatted())
                                .font(BrandFonts.sans(10.5, weight: .medium))
                        }
                        .foregroundStyle(Theme.textTertiary)
                        .frame(height: 19)
                    }
                    if let pr = card.pr {
                        LinearPullChip(link: pr)
                    }
                }
                HStack(spacing: 6) {
                    StateIcon(type: card.stateType, name: card.state, size: 11)
                    Text(BoardDates.relative(card.updatedAt))
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let assignee = card.assignee {
                        RemoteAvatar(url: nil, name: assignee, size: 18)
                    }
                }
            }
            .padding(Spacing.m)
            .background(cardBackground, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .softElevation(lifted: hovering)
            .contentShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .onTapGesture { store.select(isSelected ? nil : card.id) }
        .clickable()
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: isSelected)
        .draggable(card.id) {
            Text("\(card.id) · \(card.title)")
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .padding(.horizontal, Spacing.m)
                .frame(height: 32)
                .background(Theme.surfaceRaised, in: Capsule())
        }
        .contextMenu {
            Button("Iniciar") { Task { await store.startIssue(card.id) } }
            Button("Atribuir a mim") { Task { await store.assignToMe(card.id) } }
            if let branch = card.branch {
                Button("Copiar a branch") {
                    store.copy(branch)
                    store.show(.success("Branch copiada"))
                }
            }
            Button("Abrir no Linear") { BoardLinks.open(card.url) }
        }
    }

    private var cardBackground: Color {
        if isSelected { return Theme.selection }
        return colorScheme == .dark ? Theme.surface : Theme.background
    }
}

struct LinearPullChip: View {
    let link: LNPullLink

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var hovering = false

    private var tint: Color {
        if link.state == "merged" { return Theme.merged }
        if link.state == "closed" { return Theme.danger }
        if link.draft { return Theme.textTertiary }
        return Theme.success
    }

    var body: some View {
        Button {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                GitHubStore.shared.focus(repo: link.repo, number: link.number)
                model.closeSettings()
                model.section = .git
            }
        } label: {
            HStack(spacing: 4) {
                BrandMarkImage(mark: .github, size: 10)
                    .foregroundStyle(tint)
                Text("#\(link.number)")
                    .font(BrandFonts.mono(10.5))
                    .foregroundStyle(hovering ? Theme.textPrimary : Theme.textSecondary)
                if link.state == "open", link.ci != "none" {
                    BoardDot(color: GHStyle.ciColor(link.ci), size: 5)
                }
            }
            .padding(.horizontal, 7)
            .frame(height: 20)
            .background(hovering ? Theme.selection : tint.opacity(0.12), in: Capsule())
            .contentShape(Capsule())
            .fixedSize()
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .help("\(link.repo) #\(link.number): \(link.title)")
    }
}
