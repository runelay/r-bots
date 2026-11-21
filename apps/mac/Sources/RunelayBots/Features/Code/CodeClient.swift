import Foundation

extension BotsClient {
    private func codeSend(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: JSONValue? = nil, timeout: TimeInterval = 30) async throws -> JSONValue {
        var urlRequest = try request(path: path, query: query)
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = timeout
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

    private static func codeRoot(_ botID: String) -> String {
        "/bots/\(botID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? botID)/code"
    }

    private static func sessionQuery(_ sessionID: String?, workspaceID: String? = nil) -> [URLQueryItem] {
        (sessionID.map { [URLQueryItem(name: "sessionId", value: $0)] } ?? [])
            + (workspaceID.map { [URLQueryItem(name: "workspaceId", value: $0)] } ?? [])
    }

    func repos(query: String = "") async throws -> [RepoInfo] {
        let json = try await codeSend("/code/repos", query: query.isEmpty ? [] : [URLQueryItem(name: "query", value: query)])
        return json.arrayValue?.compactMap(RepoInfo.init) ?? []
    }

    func codeState(botID: String, sessionID: String?) async throws -> CodeState {
        CodeState(try await codeSend(Self.codeRoot(botID), query: Self.sessionQuery(sessionID)))
    }

    func openWorkspace(botID: String, sessionID: String?, repo: String, task: String?) async throws -> CodeState {
        var body: [String: JSONValue] = ["repo": .string(repo)]
        if let task, !task.isEmpty { body["task"] = .string(task) }
        return CodeState(try await codeSend(Self.codeRoot(botID) + "/workspace", method: "POST", query: Self.sessionQuery(sessionID), body: .object(body), timeout: 120))
    }

    func closeWorkspace(botID: String, sessionID: String?, workspaceID: String? = nil) async throws {
        _ = try await codeSend(Self.codeRoot(botID) + "/workspace", method: "DELETE", query: Self.sessionQuery(sessionID, workspaceID: workspaceID))
    }

    func finishWorkspace(botID: String, sessionID: String?, workspaceID: String? = nil) async throws {
        _ = try await codeSend(Self.codeRoot(botID) + "/finish", method: "POST", query: Self.sessionQuery(sessionID, workspaceID: workspaceID), timeout: 120)
    }

    func reopenPullRequest(botID: String, sessionID: String?, workspaceID: String? = nil) async throws {
        _ = try await codeSend(Self.codeRoot(botID) + "/pr/reopen", method: "POST", query: Self.sessionQuery(sessionID, workspaceID: workspaceID), timeout: 90)
    }

    func pullRequest(botID: String, sessionID: String?, workspaceID: String? = nil, refresh: Bool) async throws -> PullRequestInfo? {
        let json = try await codeSend(
            Self.codeRoot(botID) + "/pr", query: Self.sessionQuery(sessionID, workspaceID: workspaceID) + (refresh ? [URLQueryItem(name: "refresh", value: "1")] : []), timeout: 60)
        return PullRequestInfo(json["pr"])
    }

    func fileDiff(botID: String, sessionID: String?, workspaceID: String? = nil, path: String) async throws -> CodeEdit {
        let json = try await codeSend(Self.codeRoot(botID) + "/diff", query: Self.sessionQuery(sessionID, workspaceID: workspaceID) + [URLQueryItem(name: "path", value: path)])
        return CodeEdit(
            path: json["path"]?.stringValue ?? path,
            before: json["before"]?.stringValue,
            after: json["after"]?.stringValue,
            hunks: CodeHunk.list(json["hunks"]),
            added: json["added"]?.intValue ?? 0,
            removed: json["removed"]?.intValue ?? 0,
            created: ["added", "untracked"].contains(json["status"]?.stringValue ?? ""),
            deleted: json["status"]?.stringValue == "deleted"
        )
    }

    func allDiffs(botID: String, sessionID: String?, workspaceID: String? = nil) async throws -> [CodeEdit] {
        let json = try await codeSend(Self.codeRoot(botID) + "/diff", query: Self.sessionQuery(sessionID, workspaceID: workspaceID), timeout: 60)
        return json["files"]?.arrayValue?.compactMap { item -> CodeEdit? in
            guard let path = item["path"]?.stringValue else { return nil }
            let status = item["status"]?.stringValue ?? ""
            return CodeEdit(
                path: path,
                before: nil,
                after: nil,
                hunks: CodeHunk.list(item["hunks"]),
                added: item["added"]?.intValue ?? 0,
                removed: item["removed"]?.intValue ?? 0,
                created: status == "added" || status == "untracked",
                deleted: status == "deleted"
            )
        } ?? []
    }

    func revertFile(botID: String, sessionID: String?, workspaceID: String? = nil, path: String) async throws {
        _ = try await codeSend(Self.codeRoot(botID) + "/revert", method: "POST", query: Self.sessionQuery(sessionID, workspaceID: workspaceID), body: .object(["path": .string(path)]))
    }

    func rewind(botID: String, sessionID: String?, turnID: String) async throws {
        _ = try await codeSend(Self.codeRoot(botID) + "/rewind", method: "POST", query: Self.sessionQuery(sessionID), body: .object(["turnId": .string(turnID)]), timeout: 120)
    }

    func deliver(botID: String, sessionID: String?, workspaceID: String? = nil, action: String, message: String) async throws -> JSONValue {
        try await codeSend(
            Self.codeRoot(botID) + "/deliver",
            method: "POST",
            query: Self.sessionQuery(sessionID, workspaceID: workspaceID),
            body: .object(["action": .string(action), "message": .string(message)]),
            timeout: 300
        )
    }

    func stopDevServers(botID: String, sessionID: String?, workspaceID: String? = nil) async throws {
        _ = try await codeSend(Self.codeRoot(botID) + "/servers/stop", method: "POST", query: Self.sessionQuery(sessionID, workspaceID: workspaceID), body: .object([:]))
    }

    func previewURL(path: String) -> URL? {
        try? request(path: path).url
    }
}
