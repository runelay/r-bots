import Foundation
import Observation
import SwiftUI
import UIKit

enum BotListState: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

@MainActor
@Observable
final class AppModel {
    private(set) var bots: [Bot] = []
    private(set) var listState: BotListState = .idle
    private(set) var conversationLists: [String: [BotConversation]] = [:]
    private(set) var liveStatuses: [String: BotStatus] = [:]
    private(set) var sessionStatuses: [String: BotStatus] = [:]
    private(set) var statusStreamLive = false
    private(set) var notice: String?
    private(set) var meta: ServerMeta = .fallback
    private(set) var accounts: [AIAccount] = []
    private(set) var sections: [BotSection] = []
    private(set) var searchResults: LoadState<[Bot]> = .idle
    var searchQuery = "" {
        didSet { scheduleSearch() }
    }

    var groupBySection = UserDefaults.standard.object(forKey: "sidebar.groupBySection") as? Bool ?? true {
        didSet { UserDefaults.standard.set(groupBySection, forKey: "sidebar.groupBySection") }
    }
    var collapsedBots: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "sidebar.collapsedBots") ?? []) {
        didSet { UserDefaults.standard.set(Array(collapsedBots), forKey: "sidebar.collapsedBots") }
    }
    var collapsedThreads: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "sidebar.collapsedThreads") ?? []) {
        didSet { UserDefaults.standard.set(Array(collapsedThreads), forKey: "sidebar.collapsedThreads") }
    }

    @ObservationIgnored private var stores: [String: ConversationStore] = [:]
    @ObservationIgnored private var drafts: [String: ConversationStore] = [:]
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private(set) var openSessions: Set<String> = []
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    var client: BotsClient { BotsClient(baseURL: ServerConfig.currentURL()) }

    func bot(id: String) -> Bot? {
        bots.first { $0.id == id }
    }

    var visibleBots: [Bot] {
        bots.filter { !$0.isGroup && !$0.isPending && !$0.hidden }
            .sorted { lhs, rhs in
                if lhs.pinned != rhs.pinned { return lhs.pinned }
                return (activityDate(for: lhs) ?? .distantPast) > (activityDate(for: rhs) ?? .distantPast)
            }
    }

    var pinnedBots: [Bot] {
        visibleBots.filter(\.pinned)
    }

    var activeSections: [BotSection] {
        sections.filter { $0.archivedAt == nil }
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

    func loadSections() async {
        if let list = await client.sections() {
            withAnimation(Motion.spring) { sections = list }
        }
    }

    func start() async {
        startStatusStream()
        async let loadedMeta = client.meta()
        await loadBots()
        await loadSections()
        if let value = await loadedMeta { meta = value }
    }

    func refreshMeta() async {
        if let value = await client.meta() { meta = value }
    }

    func stop() {
        statusTask?.cancel()
        statusTask = nil
        statusStreamLive = false
        for store in stores.values {
            store.stop()
        }
        stores = [:]
        drafts = [:]
        bots = []
        conversationLists = [:]
        sections = []
        searchTask?.cancel()
        searchQuery = ""
        searchResults = .idle
        liveStatuses = [:]
        sessionStatuses = [:]
        listState = .idle
    }

    func enterBackground() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "status") { [weak self] in
            MainActor.assumeIsolated {
                self?.suspendAll()
            }
        }
    }

    private func suspendAll() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        statusTask?.cancel()
        statusTask = nil
        statusStreamLive = false
        for store in stores.values {
            store.suspend()
        }
    }

    func enterForeground() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        guard statusTask == nil, listState != .idle else { return }
        startStatusStream()
        for (sessionID, store) in stores where openSessions.contains(sessionID) {
            store.resume()
        }
        Task { await refresh() }
    }

    func loadBots() async {
        if listState != .loaded {
            listState = .loading
        }
        do {
            let list = try await client.bots().filter { !$0.isArchived }
            withAnimation(Motion.spring) {
                bots = list
                syncConversations(from: list)
                listState = .loaded
            }
        } catch {
            if listState != .loaded {
                listState = .failed(ErrorMessage.describe(error))
            }
        }
    }

    func refresh() async {
        await loadBots()
        await loadSections()
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    private func syncConversations(from list: [Bot]) {
        var next: [String: [BotConversation]] = [:]
        for bot in list where !bot.isGroup {
            next[bot.id] = bot.conversations.filter { $0.archivedAt == nil }
        }
        conversationLists = next
    }

    func conversations(for botID: String) -> [BotConversation] {
        conversationLists[botID] ?? []
    }

    func showsConversations(_ bot: Bot) -> Bool {
        !bot.isGroup && conversations(for: bot.id).count > 1
    }

    func latestConversation(for botID: String) -> BotConversation? {
        conversations(for: botID).max { ($0.activityDate ?? .distantPast) < ($1.activityDate ?? .distantPast) }
    }

    func conversationTree(for botID: String) -> [(conversation: BotConversation, depth: Int)] {
        let list = conversations(for: botID)
        let ids = Set(list.map(\.sessionId))
        var children: [String: [BotConversation]] = [:]
        var roots: [BotConversation] = []
        for item in list {
            if let parent = item.parentSessionId, parent != item.sessionId, ids.contains(parent) {
                children[parent, default: []].append(item)
            } else {
                roots.append(item)
            }
        }
        var result: [(conversation: BotConversation, depth: Int)] = []
        var seen: Set<String> = []
        func walk(_ item: BotConversation, depth: Int) {
            guard seen.insert(item.sessionId).inserted else { return }
            result.append((item, depth))
            guard !collapsedThreads.contains(item.sessionId) else { return }
            for child in (children[item.sessionId] ?? []).sorted(by: { $0.createdAt < $1.createdAt }) {
                walk(child, depth: depth + 1)
            }
        }
        for root in roots {
            walk(root, depth: 0)
        }
        return result
    }

    func childThreadCount(of conversation: BotConversation) -> Int {
        conversations(for: conversation.botId).filter { $0.parentSessionId == conversation.sessionId }.count
    }

    func toggleThreadChildren(_ conversation: BotConversation) {
        if collapsedThreads.contains(conversation.sessionId) {
            collapsedThreads.remove(conversation.sessionId)
        } else {
            collapsedThreads.insert(conversation.sessionId)
        }
    }

    func toggleCollapsed(_ botID: String) {
        if collapsedBots.contains(botID) {
            collapsedBots.remove(botID)
        } else {
            collapsedBots.insert(botID)
        }
    }

    func loadConversations(for botID: String) async {
        guard let list = try? await client.conversations(botID: botID) else { return }
        conversationLists[botID] = list.filter { $0.archivedAt == nil }
    }

    func mainSessionID(for bot: Bot) -> String? {
        bot.thread?.sessionId ?? conversations(for: bot.id).first(where: \.isMain)?.sessionId
    }

    func resolveMainSession(for bot: Bot) async -> String? {
        if let known = mainSessionID(for: bot) { return known }
        if let thread = await client.thread(botID: bot.id)?.sessionId { return thread }
        return (try? await client.sessions(botID: bot.id))?.first?.sessionId
    }

    func store(for bot: Bot, sessionID: String) -> ConversationStore {
        if let existing = stores[sessionID] { return existing }
        let store = makeStore(bot: bot, sessionID: sessionID)
        stores[sessionID] = store
        return store
    }

    func draftStore(for bot: Bot, onCreated: @escaping @MainActor (String) -> Void) -> ConversationStore {
        if let existing = drafts[bot.id], existing.sessionId == nil { return existing }
        let store = makeStore(bot: bot, sessionID: nil, settled: true)
        let client = client
        let botID = bot.id
        store.createSession = { [weak self] text, skills, attachments in
            let created = try await client.createConversation(botID: botID, message: text, skills: skills, attachments: attachments)
            self?.adoptDraft(created, store: store)
            onCreated(created.sessionId)
            return created.sessionId
        }
        drafts[bot.id] = store
        return store
    }

    private func adoptDraft(_ created: BotConversation, store: ConversationStore) {
        drafts[created.botId] = nil
        stores[created.sessionId] = store
        openSessions.insert(created.sessionId)
        upsertConversation(created)
    }

    func open(_ store: ConversationStore) {
        if let id = store.sessionId {
            openSessions.insert(id)
        }
        store.resume()
        store.start()
    }

    func close(_ store: ConversationStore) {
        if let id = store.sessionId {
            openSessions.remove(id)
            markRead(bot: store.bot, sessionID: id)
        }
        store.suspend()
    }

    private func makeStore(bot: Bot, sessionID: String?, settled: Bool = false) -> ConversationStore {
        let store = ConversationStore(bot: bot, client: client, sessionId: sessionID, settled: settled)
        store.onBotUpdated = { [weak self] in
            self?.scheduleRefresh()
        }
        store.onNotify = { [weak self] event in
            guard let self, let current = self.bot(id: bot.id) else { return }
            switch event {
            case .reply(let text, _, _):
                LocalNotifier.post(title: current.name, body: String(text.prefix(180)), botID: current.id)
            case .approval(_, let prompt):
                LocalNotifier.post(title: "\(current.name) precisa de você", body: prompt, botID: current.id)
            case .question(_, let title, _):
                LocalNotifier.post(title: "\(current.name) perguntou", body: title, botID: current.id)
            case .failed(let text):
                LocalNotifier.post(title: current.name, body: text, botID: current.id)
            case .ciFailed:
                break
            }
        }
        store.onLiveReply = { [weak self, weak store] in
            guard let self, let store, let id = store.sessionId, self.openSessions.contains(id) else { return }
            self.markRead(bot: store.bot, sessionID: id)
        }
        return store
    }

    func markRead(bot: Bot, sessionID: String?) {
        let client = client
        let botID = bot.id
        let conversation = conversations(for: botID).first { $0.sessionId == sessionID }
        if let sessionID {
            updateConversation(botID: botID, sessionID: sessionID) { $0.unread = 0 }
        }
        if let index = bots.firstIndex(where: { $0.id == botID }), let thread = bots[index].thread, thread.unread > 0,
            conversation?.isMain != false
        {
            var copy = BotThread(sessionId: thread.sessionId, lastMessage: thread.lastMessage, unread: 0)
            copy.running = thread.running
            copy.status = thread.status
            bots[index].thread = copy
        }
        Task {
            if let conversation, !conversation.isMain {
                try? await client.conversationAction(botID: botID, sessionID: conversation.sessionId, action: "read")
            } else {
                await client.markRead(botID: botID)
            }
        }
    }

    func unread(for bot: Bot) -> Int {
        let lists = conversations(for: bot.id)
        if lists.count > 1 {
            return lists.reduce(0) { $0 + $1.unread }
        }
        return bot.thread?.unread ?? 0
    }

    func status(for botID: String) -> BotStatus {
        var result = serverStatus(for: botID)
        for (sessionID, store) in stores where store.bot.id == botID && openSessions.contains(sessionID) {
            result = max(result, store.botStatus)
        }
        return result
    }

    func status(of conversation: BotConversation) -> BotStatus {
        let local = stores[conversation.sessionId]?.botStatus ?? .idle
        let remote = sessionStatuses[conversation.sessionId] ?? (statusStreamLive ? .idle : conversation.serverStatus)
        return max(local, remote)
    }

    func mood(for botID: String) -> CharacterMood {
        switch status(for: botID) {
        case .working: .thinking
        case .awaitingApproval: .waiting
        case .error: .error
        case .idle: .idle
        }
    }

    private func serverStatus(for botID: String) -> BotStatus {
        if let live = liveStatuses[botID] { return live }
        guard !statusStreamLive, let thread = bot(id: botID)?.thread else { return .idle }
        if thread.status == "awaiting" { return .awaitingApproval }
        return thread.running ? .working : .idle
    }

    func activity(for bot: Bot) -> ThreadActivity? {
        let latest = conversations(for: bot.id)
            .filter { $0.lastMessage != nil }
            .max { ($0.activityDate ?? .distantPast) < ($1.activityDate ?? .distantPast) }
        if let message = latest?.lastMessage, !message.text.isEmpty {
            return ThreadActivity(text: message.text, isUser: message.role == "user", date: message.date)
        }
        guard let message = bot.thread?.lastMessage, !message.text.isEmpty else { return nil }
        return ThreadActivity(text: message.text, isUser: message.role == "user", date: message.date)
    }

    func activityDate(for bot: Bot) -> Date? {
        activity(for: bot)?.date
    }

    private func updateConversation(botID: String, sessionID: String, change: (inout BotConversation) -> Void) {
        guard var list = conversationLists[botID], let index = list.firstIndex(where: { $0.sessionId == sessionID }) else { return }
        change(&list[index])
        conversationLists[botID] = list
    }

    private func upsertConversation(_ conversation: BotConversation) {
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

    private func startStatusStream() {
        statusTask?.cancel()
        let client = client
        statusTask = Task { [weak self] in
            var failures = 0
            while !Task.isCancelled {
                do {
                    let request = try client.statusStreamRequest()
                    let (bytes, response) = try await HTTPSessions.streaming.bytes(for: request)
                    AuthStore.reportUnauthorized(response)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                        throw BotsClient.ClientError.http((response as? HTTPURLResponse)?.statusCode ?? 0, nil)
                    }
                    failures = 0
                    for try await line in bytes.lines {
                        guard let data = line.data(using: .utf8),
                            let value = try? JSONDecoder().decode(JSONValue.self, from: data)
                        else { continue }
                        self?.applyStatus(value)
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

    private func applyStatus(_ value: JSONValue) {
        switch value["type"]?.stringValue {
        case "snapshot":
            var next: [String: BotStatus] = [:]
            if case .object(let items) = value["bots"] ?? .null {
                for (id, status) in items {
                    next[id] = Self.botStatus(status.stringValue)
                }
            }
            var sessions: [String: BotStatus] = [:]
            if case .object(let items) = value["sessions"] ?? .null {
                for (id, item) in items {
                    sessions[id] = Self.botStatus(item["status"]?.stringValue)
                }
            }
            withAnimation(Motion.spring) {
                liveStatuses = next.filter { $0.value != .idle }
                sessionStatuses = sessions.filter { $0.value != .idle }
                statusStreamLive = true
            }
        case "session":
            guard let id = value["sessionId"]?.stringValue else { return }
            let status = Self.botStatus(value["status"]?.stringValue)
            withAnimation(Motion.spring) {
                sessionStatuses[id] = status == .idle ? nil : status
            }
        case "conversation":
            if let conversation = value["conversation"].flatMap(BotConversation.init) {
                withAnimation(Motion.spring) {
                    upsertConversation(conversation)
                }
            } else if let botID = value["botId"]?.stringValue, let sessionID = value["sessionId"]?.stringValue {
                conversationLists[botID]?.removeAll { $0.sessionId == sessionID }
            }
        case "status":
            guard let id = value["botId"]?.stringValue else { return }
            let status = Self.botStatus(value["status"]?.stringValue)
            let previous = liveStatuses[id] ?? .idle
            withAnimation(Motion.spring) {
                liveStatuses[id] = status == .idle ? nil : status
            }
            if previous != status, status != .working {
                scheduleRefresh()
                notify(botID: id, from: previous, to: status)
            }
        case "settings":
            let areas = value["areas"]?.arrayValue?.compactMap(\.stringValue) ?? []
            if areas.contains(where: { ["bots", "conversations"].contains($0) }) {
                scheduleRefresh()
            }
            if areas.contains("sections") {
                Task { await loadSections() }
            }
        default:
            break
        }
    }

    private func notify(botID: String, from previous: BotStatus, to status: BotStatus) {
        guard let bot = bot(id: botID) else { return }
        guard !stores.contains(where: { openSessions.contains($0.key) && $0.value.bot.id == botID }) else { return }
        if status == .awaitingApproval {
            LocalNotifier.post(title: "\(bot.name) precisa de você", body: "Tem um pedido esperando sua resposta.", botID: botID)
        } else if previous == .working, status == .idle {
            Task {
                await refresh()
                let text = self.bot(id: botID).flatMap { activity(for: $0)?.text } ?? "Terminou o que você pediu."
                LocalNotifier.post(title: bot.name, body: String(text.prefix(180)), botID: botID)
            }
        }
    }

    private static func botStatus(_ text: String?) -> BotStatus {
        switch text {
        case "working", "queued": .working
        case "awaiting": .awaitingApproval
        default: .idle
        }
    }

    func loadAccounts() async {
        if let list = try? await client.accounts() { accounts = list }
    }

    func replace(_ bot: Bot) {
        if let index = bots.firstIndex(where: { $0.id == bot.id }) {
            bots[index] = bot
        } else {
            bots.append(bot)
        }
    }

    func updateBot(_ id: String, body: JSONValue) async throws {
        let updated = try await client.updateBot(id: id, body: body)
        withAnimation(Motion.spring) { replace(updated) }
    }

    func createBot(_ body: JSONValue) async throws -> Bot {
        let created = try await client.createBot(body)
        withAnimation(Motion.spring) { replace(created) }
        return created
    }

    func archiveBot(_ id: String) async throws {
        try await client.archiveBot(id: id)
        withAnimation(Motion.spring) { bots.removeAll { $0.id == id } }
    }

    func permission(botID: String, sessionID: String?) -> PermissionMode {
        if let sessionID, let found = conversations(for: botID).first(where: { $0.sessionId == sessionID }) {
            return found.effectivePermission
        }
        return bot(id: botID)?.permission ?? .standard
    }

    func setPermission(_ mode: PermissionMode, botID: String, sessionID: String) async throws {
        let previous = conversations(for: botID).first { $0.sessionId == sessionID }
        updateConversation(botID: botID, sessionID: sessionID) {
            $0.permission = mode
            $0.effectivePermission = mode
        }
        do {
            try await client.updateConversation(botID: botID, sessionID: sessionID, body: .object(["permission": .string(mode.rawValue)]))
        } catch {
            if let previous { updateConversation(botID: botID, sessionID: sessionID) { $0 = previous } }
            throw error
        }
    }
}
