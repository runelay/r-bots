import Foundation

struct BotCapabilitySet: Hashable, Sendable, Decodable {
    var browser: Bool
    var delegate: [String]
    var desktop = false

    init(browser: Bool, delegate: [String]) {
        self.browser = browser
        self.delegate = delegate
    }

    private enum CodingKeys: String, CodingKey {
        case browser, delegate, desktop
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        browser = (try? container.decodeIfPresent(Bool.self, forKey: .browser)) ?? false
        delegate = (try? container.decodeIfPresent([String].self, forKey: .delegate)) ?? []
        desktop = (try? container.decodeIfPresent(Bool.self, forKey: .desktop)) ?? false
    }

    var json: JSONValue {
        .object([
            "browser": .bool(browser),
            "delegate": .array(delegate.map { .string($0) })
        ])
    }
}

struct BotGroup: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    var name: String
    var members: [String]
    var thread: BotThread?
    var sessionBasePath: String
    var archivedAt: String?
    var pinned = false
    var sectionId: String?
    var hidden = false

    private enum CodingKeys: String, CodingKey {
        case id, name, members, thread, sessionBasePath, archivedAt, sidebar, pinned, sectionId, hidden
    }

    init(id: String, name: String, members: [String]) {
        self.id = id
        self.name = name
        self.members = members
        thread = nil
        sessionBasePath = "/groups/\(id)/eve/v1"
        archivedAt = nil
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        self.id = id
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? id
        members = (try? container.decodeIfPresent([String].self, forKey: .members)) ?? []
        thread = try? container.decodeIfPresent(BotThread.self, forKey: .thread)
        sessionBasePath = (try? container.decodeIfPresent(String.self, forKey: .sessionBasePath)) ?? "/groups/\(id)/eve/v1"
        archivedAt = try? container.decodeIfPresent(String.self, forKey: .archivedAt)
        let sidebar = try? container.decodeIfPresent(JSONValue.self, forKey: .sidebar)
        pinned = sidebar?["pinned"]?.boolValue ?? (try? container.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
        sectionId = sidebar?["sectionId"]?.stringValue ?? (try? container.decodeIfPresent(String.self, forKey: .sectionId))
        hidden = sidebar?["hidden"]?.boolValue ?? (try? container.decodeIfPresent(Bool.self, forKey: .hidden)) ?? false
    }
}

struct BotMemory: Hashable, Sendable, Decodable {
    var capture: Bool
    var recall: Bool

    private enum CodingKeys: String, CodingKey {
        case capture, recall
    }

    init(capture: Bool, recall: Bool) {
        self.capture = capture
        self.recall = recall
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        capture = (try? container.decodeIfPresent(Bool.self, forKey: .capture)) ?? true
        recall = (try? container.decodeIfPresent(Bool.self, forKey: .recall)) ?? true
    }
}

struct BotConnectors: Hashable, Sendable, Decodable {
    var allowed: [String]
    var memory: Bool

    private enum CodingKeys: String, CodingKey {
        case allowed, memory
    }

    init(allowed: [String], memory: Bool) {
        self.allowed = allowed
        self.memory = memory
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        allowed = (try? container.decodeIfPresent([String].self, forKey: .allowed)) ?? []
        memory = (try? container.decodeIfPresent(Bool.self, forKey: .memory)) ?? true
    }

    var json: JSONValue {
        .object(["allowed": .array(allowed.map { .string($0) }), "memory": .bool(memory)])
    }
}

struct Connector: Identifiable, Hashable, Sendable, Decodable {
    let name: String
    let label: String
    let icon: String?
    let status: String
    let toolCount: Int?
    let reconnectUrl: String?

    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, label, icon, status, toolCount, reconnectUrl
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        let serverLabel = try? container.decodeIfPresent(String.self, forKey: .label)
        label = ConnectorNames.isKnown(name) ? ConnectorNames.pretty(name) : (serverLabel ?? ConnectorNames.pretty(name))
        icon = try? container.decodeIfPresent(String.self, forKey: .icon)
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "ok"
        toolCount = try? container.decodeIfPresent(Int.self, forKey: .toolCount)
        reconnectUrl = try? container.decodeIfPresent(String.self, forKey: .reconnectUrl)
    }

    var statusLabel: String {
        switch status {
        case "ok": "Conectado"
        case "needs_auth": "Reconectar"
        default: "Erro"
        }
    }
}

enum ConnectorNames {
    static func isKnown(_ name: String) -> Bool {
        friendly[name.lowercased()] != nil
    }

