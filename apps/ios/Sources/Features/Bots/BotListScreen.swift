import SwiftUI

struct BotListScreen: View {
    @Environment(AppModel.self) private var model
    @Binding var path: [Route]
    @Binding var showsSettings: Bool
    @State private var creating = false
    @State private var managingServers = false
    @State private var showsShortcuts = false
    @State private var searchOpen = false
    @FocusState private var searchFocused: Bool
    @Namespace private var searchNamespace

    var body: some View {
        content
            .safeAreaInset(edge: .bottom, alignment: .trailing) {
                bottomControls
            }
            .safeAreaInset(edge: .top) {
                if let failure = RunEnvironmentStore.shared.failure {
                    Text(failure)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Spacing.l)
                        .padding(.vertical, Spacing.xs)
                        .transition(.opacity)
                }
            }
            .springAnimation(value: RunEnvironmentStore.shared.failure)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Bots")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showsShortcuts) {
                NavigationStack {
                    ShortcutsScreen()
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("OK") { showsShortcuts = false }
                            }
                        }
                }
                .environment(model)
            }
            .sheet(isPresented: $creating) {
                BotEditorScreen(bot: nil) { created in
                    path.append(.conversation(botID: created.id))
                }
                .environment(model)
            }
            .sheet(isPresented: $managingServers) {
                NavigationStack {
                    ServersScreen()
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("OK") { managingServers = false }
                            }
                        }
                }
                .environment(model)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    RbotsGlyph()
                        .frame(width: 28 * 572 / 592, height: 28)
                        .padding(.trailing, 2)
                        .accessibilityLabel("r/bots")
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .topBarLeading) {
                    ServerSwitcher(managing: $managingServers)
                }
                ToolbarItem(placement: .principal) {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityHidden(true)
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        creating = true
                    } label: {
                        Image(systemName: "plus")
                            .foregroundStyle(Theme.textPrimary)
                    }
                    .accessibilityLabel("Novo bot")
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(Theme.textPrimary)
                    }
                    .accessibilityLabel("Ajustes")
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.listState {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("Sem conexão", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Tentar de novo") {
                    Task { await model.refresh() }
                }
                .buttonStyle(SoftButtonStyle())
            }
        case .loaded:
            if isSearching {
                searchContent
            } else if model.visibleBots.isEmpty {
                ContentUnavailableView("Nenhum bot ainda", systemImage: "person.2", description: Text("Crie bots pelo app do Mac e eles aparecem aqui."))
            } else {
                list
            }
        }
    }

    private var isSearching: Bool {
        !model.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static let floatingSize: CGFloat = 56

    private var bottomControls: some View {
        GlassEffectContainer(spacing: 12) {
            HStack(spacing: 12) {
                if searchOpen {
                    searchCapsule
                } else {
                    searchButton
                    shortcutsButton
                }
            }
        }
        .padding(.leading, searchOpen ? Spacing.l : 0)
        .padding(.trailing, Spacing.l)
        .padding(.bottom, Spacing.s)
    }

    private var searchButton: some View {
        Button(action: openSearch) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .frame(width: Self.floatingSize, height: Self.floatingSize)
                .glassEffect(.regular.interactive(), in: Circle())
                .glassEffectID("search", in: searchNamespace)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Buscar")
    }

    private var searchCapsule: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            TextField("Buscar", text: Bindable(model).searchQuery)
                .font(BrandFonts.sans(17))
                .foregroundStyle(Theme.textPrimary)
                .focused($searchFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onAppear { searchFocused = true }
            Button(action: closeSearch) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 36, height: 36)
                    .background(Theme.textTertiary.opacity(0.18), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fechar busca")
        }
        .padding(.leading, 20)
        .padding(.trailing, 10)
        .frame(maxWidth: .infinity)
        .frame(height: Self.floatingSize)
        .glassEffect(.regular.interactive(), in: Capsule())
        .glassEffectID("search", in: searchNamespace)
        .onChange(of: searchFocused) { _, focused in
            if !focused && !isSearching {
                withAnimation(Motion.spring) { searchOpen = false }
            }
        }
    }

    private var shortcutsButton: some View {
        Button {
            showsShortcuts = true
        } label: {
            GridPlusIcon()
                .scaleEffect(1.2)
                .foregroundStyle(Theme.textPrimary)
                .frame(width: Self.floatingSize, height: Self.floatingSize)
                .glassEffect(.regular.interactive(), in: Circle())
                .glassEffectID("shortcuts", in: searchNamespace)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Atalhos")
        .accessibilityHint("GitHub, Linear, Agenda e mais")
    }

    private func openSearch() {
        withAnimation(Motion.spring) { searchOpen = true }
    }

    private func closeSearch() {
        model.searchQuery = ""
        searchFocused = false
        withAnimation(Motion.spring) { searchOpen = false }
    }

    @ViewBuilder
    private var searchContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                switch model.searchResults {
                case .idle, .loading:
                    HStack(spacing: Spacing.s) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Buscando…")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    .padding(Spacing.l)
                case .failed(let message):
                    Text(message)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(Spacing.l)
                case .loaded(let found):
                    BotListSectionHeader(title: tr("Resultados"))
                    if found.isEmpty {
                        Text("Nenhum bot com esse nome.")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .padding(.horizontal, Spacing.l)
                    } else {
                        ForEach(found) { bot in
                            let current = model.bot(id: bot.id) ?? bot
                            Button {
                                path.append(.conversation(botID: current.id))
                            } label: {
                                BotRow(bot: current)
                            }
                            .buttonStyle(RowButtonStyle())
                            .padding(.horizontal, Spacing.l)
                            .padding(.vertical, Spacing.s)
                        }
                    }
                }
            }
            .padding(.bottom, Spacing.l)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var items: [BotListItem] {
        var taken: Set<String> = []
        var result: [BotListItem] = []

        func add(_ title: String, _ bots: [Bot], section: BotSection? = nil) {
            let fresh = bots.filter { !taken.contains($0.id) }
            guard !fresh.isEmpty else { return }
            fresh.forEach { taken.insert($0.id) }
            result.append(.header(title, section))
            for bot in fresh {
                result.append(.bot(bot))
                guard model.showsConversations(bot), !model.collapsedBots.contains(bot.id) else { continue }
                let children = model.conversationTree(for: bot.id)
                let lastRoot = children.lastIndex { $0.depth == 0 } ?? 0
                for (index, entry) in children.enumerated() {
                    result.append(.conversation(bot, entry.conversation, index >= lastRoot, entry.depth))
                }
            }
        }

        if model.groupBySection {
            add(tr("Fixados"), model.pinnedBots)
            for section in model.activeSections {
                add(section.name, model.visibleBots.filter { $0.sectionId == section.id }, section: section)
            }
        }
        add(tr("Todos"), model.visibleBots)
        return result
    }

    private var list: some View {
        let entries = items
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(entries) { item in
                    switch item {
                    case .header(let title, _):
                        BotListSectionHeader(title: title)
                    case .bot(let bot):
                        botItem(bot)
                    case .conversation(let bot, let conversation, let isLast, let depth):
                        conversationItem(bot, conversation, isLast: isLast, depth: depth)
                    }
                }
            }
            .padding(.bottom, Spacing.l)
            .springAnimation(value: entries.map(\.id))
        }
        .refreshable {
            await model.refresh()
        }
    }

    @ViewBuilder
    private func botItem(_ bot: Bot) -> some View {
        if model.showsConversations(bot) {
            let collapsed = model.collapsedBots.contains(bot.id)
            HStack(spacing: 0) {
                Button {
                    openLatest(bot)
                } label: {
                    if collapsed {
                        BotRow(bot: bot)
                            .padding(.vertical, Spacing.s)
                    } else {
                        BotConversationHeader(bot: bot)
                    }
                }
                .buttonStyle(RowButtonStyle())
                Button {
                    withAnimation(Motion.spring) {
                        model.toggleCollapsed(bot.id)
                    }
                } label: {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .frame(width: 36, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityLabel(collapsed ? "Mostrar conversas" : "Recolher conversas")
            }
            .padding(.leading, Spacing.l)
            .padding(.trailing, Spacing.xs)
            .overlay(alignment: .topLeading) {
                if !collapsed {
                    BotTreeGuide(
                        top: (BotTree.headerHeight + BotTree.avatarSize) / 2 + 3,
                        bottom: BotTree.headerHeight
                    )
                }
            }
            .transition(.opacity)
        } else {
            Button {
                path.append(.conversation(botID: bot.id))
            } label: {
                BotRow(bot: bot)
            }
            .buttonStyle(RowButtonStyle())
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.s)
            .transition(.opacity)
        }
    }

    private func conversationItem(_ bot: Bot, _ conversation: BotConversation, isLast: Bool, depth: Int) -> some View {
        let childCount = model.childThreadCount(of: conversation)
        return ConversationTreeRow(
            conversation: conversation,
            provider: ModelNames.provider(bot.engine?.account ?? "vps:claude"),
            status: model.status(of: conversation),
            unread: conversation.unread,
            isLast: isLast,
            depth: depth,
            childCount: childCount,
            childrenCollapsed: model.collapsedThreads.contains(conversation.sessionId),
            toggleChildren: childCount == 0
                ? nil
                : {
                    withAnimation(Motion.spring) {
                        model.toggleThreadChildren(conversation)
                    }
                }
        ) {
            path.append(.conversation(botID: bot.id, sessionID: conversation.sessionId))
        }
        .transition(.opacity)
    }

    private func openLatest(_ bot: Bot) {
        path.append(.conversation(botID: bot.id, sessionID: model.latestConversation(for: bot.id)?.sessionId))
    }
}

