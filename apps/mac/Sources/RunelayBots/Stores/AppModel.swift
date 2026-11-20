import AppKit
import Foundation
import Observation

enum InspectorTab: String, CaseIterable, Identifiable {
    case activity
    case library
    case routines

    var id: String { rawValue }

    var title: String {
        switch self {
        case .activity: "Atividade"
        case .library: "Biblioteca"
        case .routines: "Rotinas"
        }
    }
}

enum ProfileTab: String, CaseIterable, Identifiable {
    case general
    case routines

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "Geral"
        case .routines: "Rotinas"
        }
    }
}

struct GroupRequest: Identifiable {
    let id = UUID()
    let groupID: String?
    let name: String
    let members: [String]
}

struct EditorRequest: Identifiable {
    let id = UUID()
    let botID: String?
    let draft: BotDraft
    let errors: [String: String]
}

enum AppSheet: Identifiable {
    case profile(String)
    case editor(EditorRequest)
    case groupEditor(GroupRequest)
    case changes(String)
    case repoPicker(String)

    var id: String {
        switch self {
        case .changes(let botID): "changes-\(botID)"
        case .repoPicker(let botID): "repos-\(botID)"
        case .profile(let botID): "profile-\(botID)"
        case .editor(let request): "editor-\(request.id.uuidString)"
        case .groupEditor(let request): "group-\(request.id.uuidString)"
        }
    }

    var preferredWidth: CGFloat {
        switch self {
        case .editor, .groupEditor: 520
        case .changes: 1040
        case .repoPicker: 460
        default: 640
        }
    }

    var preferredHeight: CGFloat? {
        switch self {
        case .editor, .groupEditor: nil
        case .changes: 760
        case .repoPicker: 520
        default: 720
        }
    }
}

enum AppSection: String, CaseIterable, Identifiable {
    case conversations
    case routines
    case connectors
    case usage

    static let railCases: [AppSection] = [.conversations, .routines]

    var id: String { rawValue }

    var title: String {
        switch self {
        case .conversations: "Conversas"
        case .routines: "Rotinas"
        case .connectors: "Conectores"
        case .usage: "Uso"
        }
    }

    var systemImage: String {
        switch self {
        case .conversations: "bubble.left.and.bubble.right"
        case .routines: "clock.arrow.circlepath"
        case .connectors: "puzzlepiece.extension"
        case .usage: "gauge.with.dots.needle.33percent"
        }
    }
}

enum ConnectorsState {
    case idle
    case loading
    case unsupported
    case loaded([Connector])
    case failed(String)
}

enum AccountsState {
    case idle
    case loading
    case unsupported
    case loaded([AIAccount])
    case failed(String)
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case server
    case account
    case appearance
    case notifications
    case bots
    case aiAccounts
    case computer
    case devices
    case vault
    case integrations
    case shortcuts
    case about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .server: "Servidores"
        case .account: "Conta"
        case .appearance: "Aparência"
        case .notifications: "Notificações"
        case .bots: "Bots"
        case .aiAccounts: "Contas de IA"
        case .computer: "Uso do computador"
        case .devices: "Dispositivos"
        case .vault: "Cofre"
        case .integrations: "Integrações"
        case .shortcuts: "Atalhos"
        case .about: "Sobre"
        }
    }

    var systemImage: String {
        switch self {
        case .server: "server.rack"
        case .account: "person.crop.circle"
        case .appearance: "paintbrush"
        case .notifications: "bell"
        case .bots: "person.2"
        case .aiAccounts: "key"
        case .vault: "lock.shield"
        case .computer: "desktopcomputer"
        case .devices: "laptopcomputer.and.iphone"
        case .integrations: "key.horizontal"
        case .shortcuts: "command"
        case .about: "info.circle"
        }
    }
}

struct NoticeAction {
    let title: String
    let run: @MainActor () -> Void
}

struct ThreadActivity: Equatable {
    let text: String
    let isUser: Bool
    let date: Date?
    var speakerID: String? = nil
}

@MainActor
@Observable
final class AppModel {
    private(set) var bots: LoadState<[Bot]> = .idle
    private(set) var archivedBots: LoadState<[Bot]> = .idle
    private(set) var meta: ServerMeta = .fallback
    private(set) var connection: ConnectionStatus = .unknown
    private(set) var selectedBotID: String?
    private(set) var sidebarNotice: String?
    private(set) var noticeAction: NoticeAction?
    private(set) var composerFocusToken = 0
    private(set) var lastLatencyMs: Int?
    private(set) var runningSchedules: Set<String> = []
    private(set) var sections: [BotSection] = []
    private(set) var groups: [BotGroup] = []
    private(set) var connectors: ConnectorsState = .idle
    private(set) var isRefreshingConnectors = false
    private(set) var extraBots: LoadState<[Bot]> = .idle
    private(set) var accounts: AccountsState = .idle
    private(set) var isRefreshingAccounts = false
    private(set) var searchResults: LoadState<[Bot]> = .idle
    var section: AppSection = .conversations
    private(set) var computerMode = false
    private(set) var computerSurface = "browser"
    private(set) var liveSession: BrowserLiveSession?
    var browserReplay: BrowserReplay?
    var modelPickerOpen = false
    var floatingMenu: FloatingMenuID?
    let catalog = ConnectorCatalogStore()
    var groupBySection = UserDefaults.standard.object(forKey: "sidebar.groupBySection") as? Bool ?? true {
        didSet { UserDefaults.standard.set(groupBySection, forKey: "sidebar.groupBySection") }
    }
    var showHiddenBots = false {
        didSet { Task { await loadBots() } }
    }
    var searchQuery = "" {
        didSet { scheduleSearch() }
    }
    private(set) var metaLoaded = false
    var settingsPresented = false
    var settingsSection: SettingsSection = .server
    var inspectorPresented = UserDefaults.standard.bool(forKey: "inspectorOpen")
    var inspectorTab: InspectorTab = .activity
    var profileTab: ProfileTab = .general
    var activeSheet: AppSheet?
    var codeFocusPath: String?
    let browser = BrowserStore()

    private var threads: [String: ConversationStore] = [:]
    private var resolvingThreads: Set<String> = []
    @ObservationIgnored private var clearedStores: [String: ConversationStore] = [:]
    @ObservationIgnored private var clearingThreads: Set<String> = []
    private var unreadCounts: [String: Int] = [:] {
        didSet {
            let total = unreadCounts.values.reduce(0, +)
            NSApp?.dockTile.badgeLabel = total > 0 ? "\(total)" : nil
        }
    }

