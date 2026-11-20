import AppKit
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch model.bots {
            case .idle, .loading:
                SidebarHeader()
                VStack(spacing: Spacing.xs) {
                    ForEach(0..<4, id: \.self) { index in
                        SkeletonRow(width: CGFloat(150 - (index % 3) * 24))
                    }
                }
                .padding(.horizontal, Spacing.s)
                Spacer(minLength: 0)
            case .failed(let message):
                SidebarHeader()
                LoadFailedView(message: message) {
                    reload()
                }
            case .loaded:
                BotChatList()
            }
        }
        .bottomBar {
            VStack(spacing: 0) {
                SidebarFooter()
                SidebarAccountBar()
            }
        }
    }

    private func reload() {
        Task {
            await model.loadBots()
        }
    }
}

struct SidebarHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            ServerProfileSwitcher()
                .padding(.horizontal, -Spacing.xs)
            searchRow
        }
        .padding(.horizontal, Spacing.m)
        .padding(.top, Spacing.m)
        .padding(.bottom, Spacing.s)
    }

    private var searchRow: some View {
        HStack(spacing: Spacing.xs + 2) {
            HStack(spacing: Spacing.s) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textTertiary)
                TextField("Buscar", text: Bindable(model).searchQuery)
                    .textFieldStyle(.plain)
                    .font(TypeScale.rowSubtitle)
                    .onKeyPress(.escape) {
                        guard !model.searchQuery.isEmpty else { return .ignored }
                        model.searchQuery = ""
                        return .handled
                    }
                if !model.searchQuery.isEmpty {
                    Button {
                        model.searchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textTertiary)
                    }
                    .buttonStyle(PressableButtonStyle())
                    .help("Limpar busca")
                }
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 32)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small + 1, style: .continuous))

            FloatingMenuButton(id: .sidebarFilter, systemImage: "line.3.horizontal.decrease", help: "Filtrar")
            FloatingMenuButton(id: .sidebarNew, systemImage: "plus", help: "Novo bot ou grupo", iconSize: 15)
        }
    }
}

enum SidebarItem: Identifiable {
    case header(String, Int?, Bool, BotSection?)
    case bot(Bot)
    case conversation(Bot, BotConversation, Bool)

    var id: String {
        switch self {
        case .header(let title, _, _, let section): "header-\(section?.id ?? title)"
        case .bot(let bot): "bot-\(bot.id)"
        case .conversation(_, let conversation, _): "conversation-\(conversation.sessionId)"
        }
    }
}