    static func key(_ name: String) -> String {
        var lowered = name.lowercased()
        if lowered.contains("/") {
            lowered = (lowered as NSString).lastPathComponent
            lowered = (lowered as NSString).deletingPathExtension
        }
        for suffix in ["_server", "-server", "_mcp", "-mcp"] where lowered.hasSuffix(suffix) {
            return String(lowered.dropLast(suffix.count))
        }
        return lowered
    }

    private static let friendly: [String: String] = [
        "cloudflare_docs": "Cloudflare Docs",
        "conty_backoffice": "Conty Backoffice",
        "conty_ben": "Conty BEN",
        "google_calendar": "Google Calendar",
        "linear_server": "Linear",
        "meta_social_technologies": "Meta"
    ]

    static func pretty(_ name: String) -> String {
        if let known = friendly[name.lowercased()] {
            return known
        }
        return key(name)
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }
}

struct BotSection: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    var name: String
    var archivedAt: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, archivedAt
    }

    init(id: String, name: String) {
        self.id = id
        self.name = name
        archivedAt = nil
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? id
        archivedAt = try? container.decodeIfPresent(String.self, forKey: .archivedAt)
    }
}

struct BotDecisions: Hashable, Sendable, Decodable {
    var autoApprove: Bool
    var threshold: Double?

    private enum CodingKeys: String, CodingKey {
        case autoApprove, threshold
    }

    init(autoApprove: Bool, threshold: Double?) {
        self.autoApprove = autoApprove
        self.threshold = threshold
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        autoApprove = (try? container.decodeIfPresent(Bool.self, forKey: .autoApprove)) ?? true
        threshold = try? container.decodeIfPresent(Double.self, forKey: .threshold)
    }
}

struct ThreadMessage: Hashable, Sendable, Decodable {
    let role: String
    let text: String
    let at: String?

    var date: Date? { at.flatMap(ISODate.parse) }

    private enum CodingKeys: String, CodingKey {
        case role, text, at
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = (try? container.decodeIfPresent(String.self, forKey: .role)) ?? "assistant"
        text = (try? container.decodeIfPresent(String.self, forKey: .text)) ?? ""
        at = try? container.decodeIfPresent(String.self, forKey: .at)
    }
}

struct BotThread: Hashable, Sendable, Decodable {
    let sessionId: String?
    let lastMessage: ThreadMessage?
    let unread: Int
    var running = false
    var status: String? = nil

    private enum CodingKeys: String, CodingKey {
        case sessionId, lastMessage, unread, running, status
    }

    init(sessionId: String?, lastMessage: ThreadMessage?, unread: Int) {
        self.sessionId = sessionId
        self.lastMessage = lastMessage
        self.unread = unread
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try? container.decodeIfPresent(String.self, forKey: .sessionId)
        lastMessage = try? container.decodeIfPresent(ThreadMessage.self, forKey: .lastMessage)
        unread = (try? container.decodeIfPresent(Int.self, forKey: .unread)) ?? 0
        running = (try? container.decodeIfPresent(Bool.self, forKey: .running)) ?? false
        status = try? container.decodeIfPresent(String.self, forKey: .status)
    }
}