enum BotListItem: Identifiable {
    case header(String, BotSection?)
    case bot(Bot)
    case conversation(Bot, BotConversation, Bool, Int)

    var id: String {
        switch self {
        case .header(let title, let section): "header-\(section?.id ?? title)"
        case .bot(let bot): "bot-\(bot.id)"
        case .conversation(_, let conversation, _, _): "conversation-\(conversation.sessionId)"
        }
    }
}

enum BotTree {
    static let avatarSize: CGFloat = 44
    static let guideX: CGFloat = Spacing.l + avatarSize / 2
    static let pillX: CGFloat = guideX + 11
    static let nestStep: CGFloat = 16
    static let iconWidth: CGFloat = 14
    static let headerHeight: CGFloat = 68
    static let rowHeight: CGFloat = 44
}

struct BotListSectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(TypeScale.sectionCaption)
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.l)
            .padding(.top, Spacing.m)
            .padding(.bottom, Spacing.xs)
            .accessibilityAddTraits(.isHeader)
    }
}

struct BotTreeGuide: View {
    let top: CGFloat
    let bottom: CGFloat

    var body: some View {
        Rectangle()
            .fill(Theme.textTertiary.opacity(0.4))
            .frame(width: 1.2, height: max(0, bottom - top))
            .offset(x: BotTree.guideX - 0.6, y: top)
            .allowsHitTesting(false)
    }
}