struct BotChatList: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    @State private var renamingBotID: String?
    @State private var renameText = ""
    @State private var deleting: Bot?
    @State private var newSectionFor: Bot?
    @State private var newSectionName = ""
    @State private var renamingSection: BotSection?
    @State private var sectionName = ""
    @State private var renamingConversationID: String?
    @State private var conversationTitle = ""

    private var items: [SidebarItem] {
        var taken: Set<String> = []
        var result: [SidebarItem] = []

        func add(_ title: String, _ bots: [Bot], count: Int?, highlight: Bool, section: BotSection? = nil) {
            let fresh = bots.filter { !taken.contains($0.id) }
            guard !fresh.isEmpty else { return }
            fresh.forEach { taken.insert($0.id) }
            result.append(.header(title, count.map { _ in fresh.count }, highlight, section))
            for bot in fresh {
                result.append(.bot(bot))
                guard model.showsConversations(bot), !model.collapsedBots.contains(bot.id) else { continue }
                let children = model.conversations(for: bot.id)
                for (index, conversation) in children.enumerated() {
                    result.append(.conversation(bot, conversation, index == children.count - 1))
                }
            }
        }

        if model.groupBySection {
            add("Fixados", model.pinnedBots, count: nil, highlight: false)
            for section in model.activeSections {
                add(section.name, model.visibleBots.filter { $0.sectionId == section.id }, count: nil, highlight: false, section: section)
            }
        }
        add("Todos", model.visibleBots, count: nil, highlight: false)
        return result
    }

    var body: some View {
        let list = items
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if model.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                    ForEach(list) { item in
                        switch item {
                        case .header(let title, let count, let highlight, let section):
                            ListSectionHeader(title: title, count: count, highlight: highlight)
                                .contextMenu {
                                    if let section {
                                        Button {
                                            sectionName = section.name
                                            renamingSection = section
                                        } label: {
                                            Label("Renomear seção", systemImage: "pencil")
                                        }
                                        Button {
                                            model.archiveSection(section)
                                        } label: {
                                            Label("Arquivar seção", systemImage: "archivebox")
                                        }
                                    }
                                }
                                .transition(.opacity)
                        case .bot(let bot):
                            if model.showsConversations(bot) && !model.collapsedBots.contains(bot.id) {
                                header(bot)
                            } else {
                                row(bot)
                            }
                        case .conversation(let bot, let conversation, let isLast):
                            conversationRow(bot, conversation, isLast: isLast)
                        }
                    }
                } else {
                    searchContent
                }
            }
            .padding(.horizontal, Spacing.s)
            .padding(.bottom, Spacing.l)
            .springAnimation(value: list.map(\.id))
        }
        .topBar {
            SidebarHeader()
        }
        .confirmationDialog(
            "Excluir \(deleting?.name ?? "bot")?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
        ) {
            Button("Excluir", role: .destructive) {
                if let deleting {
                    model.deleteBot(deleting)
                }
                deleting = nil
            }
            Button("Cancelar", role: .cancel) {
                deleting = nil
            }
        } message: {
            Text("Dá para restaurar em Configurações › Bots.")
        }
        .alert("Nova seção", isPresented: Binding(get: { newSectionFor != nil }, set: { if !$0 { newSectionFor = nil } })) {
            TextField("Nome da seção", text: $newSectionName)
            Button("Criar") {
                model.createSection(named: newSectionName, moving: newSectionFor)
                newSectionFor = nil
            }
            Button("Cancelar", role: .cancel) {
                newSectionFor = nil
            }
        }
        .alert("Renomear seção", isPresented: Binding(get: { renamingSection != nil }, set: { if !$0 { renamingSection = nil } })) {
            TextField("Nome da seção", text: $sectionName)
            Button("Salvar") {
                if let renamingSection {
                    model.renameSection(renamingSection, to: sectionName)
                }
                renamingSection = nil
            }
            Button("Cancelar", role: .cancel) {
                renamingSection = nil
            }
        }
    }

    @ViewBuilder
    private var searchContent: some View {
        switch model.searchResults {
        case .idle, .loading:
            HStack(spacing: Spacing.s) {
                ProgressView()
                    .controlSize(.small)
                Text("Buscando…")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
            .padding(Spacing.m)
        case .failed(let message):
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .padding(Spacing.m)
        case .loaded(let found):
            ListSectionHeader(title: "Resultados", count: found.count, highlight: false)
            if found.isEmpty {
                Text("Nenhum bot com esse nome.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.horizontal, Spacing.m)
            } else {
                ForEach(found) { bot in
                    row(model.bot(id: bot.id) ?? bot)
                }
            }
        }
    }

    private func row(_ bot: Bot) -> some View {
        BotChatRow(
            bot: bot,
            mood: model.mood(for: bot.id),
            status: model.status(for: bot.id),
            activity: model.activity(for: bot),
            unread: model.unread(for: bot),
            isSelected: model.selectedBotID == bot.id,
            isRenaming: renamingBotID == bot.id,
            renameText: $renameText,
            commitRename: {
                model.renameBot(bot, to: renameText)
                renamingBotID = nil
            },
            cancelRename: {
                renamingBotID = nil
            },
            onNewConversation: bot.isGroup || bot.isPending ? nil : {
                model.newConversation(in: bot.id)
            },
            collapse: collapseAction(for: bot)
        ) {
            model.openFromSidebar(newTab: NSEvent.modifierFlags.contains(.command)) {
                model.selectBot(bot.id)
            }
        }
        .onHover { hovering in
            if hovering {
                model.ensureThread(for: bot.id)
            }
        }
        .contextMenu {
            menu(for: bot)
        }
        .overlay {
            MiddleClickArea {
                model.openFromSidebar(newTab: true) {
                    model.selectBot(bot.id)
                }
            }
        }
        .transition(.opacity)
    }

    private func header(_ bot: Bot) -> some View {
        let collapsed = model.collapsedBots.contains(bot.id)
        let count = model.conversations(for: bot.id).count
        return BotConversationHeader(
            bot: bot,
            subtitle: count == 1 ? "1 conversa" : "\(count) conversas",
            mood: model.mood(for: bot.id),
            status: model.status(for: bot.id),
            unread: model.unread(for: bot),
            isSelected: model.selectedBotID == bot.id && (collapsed || model.isDraft(bot.id)),
            isCollapsed: collapsed,
            isRenaming: renamingBotID == bot.id,
            renameText: $renameText,
            commitRename: {
                model.renameBot(bot, to: renameText)
                renamingBotID = nil
            },
            cancelRename: {
                renamingBotID = nil
            },
            onNewConversation: {
                model.newConversation(in: bot.id)
            },
            toggleCollapse: {
                if model.collapsedBots.contains(bot.id) {
                    model.collapsedBots.remove(bot.id)
                } else {
                    model.collapsedBots.insert(bot.id)
                }
            }
        ) {
            model.openFromSidebar(newTab: NSEvent.modifierFlags.contains(.command)) {
                model.openLatestConversation(bot.id)
            }
        }
        .contextMenu {
            menu(for: bot)
        }
        .overlay {
            MiddleClickArea {
                model.openFromSidebar(newTab: true) {
                    model.openLatestConversation(bot.id)
                }
            }
        }
        .transition(.opacity)
    }

    private func collapseAction(for bot: Bot) -> (Bool, () -> Void)? {
        guard model.showsConversations(bot) else { return nil }
        let collapsed = model.collapsedBots.contains(bot.id)
        let toggle: () -> Void = {
            if model.collapsedBots.contains(bot.id) {
                model.collapsedBots.remove(bot.id)
            } else {
                model.collapsedBots.insert(bot.id)
            }
        }
        return (collapsed, toggle)
    }

    private func conversationRow(_ bot: Bot, _ conversation: BotConversation, isLast: Bool) -> some View {
        ConversationRow(
            conversation: conversation,
            provider: ModelNames.provider(bot.engine?.account ?? "vps:claude"),
            status: model.conversationStatus(conversation),
            unread: model.conversationUnread(conversation),
            isSelected: model.selectedBotID == bot.id && model.activeConversationID(for: bot.id) == conversation.sessionId,
            isLast: isLast,
            isRenaming: renamingConversationID == conversation.sessionId,
            renameText: $conversationTitle,
            commitRename: {
                model.renameConversation(conversation, to: conversationTitle)
                renamingConversationID = nil
            },
            cancelRename: {
                renamingConversationID = nil
            },
            startRename: {
                conversationTitle = conversation.title
                renamingConversationID = conversation.sessionId
            },
            archive: conversation.isMain ? nil : {
                model.archiveConversation(conversation)
            }
        ) {
            model.openFromSidebar(newTab: NSEvent.modifierFlags.contains(.command)) {
                model.selectConversation(botID: bot.id, sessionID: conversation.sessionId)
            }
        }
        .onHover { hovering in
            if hovering {
                model.prefetchConversation(botID: bot.id, sessionID: conversation.sessionId)
            }
        }
        .contextMenu {
            conversationMenu(bot, conversation)
        }
        .overlay {
            MiddleClickArea {
                model.openFromSidebar(newTab: true) {
                    model.selectConversation(botID: bot.id, sessionID: conversation.sessionId)
                }
            }
        }
        .transition(.opacity)
    }

    @ViewBuilder
    private func conversationMenu(_ bot: Bot, _ conversation: BotConversation) -> some View {
        Button {
            conversationTitle = conversation.title
            renamingConversationID = conversation.sessionId
        } label: {
            Label("Renomear", systemImage: "pencil")
        }
        Button {
            model.markConversationUnread(conversation)
        } label: {
            Label("Marcar como não lida", systemImage: "bell.badge")
        }
        if !conversation.isMain {
            Menu {
                ForEach(model.loadedBots.filter { $0.id != bot.id && !$0.isPending && !$0.isGroup }) { target in
                    Button(target.name) {
                        model.moveConversation(conversation, to: target.id)
                    }
                }
            } label: {
                Label("Mover para…", systemImage: "arrow.right.square")
            }
            Divider()
            Button {
                model.archiveConversation(conversation)
            } label: {
                Label("Arquivar", systemImage: "archivebox")
            }
        }
    }

    @ViewBuilder
    private func menu(for bot: Bot) -> some View {
        Button("Abrir em nova aba") {
            model.open(bot.id, placement: .new)
        }
        Divider()
        if bot.isGroup {
            groupMenu(for: bot)
        } else {
            botMenu(for: bot)
        }
    }

    @ViewBuilder
    private func groupMenu(for bot: Bot) -> some View {
        Button {
            renameText = bot.name
            renamingBotID = bot.id
        } label: {
            Label("Renomear", systemImage: "pencil")
        }
        Button {
            model.openGroupEditor(for: bot)
        } label: {
            Label("Membros…", systemImage: "person.2")
        }
        Divider()
        Button {
            model.setPinned(!bot.pinned, for: bot)
        } label: {
            Label(bot.pinned ? "Desafixar" : "Fixar", systemImage: bot.pinned ? "pin.slash" : "pin")
        }
        moveMenu(for: bot)
        Divider()
        Button {
            model.setHidden(true, for: bot)
        } label: {
            Label("Ocultar da barra lateral", systemImage: "eye.slash")
        }
        Divider()
        Button(role: .destructive) {
            model.archiveGroup(bot)
        } label: {
            Label("Arquivar", systemImage: "archivebox")
        }
    }

    @ViewBuilder
    private func moveMenu(for bot: Bot) -> some View {
        Menu {
            ForEach(model.activeSections) { section in
                Button {
                    model.move(bot, to: section.id)
                } label: {
                    Label(section.name, systemImage: "folder")
                }
                .disabled(bot.sectionId == section.id)
            }
            Button {
                newSectionName = ""
                newSectionFor = bot
            } label: {
                Label("Nova seção…", systemImage: "folder.badge.plus")
            }
            Button {
                model.move(bot, to: nil)
            } label: {
                Label("Sem seção", systemImage: "tray")
            }
            .disabled(bot.sectionId == nil)
        } label: {
            Label("Mover para", systemImage: "folder")
        }
    }

    @ViewBuilder
    private func botMenu(for bot: Bot) -> some View {
        Button {
            model.setPinned(!bot.pinned, for: bot)
        } label: {
            Label(bot.pinned ? "Desafixar" : "Fixar", systemImage: bot.pinned ? "pin.slash" : "pin")
        }
        Menu {
            ForEach(model.activeSections) { section in
                Button {
                    model.move(bot, to: section.id)
                } label: {
                    Label(section.name, systemImage: "folder")
                }
                .disabled(bot.sectionId == section.id)
            }
            Button {
                newSectionName = ""
                newSectionFor = bot
            } label: {
                Label("Nova seção…", systemImage: "folder.badge.plus")
            }
            Button {
                model.move(bot, to: nil)
            } label: {
                Label("Sem seção", systemImage: "tray")
            }
            .disabled(bot.sectionId == nil)
        } label: {
            Label("Mover para", systemImage: "folder")
        }
        Button {
            model.markUnread(bot)
        } label: {
            Label("Marcar como não lido", systemImage: "bell.badge")
        }
        .disabled(model.selectedBotID == bot.id)
        Button {
            openWindow(value: bot.id)
        } label: {
            Label("Nova janela", systemImage: "macwindow.badge.plus")
        }
        Divider()
        Button {
            renameText = bot.name
            renamingBotID = bot.id
        } label: {
            Label("Renomear bot", systemImage: "pencil")
        }
        Divider()
        Button {
            model.copyThreadID(of: bot)
        } label: {
            Label("Copiar ID da conversa", systemImage: "doc.on.doc")
        }
        if model.canClearConversation(bot) {
            Button {
                model.clearConversation(bot)
            } label: {
                Label("Limpar conversa", systemImage: "eraser")
            }
        }
        Divider()
        Button {
            model.setHidden(true, for: bot)
        } label: {
            Label("Ocultar da barra lateral", systemImage: "eye.slash")
        }
        Divider()
        Button(role: .destructive) {
            deleting = bot
        } label: {
            Label("Excluir", systemImage: "trash")
        }
    }
}

struct ListSectionHeader: View {
    let title: String
    let count: Int?
    let highlight: Bool

    var body: some View {
        HStack(spacing: Spacing.s) {
            Text(title)
                .font(TypeScale.sectionCaption)
                .foregroundStyle(Theme.textSecondary)
            if let count, count > 0 {
                Text("\(count)")
                    .font(TypeScale.counter)
                    .foregroundStyle(highlight ? Theme.onAccent : Theme.textSecondary)
                    .contentTransition(.numericText(value: Double(count)))
                    .padding(.horizontal, 6)
                    .frame(minWidth: 18, minHeight: 18)
                    .background(highlight ? Theme.attention : Theme.surfaceRaised, in: Capsule())
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.m)
        .padding(.top, Spacing.m)
        .padding(.bottom, Spacing.xs)
        .accessibilityAddTraits(.isHeader)
    }
}

struct BotChatRow: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    let mood: CharacterMood
    let status: BotStatus
    let activity: ThreadActivity?
    let unread: Int
    let isSelected: Bool
    var isRenaming = false
    var renameText: Binding<String> = .constant("")
    var commitRename: () -> Void = {}
    var cancelRename: () -> Void = {}
    var onNewConversation: (() -> Void)? = nil
    var collapse: (Bool, () -> Void)? = nil
    let select: () -> Void

    @State private var isHovering = false
    @FocusState private var renameFocused: Bool

    private var showsActions: Bool {
        isHovering && !isRenaming && (onNewConversation != nil || collapse != nil)
    }

    var body: some View {
        Button(action: select) {
            HStack(spacing: Spacing.m) {
                RowAvatar(bot: bot, mood: status == .working && mood == .idle ? .thinking : mood, members: model.members(of: bot))
                    .overlay(alignment: .bottomTrailing) {
                        StatusBadge(status: status)
                            .offset(x: 4, y: 4)
                    }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .center, spacing: Spacing.s - 2) {
                        if isRenaming {
                            TextField("Nome do bot", text: renameText)
                                .textFieldStyle(.plain)
                                .font(TypeScale.rowTitle)
                                .focused($renameFocused)
                                .onSubmit(commitRename)
                                .onExitCommand(perform: cancelRename)
                                .onAppear {
                                    renameFocused = true
                                }
                        } else {
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: Spacing.s - 2) {
                                    nameText
                                    if showsRole {
                                        RoleTag(text: bot.role)
                                            .fixedSize()
                                    }
                                    if bot.pinned {
                                        Image(systemName: "pin.fill")
                                            .font(.system(size: 9))
                                            .foregroundStyle(Theme.textTertiary)
                                    }
                                }
                                nameText
                            }
                        }
                        Spacer(minLength: 0)
                        if let date = activity?.date {
                            Text(ShortStamp.label(for: date, now: Date()))
                                .font(TypeScale.caption)
                                .monospacedDigit()
                                .foregroundStyle(unread > 0 ? Theme.brandText : Theme.textTertiary)
                                .layoutPriority(1)
                                .opacity(showsActions ? 0 : 1)
                        }
                    }
                    HStack(spacing: Spacing.s) {
                        Text(previewText)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if unread > 0 {
                            Text(unread > 99 ? "99+" : "\(unread)")
                                .font(TypeScale.counter)
                                .foregroundStyle(Theme.onAccent)
                                .contentTransition(.numericText(value: Double(unread)))
                                .padding(.horizontal, 6)
                                .frame(minWidth: 20, minHeight: 20)
                                .background(Theme.brandAccent, in: Capsule())
                                .transition(.scale(scale: 0.4).combined(with: .opacity))
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 64)
            .modifier(RowSurface(isSelected: isSelected, isHovering: isHovering))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .overlay(alignment: .topTrailing) {
            if showsActions {
                HStack(spacing: 0) {
                    if let collapse {
                        RowActionButton(systemImage: collapse.0 ? "chevron.right" : "chevron.down", help: collapse.0 ? "Mostrar conversas" : "Recolher conversas", action: collapse.1)
                    }
                    if let onNewConversation {
                        RowActionButton(systemImage: "plus", help: "Nova conversa (⌘N)", action: onNewConversation)
                    }
                }
                .padding(.top, Spacing.s + 1)
                .padding(.trailing, Spacing.s)
                .transition(.opacity)
            }
        }
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isSelected)
        .springAnimation(value: isHovering)
        .springAnimation(value: unread)
        .springAnimation(value: status)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var previewText: String {
        if bot.isPending {
            return "Criando…"
        }
        switch mood {
        case .thinking: return "pensando…"
        case .speaking: return "escrevendo…"
        case .waiting: return "Aguardando sua resposta"
        default: break
        }
        guard let activity else { return "Sem mensagens ainda" }
        let line = activity.text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return activity.isUser ? "Você: \(line)" : line
    }

    private var showsRole: Bool {
        let role = bot.role.trimmingCharacters(in: .whitespaces)
        return !role.isEmpty && role.lowercased() != bot.name.lowercased()
    }

    private var nameText: some View {
        Text(bot.name)
            .font(TypeScale.rowTitle)
            .foregroundStyle(Theme.textPrimary)
            .lineLimit(1)
            .fixedSize()
    }
}

struct RowActionButton: View {
    let systemImage: String
    let help: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 22, height: 22)
                .background(isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small - 2, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { isHovering = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

enum ConversationTree {
    static let avatarSize: CGFloat = 40
    static let guideX: CGFloat = Spacing.m + avatarSize / 2
    static let textX: CGFloat = Spacing.m + avatarSize + Spacing.s + 2
    static let iconWidth: CGFloat = 12
    static let iconGap: CGFloat = Spacing.s - 2
    static let pillX: CGFloat = guideX + 11
    static let headerHeight: CGFloat = 56
    static let rowHeight: CGFloat = 30
    static let rowGap: CGFloat = 2
}

struct ConversationGuide: View {
    let top: CGFloat
    let bottom: CGFloat

    var body: some View {
        Rectangle()
            .fill(Theme.textTertiary.opacity(0.4))
            .frame(width: 1.2, height: max(0, bottom - top))
            .offset(x: ConversationTree.guideX - 0.5, y: top)
            .allowsHitTesting(false)
    }
}

struct BotConversationHeader: View {
    let bot: Bot
    var subtitle: String = ""
    let mood: CharacterMood
    let status: BotStatus
    let unread: Int
    let isSelected: Bool
    let isCollapsed: Bool
    var isRenaming = false
    var renameText: Binding<String> = .constant("")
    var commitRename: () -> Void = {}
    var cancelRename: () -> Void = {}
    let onNewConversation: () -> Void
    let toggleCollapse: () -> Void
    let select: () -> Void

    @State private var isHovering = false
    @FocusState private var renameFocused: Bool

    private var showsActions: Bool {
        isHovering && !isRenaming
    }

    var body: some View {
        Button(action: select) {
            HStack(spacing: Spacing.s + 2) {
                BotCharacter(bot: bot, mood: status == .working && mood == .idle ? .thinking : mood, size: ConversationTree.avatarSize)
                    .overlay(alignment: .bottomTrailing) {
                        if isCollapsed {
                            StatusBadge(status: status)
                                .scaleEffect(0.7)
                                .offset(x: 5, y: 5)
                        }
                    }
                if isRenaming {
                    TextField("Nome do bot", text: renameText)
                        .textFieldStyle(.plain)
                        .font(TypeScale.rowTitle)
                        .focused($renameFocused)
                        .onSubmit(commitRename)
                        .onExitCommand(perform: cancelRename)
                        .onAppear { renameFocused = true }
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: Spacing.s - 2) {
                            Text(bot.name)
                                .font(TypeScale.rowTitle)
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                                .layoutPriority(1)
                            if !bot.role.isEmpty && bot.role.lowercased() != bot.name.lowercased() {
                                RoleTag(text: bot.role)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
                        Text(subtitle)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                    }
                }
                if bot.pinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(Theme.textTertiary)
                }
                Spacer(minLength: Spacing.xs)
                if isCollapsed && unread > 0 && !showsActions {
                    Text(unread > 99 ? "99+" : "\(unread)")
                        .font(TypeScale.counter)
                        .foregroundStyle(Theme.onAccent)
                        .contentTransition(.numericText(value: Double(unread)))
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Theme.brandAccent, in: Capsule())
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .padding(.leading, Spacing.m)
            .padding(.trailing, showsActions ? 60 : Spacing.s)
            .frame(height: ConversationTree.headerHeight)
            .modifier(RowSurface(isSelected: isSelected, isHovering: isHovering))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .overlay(alignment: .trailing) {
            if showsActions {
                HStack(spacing: 0) {
                    RowActionButton(systemImage: "plus", help: "Nova conversa (⌘N)", action: onNewConversation)
                    RowActionButton(systemImage: isCollapsed ? "chevron.right" : "chevron.down", help: isCollapsed ? "Mostrar conversas" : "Recolher conversas", action: toggleCollapse)
                }
                .padding(.trailing, Spacing.xs + 2)
                .transition(.opacity)
            }
        }
        .overlay(alignment: .topLeading) {
            if !isCollapsed {
                ConversationGuide(
                    top: (ConversationTree.headerHeight + ConversationTree.avatarSize) / 2 + 3,
                    bottom: ConversationTree.headerHeight + ConversationTree.rowGap
                )
            }
        }
        .onHover { isHovering = $0 }
        .springAnimation(value: isSelected)
        .springAnimation(value: isHovering)
        .springAnimation(value: unread)
        .springAnimation(value: status)
        .help(bot.name)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct ConversationRow: View {
    let conversation: BotConversation
    let provider: String
    let status: BotStatus
    let unread: Int
    let isSelected: Bool
    let isLast: Bool
    var isRenaming = false
    var renameText: Binding<String> = .constant("")
    var commitRename: () -> Void = {}
    var cancelRename: () -> Void = {}
    var startRename: () -> Void = {}
    var archive: (() -> Void)? = nil
    let select: () -> Void

    @State private var isHovering = false
    @FocusState private var renameFocused: Bool

    private var showsActions: Bool {
        isHovering && !isRenaming
    }

    var body: some View {
        Button(action: select) {
            HStack(spacing: ConversationTree.iconGap) {
                ConversationStateIcon(status: status, provider: provider)
                if isRenaming {
                    TextField("Nome da conversa", text: renameText)
                        .textFieldStyle(.plain)
                        .font(TypeScale.rowSubtitle)
                        .focused($renameFocused)
                        .onSubmit(commitRename)
                        .onExitCommand(perform: cancelRename)
                        .onAppear { renameFocused = true }
                } else {
                    Text(conversation.title)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if conversation.repoName != nil && !isRenaming {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .help(conversation.repoName ?? "")
                }
                Spacer(minLength: Spacing.xs)
                if !showsActions {
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
            }
            .padding(.leading, Spacing.s)
            .padding(.trailing, Spacing.s)
            .frame(height: ConversationTree.rowHeight)
            .background(
                isSelected ? Theme.selection : isHovering ? Theme.hover : Theme.maskHidden,
                in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .padding(.leading, ConversationTree.pillX)
        }
        .buttonStyle(.plain)
        .clickable()
        .overlay(alignment: .trailing) {
            if showsActions {
                HStack(spacing: 0) {
                    RowActionButton(systemImage: "pencil", help: "Renomear", action: startRename)
                    if let archive {
                        RowActionButton(systemImage: "archivebox", help: "Arquivar", action: archive)
                    }
                }
                .padding(.trailing, Spacing.xs)
                .transition(.opacity)
            }
        }
        .overlay(alignment: .topLeading) {
            ConversationBranch(isLast: isLast)
        }
        .onHover { isHovering = $0 }
        .springAnimation(value: isSelected)
        .springAnimation(value: isHovering)
        .springAnimation(value: unread)
        .springAnimation(value: status)
        .help(conversation.delegatedByName.map { "Pedido de \($0)" } ?? conversation.title)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
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
                ProviderLogo(provider: provider, size: ConversationTree.iconWidth)
                    .opacity(status == .idle ? 0.75 : 1)
            }
            switch status {
            case .awaitingApproval:
                Circle()
                    .fill(Theme.attention)
                    .frame(width: 5, height: 5)
                    .offset(x: 5, y: -5)
                    .transition(.scale.combined(with: .opacity))
            default:
                EmptyView()
            }
        }
        .frame(width: ConversationTree.iconWidth, height: ConversationTree.iconWidth)
        .accessibilityLabel(status == .idle ? "" : status.label)
    }
}

struct ConversationBranch: View {
    let isLast: Bool

    var body: some View {
        let x = ConversationTree.guideX
        let mid = ConversationTree.rowHeight / 2
        let end = ConversationTree.pillX - 2
        let radius: CGFloat = 7
        Path { path in
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: mid - radius))
            path.addQuadCurve(to: CGPoint(x: x + radius, y: mid), control: CGPoint(x: x, y: mid))
            path.addLine(to: CGPoint(x: max(end, x + radius), y: mid))
            if !isLast {
                path.move(to: CGPoint(x: x, y: mid - radius))
                path.addLine(to: CGPoint(x: x, y: ConversationTree.rowHeight + ConversationTree.rowGap))
            }
        }
        .stroke(Theme.textTertiary.opacity(0.4), style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
        .frame(width: ConversationTree.textX, height: ConversationTree.rowHeight + ConversationTree.rowGap, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}

struct RowSurface: ViewModifier {
    let isSelected: Bool
    let isHovering: Bool

    func body(content: Content) -> some View {
        if isSelected {
            content.background(
                Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
            )
        } else {
            content.background(
                isHovering ? Theme.hover : Theme.maskHidden,
                in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
            )
        }
    }
}

struct StatusBadge: View {
    let status: BotStatus

    var body: some View {
        if status == .awaitingApproval || status == .error {
            Image(systemName: status == .error ? "exclamationmark" : "questionmark")
                .font(.system(size: 8, weight: .heavy))
                .foregroundStyle(Theme.onAccent)
                .frame(width: 16, height: 16)
                .background(status == .error ? Theme.danger : Theme.attention, in: Circle())
                .padding(2)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel(status.label)
        }
    }
}

struct SidebarFooter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            if let notice = model.sidebarNotice {
                HStack(alignment: .top, spacing: Spacing.s) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(Theme.textTertiary)
                    Text(notice)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if let action = model.noticeAction {
                        Button(action.title) {
                            model.runNoticeAction()
                        }
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.brandText)
                        .buttonStyle(PressableButtonStyle())
                    }
                    Button {
                        model.dismissNotice()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                            .frame(width: 18, height: 18)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle())
                    .help("Fechar")
                }
                .padding(Spacing.m)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                .transition(.opacity.combined(with: .offset(y: 6)))
            }
        }
        .padding(.horizontal, Spacing.l)
        .padding(.top, model.sidebarNotice == nil ? 0 : Spacing.xs)
        .springAnimation(value: model.sidebarNotice)
    }
}

enum ShortStamp {
    private static let locale = Locale(identifier: "pt_BR")

    static func label(for date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if now.timeIntervalSince(date) < 60 {
            return "agora"
        }
        if calendar.isDateInToday(date) {
            return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
        }
        if calendar.isDateInYesterday(date) {
            return "ontem"
        }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(Date.FormatStyle().weekday(.abbreviated).locale(locale))
        }
        return date.formatted(Date.FormatStyle().day(.twoDigits).month(.twoDigits).locale(locale))
    }

    static func dayLabel(for date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "Hoje"
        }
        if calendar.isDateInYesterday(date) {
            return "Ontem"
        }
        return date.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(locale))
    }
}

struct RowAvatar: View {
    let bot: Bot
    let mood: CharacterMood
    let members: [Bot]

    var body: some View {
        if bot.isGroup {
            GroupAvatar(members: members, size: 40)
        } else {
            BotCharacter(bot: bot, mood: mood, size: 40)
        }
    }
}

private struct BreathingLogo: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let provider: String
    @State private var bright = false

    var body: some View {
        ProviderLogo(provider: provider, size: ConversationTree.iconWidth)
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
