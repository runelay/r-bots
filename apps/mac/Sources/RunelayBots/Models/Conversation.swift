import Foundation

enum PermissionMode: String, CaseIterable, Identifiable, Hashable, Sendable {
    case readonly
    case edit
    case standard = "default"
    case full

    var id: String { rawValue }

    var title: String {
        switch self {
        case .readonly: "Somente leitura"
        case .edit: "Editar"
        case .standard: "Padrão"
        case .full: "Acesso total"
        }
    }

    var systemImage: String {
        switch self {
        case .readonly: "lock"
        case .edit: "pencil"
        case .standard: "checkmark.shield"
        case .full: "shield.slash"
        }
    }

    var detail: String {
        switch self {
        case .readonly: "Lê, busca e roda comandos de leitura. Não edita, não faz commit e não escreve em conectores."
        case .edit: "Edita os arquivos direto. Comandos, commit, push e escrita em conectores pedem sua confirmação."
        case .standard: "Faz o trabalho sozinho e só pede para o que é arriscado: push forçado, deploy, produção e mensagem para fora."
        case .full: "Nada pede confirmação. Só continua proibido o que fere as suas regras fixas."
        }
    }

    var next: PermissionMode {
        let all = Self.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }

    init(server: String?) {
        self = server.flatMap(PermissionMode.init(rawValue:)) ?? .standard
    }
}

struct BotConversation: Identifiable, Hashable, Sendable {
    let sessionId: String
    var botId: String
    var title: String
    var isMain: Bool
    var createdAt: String
    var updatedAt: String?
    var lastMessage: ThreadMessage?
    var unread: Int
    var status: String
    var archivedAt: String?
    var permission: PermissionMode?
    var effectivePermission: PermissionMode
    var delegatedByName: String?
    var repoName: String?

    var id: String { sessionId }

    var activityDate: Date? {
        lastMessage?.date ?? updatedAt.flatMap(ISODate.parse) ?? ISODate.parse(createdAt)
    }

    var serverStatus: BotStatus {
        switch status {
        case "working", "queued": .working
        case "awaiting": .awaitingApproval
        default: .idle
        }
    }

    init?(_ json: JSONValue) {
        guard let sessionId = json["sessionId"]?.stringValue, let botId = json["botId"]?.stringValue else { return nil }
        self.sessionId = sessionId
        self.botId = botId
        title = json["title"]?.stringValue ?? "Nova conversa"
        isMain = json["main"]?.boolValue ?? false
        createdAt = json["createdAt"]?.stringValue ?? ""
        updatedAt = json["updatedAt"]?.stringValue
        if let message = json["lastMessage"], message != .null, let data = try? JSONEncoder().encode(message) {
            lastMessage = try? JSONDecoder().decode(ThreadMessage.self, from: data)
        }
        unread = json["unread"]?.intValue ?? 0
        status = json["status"]?.stringValue ?? "idle"
        archivedAt = json["archivedAt"]?.stringValue
        permission = json["permission"]?.stringValue.flatMap(PermissionMode.init(rawValue:))
        effectivePermission = PermissionMode(server: json["effectivePermission"]?.stringValue)
        delegatedByName = json["delegatedBy"]?["name"]?.stringValue
        repoName = json["code"]?["repoName"]?.stringValue
    }
}

extension BotsClient {
    private func conversationSend(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> JSONValue {
        var urlRequest = try request(path: path)
        urlRequest.httpMethod = method
        if let body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(http.statusCode) else {
            throw ClientError.http(http.statusCode, json["error"]?.stringValue)
        }
        return json
    }

    private static func conversationsRoot(_ botID: String) -> String {
        "/bots/\(botID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? botID)/conversations"
    }

    func conversations(botID: String) async throws -> [BotConversation] {
        try await conversationSend(Self.conversationsRoot(botID)).arrayValue?.compactMap(BotConversation.init) ?? []
    }

    func createConversation(botID: String, permission: PermissionMode? = nil, message: String = "", skills: [String] = [], attachments: [String] = []) async throws -> BotConversation {
        var body: [String: JSONValue] = [:]
        if let permission { body["permission"] = .string(permission.rawValue) }
        if !message.isEmpty { body["message"] = .string(message) }
        if !skills.isEmpty { body["skills"] = .array(skills.map(JSONValue.string)) }
        if !attachments.isEmpty { body["attachments"] = .array(attachments.map(JSONValue.string)) }
        guard let conversation = BotConversation(try await conversationSend(Self.conversationsRoot(botID), method: "POST", body: .object(body))) else {
            throw ClientError.invalidResponse
        }
        return conversation
    }

    @discardableResult
    func updateConversation(botID: String, sessionID: String, body: JSONValue) async throws -> BotConversation? {
        BotConversation(try await conversationSend("\(Self.conversationsRoot(botID))/\(sessionID)", method: "PATCH", body: body))
    }

    @discardableResult
    func conversationAction(botID: String, sessionID: String, action: String, body: JSONValue? = nil) async throws -> BotConversation? {
        BotConversation(try await conversationSend("\(Self.conversationsRoot(botID))/\(sessionID)/\(action)", method: "POST", body: body ?? .object([:])))
    }
}
