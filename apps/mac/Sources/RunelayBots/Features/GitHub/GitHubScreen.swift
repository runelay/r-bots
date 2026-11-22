import AppKit
import SwiftUI

struct GitHubScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var searchText = GitHubStore.shared.query

    private var store: GitHubStore { .shared }

    var body: some View {
        HStack(spacing: 0) {
            GitRepoColumn()
                .frame(width: 236)
                .frame(maxHeight: .infinity)
                .background(Theme.sidebarBackground)
            Rectangle().fill(Theme.paneDivider).frame(width: 1)
            GitPullList(searchText: $searchText)
                .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.background)
            Rectangle().fill(Theme.paneDivider).frame(width: 1)
            GitPullInspector()
                .frame(width: 470)
                .frame(maxHeight: .infinity)
                .background(Theme.inspectorBackground)
        }
        .overlay(alignment: .bottom) {
            if let notice = store.notice {
                BoardNoticeView(notice: notice) { store.dismissNotice() }
                    .padding(.bottom, Spacing.xl)
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
                    .id(notice.id)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.notice)
        .background {
            Button("") { Task { await store.load(refresh: true) } }
                .keyboardShortcut("r", modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
            BoardBackShortcuts()
        }
        .task {
            store.attach(model.client)
            if store.phase == .idle || store.items.isEmpty {
                await store.load()
            }
        }
        .task { await store.poll() }
        .task(id: searchText) {
            guard searchText != store.query else { return }
            await store.search(searchText)
        }
    }
}

private struct GitRepoColumn: View {
    private var store: GitHubStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.s) {
                BrandMarkImage(mark: .github, size: 18)
                    .foregroundStyle(Theme.textPrimary)
                    .frame(width: 22, height: 22)
                Text("GitHub")
                    .font(BrandFonts.sans(18, weight: .semibold))
                    .tracking(-0.18)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
                if let viewer = store.viewer {
                    RemoteAvatar(url: viewer.avatarUrl, name: viewer.login, size: 22)
                        .help("Conectado como \(viewer.login)")
                        .transition(.opacity)
                }
            }
            .frame(height: 30)
            .padding(.horizontal, Spacing.l)
            .padding(.top, Spacing.l)
            .padding(.bottom, Spacing.l)

            Text("REPOSITÓRIOS")
                .font(BrandFonts.sans(10.5, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(Theme.textTertiary)
                .padding(.horizontal, Spacing.l)
                .padding(.bottom, Spacing.xs)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    GitRepoRow(title: tr("Todos"), subtitle: nil, avatar: nil, count: store.allCount, isSelected: store.repo == nil) {
                        store.setRepo(nil)
                    }
                    if store.phase == .loading && store.repos.isEmpty {
                        ForEach(0..<5, id: \.self) { _ in
                            HStack(spacing: Spacing.s) {
                                ShimmerBlock(width: 20, height: 20, radius: 6)
                                ShimmerBlock(width: 110, height: 9)
                            }
                            .padding(.horizontal, Spacing.s)
                            .frame(height: 34)
                        }
                    }
                    ForEach(store.repos) { group in
                        GitRepoRow(
                            title: group.shortName,
                            subtitle: group.owner,
                            avatar: group.avatarUrl,
                            count: group.count,
                            isSelected: store.repo == group.name
                        ) {
                            store.setRepo(group.name)
                        }
                    }
                    if let repo = store.repo, !store.repos.contains(where: { $0.name == repo }) {
                        GitRepoRow(title: repo.split(separator: "/").last.map(String.init) ?? repo, subtitle: tr("sem PRs neste filtro"), avatar: nil, count: 0, isSelected: true) {}
                    }
                }
                .padding(.horizontal, Spacing.s)
                .padding(.bottom, Spacing.l)
            }
            .scrollEdgesHidden()
        }
    }
}

