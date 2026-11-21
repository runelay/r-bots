import Foundation

private struct CliVersionList: Decodable {
    let providers: [CliVersion]
}

private struct CliRollbackResult: Decodable {
    let version: CliVersion
}

private struct ServerUpdateRefusal: Decodable {
    let code: String?
    let running: Int?
}

extension BotsClient {
    func serverVersion() async throws -> ServerVersionInfo? {
        let (data, status) = try await versionsCall(try request(path: "/server/version"))
        if status == 404 { return nil }
        try Self.versionsCheck(status, data)
        return try JSONDecoder().decode(ServerVersionInfo.self, from: data)
    }

    func requestServerUpdate(force: Bool) async throws -> ServerUpdateRequest {
        var urlRequest = try request(path: "/server/update")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.httpBody = try JSONEncoder().encode(["force": force])
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, status) = try await versionsCall(urlRequest)
        if status == 409, let refusal = try? JSONDecoder().decode(ServerUpdateRefusal.self, from: data), refusal.code == "turns_running" {
            return .turnsRunning(max(refusal.running ?? 1, 1))
        }
        try Self.versionsCheck(status, data)
        return .queued
    }

    func providerVersions() async throws -> [CliVersion]? {
        let (data, status) = try await versionsCall(try request(path: "/providers/versions"))
        if status == 404 { return nil }
        try Self.versionsCheck(status, data)
        return try JSONDecoder().decode(CliVersionList.self, from: data).providers
    }

    func updateProvider(_ provider: String) async throws {
        var urlRequest = try request(path: "/providers/\(Self.versionsEscape(provider))/update")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.httpBody = Data("{}".utf8)
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, status) = try await versionsCall(urlRequest)
        try Self.versionsCheck(status, data)
    }

    func rollbackProvider(_ provider: String) async throws -> CliVersion {
        var urlRequest = try request(path: "/providers/\(Self.versionsEscape(provider))/rollback")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        let (data, status) = try await versionsCall(urlRequest)
        try Self.versionsCheck(status, data)
        return try JSONDecoder().decode(CliRollbackResult.self, from: data).version
    }

    private func versionsCall(_ urlRequest: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        AuthStore.reportUnauthorized(response)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        return (data, http.statusCode)
    }

    private static func versionsCheck(_ status: Int, _ data: Data) throws {
        guard (200..<300).contains(status) else {
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
            let message = json?["error"]?["message"]?.stringValue ?? json?["error"]?.stringValue
            throw ClientError.http(status, message)
        }
    }

    private static func versionsEscape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}