struct Bot: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    var name: String
    var role: String
    var accent: String
    let sessionBasePath: String
    var schedules: [BotSchedule]
    var hasBrowser: Bool
    var instructions: String
    var capabilities: BotCapabilitySet?
    var glyph: String?
    var archivedAt: String?
    var thread: BotThread?
    var engine: BotEngine?
    var decisions: BotDecisions?
    var connectors: BotConnectors?
    var memorySettings: BotMemory?
    var groupMembers: [String]?
    var pinned = false
    var sectionId: String?
    var hidden = false
    var deletedAt: String?
    var isPending = false
    var codeBadge: CodeBadge?
    var conversations: [BotConversation] = []
    var permission: PermissionMode = .standard

    private enum CodingKeys: String, CodingKey {
        case id, name, role, accent, sessionBasePath, schedules, hasBrowser
        case instructions, capabilities, glyph, archivedAt, thread, engine, decisions
        case sidebar, pinned, sectionId, hidden, deletedAt, connectors, memory, code
        case conversations, permission
    }

    init(
        id: String,
        name: String,
        role: String,
        accent: String,
        schedules: [BotSchedule],
        instructions: String,
        capabilities: BotCapabilitySet,
        isPending: Bool
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.accent = accent
        sessionBasePath = "/bots/\(id)/eve/v1"
        self.schedules = schedules
        hasBrowser = capabilities.browser
        self.instructions = instructions
        self.capabilities = capabilities
        glyph = "auto"
        archivedAt = nil
        thread = nil
        self.isPending = isPending
    }

    init(group: BotGroup) {
        id = "group:\(group.id)"
        name = group.name
        role = ""
        accent = "grey"
        sessionBasePath = group.sessionBasePath
        schedules = []
        hasBrowser = false
        instructions = ""
        capabilities = nil
        glyph = nil
        archivedAt = group.archivedAt
        thread = group.thread
        groupMembers = group.members
        pinned = group.pinned
        sectionId = group.sectionId
        hidden = group.hidden
    }

    var groupID: String? {
        isGroup ? String(id.dropFirst("group:".count)) : nil
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        self.id = id
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? id
        role = (try? container.decodeIfPresent(String.self, forKey: .role)) ?? ""
        accent = (try? container.decodeIfPresent(String.self, forKey: .accent)) ?? "electric"
        sessionBasePath = (try? container.decodeIfPresent(String.self, forKey: .sessionBasePath)) ?? "/bots/\(id)/eve/v1"
        schedules = ((try? container.decodeIfPresent([Lossy<BotSchedule>].self, forKey: .schedules)) ?? [])
            .compactMap(\.value)
        capabilities = try? container.decodeIfPresent(BotCapabilitySet.self, forKey: .capabilities)
        hasBrowser = (try? container.decodeIfPresent(Bool.self, forKey: .hasBrowser)) ?? capabilities?.browser ?? false
        instructions = (try? container.decodeIfPresent(String.self, forKey: .instructions)) ?? ""
        glyph = (try? container.decodeIfPresent(String.self, forKey: .glyph)).map(CharacterGlyph.canonicalFace)
        archivedAt = try? container.decodeIfPresent(String.self, forKey: .archivedAt)
        thread = try? container.decodeIfPresent(BotThread.self, forKey: .thread)
        engine = try? container.decodeIfPresent(BotEngine.self, forKey: .engine)
        decisions = try? container.decodeIfPresent(BotDecisions.self, forKey: .decisions)
        let sidebar = try? container.decodeIfPresent(JSONValue.self, forKey: .sidebar)
        pinned = sidebar?["pinned"]?.boolValue ?? (try? container.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
        sectionId = sidebar?["sectionId"]?.stringValue ?? (try? container.decodeIfPresent(String.self, forKey: .sectionId))
        hidden = sidebar?["hidden"]?.boolValue ?? (try? container.decodeIfPresent(Bool.self, forKey: .hidden)) ?? false
        deletedAt = try? container.decodeIfPresent(String.self, forKey: .deletedAt)
        connectors = try? container.decodeIfPresent(BotConnectors.self, forKey: .connectors)
        memorySettings = try? container.decodeIfPresent(BotMemory.self, forKey: .memory)
        codeBadge = CodeBadge(try? container.decodeIfPresent(JSONValue.self, forKey: .code))
        conversations = ((try? container.decodeIfPresent(JSONValue.self, forKey: .conversations))?.arrayValue ?? []).compactMap(BotConversation.init)
        permission = PermissionMode(server: try? container.decodeIfPresent(String.self, forKey: .permission))
    }

    var isGroup: Bool { groupMembers != nil }

    var hasDesktop: Bool { capabilities?.desktop == true }

    var hasComputer: Bool { hasBrowser || hasDesktop }

    var isDeleted: Bool { deletedAt != nil }

    var initial: String {
        String(name.prefix(1)).uppercased()
    }

    var isArchived: Bool { archivedAt != nil }

    var memberRoot: String {
        if let range = sessionBasePath.range(of: "/eve/v1") {
            return String(sessionBasePath[..<range.lowerBound])
        }
        return "/bots/\(id)"
    }

    func resolve(memberPath path: String) -> String {
        guard path.hasPrefix("/eve/") else { return path }
        return memberRoot + path
    }
}

struct MetaCapability: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    let label: String
    let description: String

    private enum CodingKeys: String, CodingKey {
        case id, label, description
    }

    init(id: String, label: String, description: String) {
        self.id = id
        self.label = label
        self.description = description
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? id
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? ""
    }
}

struct ServerMeta: Sendable, Decodable {
    let accents: [String]
    let capabilities: [MetaCapability]
    var engine: String? = nil
    var model: String? = nil
    var version: String? = nil
    var integrations: [String: Bool]? = nil

    private enum CodingKeys: String, CodingKey {
        case accents, capabilities, engine, model, version, integrations
    }

    init(accents: [String], capabilities: [MetaCapability], engine: String? = nil, model: String? = nil, version: String? = nil, integrations: [String: Bool]? = nil) {
        self.accents = accents
        self.capabilities = capabilities
        self.engine = engine
        self.model = model
        self.version = version
        self.integrations = integrations
    }