private struct GitRepoRow: View {
    let title: String
    let subtitle: String?
    let avatar: String?
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.s) {
                if let avatar {
                    RemoteAvatar(url: avatar, name: subtitle ?? title, size: 20)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                } else {
                    Image(systemName: "square.stack.3d.up")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 20, height: 20)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(BrandFonts.sans(13, weight: isSelected ? .semibold : .medium))
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(1)
                    if let subtitle {
                        Text(subtitle)
                            .font(BrandFonts.sans(10.5))
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if count > 0 {
                    Text("\(count)")
                        .font(TypeScale.counter)
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textTertiary)
                        .contentTransition(.numericText())
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 38)
            .background(isSelected ? Theme.selection : hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: isSelected)
    }
}

private struct GitPullList: View {
    @Binding var searchText: String
    @FocusState private var listFocused: Bool

    private var store: GitHubStore { .shared }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: Spacing.m) {
                HStack(spacing: Spacing.s) {
                    BoardSegment(
                        items: GHFilter.allCases,
                        selection: store.filter,
                        title: { $0.title },
                        count: { store.counts.count($0) },
                        onSelect: { store.setFilter($0) }
                    )
                    Spacer(minLength: Spacing.s)
                    ReviewButton { store.show($0) }
                    BoardIconButton(systemImage: "arrow.clockwise", help: tr("Atualizar (⌘R)"), spinning: store.refreshing) {
                        Task { await store.load(refresh: true) }
                    }
                }
                BoardSearchField(text: $searchText, prompt: tr("Buscar PRs por título, branch ou autor"))
            }
            .padding(.horizontal, Spacing.l)
            .padding(.top, Spacing.l)
            .padding(.bottom, Spacing.m)

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .failed(let message) where store.items.isEmpty:
            BoardInlineNotice(
                systemImage: "exclamationmark.icloud",
                title: tr("Não deu para falar com o GitHub"),
                message: message,
                actionTitle: tr("Tentar de novo")
            ) {
                Task { await store.load(refresh: true) }
            }
        case .loading, .idle:
            ScrollView {
                VStack(spacing: Spacing.xs) {
                    ForEach(0..<7, id: \.self) { _ in GitPullSkeleton() }
                }
                .padding(.horizontal, Spacing.m)
            }
            .scrollDisabled(true)
            .transition(.opacity)
        default:
            if store.items.isEmpty {
                BoardInlineNotice(
                    systemImage: store.query.isEmpty ? "tray" : "magnifyingglass",
                    title: store.query.isEmpty ? store.filter.emptyTitle : tr("Nada encontrado"),
                    message: store.query.isEmpty ? store.filter.emptyMessage : tr("Tente outras palavras ou outro filtro.")
                )
            } else {
                list
            }
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: Spacing.xxs) {
                    ForEach(store.items) { pull in
                        GitPullRow(pull: pull, isSelected: store.selectedKey == pull.key) {
                            store.select(pull)
                            listFocused = true
                        }
                        .id(pull.key)
                    }
                    if store.nextCursor != nil {
                        HStack(spacing: Spacing.s) {
                            ProgressView().controlSize(.small)
                            Text("Carregando mais")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(Spacing.m)
                        .task { await store.loadMore() }
                    } else if store.total > store.items.count {
                        Text("\(store.items.count) de \(store.total)")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .padding(Spacing.m)
                    }
                }
                .padding(.horizontal, Spacing.m)
                .padding(.bottom, Spacing.xl)
            }
            .scrollEdgesHidden()
            .focusable()
            .focusEffectDisabled()
            .focused($listFocused)
            .onKeyPress(.upArrow) {
                store.move(by: -1)
                if let key = store.selectedKey { withAnimation { proxy.scrollTo(key) } }
                return .handled
            }
            .onKeyPress(.downArrow) {
                store.move(by: 1)
                if let key = store.selectedKey { withAnimation { proxy.scrollTo(key) } }
                return .handled
            }
            .onKeyPress(.return) {
                BoardLinks.open(store.selected?.url)
                return .handled
            }
        }
    }
}