struct BotConversationHeader: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    var body: some View {
        let count = model.conversations(for: bot.id).count
        HStack(spacing: Spacing.m + 2) {
            BotAvatar(bot: bot, mood: model.mood(for: bot.id), size: BotTree.avatarSize)
            VStack(alignment: .leading, spacing: 3) {
                Text(bot.name)
                    .font(BrandFonts.sans(16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(count == 1 ? "1 conversa" : "\(count) conversas")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
            if bot.pinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textTertiary)
            }
            Spacer(minLength: Spacing.xs)
        }
        .frame(height: BotTree.headerHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct ConversationTreeRow: View {
    let conversation: BotConversation
    let provider: String
    let status: BotStatus
    let unread: Int
    let isLast: Bool
    var depth = 0
    var childCount = 0
    var childrenCollapsed = false
    var toggleChildren: (() -> Void)? = nil
    let select: () -> Void

    private var displayTitle: String {
        var title = conversation.title
        while title.hasPrefix("↳") {
            title = String(title.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        return title.isEmpty ? conversation.title : title
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: select) {
                HStack(spacing: Spacing.s) {
                    if depth > 0 {
                        Text("↳")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    ConversationStateIcon(status: status, provider: provider)
                    Text(displayTitle)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(unread > 0 ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if conversation.repoName != nil {
                        Image(systemName: "chevron.left.forwardslash.chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                            .accessibilityLabel(conversation.repoName ?? "")
                    }
                    Spacer(minLength: Spacing.xs)
                    if childrenCollapsed && childCount > 0 {
                        Text("+\(childCount)")
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)")
                            .font(TypeScale.counter)
                            .foregroundStyle(Theme.onAccent)
                            .contentTransition(.numericText(value: Double(unread)))
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Theme.brandAccent, in: Capsule())
                            .transition(.scale(scale: 0.4).combined(with: .opacity))
                    } else if let date = conversation.activityDate {
                        Text(ShortStamp.label(for: date, now: Date()))
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .padding(.leading, Spacing.s)
                .frame(height: BotTree.rowHeight)
                .contentShape(Rectangle())
                .accessibilityElement(children: .combine)
            }
            .buttonStyle(RowButtonStyle())
            if let toggleChildren {
                Button(action: toggleChildren) {
                    Image(systemName: childrenCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .frame(width: 32, height: BotTree.rowHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityLabel(childrenCollapsed ? "Mostrar secundárias" : "Recolher secundárias")
            }
        }
        .padding(.leading, BotTree.pillX + CGFloat(depth) * BotTree.nestStep)
        .padding(.trailing, toggleChildren == nil ? Spacing.l : Spacing.xs)
        .overlay(alignment: .topLeading) {
            ConversationBranch(isLast: isLast, nested: depth > 0)
        }
        .springAnimation(value: unread)
        .springAnimation(value: status)
    }
}

struct ConversationStateIcon: View {
    let status: BotStatus
    let provider: String

    var body: some View {
        ZStack {
            if status == .working {
                BreathingLogo(provider: provider)
            } else {
                ProviderLogo(provider: provider, size: BotTree.iconWidth)
                    .opacity(status == .idle ? 0.75 : 1)
            }
            switch status {
            case .awaitingApproval:
                Circle()
                    .fill(Theme.attention)
                    .frame(width: 6, height: 6)
                    .offset(x: 6, y: -6)
                    .transition(.scale.combined(with: .opacity))
            case .error:
                Circle()
                    .fill(Theme.danger)
                    .frame(width: 6, height: 6)
                    .offset(x: 6, y: -6)
                    .transition(.scale.combined(with: .opacity))
            default:
                EmptyView()
            }
        }
        .frame(width: BotTree.iconWidth, height: BotTree.iconWidth)
        .accessibilityLabel(status == .idle ? "" : status.label)
    }
}

struct ConversationBranch: View {
    let isLast: Bool
    var nested = false

    var body: some View {
        let x = BotTree.guideX
        let height = BotTree.rowHeight
        let mid = height / 2
        let end = BotTree.pillX - 2
        let radius: CGFloat = 7
        Path { path in
            if nested {
                if !isLast {
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: height))
                }
                return
            }
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: mid - radius))
            path.addQuadCurve(to: CGPoint(x: x + radius, y: mid), control: CGPoint(x: x, y: mid))
            path.addLine(to: CGPoint(x: max(end, x + radius), y: mid))
            if !isLast {
                path.move(to: CGPoint(x: x, y: mid - radius))
                path.addLine(to: CGPoint(x: x, y: height))
            }
        }
        .stroke(Theme.textTertiary.opacity(0.4), style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
        .frame(width: BotTree.pillX, height: height, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}

private struct BreathingLogo: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let provider: String
    @State private var bright = false

    var body: some View {
        ProviderLogo(provider: provider, size: BotTree.iconWidth)
            .opacity(reduceMotion ? 1 : (bright ? 1 : 0.35))
            .scaleEffect(reduceMotion ? 1 : (bright ? 1 : 0.88))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    bright = true
                }
            }
    }
}

struct BotRow: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    var body: some View {
        let status = model.status(for: bot.id)
        let unread = model.unread(for: bot)
        let activity = model.activity(for: bot)
        HStack(spacing: Spacing.m + 2) {
            BotAvatar(bot: bot, mood: model.mood(for: bot.id), size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                    Text(bot.name)
                        .font(BrandFonts.sans(16, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.s)
                    if let date = activity?.date {
                        Text(ShortStamp.label(for: date, now: Date()))
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(unread > 0 ? Theme.brandText : Theme.textTertiary)
                    }
                }
                HStack(alignment: .center, spacing: Spacing.s) {
                    subtitle(status: status, activity: activity)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)")
                            .font(TypeScale.counter)
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 6)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(Theme.brandAccent, in: Capsule())
                            .transition(.scale.combined(with: .opacity))
                    }
                }
            }
        }
        .padding(.vertical, Spacing.xs)
        .contentShape(Rectangle())
        .animation(Motion.spring, value: status)
        .animation(Motion.spring, value: unread)
    }

    @ViewBuilder
    private func subtitle(status: BotStatus, activity: ThreadActivity?) -> some View {
        switch status {
        case .working:
            StatusText(text: tr("Trabalhando…"), color: Theme.brandText)
        case .awaitingApproval:
            StatusText(text: tr("Precisa de você"), color: Theme.attention)
        case .error:
            StatusText(text: tr("Algo deu errado"), color: Theme.danger)
        case .idle:
            if let activity {
                Text(preview(activity))
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
            } else {
                Text(bot.role.isEmpty ? tr("Sem mensagens ainda") : bot.role)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
        }
    }

    private func preview(_ activity: ThreadActivity) -> String {
        let flat = activity.text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return activity.isUser ? tr("Você: %@", flat) : flat
    }
}

struct StatusText: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(text)
                .font(BrandFonts.sans(14, weight: .medium))
                .foregroundStyle(color)
                .lineLimit(1)
        }
    }
}

struct GridPlusIcon: View {
    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 6.5
            let gap: CGFloat = 2.5
            let total = cell * 2 + gap
            let origin = CGPoint(x: (size.width - total) / 2, y: (size.height - total) / 2)
            let stroke = StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
            for (column, row) in [(0, 0), (1, 0), (0, 1)] {
                let rect = CGRect(
                    x: origin.x + CGFloat(column) * (cell + gap),
                    y: origin.y + CGFloat(row) * (cell + gap),
                    width: cell,
                    height: cell
                )
                context.stroke(Path(roundedRect: rect, cornerRadius: 1.8, style: .continuous), with: .foreground, style: stroke)
            }
            let center = CGPoint(x: origin.x + cell + gap + cell / 2, y: origin.y + cell + gap + cell / 2)
            var plus = Path()
            plus.move(to: CGPoint(x: center.x - cell / 2, y: center.y))
            plus.addLine(to: CGPoint(x: center.x + cell / 2, y: center.y))
            plus.move(to: CGPoint(x: center.x, y: center.y - cell / 2))
            plus.addLine(to: CGPoint(x: center.x, y: center.y + cell / 2))
            context.stroke(plus, with: .foreground, style: stroke)
        }
        .frame(width: 18, height: 18)
    }
}
