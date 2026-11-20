import Foundation

extension BotsClient {
    private func serversSend(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: JSONValue? = nil, timeout: TimeInterval = 30) async throws -> JSONValue {
        var urlRequest = try request(path: path, query: query)
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = timeout
        if let body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        AuthStore.reportUnauthorized(response)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(http.statusCode) else {
            throw ClientError.http(http.statusCode, json["error"]?.stringValue)
        }
        return json
    }

    private static func serverPath(_ id: String) -> String {
        "/servers/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
    }

    func devServers() async throws -> [DevServerInfo] {
        try await serversSend("/servers")["servers"]?.arrayValue?.compactMap(DevServerInfo.init) ?? []
    }

    func serverProjects() async throws -> [ServerProject] {
        try await serversSend("/servers/projects")["projects"]?.arrayValue?.compactMap(ServerProject.init) ?? []
    }

    func projectScripts(path: String) async throws -> ProjectScripts {
        ProjectScripts(try await serversSend("/servers/scripts", query: [URLQueryItem(name: "path", value: path)]))
    }

    func serverProfiles() async throws -> [RunProfile] {
        try await serversSend("/servers/profiles")["profiles"]?.arrayValue?.compactMap(RunProfile.init) ?? []
    }

    func saveServerProfile(name: String, path: String, script: String) async throws -> RunProfile? {
        let body: JSONValue = .object(["name": .string(name), "path": .string(path), "script": .string(script)])
        return RunProfile(try await serversSend("/servers/profiles", method: "POST", body: body)["profile"] ?? .null)
    }

    func deleteServerProfile(id: String) async throws {
        _ = try await serversSend("/servers/profiles/\(id)", method: "DELETE")
    }

    func startServer(path: String?, script: String?, profile: String?) async throws -> DevServerInfo? {
        var body: [String: JSONValue] = [:]
        if let path { body["path"] = .string(path) }
        if let script { body["script"] = .string(script) }
        if let profile { body["profile"] = .string(profile) }
        return DevServerInfo(try await serversSend("/servers", method: "POST", body: .object(body), timeout: 60)["server"])
    }

    func stopServer(id: String) async throws {
        _ = try await serversSend(Self.serverPath(id) + "/stop", method: "POST", timeout: 20)
    }

    func previewLink(id: String) async throws -> String? {
        try await serversSend(Self.serverPath(id) + "/preview-link", method: "POST", timeout: 15)["path"]?.stringValue
    }

    func restartServer(id: String) async throws {
        _ = try await serversSend(Self.serverPath(id) + "/restart", method: "POST", timeout: 30)
    }

    func forgetServer(id: String) async throws {
        _ = try await serversSend(Self.serverPath(id), method: "DELETE")
    }

    func serverLogStreamRequest(id: String) throws -> URLRequest {
        var urlRequest = try request(path: Self.serverPath(id) + "/logs/stream", query: [URLQueryItem(name: "lines", value: "1500")])
        urlRequest.timeoutInterval = 60
        urlRequest.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        return urlRequest
    }
}