    @ObservationIgnored private var started = false
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    private var liveStatuses: [String: BotStatus] = [:]
    private var statusStreamLive = false
    private(set) var conversationLists: [String: [BotConversation]] = [:]
    private var sessionStatuses: [String: BotStatus] = [:]
    @ObservationIgnored private var parkedStores: [String: ConversationStore] = [:]
    @ObservationIgnored private var draftReturns: [String: ConversationStore] = [:]
    private(set) var draftBots: Set<String> = []
    private var draftPermissions: [String: PermissionMode] = [:]
    var collapsedBots: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "sidebar.collapsedBots") ?? []) {
        didSet { UserDefaults.standard.set(Array(collapsedBots), forKey: "sidebar.collapsedBots") }
    }
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var isRefreshing = false

    var client: BotsClient {
        BotsClient(baseURL: ServerConfig.currentURL())
    }

    var loadedBots: [Bot] {
        if case .loaded(let list) = bots {
            return list
        }
        return []
    }

    var groupBots: [Bot] {
        groups.filter { $0.archivedAt == nil }.map(Bot.init(group:))
    }

    var sortedBots: [Bot] {
        loadedBots + groupBots
    }

    var selectedBot: Bot? {
        guard let selectedBotID else { return nil }
        return bot(id: selectedBotID)
    }

    var selectedConversation: ConversationStore? {
        guard let selectedBotID else { return nil }
        return threads[selectedBotID]
    }

    var isResolvingSelectedThread: Bool {
        guard let selectedBotID else { return false }
        return resolvingThreads.contains(selectedBotID)
    }

    func bot(id: String) -> Bot? {
        loadedBots.first { $0.id == id } ?? groupBots.first { $0.id == id }
    }

    func members(of bot: Bot) -> [Bot] {
        (bot.groupMembers ?? []).compactMap { id in loadedBots.first { $0.id == id } }
    }

    func loadGroups() async {
        if let list = await client.groups() {
            groups = list
        }
    }

    func openGroupEditor(for group: Bot?) {
        activeSheet = .groupEditor(GroupRequest(
            groupID: group?.groupID,
            name: group?.name ?? "",
            members: group?.groupMembers ?? []
        ))
    }

    func createGroup(name: String, members: [String]) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, members.count >= 2 else { return }
        let tempID = "pending-\(UUID().uuidString)"
        groups.append(BotGroup(id: tempID, name: trimmed, members: members))
        activeSheet = nil
        section = .conversations
        settingsPresented = false
        selectedBotID = "group:\(tempID)"
        let client = client
        Task {
            do {
                let created = try await client.createGroup(name: trimmed, members: members)
                if let index = groups.firstIndex(where: { $0.id == tempID }) {
                    groups[index] = created
                }
                if selectedBotID == "group:\(tempID)" {
                    selectBot("group:\(created.id)")
                }
            } catch {
                groups.removeAll { $0.id == tempID }
                if selectedBotID == "group:\(tempID)" {
                    selectedBotID = visibleBots.first?.id
                }
                if let clientError = error as? BotsClient.ClientError, case .unsupported = clientError {
                    showNotice("O servidor ainda não aceita grupos.")
                } else {
                    showNotice(ErrorMessage.describe(error))
                }
            }
        }
    }

    func saveGroup(id: String, name: String, members: [String]) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        activeSheet = nil
        mutateGroup(id, body: .object([
            "name": .string(trimmed),
            "members": .array(members.map { .string($0) })
        ])) { group in
            group.name = trimmed
            group.members = members
        }
    }

    func archiveGroup(_ bot: Bot) {
        guard let groupID = bot.groupID, let index = groups.firstIndex(where: { $0.id == groupID }) else { return }
        let original = groups[index]
        groups.remove(at: index)
        if selectedBotID == bot.id {
            threads[bot.id]?.stop()
            threads[bot.id] = nil
            selectedBotID = visibleBots.first?.id
        }
        let client = client
        Task {
            do {
                try await client.archiveGroup(id: groupID)
            } catch {
                groups.insert(original, at: min(index, groups.count))
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func mutateGroup(_ groupID: String, body: JSONValue, change: (inout BotGroup) -> Void) {
        guard let index = groups.firstIndex(where: { $0.id == groupID }) else { return }
        let original = groups[index]
        change(&groups[index])
        let client = client
        Task {
            do {
                try await client.updateGroup(id: groupID, body: body)
            } catch {
                if let current = groups.firstIndex(where: { $0.id == groupID }) {
                    groups[current] = original
                }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func start() async {
        guard !started else { return }
        started = true
        async let metaResult = client.meta()
        await loadBots()
        applyMeta(await metaResult)
        await loadSections()
        await loadGroups()
        await loadAccounts()
        await loadConnectors()
        startRefreshing()
    }

    func loadBots() async {
        if case .loaded = bots {
        } else {
            bots = .loading
        }
        connection = .checking
        let clock = ContinuousClock()
        let started = clock.now
        do {
            let list = try await client.bots(hidden: showHiddenBots).filter { !$0.isArchived }
            lastLatencyMs = Self.milliseconds(started.duration(to: clock.now))
            let pending = loadedBots.filter(\.isPending)
            bots = .loaded(list + pending)
            syncConversations(from: list)
            syncUnread(from: list)
            connection = .online(list.count)
            if !metaLoaded {
                applyMeta(await client.meta())
            }
            if let selectedBotID, list.contains(where: { $0.id == selectedBotID }) {
                selectBot(selectedBotID)
            } else if let first = sortedBots.first {
                selectBot(first.id)
            }
        } catch {
            let message = ErrorMessage.describe(error)
            if case .loaded = bots {
            } else {
                bots = .failed(message)
            }
            connection = .offline(message)
        }
    }

    func checkConnection() async {
        connection = .checking
        let clock = ContinuousClock()
        let started = clock.now
        do {
            let list = try await client.bots().filter { !$0.isArchived }
            lastLatencyMs = Self.milliseconds(started.duration(to: clock.now))
            connection = .online(list.count)
            applyMeta(await client.meta())
        } catch {
            connection = .offline(ErrorMessage.describe(error))
        }
    }

    func reloadAfterSignIn() async {
        applyMeta(await client.meta())
        await loadBots()
        await loadSections()
        await loadGroups()
        await loadAccounts()
        await loadConnectors()
    }

    var readyAccounts: [AIAccount] {
        if case .loaded(let list) = accounts {
            return list.filter(\.isReady)
        }
        return []
    }

    var visibleBots: [Bot] {
        sortedBots.filter { (showHiddenBots || !$0.hidden) && !$0.isDeleted }
    }

    var pinnedBots: [Bot] {
        visibleBots.filter(\.pinned)
    }

    var activeSections: [BotSection] {
        sections.filter { $0.archivedAt == nil }
    }

    var loadedConnectors: [Connector] {
        if case .loaded(let list) = connectors {
            return list
        }
        return []
    }

    func connector(named name: String) -> Connector? {
        loadedConnectors.first { $0.name == name }
    }

    func loadConnectors() async {
        if case .loaded = connectors {
        } else {
            connectors = .loading
        }
        do {
            if let list = try await client.connectors() {
                connectors = .loaded(list)
            } else {
                connectors = .unsupported
            }
        } catch {
            connectors = .failed(ErrorMessage.describe(error))
        }
    }

    func refreshConnectors() {
        guard !isRefreshingConnectors else { return }
        isRefreshingConnectors = true
        let client = client
        Task {
            let supported = (try? await client.refreshConnectors()) ?? false
            if supported {
                await loadConnectors()
            } else {
                connectors = .unsupported
            }
            isRefreshingConnectors = false
        }
    }

    func setConnector(_ name: String, allowed: Bool, for bot: Bot) {
        guard let current = self.bot(id: bot.id) else { return }
        var settings = current.connectors ?? BotConnectors(allowed: [], memory: true)
        if allowed {
            if !settings.allowed.contains(name) {
                settings.allowed.append(name)
            }
        } else {
            settings.allowed.removeAll { $0 == name }
        }
        updateConnectors(settings, for: current)
    }

    func setMemory(capture: Bool? = nil, recall: Bool? = nil, for bot: Bot) {
        guard var edited = self.bot(id: bot.id), !bot.isGroup else { return }
        let original = edited
        var settings = edited.memorySettings ?? BotMemory(capture: true, recall: true)
        if let capture {
            settings.capture = capture
        }
        if let recall {
            settings.recall = recall
        }
        edited.memorySettings = settings
        replaceBot(edited)
        let client = client
        Task {
            do {
                let updated = try await client.updateBot(id: bot.id, body: .object([
                    "memory": .object(["capture": .bool(settings.capture), "recall": .bool(settings.recall)])
                ]))
                replaceBot(updated)
            } catch {
                replaceBot(original)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func setConnectorMemory(_ enabled: Bool, for bot: Bot) {
        guard let current = self.bot(id: bot.id) else { return }
        var settings = current.connectors ?? BotConnectors(allowed: [], memory: true)
        settings.memory = enabled
        updateConnectors(settings, for: current)
    }

    private func updateConnectors(_ settings: BotConnectors, for bot: Bot) {
        var edited = bot
        edited.connectors = settings
        replaceBot(edited)
        let client = client
        Task {
            do {
                let updated = try await client.updateBot(id: bot.id, body: .object(["connectors": settings.json]))
                replaceBot(updated)
            } catch {
                replaceBot(bot)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func loadSections() async {
        if let list = await client.sections() {
            sections = list
        }
    }

    func loadExtraBots() async {
        if case .loaded = extraBots {
        } else {
            extraBots = .loading
        }
        do {
            let list = try await client.extraBots()
            extraBots = .loaded(list.filter { $0.hidden || $0.isDeleted })
        } catch {
            extraBots = .failed(ErrorMessage.describe(error))
        }
    }

    func setPinned(_ pinned: Bool, for bot: Bot) {
        if let groupID = bot.groupID {
            mutateGroup(groupID, body: .object(["pinned": .bool(pinned)])) { $0.pinned = pinned }
            return
        }
        updateSidebar(bot, body: .object(["pinned": .bool(pinned)])) { $0.pinned = pinned }
    }

    func move(_ bot: Bot, to sectionID: String?) {
        let value = sectionID.map(JSONValue.string) ?? .null
        if let groupID = bot.groupID {
            mutateGroup(groupID, body: .object(["sectionId": value])) { $0.sectionId = sectionID }
            return
        }
        updateSidebar(bot, body: .object(["sectionId": value])) { $0.sectionId = sectionID }
    }

    func setHidden(_ hidden: Bool, for bot: Bot) {
        if let groupID = bot.groupID {
            mutateGroup(groupID, body: .object(["hidden": .bool(hidden)])) { $0.hidden = hidden }
        } else {
            updateSidebar(bot, body: .object(["hidden": .bool(hidden)])) { $0.hidden = hidden }
        }
        if hidden, selectedBotID == bot.id, let next = visibleBots.first(where: { $0.id != bot.id }) {
            selectBot(next.id)
        }
        if !hidden {
            removeExtra(bot.id)
        }
    }

    func renameBot(_ bot: Bot, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let groupID = bot.groupID {
            guard !trimmed.isEmpty, trimmed != bot.name else { return }
            mutateGroup(groupID, body: .object(["name": .string(trimmed)])) { $0.name = trimmed }
            return
        }
        guard !trimmed.isEmpty, trimmed != bot.name, var edited = self.bot(id: bot.id) else { return }
        let original = edited
        edited.name = trimmed
        replaceBot(edited)
        let client = client
        Task {
            do {
                let updated = try await client.updateBot(id: bot.id, body: .object(["name": .string(trimmed)]))
                replaceBot(updated)
            } catch {
                replaceBot(original)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func markUnread(_ bot: Bot) {
        guard bot.id != selectedBotID else { return }
        let previous = unreadCounts[bot.id] ?? 0
        unreadCounts[bot.id] = max(previous, 1)
        let client = client
        Task {
            do {
                try await client.markUnread(botID: bot.id)
            } catch {
                unreadCounts[bot.id] = previous
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func threadSessionID(for bot: Bot) -> String? {
        threads[bot.id]?.sessionId ?? bot.thread?.sessionId
    }

    func copyThreadID(of bot: Bot) {
        guard let id = threadSessionID(for: bot) else {
            showNotice("Essa conversa ainda não começou.")
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(id, forType: .string)
        showNotice("Copiado")
    }

    func deleteBot(_ bot: Bot) {
        guard let index = loadedBots.firstIndex(where: { $0.id == bot.id }) else { return }
        mutateBots { $0.removeAll { $0.id == bot.id } }
        if selectedBotID == bot.id {
            threads[bot.id]?.stop()
            threads[bot.id] = nil
            if let next = visibleBots.first {
                selectBot(next.id)
            } else {
                selectedBotID = nil
            }
        }
        let client = client
        Task {
            do {
                try await client.deleteBot(id: bot.id)
            } catch {
                mutateBots { list in
                    list.insert(bot, at: min(index, list.count))
                }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func restoreDeleted(_ bot: Bot) {
        removeExtra(bot.id)
        var restored = bot
        restored.deletedAt = nil
        restored.hidden = false
        mutateBots { $0.append(restored) }
        let client = client
        Task {
            do {
                try await client.restoreBot(id: bot.id)
            } catch {
                mutateBots { $0.removeAll { $0.id == bot.id } }
                showNotice(ErrorMessage.describe(error))
                await loadExtraBots()
            }
        }
    }

    func showHidden(_ bot: Bot) {
        removeExtra(bot.id)
        var shown = bot
        shown.hidden = false
        if self.bot(id: bot.id) == nil {
            mutateBots { $0.append(shown) }
        }
        let client = client
        Task {
            do {
                try await client.updateSidebar(botID: bot.id, body: .object(["hidden": .bool(false)]))
            } catch {
                showNotice(ErrorMessage.describe(error))
                await loadExtraBots()
            }
        }
    }

    func createSection(named name: String, moving bot: Bot?) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let temp = BotSection(id: "pending-\(UUID().uuidString)", name: trimmed)
        sections.append(temp)
        let client = client
        Task {
            do {
                let created = try await client.createSection(name: trimmed)
                if let index = sections.firstIndex(where: { $0.id == temp.id }) {
                    sections[index] = created
                }
                if let bot {
                    move(bot, to: created.id)
                }
            } catch {
                sections.removeAll { $0.id == temp.id }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func renameSection(_ section: BotSection, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let index = sections.firstIndex(where: { $0.id == section.id }) else { return }
        let original = sections[index]
        sections[index].name = trimmed
        let client = client
        Task {
            do {
                try await client.renameSection(id: section.id, name: trimmed)
            } catch {
                if let current = sections.firstIndex(where: { $0.id == section.id }) {
                    sections[current] = original
                }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func archiveSection(_ section: BotSection) {
        guard let index = sections.firstIndex(where: { $0.id == section.id }) else { return }
        let original = sections[index]
        sections.remove(at: index)
        let client = client
        Task {
            do {
                try await client.archiveSection(id: section.id)
            } catch {
                sections.insert(original, at: min(index, sections.count))
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func updateSidebar(_ bot: Bot, body: JSONValue, change: (inout Bot) -> Void) {
        guard var edited = self.bot(id: bot.id) else { return }
        let original = edited
        change(&edited)
        replaceBot(edited)
        let client = client
        Task {
            do {
                try await client.updateSidebar(botID: bot.id, body: body)
            } catch {
                replaceBot(original)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func removeExtra(_ botID: String) {
        if case .loaded(let list) = extraBots {
            extraBots = .loaded(list.filter { $0.id != botID })
        }
    }

    func ensureThread(for botID: String) {
        guard let bot = bot(id: botID), !bot.isPending, !botID.hasPrefix("group:pending"),
              threads[botID] == nil, !resolvingThreads.contains(botID) else { return }
        if bot.isGroup {
            let store = makeStore(bot: bot, sessionId: bot.thread?.sessionId)
            threads[botID] = store
            store.start()
            return
        }
        resolvingThreads.insert(botID)
        let client = client
        let knownSession = bot.thread?.sessionId
        Task {
            var sessionId = knownSession
            if sessionId == nil {
                sessionId = await client.thread(botID: botID)?.sessionId
            }
            if sessionId == nil {
                sessionId = (try? await client.sessions(botID: botID))?.first?.sessionId
            }
            resolvingThreads.remove(botID)
            guard threads[botID] == nil, let current = self.bot(id: botID) else { return }
            let store = makeStore(bot: current, sessionId: sessionId)
            threads[botID] = store
            store.start()
        }
    }

    func conversation(for botID: String) -> ConversationStore? {
        threads[botID]
    }

    func account(id: String) -> AIAccount? {
        if case .loaded(let list) = accounts {
            return list.first { $0.id == id }
        }
        return nil
    }

    func engineLabel(for bot: Bot) -> String {
        let engine = bot.engine
        let accountID = engine?.account ?? "vps:claude"
        let provider = account(id: accountID)?.label.split(separator: "·").first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ModelNames.providerName(accountID)
        let modelID = engine?.model ?? meta.model
        let modelLabel = modelID.map { id in
            account(id: accountID)?.models.first { $0.id == id }?.label ?? ModelNames.pretty(id)
        }
        let effort = (engine?.effort).flatMap { EngineEffort(rawValue: $0)?.title }
        return [provider, modelLabel, effort].compactMap { $0 }.joined(separator: " · ")
    }

    func loadAccounts() async {
        if case .loaded = accounts {
        } else {
            accounts = .loading
        }
        do {
            if let list = try await client.accounts() {
                accounts = .loaded(list)
            } else {
                accounts = .unsupported
            }
        } catch {
            accounts = .failed(ErrorMessage.describe(error))
        }
    }

    func refreshAccounts() {
        guard !isRefreshingAccounts else { return }
        isRefreshingAccounts = true
        let client = client
        Task {
            let supported = (try? await client.refreshAccounts()) ?? false
            if supported {
                await loadAccounts()
            } else {
                accounts = .unsupported
            }
            isRefreshingAccounts = false
        }
    }

    func saveInstructions(_ text: String, for bot: Bot) {
        guard var edited = self.bot(id: bot.id) else { return }
        let original = edited
        edited.instructions = text
        replaceBot(edited)
        let client = client
        Task {
            do {
                let updated = try await client.updateBot(id: bot.id, body: .object(["instructions": .string(text)]))
                replaceBot(updated)
            } catch {
                replaceBot(original)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func setAutoApprove(_ enabled: Bool, for bot: Bot) {
        guard var edited = self.bot(id: bot.id) else { return }
        let original = edited
        edited.decisions = BotDecisions(autoApprove: enabled, threshold: original.decisions?.threshold)
        replaceBot(edited)
        let client = client
        Task {
            do {
                let updated = try await client.updateBot(
                    id: bot.id,
                    body: .object(["decisions": .object(["autoApprove": .bool(enabled)])])
                )
                replaceBot(updated)
            } catch {
                replaceBot(original)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func useFallback(_ action: FallbackOffer, for bot: Bot, then retry: @escaping @MainActor () -> Void) {
        guard let current = self.bot(id: bot.id) else { return }
        let engine = BotEngine(
            account: current.engine?.account ?? "vps:claude",
            model: current.engine?.model,
            effort: current.engine?.effort,
            fallback: EngineFallback(account: action.account, model: action.model),
            sendsFallback: true
        )
        let client = client
        Task {
            do {
                let updated = try await client.updateBot(id: bot.id, body: .object(["engine": engine.json]))
                replaceBot(updated)
                retry()
            } catch {
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func setEngine(_ engine: BotEngine, for bot: Bot) {
        guard var edited = self.bot(id: bot.id) else { return }
        let original = edited
        edited.engine = engine
        replaceBot(edited)
        let client = client
        Task {
            do {
                let updated = try await client.updateBot(id: bot.id, body: .object(["engine": engine.json]))
                replaceBot(updated)
            } catch {
                replaceBot(original)
                if let clientError = error as? BotsClient.ClientError {
                    switch clientError {
                    case .validation, .unsupported:
                        showNotice("O servidor ainda não aceita trocar a conta ou o modelo.")
                        return
                    default:
                        break
                    }
                }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchResults = .idle
            return
        }
        if case .loaded = searchResults {
        } else {
            searchResults = .loading
        }
        let client = client
        searchTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(250))
            } catch {
                return
            }
            do {
                let found = try await client.searchBots(query).filter { !$0.isArchived }
                guard !Task.isCancelled else { return }
                searchResults = .loaded(found)
            } catch {
                guard !Task.isCancelled else { return }
                searchResults = .failed("A busca não respondeu agora.")
            }
        }
    }

    func isRunning(_ schedule: BotSchedule, of bot: Bot) -> Bool {
        runningSchedules.contains("\(bot.id)|\(schedule.name)")
    }

    func runNow(_ schedule: BotSchedule, of bot: Bot) {
        let key = "\(bot.id)|\(schedule.name)"
        guard !runningSchedules.contains(key) else { return }
        runningSchedules.insert(key)
        let client = client
        Task {
            do {
                try await client.runSchedule(botID: bot.id, name: schedule.name)
                try? await Task.sleep(for: .seconds(4))
                runningSchedules.remove(key)
            } catch {
                runningSchedules.remove(key)
                if let clientError = error as? BotsClient.ClientError, case .unsupported = clientError {
                    showNotice("O servidor ainda não aceita rodar rotinas na hora.")
                } else {
                    showNotice(ErrorMessage.describe(error))
                }
            }
        }
    }

    func openSettings(_ section: SettingsSection? = nil) {
        if let section {
            settingsSection = section
        }
        settingsPresented = true
        if settingsSection == .bots {
            Task {
                await loadArchived()
                await loadExtraBots()
            }
        }
    }

    func closeSettings() {
        settingsPresented = false
    }
        if settingsSection == .aiAccounts {
            Task { await loadAccounts() }
        }

    private func applyMeta(_ loaded: ServerMeta?) {
        guard let loaded else { return }
        metaLoaded = true
        meta = ServerMeta(
            accents: loaded.accents.isEmpty ? ServerMeta.fallback.accents : loaded.accents,
            capabilities: loaded.capabilities.isEmpty ? ServerMeta.fallback.capabilities : loaded.capabilities,
            engine: loaded.engine,
            model: loaded.model,
            version: loaded.version,
            integrations: loaded.integrations
        )
    }

    func refreshMeta() async {
        applyMeta(await client.meta())
    }

    func openIntegrations() {
        openSettings(.integrations)
    }

    private static func milliseconds(_ duration: Duration) -> Int {
        let parts = duration.components
        return Int(parts.seconds) * 1000 + Int(parts.attoseconds / 1_000_000_000_000_000)
    }

    func serverURLChanged() {
        refreshTask?.cancel()
        RunnerConnection.shared.restart()
        for store in threads.values {
            store.stop()
        }
        threads = [:]
        resolvingThreads = []
        unreadCounts = [:]
        selectedBotID = nil
        bots = .idle
        archivedBots = .idle
        browser.reset(botID: nil)
        started = false
        Task {
            await start()
        }
    }

    func shutdown() {
        refreshTask?.cancel()
        statusTask?.cancel()
        noticeTask?.cancel()
        searchTask?.cancel()
        for store in threads.values {
            store.stop()
        }
        for store in parkedStores.values {
            store.stop()
        }
        for store in draftReturns.values {
            store.stop()
        }
        threads = [:]
        parkedStores = [:]
        draftReturns = [:]
        browser.reset(botID: nil)
        NSApp?.dockTile.badgeLabel = nil
    }

    func conversations(for botID: String) -> [BotConversation] {
        conversationLists[botID] ?? []
    }

    func activeConversationID(for botID: String) -> String? {
        threads[botID]?.sessionId
    }

    func showsConversations(_ bot: Bot) -> Bool {
        !bot.isGroup && conversations(for: bot.id).count > 1
    }

    func conversationStatus(_ conversation: BotConversation) -> BotStatus {
        let store = threads[conversation.botId].flatMap { $0.sessionId == conversation.sessionId ? $0 : nil } ?? parkedStores[conversation.sessionId]
        let local = store?.botStatus ?? .idle
        let remote = sessionStatuses[conversation.sessionId] ?? (statusStreamLive ? .idle : conversation.serverStatus)
        return max(local, remote)
    }

    func conversationUnread(_ conversation: BotConversation) -> Int {
        if selectedBotID == conversation.botId && activeConversationID(for: conversation.botId) == conversation.sessionId {
            return 0
        }
        return conversation.unread
    }

    func permission(for botID: String) -> PermissionMode {
        if draftBots.contains(botID) {
            return draftPermissions[botID] ?? bot(id: botID)?.permission ?? .standard
        }
        let sessionID = activeConversationID(for: botID) ?? bot(id: botID)?.thread?.sessionId
        if let sessionID, let found = conversations(for: botID).first(where: { $0.sessionId == sessionID }) {
            return found.effectivePermission
        }
        return bot(id: botID)?.permission ?? .standard
    }

    func setPermission(_ mode: PermissionMode, for botID: String) {
        if draftBots.contains(botID) {
            draftPermissions[botID] = mode
            return
        }
        guard let sessionID = activeConversationID(for: botID) ?? bot(id: botID)?.thread?.sessionId else { return }
        let previous = conversations(for: botID).first { $0.sessionId == sessionID }
        updateConversationLocally(botID: botID, sessionID: sessionID) {
            $0.permission = mode
            $0.effectivePermission = mode
        }
        let client = client
        Task {
            do {
                try await client.updateConversation(botID: botID, sessionID: sessionID, body: .object(["permission": .string(mode.rawValue)]))
            } catch {
                if let previous {
                    updateConversationLocally(botID: botID, sessionID: sessionID) { $0 = previous }
                }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func cycleSelectedPermission() {
        guard let bot = selectedBot, !bot.isGroup, !bot.isPending else { return }
        setPermission(permission(for: bot.id).next, for: bot.id)
    }

    func setDefaultPermission(_ mode: PermissionMode, for botID: String) {
        guard var edited = bot(id: botID) else { return }
        let previous = edited.permission
        edited.permission = mode
        replaceBot(edited)
        let client = client
        Task {
            do {
                _ = try await client.updateBot(id: botID, body: .object(["permission": .string(mode.rawValue)]))
            } catch {
                edited.permission = previous
                replaceBot(edited)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func updateConversationLocally(botID: String, sessionID: String, change: (inout BotConversation) -> Void) {
        guard var list = conversationLists[botID], let index = list.firstIndex(where: { $0.sessionId == sessionID }) else { return }
        change(&list[index])
        conversationLists[botID] = list
    }

    private func upsertConversation(_ conversation: BotConversation) {
        for (botID, list) in conversationLists where botID != conversation.botId && list.contains(where: { $0.sessionId == conversation.sessionId }) {
            conversationLists[botID] = list.filter { $0.sessionId != conversation.sessionId }
        }
        var list = conversationLists[conversation.botId] ?? []
        if conversation.archivedAt != nil {
            list.removeAll { $0.sessionId == conversation.sessionId }
        } else if let index = list.firstIndex(where: { $0.sessionId == conversation.sessionId }) {
            list[index] = conversation
        } else if conversation.isMain {
            list.insert(conversation, at: 0)
        } else {
            list.insert(conversation, at: list.first?.isMain == true ? 1 : 0)
        }
        conversationLists[conversation.botId] = list
    }

    private func syncConversations(from list: [Bot]) {
        var next: [String: [BotConversation]] = [:]
        for bot in list where !bot.isGroup {
            next[bot.id] = bot.conversations
        }
        conversationLists = next
    }

    func selectConversation(botID: String, sessionID: String) {
        if selectedBotID != botID || section != .conversations {
            activeSheet = nil
            settingsPresented = false
            section = .conversations
            selectBot(botID)
        }
        switchStore(botID: botID, sessionID: sessionID)
        markRead(botID: botID, sessionID: sessionID)
    }

    func openConversation(_ botID: String, sessionID: String?) {
        guard let sessionID else {
            openConversation(botID)
            return
        }
        selectConversation(botID: botID, sessionID: sessionID)
    }

    private func switchStore(botID: String, sessionID: String) {
        guard let bot = bot(id: botID), !bot.isGroup else { return }
        discardDraft(botID)
        if let current = threads[botID] {
            if current.sessionId == sessionID { return }
            if let id = current.sessionId {
                parkedStores[id] = current
            }
        }
        let store = parkedStores.removeValue(forKey: sessionID) ?? makeStore(bot: bot, sessionId: sessionID)
        threads[botID] = store
        resolvingThreads.remove(botID)
        store.start()
    }

    private func prepareDelegated(botID: String, sessionID: String?) {
        guard let sessionID else { return }
        guard threads[botID]?.sessionId != sessionID, parkedStores[sessionID] == nil, let bot = bot(id: botID) else { return }
        let store = makeStore(bot: bot, sessionId: sessionID)
        parkedStores[sessionID] = store
        store.start()
    }

    func isDraft(_ botID: String) -> Bool {
        draftBots.contains(botID)
    }

    func newConversation(in botID: String? = nil) {
        guard let bot = (botID.flatMap { bot(id: $0) }) ?? selectedBot, !bot.isGroup, !bot.isPending else { return }
        let botID = bot.id
        if !draftBots.contains(botID) {
            let store = makeStore(bot: bot, sessionId: nil, settled: true)
            let client = client
            store.createSession = { [weak self] text, skills, attachments in
                let created = try await client.createConversation(botID: botID, permission: self?.draftPermissions[botID], message: text, skills: skills, attachments: attachments)
                self?.finishDraft(created)
                return created.sessionId
            }
            if let previous = threads[botID] {
                draftReturns[botID] = previous
            }
            threads[botID] = store
            resolvingThreads.remove(botID)
            draftBots.insert(botID)
        }
        if selectedBotID != botID || section != .conversations {
            openConversation(botID)
        }
        focusComposer()
    }

    private func finishDraft(_ created: BotConversation) {
        let botID = created.botId
        draftBots.remove(botID)
        draftPermissions.removeValue(forKey: botID)
        if let previous = draftReturns.removeValue(forKey: botID), let id = previous.sessionId {
            parkedStores[id] = previous
        }
        collapsedBots.remove(botID)
        upsertConversation(created)
    }

    private func discardDraft(_ botID: String) {
        guard draftBots.contains(botID), let store = threads[botID], store.sessionId == nil, !store.isCreating else { return }
        draftBots.remove(botID)
        draftPermissions.removeValue(forKey: botID)
        store.clearDraft()
        store.stop()
        threads[botID] = draftReturns.removeValue(forKey: botID)
    }

    func openLatestConversation(_ botID: String) {
        let latest = conversations(for: botID).max { ($0.activityDate ?? .distantPast) < ($1.activityDate ?? .distantPast) }
        guard let latest else {
            openConversation(botID)
            return
        }
        selectConversation(botID: botID, sessionID: latest.sessionId)
    }

    func renameConversation(_ conversation: BotConversation, to title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != conversation.title else { return }
        updateConversationLocally(botID: conversation.botId, sessionID: conversation.sessionId) { $0.title = trimmed }
        let client = client
        Task {
            do {
                try await client.updateConversation(botID: conversation.botId, sessionID: conversation.sessionId, body: .object(["title": .string(trimmed)]))
            } catch {
                updateConversationLocally(botID: conversation.botId, sessionID: conversation.sessionId) { $0.title = conversation.title }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func archiveConversation(_ conversation: BotConversation) {
        guard !conversation.isMain else { return }
        let botID = conversation.botId
        let before = conversationLists[botID] ?? []
        let wasActive = activeConversationID(for: botID) == conversation.sessionId
        if wasActive, conversationStatus(conversation) != .idle {
            showNotice("Essa conversa ainda está trabalhando. Pare antes de arquivar.")
            return
        }
        conversationLists[botID] = before.filter { $0.sessionId != conversation.sessionId }
        if wasActive, let main = before.first(where: \.isMain) {
            selectConversation(botID: botID, sessionID: main.sessionId)
        }
        parkedStores.removeValue(forKey: conversation.sessionId)?.stop()
        let client = client
        Task {
            do {
                try await client.conversationAction(botID: botID, sessionID: conversation.sessionId, action: "archive")
                showNotice("Conversa arquivada", action: NoticeAction(title: "Desfazer") { [weak self] in
                    self?.unarchiveConversation(conversation)
                })
            } catch {
                conversationLists[botID] = before
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func unarchiveConversation(_ conversation: BotConversation) {
        let client = client
        Task {
            do {
                if let restored = try await client.conversationAction(botID: conversation.botId, sessionID: conversation.sessionId, action: "unarchive") {
                    upsertConversation(restored)
                }
            } catch {
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func moveConversation(_ conversation: BotConversation, to targetID: String) {
        guard !conversation.isMain, targetID != conversation.botId else { return }
        let client = client
        Task {
            do {
                guard let moved = try await client.conversationAction(botID: conversation.botId, sessionID: conversation.sessionId, action: "move", body: .object(["botId": .string(targetID)])) else { return }
                let wasActive = activeConversationID(for: conversation.botId) == conversation.sessionId
                parkedStores.removeValue(forKey: conversation.sessionId)?.stop()
                if wasActive, let main = conversations(for: conversation.botId).first(where: \.isMain) {
                    switchStore(botID: conversation.botId, sessionID: main.sessionId)
                }
                parkedStores.removeValue(forKey: conversation.sessionId)?.stop()
                upsertConversation(moved)
                if wasActive {
                    selectConversation(botID: targetID, sessionID: moved.sessionId)
                }
            } catch {
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func markConversationUnread(_ conversation: BotConversation) {
        guard !(selectedBotID == conversation.botId && activeConversationID(for: conversation.botId) == conversation.sessionId) else { return }
        updateConversationLocally(botID: conversation.botId, sessionID: conversation.sessionId) { $0.unread = max($0.unread, 1) }
        let client = client
        Task {
            try? await client.conversationAction(botID: conversation.botId, sessionID: conversation.sessionId, action: "unread")
        }
    }

    private func markRead(botID: String, sessionID: String) {
        updateConversationLocally(botID: botID, sessionID: sessionID) { $0.unread = 0 }
        guard conversations(for: botID).first(where: { $0.sessionId == sessionID })?.isMain == false else { return }
        let client = client
        Task {
            try? await client.conversationAction(botID: botID, sessionID: sessionID, action: "read")
        }
    }

    func selectBot(_ botID: String) {
        let changed = selectedBotID != botID
        if changed, let previousID = selectedBotID {
            discardDraft(previousID)
        }
        selectedBotID = botID
        guard let bot = bot(id: botID) else { return }
        markRead(bot)
        if changed {
            modelPickerOpen = false
            browser.reset(botID: nil)
            if !bot.hasComputer {
                closeComputer()
            } else if computerMode {
                openComputer()
            }
        }
        ensureThread(for: botID)
    }

    func openComputer() {
        guard let bot = selectedBot, bot.hasComputer else { return }
        if !bot.hasBrowser {
            computerSurface = "desktop"
        } else if !bot.hasDesktop {
            computerSurface = "browser"
        }
        computerMode = true
        if liveSession?.botID != bot.id || liveSession?.surface != computerSurface {
            liveSession?.stop()
            let session = BrowserLiveSession(botID: bot.id, surface: computerSurface)
            liveSession = session
            session.start(client: client)
        }
    }

    func switchComputerSurface(_ surface: String) {
        guard surface != computerSurface else { return }
        computerSurface = surface
        openComputer()
    }

    func closeComputer() {
        computerMode = false
        browserReplay = nil
        liveSession?.stop()
        liveSession = nil
    }

    func setBrowserControl(user: Bool) {
        guard let liveSession else { return }
        liveSession.setControl(user: user, client: client) { [weak self] message in
            self?.showNotice(message)
        }
    }

    func toggleComputer() {
        if computerMode {
            closeComputer()
        } else {
            openComputer()
        }
    }

    func openPage(_ url: String) {
        guard let bot = selectedBot else { return }
        let client = client
        Task {
            do {
                try await browser.open(url, client: client, botID: bot.id)
            } catch {
                if let clientError = error as? BotsClient.ClientError, case .unsupported = clientError {
                    showNotice("O servidor ainda não abre páginas direto. Peça para \(bot.name) abrir na conversa.")
                } else {
                    showNotice(ErrorMessage.describe(error))
                }
            }
        }
    }

    func openConversation(_ botID: String) {
        activeSheet = nil
        settingsPresented = false
        section = .conversations
        selectBot(botID)
    }

    func answerFromNotification(botID: String, interactionID: String, optionID: String) {
        threads[botID]?.respond(approvalID: interactionID, optionID: optionID)
    }

    func focusComposer() {
        composerFocusToken += 1
    }

    private func syncUnread(from list: [Bot]) {
        var counts: [String: Int] = [:]
        for bot in list where bot.id != selectedBotID {
            counts[bot.id] = bot.thread?.unread ?? 0
        }
        unreadCounts = counts
    }

    func markRead(_ bot: Bot) {
        unreadCounts[bot.id] = 0
        guard !bot.isPending, !bot.id.hasPrefix("group:pending"), !draftBots.contains(bot.id) else { return }
        if let active = activeConversationID(for: bot.id), let conversation = conversations(for: bot.id).first(where: { $0.sessionId == active }), !conversation.isMain {
            markRead(botID: bot.id, sessionID: active)
            return
        }
        if let main = conversations(for: bot.id).first(where: \.isMain) {
            updateConversationLocally(botID: bot.id, sessionID: main.sessionId) { $0.unread = 0 }
        }
        let client = client
        Task {
            await client.markRead(botID: bot.id)
        }
    }

    func unread(for bot: Bot) -> Int {
        if showsConversations(bot) {
            guard collapsedBots.contains(bot.id) else { return 0 }
            return conversations(for: bot.id).reduce(0) { $0 + conversationUnread($1) }
        }
        return bot.id == selectedBotID ? 0 : (unreadCounts[bot.id] ?? 0)
    }

    func activity(for bot: Bot) -> ThreadActivity? {
        if let store = threads[bot.id], var activity = store.lastActivity {
            if bot.isGroup, let speaker = activity.speakerID, let name = self.bot(id: speaker)?.name {
                activity = ThreadActivity(text: "\(name): \(activity.text)", isUser: activity.isUser, date: activity.date)
            }
            return activity
        }
        guard let message = bot.thread?.lastMessage, !message.text.isEmpty else { return nil }
        return ThreadActivity(text: message.text, isUser: message.role == "user", date: message.date)
    }

    func status(for botID: String) -> BotStatus {
        if let store = threads[botID] {
            return max(store.botStatus, serverStatus(for: botID))
        }
        return serverStatus(for: botID)
    }

    func mood(for botID: String) -> CharacterMood {
        if let store = threads[botID] {
            let mood = store.mood
            guard mood == .idle else { return mood }
            switch serverStatus(for: botID) {
            case .working: return .thinking
            case .awaitingApproval: return .waiting
            default: return mood
            }
        }
        switch serverStatus(for: botID) {
        case .working: return .thinking
        case .awaitingApproval: return .waiting
        default: return .idle
        }
    }

    private func serverStatus(for botID: String) -> BotStatus {
        let key = botID.hasPrefix("group:") ? String(botID.dropFirst("group:".count)) : botID
        if let live = liveStatuses[key] {
            return live
        }
        guard statusStreamLive == false, let thread = bot(id: botID)?.thread else { return .idle }
        if thread.status == "awaiting" {
            return .awaitingApproval
        }
        return thread.running ? .working : .idle
    }

    private static func botStatus(_ text: String?) -> BotStatus {
        switch text {
        case "working", "queued": .working
        case "awaiting": .awaitingApproval
        default: .idle
        }
    }

    private func startStatusStream() {
        statusTask?.cancel()
        let client = client
        statusTask = Task { [weak self] in
            var failures = 0
            while !Task.isCancelled {
                do {
                    let request = try client.statusStreamRequest()
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    AuthStore.reportUnauthorized(response)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                        throw BotsClient.ClientError.http((response as? HTTPURLResponse)?.statusCode ?? 0, nil)
                    }
                    failures = 0
                    for try await line in bytes.lines {
                        guard let data = line.data(using: .utf8),
                              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { continue }
                        self?.applyStatusLine(value)
                    }
                } catch {
                    if Task.isCancelled { return }
                }
                self?.statusStreamLive = false
                failures += 1
                let delay = min(0.5 * Double(1 << min(failures, 5)), 15)
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return
                }
            }
        }
    }

    private func applyStatusLine(_ value: JSONValue) {
        switch value["type"]?.stringValue {
        case "snapshot":
            var next: [String: BotStatus] = [:]
            if case .object(let bots) = value["bots"] ?? .null {
                for (id, status) in bots {
                    next[id] = Self.botStatus(status.stringValue)
                }
            }
            liveStatuses = next
            var sessions: [String: BotStatus] = [:]
            if case .object(let items) = value["sessions"] ?? .null {
                for (id, item) in items {
                    sessions[id] = Self.botStatus(item["status"]?.stringValue)
                }
            }
            sessionStatuses = sessions
            statusStreamLive = true
        case "session":
            guard let id = value["sessionId"]?.stringValue else { return }
            let status = Self.botStatus(value["status"]?.stringValue)
            sessionStatuses[id] = status == .idle ? nil : status
        case "conversation":
            if let conversation = value["conversation"].flatMap(BotConversation.init) {
                upsertConversation(conversation)
            } else if let botID = value["botId"]?.stringValue, let sessionID = value["sessionId"]?.stringValue {
                conversationLists[botID]?.removeAll { $0.sessionId == sessionID }
            }
        case "status":
            guard let id = value["botId"]?.stringValue else { return }
            let status = Self.botStatus(value["status"]?.stringValue)
            if status == .idle {
                liveStatuses[id] = nil
            } else {
                liveStatuses[id] = status
            }
        default:
            break
        }
    }

    func toggleInspector() {
        inspectorPresented.toggle()
        UserDefaults.standard.set(inspectorPresented, forKey: "inspectorOpen")
    }

    func openProfile(_ bot: Bot) {
        profileTab = .general
        activeSheet = .profile(bot.id)
    }

    func openEditor(for bot: Bot?) {
        activeSheet = .editor(EditorRequest(botID: bot?.id, draft: BotDraft(bot: bot), errors: [:]))
    }

    func dismissSheet() {
        activeSheet = nil
    }

    func dismissNotice() {
        sidebarNotice = nil
        noticeAction = nil
    }

    func runNoticeAction() {
        guard let action = noticeAction else { return }
        dismissNotice()
        action.run()
    }

    func canClearConversation(_ bot: Bot) -> Bool {
        !bot.isGroup && !bot.isPending && threadSessionID(for: bot) != nil
    }

    func clearSelectedConversation() {
        guard section == .conversations, let bot = selectedBot else { return }
        clearConversation(bot)
    }

    func clearConversation(_ bot: Bot) {
        guard canClearConversation(bot), !clearingThreads.contains(bot.id) else { return }
        if threads[bot.id]?.canStop == true {
            showNotice("O bot ainda está respondendo. Pare a resposta antes de limpar a conversa.")
            return
        }
        clearingThreads.insert(bot.id)
        let client = client
        Task {
            defer { clearingThreads.remove(bot.id) }
            do {
                let swap = try await client.resetThread(botID: bot.id)
                let previous = threads[bot.id]
                previous?.stop()
                swapThread(bot.id, thread: swap.thread, store: nil, draftFrom: previous)
                guard let archiveID = swap.archiveID else { return }
                if let previous {
                    clearedStores[archiveID] = previous
                }
                showNotice("Conversa limpa", action: NoticeAction(title: "Desfazer") { [weak self] in
                    self?.undoClear(botID: bot.id, archiveID: archiveID)
                })
            } catch {
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func undoClear(botID: String, archiveID: String) {
        guard !clearingThreads.contains(botID) else { return }
        clearingThreads.insert(botID)
        let client = client
        Task {
            defer { clearingThreads.remove(botID) }
            do {
                let swap = try await client.restoreThread(botID: botID, archiveID: archiveID)
                let current = threads[botID]
                current?.stop()
                let kept = clearedStores.removeValue(forKey: archiveID)
                let reusable = kept?.sessionId == swap.thread.sessionId ? kept : nil
                swapThread(botID, thread: swap.thread, store: reusable, draftFrom: current)
            } catch {
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func swapThread(_ botID: String, thread: BotThread, store: ConversationStore?, draftFrom previous: ConversationStore?) {
        guard let current = bot(id: botID) else { return }
        let next = store ?? makeStore(bot: current, sessionId: thread.sessionId, settled: thread.lastMessage == nil)
        if let previous, previous !== next {
            next.draft = previous.draft
            next.attachedSkills = previous.attachedSkills
        }
        threads[botID] = next
        next.start()
        unreadCounts[botID] = 0
        mutateBots { list in
            if let index = list.firstIndex(where: { $0.id == botID }) {
                list[index].thread = BotThread(sessionId: thread.sessionId, lastMessage: thread.lastMessage, unread: 0)
            }
        }
    }

    func delegateCandidates(excluding botID: String?) -> [Bot] {
        loadedBots.filter { !$0.isPending && $0.id != botID }
    }

    func capabilityLabel(_ id: String) -> MetaCapability? {
        meta.capabilities.first { $0.id == id }
    }

    func createBot(from draft: BotDraft) {
        let errors = draft.localErrors()
        guard errors.isEmpty else {
            activeSheet = .editor(EditorRequest(botID: nil, draft: draft, errors: errors))
            return
        }
        let previousSelection = selectedBotID
        let tempID = "pending-\(UUID().uuidString)"
        var pending = Bot(
            id: tempID,
            name: draft.trimmedName,
            role: "",
            accent: draft.accent,
            schedules: [],
            instructions: "",
            capabilities: BotCapabilitySet(browser: true, delegate: []),
            isPending: true
        )
        pending.glyph = draft.glyph
        activeSheet = nil
        section = .conversations
        settingsPresented = false
        mutateBots { $0.append(pending) }
        selectBot(tempID)
        let client = client
        let body = draft.body
        Task {
            do {
                let created = try await client.createBot(body)
                mutateBots { list in
                    if let index = list.firstIndex(where: { $0.id == tempID }) {
                        list[index] = created
                    } else {
                        list.append(created)
                    }
                }
                if selectedBotID == tempID {
                    selectBot(created.id)
                }
            } catch {
                mutateBots { $0.removeAll { $0.id == tempID } }
                if selectedBotID == tempID {
                    if let previousSelection, bot(id: previousSelection) != nil {
                        selectBot(previousSelection)
                    } else if let first = sortedBots.first {
                        selectBot(first.id)
                    } else {
                        selectedBotID = nil
                    }
                }
                handleEditorFailure(error, botID: nil, draft: draft)
            }
        }
    }

    func saveBot(id: String, draft: BotDraft) {
        let errors = draft.localErrors()
        guard errors.isEmpty else {
            activeSheet = .editor(EditorRequest(botID: id, draft: draft, errors: errors))
            return
        }
        guard let original = bot(id: id) else { return }
        var edited = original
        edited.name = draft.trimmedName
        edited.accent = draft.accent
        edited.glyph = draft.glyph
        activeSheet = .profile(id)
        replaceBot(edited)
        let client = client
        let body = draft.body
        Task {
            do {
                let updated = try await client.updateBot(id: id, body: body)
                replaceBot(updated)
            } catch {
                replaceBot(original)
                handleEditorFailure(error, botID: id, draft: draft)
            }
        }
    }

    func archive(_ bot: Bot) {
        guard let index = loadedBots.firstIndex(where: { $0.id == bot.id }) else { return }
        activeSheet = nil
        mutateBots { $0.removeAll { $0.id == bot.id } }
        if selectedBotID == bot.id {
            threads[bot.id]?.stop()
            threads[bot.id] = nil
            if let first = sortedBots.first {
                selectBot(first.id)
            } else {
                selectedBotID = nil
            }
        }
        let client = client
        Task {
            do {
                try await client.archiveBot(id: bot.id)
            } catch {
                mutateBots { list in
                    list.insert(bot, at: min(index, list.count))
                }
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func loadArchived() async {
        if case .loaded = archivedBots {
        } else {
            archivedBots = .loading
        }
        do {
            let list = try await client.bots(archived: true).filter(\.isArchived)
            archivedBots = .loaded(list)
        } catch {
            archivedBots = .failed(ErrorMessage.describe(error))
        }
    }

    func restore(_ bot: Bot) {
        var archived: [Bot] = []
        if case .loaded(let list) = archivedBots {
            archived = list
        }
        archivedBots = .loaded(archived.filter { $0.id != bot.id })
        var restored = bot
        restored.archivedAt = nil
        mutateBots { $0.append(restored) }
        let client = client
        Task {
            do {
                try await client.unarchiveBot(id: bot.id)
            } catch {
                mutateBots { $0.removeAll { $0.id == bot.id } }
                archivedBots = .loaded(archived)
                showNotice(ErrorMessage.describe(error))
            }
        }
    }

    private func handleEditorFailure(_ error: any Error, botID: String?, draft: BotDraft) {
        if let clientError = error as? BotsClient.ClientError, case .validation(let message, let field) = clientError {
            activeSheet = .editor(EditorRequest(botID: botID, draft: draft, errors: [field ?? "general": message]))
            return
        }
        if let clientError = error as? BotsClient.ClientError, case .unsupported = clientError {
            showNotice(botID == nil ? "O servidor ainda não aceita criar bots." : "O servidor ainda não aceita editar bots.")
            return
        }
        showNotice(ErrorMessage.describe(error))
    }

    func showNotice(_ message: String, action: NoticeAction? = nil) {
        sidebarNotice = message
        noticeAction = action
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            sidebarNotice = nil
            noticeAction = nil
        }
    }

    private func replaceBot(_ updated: Bot) {
        mutateBots { list in
            if let index = list.firstIndex(where: { $0.id == updated.id }) {
                list[index] = updated
            }
        }
    }

    private func mutateBots(_ change: (inout [Bot]) -> Void) {
        var list = loadedBots
        change(&list)
        bots = .loaded(list)
    }

    private func startRefreshing() {
        startStatusStream()
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(30))
                } catch {
                    return
                }
                guard let self else { return }
                await self.refreshQuietly()
            }
        }
    }

    private func refreshQuietly() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await loadGroups()
        let clock = ContinuousClock()
        let started = clock.now
        guard let list = try? await client.bots() else { return }
        lastLatencyMs = Self.milliseconds(started.duration(to: clock.now))
        if !metaLoaded {
            applyMeta(await client.meta())
        }
        let fresh = list.filter { !$0.isArchived }
        let pending = loadedBots.filter(\.isPending)
        bots = .loaded(fresh + pending)
        syncUnread(from: fresh)
        connection = .online(fresh.count)
        if let selected = selectedBot {
            markRead(selected)
        }
    }

    private func makeStore(bot: Bot, sessionId: String?, settled: Bool = false) -> ConversationStore {
        let store = ConversationStore(bot: bot, client: client, sessionId: sessionId, settled: settled)
        store.onOpenProfile = { [weak self] in
            guard let self, let current = self.bot(id: bot.id) else { return }
            self.openProfile(current)
        }
        store.onDelegation = { [weak self] botID, sessionID in
            if sessionID == nil {
                self?.ensureThread(for: botID)
            } else {
                self?.prepareDelegated(botID: botID, sessionID: sessionID)
            }
        }
        store.onBotUpdated = { [weak self] in
            guard let self else { return }
            Task {
                await self.refreshQuietly()
            }
        }
        store.onNotify = { [weak self] event in
            guard let self, let current = self.bot(id: bot.id) else { return }
            let visible = NSApp.isActive && self.selectedBotID == bot.id
                && self.section == .conversations && !self.settingsPresented
            if case .approval = event {
                if visible { return }
            } else if visible {
                return
            }
            var speaker: String?
            if case .reply(_, let speakerID, _) = event, current.isGroup, let speakerID {
                speaker = self.bot(id: speakerID)?.name
            }
            Notifier.shared.post(event, bot: current, speakerName: speaker)
        }
        store.onNeedsAttention = { [weak self] in
            guard let self, self.selectedBotID == bot.id, !self.computerMode else { return }
            self.inspectorPresented = true
            self.inspectorTab = .activity
        }
        store.onLiveReply = { [weak self] in
            guard let self else { return }
            if self.selectedBotID == bot.id {
                if let current = self.bot(id: bot.id) {
                    self.markRead(current)
                }
            } else {
                self.unreadCounts[bot.id, default: 0] += 1
            }
        }
        return store
    }
}