private struct GitPullSkeleton: View {
    var body: some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            ShimmerBlock(width: 18, height: 18, radius: 9)
            VStack(alignment: .leading, spacing: Spacing.s) {
                ShimmerBlock(width: 260, height: 11)
                ShimmerBlock(width: 160, height: 9)
                HStack(spacing: Spacing.xs) {
                    ShimmerBlock(width: 56, height: 16, radius: 8)
                    ShimmerBlock(width: 72, height: 16, radius: 8)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Spacing.m)
    }
}

struct GitPullRow: View {
    let pull: GHPull
    let isSelected: Bool
    let action: () -> Void

    @Environment(AppModel.self) private var model
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            Image(systemName: GHStyle.stateSymbol(pull))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(GHStyle.stateColor(pull))
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 6) {
                Text(pull.title)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 5) {
                    Text("\(pull.repoName) #\(pull.number)")
                        .foregroundStyle(Theme.textSecondary)
                    Text("·").foregroundStyle(Theme.textTertiary)
                    Text(pull.head)
                        .font(BrandFonts.mono(11))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("·").foregroundStyle(Theme.textTertiary)
                    Text(BoardDates.relative(pull.mergedAt ?? pull.updatedAt))
                        .foregroundStyle(Theme.textTertiary)
                        .fixedSize()
                }
                .font(TypeScale.caption)
                .lineLimit(1)
                HStack(spacing: 5) {
                    if pull.ci != "none" {
                        BoardChip(text: GHStyle.ciTitle(pull.ci), tint: GHStyle.ciColor(pull.ci), filled: true)
                    }
                    if let review = GHStyle.reviewTitle(pull.review), pull.isOpen {
                        BoardChip(text: review, systemImage: GHStyle.reviewSymbol(pull.review), tint: GHStyle.reviewColor(pull.review), filled: pull.review != "review_required")
                    }
                    if pull.mergeable == "conflicting", pull.isOpen {
                        BoardChip(text: tr("Conflitos"), systemImage: "exclamationmark.triangle", tint: Theme.danger, filled: true)
                    }
                    if let key = pull.linear {
                        LinearKeyChip(identifier: key)
                    }
                    Spacer(minLength: 0)
                    if pull.comments > 0 {
                        HStack(spacing: 3) {
                            Image(systemName: "bubble.left")
                                .font(.system(size: 10, weight: .medium))
                            Text("\(pull.comments)")
                                .font(TypeScale.counter)
                        }
                        .foregroundStyle(Theme.textTertiary)
                    }
                    DiffStat(additions: pull.additions, deletions: pull.deletions)
                    RemoteAvatar(url: pull.author.avatarUrl, name: pull.author.login, size: 18)
                }
            }
        }
        .padding(Spacing.m)
        .background(isSelected ? Theme.selection : hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .onTapGesture(perform: action)
        .clickable()
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: isSelected)
        .contextMenu {
            Button("Abrir no GitHub") { BoardLinks.open(pull.url) }
            Button("Copiar a branch") { GitHubStore.shared.copy(pull.head, notice: tr("Branch copiada")) }
            Button("Copiar o link") { GitHubStore.shared.copy(pull.url, notice: tr("Link copiado")) }
        }
    }
}

struct DiffStat: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(additions)").foregroundStyle(Theme.success)
            Text("−\(deletions)").foregroundStyle(Theme.danger)
        }
        .font(BrandFonts.mono(11))
        .fixedSize()
    }
}

struct LinearKeyChip: View {
    let identifier: String

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        Button {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                LinearStore.shared.focus(identifier: identifier)
                model.closeSettings()
                model.section = .linear
            }
        } label: {
            HStack(spacing: 4) {
                BrandMarkImage(mark: .linear, size: 10)
                    .foregroundStyle(hovering ? BrandMark.linearColor : Theme.textSecondary)
                Text(identifier)
                    .font(BrandFonts.mono(10.5))
            }
            .foregroundStyle(hovering ? Theme.textPrimary : Theme.textSecondary)
            .padding(.horizontal, 7)
            .frame(height: 20)
            .background(hovering ? Theme.selection : Theme.surface, in: Capsule())
            .contentShape(Capsule())
            .fixedSize()
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .help("Abrir \(identifier) no quadro do Linear")
    }
}