    func integrationOn(_ id: String) -> Bool {
        integrations?[id] ?? true
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accents = (try? container.decodeIfPresent([String].self, forKey: .accents)) ?? []
        capabilities = ((try? container.decodeIfPresent([Lossy<MetaCapability>].self, forKey: .capabilities)) ?? [])
            .compactMap(\.value)
        engine = try? container.decodeIfPresent(String.self, forKey: .engine)
        model = try? container.decodeIfPresent(String.self, forKey: .model)
        version = try? container.decodeIfPresent(String.self, forKey: .version)
        integrations = try? container.decodeIfPresent([String: Bool].self, forKey: .integrations)
    }

    var engineLabel: String? {
        switch engine {
        case "claude-agent-sdk": "Claude · assinatura"
        case "eve": "eve"
        case .some(let value): value
        case .none: nil
        }
    }

    static let fallback = ServerMeta(
        accents: ["electric", "teal", "violet", "royal", "sky", "indigo"],
        capabilities: [
            MetaCapability(id: "browser", label: "Navegador", description: "Abre páginas, clica, preenche e tira print."),
            MetaCapability(id: "delegate", label: "Delegar", description: "Passa partes do trabalho para outros bots do time.")
        ]
    )
}

struct BotSchedule: Identifiable, Hashable, Sendable, Decodable {
    let name: String
    let cron: String
    let timezone: String?
    let description: String?
    let prompt: String?

    var id: String { "\(name)|\(cron)" }

    var timeZone: TimeZone? {
        timezone.flatMap { TimeZone(identifier: $0) }
    }

    private enum CodingKeys: String, CodingKey {
        case name, cron, timezone, description, prompt
    }

    init(name: String, cron: String, timezone: String?, description: String?, prompt: String?) {
        self.name = name
        self.cron = cron
        self.timezone = timezone
        self.description = description
        self.prompt = prompt
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cron = (try? container.decodeIfPresent(String.self, forKey: .cron)) ?? ""
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? "rotina"
        timezone = try? container.decodeIfPresent(String.self, forKey: .timezone)
        prompt = try? container.decodeIfPresent(String.self, forKey: .prompt)
        description = try? container.decodeIfPresent(String.self, forKey: .description)
    }
}

struct SessionSummary: Identifiable, Hashable, Sendable, Decodable {
    let sessionId: String
    let title: String
    let startedAt: String?
    let source: String
    let scheduleId: String?

    var id: String { sessionId }

    var isSchedule: Bool { source == "schedule" || scheduleId != nil }

    var startedDate: Date? { startedAt.flatMap(ISODate.parse) }

    private enum CodingKeys: String, CodingKey {
        case sessionId, id, title, startedAt, source, scheduleId
    }

    init(sessionId: String, title: String, startedAt: String?, source: String) {
        self.sessionId = sessionId
        self.title = title
        self.startedAt = startedAt
        self.source = source
        scheduleId = nil
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? container.decodeIfPresent(String.self, forKey: .sessionId) {
            sessionId = value
        } else {
            sessionId = try container.decode(String.self, forKey: .id)
        }
        title = (try? container.decodeIfPresent(String.self, forKey: .title)) ?? ""
        startedAt = try? container.decodeIfPresent(String.self, forKey: .startedAt)
        source = (try? container.decodeIfPresent(String.self, forKey: .source)) ?? "chat"
        scheduleId = try? container.decodeIfPresent(String.self, forKey: .scheduleId)
    }
}

struct BrowserInfo: Sendable, Equatable, Decodable {
    let url: String?
    let title: String?
    let updatedAt: String?
    let screenshotPath: String?
    var alive: Bool? = nil

    var updatedDate: Date? { updatedAt.flatMap(ISODate.parse) }
}

enum LoadState<Value> {
    case idle
    case loading
    case loaded(Value)
    case failed(String)
}

enum BotStatus: Int, Comparable, Sendable {
    case idle
    case working
    case awaitingApproval
    case error

    static func < (lhs: BotStatus, rhs: BotStatus) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    var label: String {
        switch self {
        case .idle: "Disponível"
        case .working: "Trabalhando"
        case .awaitingApproval: "Esperando aprovação"
        case .error: "Com erro"
        }
    }
}

enum ConnectionStatus: Equatable {
    case unknown
    case checking
    case online(Int)
    case offline(String)
}

struct Lossy<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: any Decoder) throws {
        value = try? Value(from: decoder)
    }
}

enum ISODate {
    static func parse(_ text: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) {
            return date
        }
        return try? Date.ISO8601FormatStyle().parse(text)
    }

    static func now() -> String {
        Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}
