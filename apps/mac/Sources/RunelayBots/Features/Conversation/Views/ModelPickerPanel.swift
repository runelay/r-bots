import SwiftUI

struct ModelPickerLayer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let bot: Bot

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if model.modelPickerOpen {
                Rectangle()
                    .fill(Theme.maskHidden)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        model.modelPickerOpen = false
                    }
                ModelPickerPanel(bot: bot)
                    .padding(.top, FrameMetrics.stripHeight)
                    .padding(.trailing, bot.hasComputer ? 92 : 54)
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .opacity.combined(with: .scale(scale: 0.95, anchor: .topTrailing))
                    )
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: model.modelPickerOpen)
    }
}

enum ModelFavorites {
    private static let key = "modelPicker.favorites"

    static func load() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    }

    static func save(_ favorites: Set<String>) {
        UserDefaults.standard.set(favorites.sorted(), forKey: key)
    }

    static func key(account: String, model: String) -> String {
        "\(account)|\(model)"
    }
}

struct ModelPickerEntry: Identifiable, Hashable {
    let account: AIAccount
    let model: AccountModel

    var id: String { ModelFavorites.key(account: account.id, model: model.id) }
}

private extension AIAccount {
    var railBadge: String {
        switch runner {
        case "vps": return "VP"
        case "mac": return "MC"
        default:
            let initials = providerTitle
                .split(whereSeparator: { !$0.isLetter })
                .compactMap(\.first)
                .prefix(2)
            return String(initials).uppercased()
        }
    }

    var railTitle: String {
        "\(ModelNames.providerName(provider)) · \(machineLabel)"
    }

    var railHelp: String {
        guard !isReady else { return railTitle }
        let base = "\(railTitle) · \(statusLabel)"
        guard let detail, !detail.isEmpty else { return base }
        return "\(base)\n\(detail)"
    }
}

