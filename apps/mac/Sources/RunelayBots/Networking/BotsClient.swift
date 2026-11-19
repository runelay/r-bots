import UniformTypeIdentifiers
import Foundation

struct BotsClient: Sendable {
    enum ClientError: LocalizedError {
        case invalidURL
        case invalidResponse
        case http(Int, String?)
        case missingSession
        case unsupported
        case validation(String, String?)

        var errorDescription: String? {
            switch self {
            case .invalidURL:
                return "O endereço do servidor não parece válido."
            case .invalidResponse:
                return "O servidor mandou uma resposta estranha."
            case .http(let status, let message):
                if let message, !message.isEmpty {
                    return message
                }
                return "O servidor respondeu com erro \(status)."
            case .missingSession:
                return "O servidor não devolveu o id da conversa."
            case .unsupported:
                return "O servidor ainda não aceita essa ação."
            case .validation(let message, _):
                return message
            }
        }
    }

    let baseURL: URL

    func bots(archived: Bool = false, hidden: Bool = false) async throws -> [Bot] {
        var flags: [String] = []
        if archived {
            flags.append("archived=1")
        }
        if hidden {
            flags.append("hidden=1")
        }
        return try await getList(flags.isEmpty ? "/bots" : "/bots?" + flags.joined(separator: "&"), as: Bot.self)
    }