struct ModelPickerPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let bot: Bot

    @State private var query = ""
    @State private var selection: String?
    @State private var expanded = false
    @State private var highlighted = 0
    @State private var favorites = ModelFavorites.load()
    @FocusState private var searchFocused: Bool
    @Namespace private var railNamespace

    private static let favoritesID = "favorites"
    private static let providerOrder = ["claude", "codex", "grok", "cursor"]
    private static let pageSize = 9
    private static let rowHeight: CGFloat = 32
    private static let maxListHeight: CGFloat = 340
    private static let railWidth: CGFloat = 52

    private var accounts: [AIAccount] {
        guard case .loaded(let list) = model.accounts else { return [] }
        return list.sorted { lhs, rhs in
            let left = Self.providerOrder.firstIndex(of: lhs.provider) ?? Self.providerOrder.count
            let right = Self.providerOrder.firstIndex(of: rhs.provider) ?? Self.providerOrder.count
            if left != right { return left < right }
            if lhs.provider != rhs.provider { return lhs.provider < rhs.provider }
            return lhs.runner == "vps" && rhs.runner != "vps"
        }
    }

    private var currentAccountID: String { bot.engine?.account ?? "vps:claude" }
    private var currentModelID: String? { bot.engine?.model ?? model.meta.model }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces).lowercased() }
    private var isSearching: Bool { !trimmedQuery.isEmpty }

    private var activeSelection: String {
        if let selection { return selection }
        if accounts.contains(where: { $0.id == currentAccountID }) { return currentAccountID }
        return accounts.first?.id ?? Self.favoritesID
    }

    private var selectedAccount: AIAccount? {
        accounts.first { $0.id == activeSelection }
    }

    private var allEntries: [ModelPickerEntry] {
        if isSearching {
            return accounts.filter(\.isReady).flatMap { account in
                account.models
                    .filter { $0.label.lowercased().contains(trimmedQuery) || $0.id.lowercased().contains(trimmedQuery) }
                    .map { ModelPickerEntry(account: account, model: $0) }
            }
        }
        if activeSelection == Self.favoritesID {
            return accounts.flatMap { account in
                account.models
                    .map { ModelPickerEntry(account: account, model: $0) }
                    .filter { favorites.contains($0.id) }
            }
        }
        guard let account = selectedAccount, account.isReady else { return [] }
        return account.models.map { ModelPickerEntry(account: account, model: $0) }
    }

    private var visibleEntries: [ModelPickerEntry] {
        let all = allEntries
        return expanded ? all : Array(all.prefix(Self.pageSize))
    }

    private var showsAccountContext: Bool {
        isSearching || activeSelection == Self.favoritesID
    }

    var body: some View {
        let visible = visibleEntries
        let hiddenCount = allEntries.count - visible.count

        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                if !accounts.isEmpty {
                    rail
                }
                VStack(alignment: .leading, spacing: 0) {
                    searchField(visible: visible, hiddenCount: hiddenCount)
                    listContent(visible: visible, hiddenCount: hiddenCount)
                }
                .frame(maxWidth: .infinity, alignment: .top)
            }
            effortFooter
            fallbackFooter
        }
        .frame(width: 384, alignment: .top)
        .fixedSize(horizontal: false, vertical: true)
        .clipShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .glassSurface(RoundedRectangle(cornerRadius: Radius.large, style: .continuous), fallback: Theme.inspectorBackground)
        .softElevation()
        .background {
            shortcutButtons(visible: visible)
        }
        .onAppear {
            searchFocused = true
            revealCurrent()
            if accounts.isEmpty {
                Task { await model.loadAccounts() }
            }
        }
        .onChange(of: query) {
            expanded = false
            highlighted = 0
        }
        .springAnimation(value: expanded)
    }

    private var rail: some View {
        VStack(spacing: Spacing.xs) {
            AccountRailItem(
                isSelected: activeSelection == Self.favoritesID,
                isDimmed: false,
                help: "Favoritos",
                namespace: railNamespace
            ) {
                selectRail(Self.favoritesID)
            } content: {
                Image(systemName: "star.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(activeSelection == Self.favoritesID ? Theme.attention : Theme.textSecondary)
            }
            ForEach(accounts) { account in
                AccountRailItem(
                    isSelected: activeSelection == account.id,
                    isDimmed: !account.isReady,
                    help: account.railHelp,
                    namespace: railNamespace
                ) {
                    selectRail(account.id)
                } content: {
                    ProviderLogo(provider: account.provider, size: 20)
                        .overlay(alignment: .bottomTrailing) {
                            Text(account.railBadge)
                                .font(.system(size: 7.5, weight: .bold))
                                .foregroundStyle(Theme.textPrimary)
                                .padding(.horizontal, 2.5)
                                .frame(height: 11)
                                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
                                .offset(x: 8, y: 6)
                        }
                }
            }
        }
        .padding(.vertical, Spacing.m)
        .frame(width: Self.railWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.hover)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: activeSelection)
    }

    private func searchField(visible: [ModelPickerEntry], hiddenCount: Int) -> some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
            TextField("Buscar modelos…", text: $query)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .focused($searchFocused)
                .onKeyPress(.upArrow) {
                    moveHighlight(by: -1, count: visible.count, hiddenCount: hiddenCount)
                    return .handled
                }
                .onKeyPress(.downArrow) {
                    moveHighlight(by: 1, count: visible.count, hiddenCount: hiddenCount)
                    return .handled
                }
                .onSubmit {
                    if visible.indices.contains(highlighted) {
                        choose(visible[highlighted])
                    }
                }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 34)
        .glassSurface(Capsule(), interactive: true, fallback: Theme.surfaceRaised)
        .padding(Spacing.m)
    }

    @ViewBuilder
    private func listContent(visible: [ModelPickerEntry], hiddenCount: Int) -> some View {
        if accounts.isEmpty {
            loadingState
        } else if !isSearching, let account = selectedAccount, !account.isReady {
            unavailableState(account)
        } else if visible.isEmpty {
            Text(emptyMessage)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Spacing.l)
                .padding(.top, Spacing.xs)
                .padding(.bottom, Spacing.l)
        } else {
            let rows = visible.count + (hiddenCount > 0 ? 1 : 0)
            let height = min(CGFloat(rows) * Self.rowHeight + Spacing.s, Self.maxListHeight)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(visible.enumerated()), id: \.element.id) { index, entry in
                            ModelPickerRow(
                                entry: entry,
                                showsAccount: showsAccountContext,
                                isCurrent: entry.account.id == currentAccountID && entry.model.id == currentModelID,
                                isHighlighted: index == highlighted,
                                isFavorite: favorites.contains(entry.id),
                                shortcut: index < Self.pageSize ? index + 1 : nil,
                                height: Self.rowHeight,
                                hover: { highlighted = index },
                                toggleFavorite: { toggleFavorite(entry) },
                                select: { choose(entry) }
                            )
                            .id(entry.id)
                        }
                        if hiddenCount > 0 {
                            showMoreButton(hiddenCount)
                        }
                    }
                    .padding(.horizontal, Spacing.s)
                    .padding(.bottom, Spacing.s)
                }
                .scrollEdgesHidden()
                .frame(height: height)
                .onChange(of: highlighted) {
                    guard visible.indices.contains(highlighted) else { return }
                    proxy.scrollTo(visible[highlighted].id)
                }
            }
        }
    }

    private var emptyMessage: String {
        if isSearching { return "Nenhum modelo encontrado." }
        if activeSelection == Self.favoritesID {
            return "Sem favoritos ainda. Passe o mouse num modelo e toque na estrela."
        }
        return "Esta conta não tem modelos."
    }

    private var loadingState: some View {
        HStack(spacing: Spacing.s) {
            if case .failed = model.accounts {
                Text("Não consegui carregar as contas.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                Button("Tentar de novo") {
                    Task { await model.loadAccounts() }
                }
                .buttonStyle(.plain)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.brandText)
                .clickable()
            } else {
                ProgressView()
                    .controlSize(.small)
                Text("Carregando contas…")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.horizontal, Spacing.l)
        .padding(.bottom, Spacing.l)
    }

    private func unavailableState(_ account: AIAccount) -> some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                ProviderLogo(provider: account.provider, size: 16)
                Text(account.railTitle)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                PillLabel(text: account.statusLabel, dot: Theme.textTertiary)
            }
            if let detail = account.detail, !detail.isEmpty {
                Text(detail)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, Spacing.l)
        .padding(.bottom, Spacing.l)
    }

    private func showMoreButton(_ hiddenCount: Int) -> some View {
        Button {
            expanded = true
        } label: {
            HStack(spacing: Spacing.xs) {
                Text("Mostrar mais (\(hiddenCount))")
                    .font(TypeScale.caption)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, Spacing.s)
            .frame(height: Self.rowHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
    }

    @ViewBuilder
    private var effortFooter: some View {
        if let current = model.account(id: currentAccountID), current.supportsEffort {
            HStack(spacing: Spacing.m) {
                Text("Esforço")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize()
                Spacer(minLength: 0)
                ChoicePills(
                    options: EngineEffort.allCases,
                    selection: Binding(
                        get: { EngineEffort(rawValue: bot.engine?.effort ?? "") ?? .medium },
                        set: { effort in
                            model.setEngine(
                                BotEngine(account: currentAccountID, model: currentModelID, effort: effort.rawValue, fallback: bot.engine?.fallback),
                                for: bot
                            )
                        }
                    ),
                    title: \.title
                )
                .fixedSize()
            }
            .padding(.horizontal, Spacing.l)
            .frame(height: 48)
            .background(Theme.hover)
        }
    }

    private func shortcutButtons(visible: [ModelPickerEntry]) -> some View {
        ZStack {
            Button("Fechar") {
                model.modelPickerOpen = false
            }
            .keyboardShortcut(.cancelAction)
            ForEach(Array(visible.prefix(Self.pageSize).enumerated()), id: \.element.id) { index, entry in
                Button(entry.model.label) {
                    choose(entry)
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
            }
        }
        .opacity(0)
        .accessibilityHidden(true)
    }

    private func selectRail(_ id: String) {
        selection = id
        query = ""
        expanded = false
        highlighted = 0
        if id == currentAccountID, let current = currentIndex(in: allEntries) {
            expanded = current >= Self.pageSize
            highlighted = current
        }
    }

    private func revealCurrent() {
        guard let current = currentIndex(in: allEntries) else { return }
        expanded = current >= Self.pageSize
        highlighted = current
    }

    private func currentIndex(in entries: [ModelPickerEntry]) -> Int? {
        entries.firstIndex { $0.account.id == currentAccountID && $0.model.id == currentModelID }
    }

    private func moveHighlight(by step: Int, count: Int, hiddenCount: Int) {
        guard count > 0 else { return }
        let next = highlighted + step
        if next >= count, hiddenCount > 0 {
            expanded = true
            highlighted = next
            return
        }
        highlighted = min(max(next, 0), count - 1)
    }

    private var fallbackChoices: [AIAccount] {
        accounts.filter { $0.isReady && $0.id != currentAccountID }
    }

    private func fallbackName(_ id: String) -> String {
        let provider = id.split(separator: ":").last.map(String.init) ?? id
        let name = provider == "codex" ? "Codex" : ModelNames.providerName(id)
        let runner = id.hasPrefix("mac:") ? "Mac" : "VPS"
        return "\(name) · \(runner)"
    }

    private var fallbackFooter: some View {
        HStack(spacing: Spacing.m) {
            Text("Se acabar o limite, usar")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize()
            Spacer(minLength: 0)
            GlassSelect(
                options: fallbackChoices.map { GlassSelectOption(fallbackName($0.id), value: Optional($0.id)) }
                    + [GlassSelectOption("Não trocar, só avisar", value: String?.none, startsSection: !fallbackChoices.isEmpty)],
                selection: Binding(
                    get: { bot.engine?.fallback?.account },
                    set: { account in
                        setFallback(account.map { EngineFallback(account: $0, model: nil) })
                    }
                ),
                title: bot.engine?.fallback.map { fallbackName($0.account) } ?? "Só avisar",
                help: "Se acabar o limite",
                edge: .trailing
            )
            .help("Quando a conta principal bater no limite, o mesmo pedido continua nesta conta, com o contexto da conversa. Volta sozinho depois do reset.")
        }
        .padding(.horizontal, Spacing.l)
        .frame(height: 44)
        .background(Theme.hover)
    }

    private func setFallback(_ fallback: EngineFallback?) {
        model.setEngine(
            BotEngine(account: currentAccountID, model: currentModelID, effort: bot.engine?.effort, fallback: fallback, sendsFallback: true),
            for: bot
        )
    }

    private func choose(_ entry: ModelPickerEntry) {
        model.setEngine(
            BotEngine(account: entry.account.id, model: entry.model.id, effort: bot.engine?.effort, fallback: bot.engine?.fallback),
            for: bot
        )
        model.modelPickerOpen = false
    }

    private func toggleFavorite(_ entry: ModelPickerEntry) {
        if favorites.contains(entry.id) {
            favorites.remove(entry.id)
        } else {
            favorites.insert(entry.id)
        }
        ModelFavorites.save(favorites)
    }
}

struct AccountRailItem<Content: View>: View {
    let isSelected: Bool
    let isDimmed: Bool
    let help: String
    let namespace: Namespace.ID
    let select: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            content()
                .frame(width: 36, height: 36)
                .background(
                    isSelected ? Theme.selection : isHovering ? Theme.hover : Theme.maskHidden,
                    in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                )
                .opacity(isDimmed ? 0.45 : 1)
                .frame(width: 52, height: 36)
                .overlay(alignment: .leading) {
                    if isSelected {
                        Capsule()
                            .fill(Theme.brandAccent)
                            .frame(width: 3, height: 18)
                            .matchedGeometryEffect(id: "railIndicator", in: namespace)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct ModelPickerRow: View {
    let entry: ModelPickerEntry
    let showsAccount: Bool
    let isCurrent: Bool
    let isHighlighted: Bool
    let isFavorite: Bool
    let shortcut: Int?
    let height: CGFloat
    let hover: () -> Void
    let toggleFavorite: () -> Void
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        HStack(spacing: Spacing.s + 2) {
            ProviderLogo(provider: entry.account.provider, size: 16)
            Text(entry.model.label)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            if showsAccount {
                Text(entry.account.machineLabel)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if isHovering || isFavorite {
                Button(action: toggleFavorite) {
                    Image(systemName: isFavorite ? "star.fill" : "star")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(isFavorite ? Theme.attention : Theme.textTertiary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle())
                .help(isFavorite ? "Tirar dos favoritos" : "Favoritar")
                .transition(.opacity)
            }
            if isCurrent {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.brandText)
            }
            if let shortcut {
                Text("⌘\(shortcut)")
                    .font(TypeScale.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    .frame(minWidth: 22, alignment: .trailing)
            }
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: height)
        .background(
            isHighlighted ? Theme.selection : Theme.maskHidden,
            in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
        )
        .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .onTapGesture(perform: select)
        .clickable()
        .onHover { hovering in
            isHovering = hovering
            if hovering {
                hover()
            }
        }
        .springAnimation(value: isHovering)
        .springAnimation(value: isHighlighted)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(named: Text("Escolher"), select)
    }
}