    func searchBots(_ query: String) async throws -> [Bot] {
        let (data, response) = try await perform(try request(path: "/bots", query: [URLQueryItem(name: "q", value: query)]))
        try validate(response, data: data)
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Lossy<Bot>].self, from: data) {
            return list.compactMap(\.value)
        }
        return try decoder.decode(WrappedList<Bot>.self, from: data).items
    }

    func accounts() async throws -> [AIAccount]? {
        let (data, response) = try await perform(try request(path: "/accounts"))
        if response.statusCode == 404 {
            return nil
        }
        try validate(response, data: data)
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Lossy<AIAccount>].self, from: data) {
            return list.compactMap(\.value)
        }
        return try decoder.decode(WrappedList<AIAccount>.self, from: data).items
    }

    func refreshAccounts() async throws -> Bool {
        var urlRequest = try request(path: "/accounts/refresh")
        urlRequest.httpMethod = "POST"
        let (data, response) = try await perform(urlRequest)
        if response.statusCode == 404 {
            return false
        }
        try validate(response, data: data)
        return true
    }

    func meta() async -> ServerMeta? {
        guard let result = try? await perform(try request(path: "/meta")),
              (200..<300).contains(result.1.statusCode)
        else { return nil }
        return try? JSONDecoder().decode(ServerMeta.self, from: result.0)
    }

    func thread(botID: String) async -> BotThread? {
        guard let result = try? await perform(try request(path: "/bots/\(Self.escape(botID))/thread")),
              (200..<300).contains(result.1.statusCode)
        else { return nil }
        return try? JSONDecoder().decode(BotThread.self, from: result.0)
    }

    func markRead(botID: String) async {
        _ = try? await post("\(Self.threadRoot(botID))/thread/read", body: nil)
    }

    func resetThread(botID: String) async throws -> ThreadSwap {
        try await threadSwap("/bots/\(Self.escape(botID))/thread/reset", body: nil)
    }

    func restoreThread(botID: String, archiveID: String) async throws -> ThreadSwap {
        try await threadSwap("/bots/\(Self.escape(botID))/thread/restore", body: .object(["archiveId": .string(archiveID)]))
    }

    private func threadSwap(_ path: String, body: JSONValue?) async throws -> ThreadSwap {
        let (json, _) = try await post(path, body: body)
        guard let json, let encoded = try? JSONEncoder().encode(json),
              let thread = try? JSONDecoder().decode(BotThread.self, from: encoded),
              thread.sessionId != nil
        else { throw ClientError.invalidResponse }
        return ThreadSwap(thread: thread, archiveID: json["archiveId"]?.stringValue)
    }

    private static func threadRoot(_ botID: String) -> String {
        if botID.hasPrefix("group:") {
            return "/groups/\(escape(String(botID.dropFirst(6))))"
        }
        return "/bots/\(escape(botID))"
    }

    func createBot(_ body: JSONValue) async throws -> Bot {
        guard let bot = try await botMutation("/bots", method: "POST", body: body) else {
            throw ClientError.invalidResponse
        }
        return bot
    }

    func updateBot(id: String, body: JSONValue) async throws -> Bot {
        guard let bot = try await botMutation("/bots/\(Self.escape(id))", method: "PATCH", body: body) else {
            throw ClientError.invalidResponse
        }
        return bot
    }

    func groups() async -> [BotGroup]? {
        guard let result = try? await perform(try request(path: "/groups")),
              (200..<300).contains(result.1.statusCode)
        else { return nil }
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Lossy<BotGroup>].self, from: result.0) {
            return list.compactMap(\.value)
        }
        return (try? decoder.decode(WrappedList<BotGroup>.self, from: result.0))?.items
    }

    func createGroup(name: String, members: [String]) async throws -> BotGroup {
        try await groupMutation("/groups", method: "POST", body: .object([
            "name": .string(name),
            "members": .array(members.map { .string($0) })
        ]))
    }

    func updateGroup(id: String, body: JSONValue) async throws {
        _ = try await groupMutation("/groups/\(Self.escape(id))", method: "PATCH", body: body)
    }

    func archiveGroup(id: String) async throws {
        _ = try await botMutation("/groups/\(Self.escape(id))/archive", method: "POST", body: nil, decodeBot: false)
    }

    @discardableResult
    private func groupMutation(_ path: String, method: String, body: JSONValue) async throws -> BotGroup {
        var urlRequest = try request(path: path)
        urlRequest.httpMethod = method
        urlRequest.httpBody = try JSONEncoder().encode(body)
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await perform(urlRequest)
        if response.statusCode == 404 || response.statusCode == 405 {
            throw ClientError.unsupported
        }
        if response.statusCode == 400 {
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw ClientError.validation(json?["error"]?.stringValue ?? "Confira os campos.", json?["field"]?.stringValue)
        }
        try validate(response, data: data)
        let json = try? JSONDecoder().decode(JSONValue.self, from: data)
        if let wrapped = json?["group"], let encoded = try? JSONEncoder().encode(wrapped) {
            return try JSONDecoder().decode(BotGroup.self, from: encoded)
        }
        return try JSONDecoder().decode(BotGroup.self, from: data)
    }

    private static func messageBody(_ message: String, skills: [String], attachments: [String] = []) -> JSONValue {
        var fields: [String: JSONValue] = [:]
        if !message.isEmpty {
            fields["message"] = .string(message)
        }
        if !skills.isEmpty {
            fields["skills"] = .array(skills.map { .string($0) })
        }
        if !attachments.isEmpty {
            fields["attachments"] = .array(attachments.map { .string($0) })
        }
        return .object(fields)
    }

    func uploadAttachment(botID: String, fileURL: URL, name: String, onProgress: @escaping @Sendable (Double) -> Void) async throws -> AttachmentRef {
        var urlRequest = try request(path: "/bots/\(Self.escape(botID))/uploads")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 600
        let mime = UTType(filenameExtension: fileURL.pathExtension.lowercased())?.preferredMIMEType ?? "application/octet-stream"
        urlRequest.setValue(mime, forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "arquivo", forHTTPHeaderField: "X-File-Name")
        let delegate = UploadProgressDelegate(onProgress: onProgress)
        let (data, response) = try await URLSession.shared.upload(for: urlRequest, fromFile: fileURL, delegate: delegate)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        try validate(http, data: data)
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data), let ref = AttachmentRef(json: json) else {
            throw ClientError.invalidResponse
        }
        return ref
    }

    func absoluteURL(_ path: String) -> URL? {
        try? request(path: path).url
    }

    func skills(query: String) async throws -> [SkillSummary] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        let items = trimmed.isEmpty ? [] : [URLQueryItem(name: "query", value: trimmed)]
        let (data, response) = try await perform(try request(path: "/skills", query: items))
        if response.statusCode == 404 {
            return []
        }
        try validate(response, data: data)
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Lossy<SkillSummary>].self, from: data) {
            return list.compactMap(\.value)
        }
        return try decoder.decode(WrappedList<SkillSummary>.self, from: data).items
    }

    func connectors() async throws -> [Connector]? {
        let (data, response) = try await perform(try request(path: "/connectors"))
        if response.statusCode == 404 || response.statusCode == 503 {
            return nil
        }
        try validate(response, data: data)
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Lossy<Connector>].self, from: data) {
            return list.compactMap(\.value)
        }
        return try decoder.decode(WrappedList<Connector>.self, from: data).items
    }

    func refreshConnectors() async throws -> Bool {
        var urlRequest = try request(path: "/connectors/refresh")
        urlRequest.httpMethod = "POST"
        let (data, response) = try await perform(urlRequest)
        if response.statusCode == 404 {
            return false
        }
        try validate(response, data: data)
        return true
    }

    func extraBots() async throws -> [Bot] {
        try await getList("/bots?hidden=1&deleted=1&archived=1", as: Bot.self)
    }

    func sections() async -> [BotSection]? {
        guard let result = try? await perform(try request(path: "/sections")),
              (200..<300).contains(result.1.statusCode)
        else { return nil }
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Lossy<BotSection>].self, from: result.0) {
            return list.compactMap(\.value)
        }
        return (try? decoder.decode(WrappedList<BotSection>.self, from: result.0))?.items
    }

    func createSection(name: String) async throws -> BotSection {
        try await sectionMutation("/sections", method: "POST", body: .object(["name": .string(name)]))
    }

    func renameSection(id: String, name: String) async throws {
        _ = try await sectionMutation("/sections/\(Self.escape(id))", method: "PATCH", body: .object(["name": .string(name)]))
    }

    func archiveSection(id: String) async throws {
        _ = try await botMutation("/sections/\(Self.escape(id))/archive", method: "POST", body: nil, decodeBot: false)
    }

    func updateSidebar(botID: String, body: JSONValue) async throws {
        _ = try await botMutation("/bots/\(Self.escape(botID))/sidebar", method: "PATCH", body: body, decodeBot: false)
    }

    func markUnread(botID: String) async throws {
        _ = try await botMutation("\(Self.threadRoot(botID))/thread/unread", method: "POST", body: nil, decodeBot: false)
    }

    func deleteBot(id: String) async throws {
        _ = try await botMutation("/bots/\(Self.escape(id))/delete", method: "POST", body: nil, decodeBot: false)
    }

    func restoreBot(id: String) async throws {
        _ = try await botMutation("/bots/\(Self.escape(id))/restore", method: "POST", body: nil, decodeBot: false)
    }

    private func sectionMutation(_ path: String, method: String, body: JSONValue) async throws -> BotSection {
        var urlRequest = try request(path: path)
        urlRequest.httpMethod = method
        urlRequest.httpBody = try JSONEncoder().encode(body)
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await perform(urlRequest)
        if response.statusCode == 404 || response.statusCode == 405 {
            throw ClientError.unsupported
        }
        try validate(response, data: data)
        let json = try? JSONDecoder().decode(JSONValue.self, from: data)
        if let wrapped = json?["section"], let encoded = try? JSONEncoder().encode(wrapped) {
            return try JSONDecoder().decode(BotSection.self, from: encoded)
        }
        return try JSONDecoder().decode(BotSection.self, from: data)
    }

    func browserControl(botID: String, mode: String, surface: String = "browser") async throws {
        _ = try await botMutation(
            "/bots/\(Self.escape(botID))/\(surface)/control",
            method: "POST",
            body: .object(["mode": .string(mode)]),
            decodeBot: false
        )
    }

    func liveBrowserURL(botID: String) -> URL? {
        liveURL(botID: botID, surface: "browser")
    }

    func liveURL(botID: String, surface: String) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        var path = components.path
        while path.hasSuffix("/") {
            path.removeLast()
        }
        components.path = path + "/bots/\(botID)/\(surface)/live"
        return components.url
    }

    func openBrowser(botID: String, url: String) async throws {
        _ = try await botMutation(
            "/bots/\(Self.escape(botID))/browser/open",
            method: "POST",
            body: .object(["url": .string(url)]),
            decodeBot: false
        )
    }

    func runSchedule(botID: String, name: String) async throws {
        _ = try await botMutation(
            "/bots/\(Self.escape(botID))/schedules/\(Self.escape(name))/run",
            method: "POST",
            body: nil,
            decodeBot: false
        )
    }

    func archiveBot(id: String) async throws {
        _ = try await botMutation("/bots/\(Self.escape(id))/archive", method: "POST", body: nil, decodeBot: false)
    }

    func unarchiveBot(id: String) async throws {
        _ = try await botMutation("/bots/\(Self.escape(id))/unarchive", method: "POST", body: nil, decodeBot: false)
    }

    @discardableResult
    private func botMutation(_ path: String, method: String, body: JSONValue?, decodeBot: Bool = true) async throws -> Bot? {
        var urlRequest = try request(path: path)
        urlRequest.httpMethod = method
        if let body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await perform(urlRequest)
        if response.statusCode == 404 || response.statusCode == 405 {
            throw ClientError.unsupported
        }
        if response.statusCode == 400 {
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
            let message = json?["error"]?.stringValue ?? "Confira os campos."
            throw ClientError.validation(message, json?["field"]?.stringValue)
        }
        try validate(response, data: data)
        guard decodeBot else { return nil }
        let json = try? JSONDecoder().decode(JSONValue.self, from: data)
        if let wrapped = json?["bot"], let encoded = try? JSONEncoder().encode(wrapped) {
            return try JSONDecoder().decode(Bot.self, from: encoded)
        }
        return try JSONDecoder().decode(Bot.self, from: data)
    }

    func sessions(botID: String) async throws -> [SessionSummary] {
        try await getList("/bots/\(Self.escape(botID))/sessions", as: SessionSummary.self)
    }

    func browserInfo(botID: String) async throws -> BrowserInfo? {
        let (data, response) = try await perform(try request(path: "/bots/\(Self.escape(botID))/browser"))
        if response.statusCode == 404 {
            return nil
        }
        try validate(response, data: data)
        return try JSONDecoder().decode(BrowserInfo.self, from: data)
    }

    func screenshot(botID: String, path: String?) async throws -> Data? {
        let resolved = path ?? "/bots/\(Self.escape(botID))/browser/latest.png"
        let stamp = String(Int(Date().timeIntervalSince1970 * 1000))
        var urlRequest = try request(path: resolved, query: [URLQueryItem(name: "t", value: stamp)])
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await perform(urlRequest)
        if response.statusCode == 404 {
            return nil
        }
        try validate(response, data: data)
        return data
    }

    func createSession(basePath: String, message: String, skills: [String] = [], attachments: [String] = []) async throws -> String {
        let body = Self.messageBody(message, skills: skills, attachments: attachments)
        let (json, response) = try await post("\(basePath)/session", body: body)
        if let id = json?["sessionId"]?.stringValue ?? response.value(forHTTPHeaderField: "x-eve-session-id") {
            return id
        }
        throw ClientError.missingSession
    }

    @discardableResult
    func sendMessage(basePath: String, sessionId: String, message: String, skills: [String] = [], attachments: [String] = []) async throws -> String? {
        let body = Self.messageBody(message, skills: skills, attachments: attachments)
        let (json, _) = try await post("\(basePath)/session/\(Self.escape(sessionId))", body: body)
        return json?["deliveryId"]?.stringValue
    }

    func answer(basePath: String, sessionId: String, interactionId: String, optionId: String) async throws {
        let answer = JSONValue.object([
            "interactionId": .string(interactionId),
            "optionId": .string(optionId)
        ])
        let body = JSONValue.object(["answers": .array([answer])])
        _ = try await post("\(basePath)/session/\(Self.escape(sessionId))", body: body)
    }

    func cancel(basePath: String, sessionId: String) async throws {
        _ = try await post("\(basePath)/session/\(Self.escape(sessionId))/cancel", body: nil)
    }

    func events(basePath: String, sessionId: String, before: Int?, limit: Int) async throws -> EventsPage? {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before {
            query.append(URLQueryItem(name: "before", value: String(before)))
        }
        let (data, response) = try await perform(try request(
            path: "\(basePath)/session/\(Self.escape(sessionId))/events",
            query: query
        ))
        if response.statusCode == 404 || response.statusCode == 405 {
            return nil
        }
        try validate(response, data: data)
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return EventsPage.parse(json)
    }

    func statusStreamRequest() throws -> URLRequest {
        var urlRequest = try request(path: "/status/stream")
        urlRequest.timeoutInterval = 60
        urlRequest.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        return urlRequest
    }

    func streamRequest(basePath: String, sessionId: String, startIndex: Int) throws -> URLRequest {
        var urlRequest = try request(
            path: "\(basePath)/session/\(Self.escape(sessionId))/stream",
            query: [URLQueryItem(name: "startIndex", value: String(startIndex))]
        )
        urlRequest.timeoutInterval = 90
        urlRequest.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        return urlRequest
    }

    func request(path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") {
            base.removeLast()
        }
        let normalizedPath = path.hasPrefix("/") ? path : "/" + path
        guard var components = URLComponents(string: base + normalizedPath) else {
            throw ClientError.invalidURL
        }
        if !query.isEmpty {
            components.queryItems = (components.queryItems ?? []) + query
        }
        guard let url = components.url else {
            throw ClientError.invalidURL
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 20
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        return urlRequest
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }
        return (data, http)
    }

    private func validate(_ response: HTTPURLResponse, data: Data) throws {
        guard (200..<300).contains(response.statusCode) else {
            throw ClientError.http(response.statusCode, Self.serverMessage(in: data))
        }
    }

    private func getList<Item: Decodable>(_ path: String, as type: Item.Type) async throws -> [Item] {
        let (data, response) = try await perform(try request(path: path))
        try validate(response, data: data)
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([Lossy<Item>].self, from: data) {
            return list.compactMap(\.value)
        }
        return try decoder.decode(WrappedList<Item>.self, from: data).items
    }

    private func post(_ path: String, body: JSONValue?) async throws -> (JSONValue?, HTTPURLResponse) {
        var urlRequest = try request(path: path)
        urlRequest.httpMethod = "POST"
        if let body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await perform(urlRequest)
        try validate(response, data: data)
        var json: JSONValue?
        if !data.isEmpty {
            json = try? JSONDecoder().decode(JSONValue.self, from: data)
        }
        return (json, response)
    }

    private static func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }

    private static func serverMessage(in data: Data) -> String? {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return json["error"]?["message"]?.stringValue
            ?? json["error"]?.stringValue
            ?? json["message"]?.stringValue
    }
}

private struct AnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private struct WrappedList<Item: Decodable>: Decodable {
    let items: [Item]

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)
        var found: [Item] = []
        for key in container.allKeys {
            if let list = try? container.decode([Lossy<Item>].self, forKey: key) {
                found = list.compactMap(\.value)
                break
            }
        }
        items = found
    }
}

struct ThreadSwap: Sendable {
    let thread: BotThread
    let archiveID: String?
}
