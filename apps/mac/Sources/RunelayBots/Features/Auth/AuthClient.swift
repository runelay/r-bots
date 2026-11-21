import Foundation

struct AuthUser: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let email: String
    let role: String
    var image: String?

    var isOwner: Bool { role == "owner" }
}

struct AuthCookie: Codable, Sendable {
    let name: String
    let value: String
}

struct AuthProfile: Sendable {
    let user: AuthUser
    let expiresAt: Date?
    let cookie: AuthCookie?
}

struct SetupStatus: Equatable, Sendable {
    let needsOwner: Bool
    var setupTokenRequired = false
    let passwordReset: Bool
    let passkey: Bool
}

struct DeviceGrant: Sendable {
    let deviceCode: String
    let userCode: String
    let verificationURL: URL
    let interval: Int
    let expiresIn: Int
}

enum DevicePoll: Sendable {
    case pending
    case slowDown
    case approved(String)
    case denied
    case expired
}

enum AuthFailure: LocalizedError, Equatable {
    case invalidURL
    case server(Int, String?)
    case unreachable

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "O endereço do servidor não parece válido."
        case .server(let status, let message):
            if let message, !message.isEmpty { return message }
            if status == 401 { return "E-mail ou senha incorretos." }
            if status == 429 { return "Muitas tentativas. Espere um minuto." }
            return "O servidor respondeu com erro \(status)."
        case .unreachable:
            return "Não deu para falar com o servidor."
        }
    }
}

enum SetupFailure: LocalizedError, Equatable {
    case ownerExists
    case invalidSetupToken

    init?(status: Int, code: String?) {
        switch (status, code) {
        case (409, _), (_, "setup_closed"): self = .ownerExists
        case (403, _), (_, "setup_token_required"): self = .invalidSetupToken
        default: return nil
        }
    }

    var errorDescription: String? {
        switch self {
        case .ownerExists:
            return "Este servidor já tem dono. Entre com o seu e-mail e senha."
        case .invalidSetupToken:
            return "Esse código não confere. Copie de novo o conteúdo do arquivo setup.token, na pasta de dados do servidor."
        }
    }
}

struct AuthClient: Sendable {
    static let clientID = "runelay-bots-mac"
    let baseURL: URL

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration)
    }()

    private func url(_ path: String) throws -> URL {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + path) else { throw AuthFailure.invalidURL }
        return url
    }

    private func send(
        _ method: String,
        _ path: String,
        body: [String: String]? = nil,
        token: String? = nil,
        headers: [String: String] = [:]
    ) async throws -> (Data, HTTPURLResponse) {
        try await send(method, path, json: body?.mapValues { JSONValue.string($0) }, token: token, headers: headers)
    }

    private func send(
        _ method: String,
        _ path: String,
        json body: [String: JSONValue]?,
        token: String? = nil,
        headers: [String: String] = [:]
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let origin = AuthStore.origin(of: baseURL) {
            request.setValue(origin, forHTTPHeaderField: "Origin")
        }
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        do {
            let (data, response) = try await Self.session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw AuthFailure.unreachable }
            return (data, http)
        } catch let failure as AuthFailure {
            throw failure
        } catch {
            throw AuthFailure.unreachable
        }
    }

    private static func object(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private static func message(_ data: Data) -> String? {
        let body = object(data)
        return (body["error"] as? String) ?? (body["message"] as? String) ?? (body["error_description"] as? String)
    }

    private static func ensure(_ data: Data, _ response: HTTPURLResponse) throws {
        guard (200..<300).contains(response.statusCode) else {
            throw AuthFailure.server(response.statusCode, message(data))
        }
    }

    func setupStatus() async throws -> SetupStatus? {
        let (data, response) = try await send("GET", "/auth/setup")
        if response.statusCode == 404 { return nil }
        try Self.ensure(data, response)
        let body = Self.object(data)
        let methods = body["methods"] as? [String: Any] ?? [:]
        return SetupStatus(
            needsOwner: body["needsOwner"] as? Bool ?? false,
            setupTokenRequired: body["setupTokenRequired"] as? Bool ?? false,
            passwordReset: methods["passwordReset"] as? Bool ?? false,
            passkey: methods["passkey"] as? Bool ?? true
        )
    }

    func providers() async -> [String] {
        guard let (data, response) = try? await send("GET", "/auth/providers"), response.statusCode == 200 else { return [] }
        return Self.object(data)["providers"] as? [String] ?? []
    }

    func requestPasswordReset(email: String) async throws {
        let (data, response) = try await send("POST", "/api/auth/request-password-reset", body: ["email": email])
        try Self.ensure(data, response)
    }

    func health() async throws {
        let (data, response) = try await send("GET", "/health")
        try Self.ensure(data, response)
    }

    func acceptInvite(code: String, name: String, email: String, password: String) async throws -> String {
        let (data, response) = try await send(
            "POST",
            "/auth/invites/accept",
            body: ["code": code, "name": name, "email": email, "password": password]
        )
        try Self.ensure(data, response)
        guard let token = Self.object(data)["token"] as? String else {
            throw AuthFailure.server(response.statusCode, "O servidor não devolveu a sessão.")
        }
        return token
    }

    func changePassword(token: String, current: String, new: String) async throws -> String? {
        var request = URLRequest(url: try url("/api/auth/change-password"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let origin = AuthStore.origin(of: baseURL) {
            request.setValue(origin, forHTTPHeaderField: "Origin")
        }
        let body: [String: JSONValue] = [
            "currentPassword": .string(current),
            "newPassword": .string(new),
            "revokeOtherSessions": .bool(true),
        ]
        request.httpBody = try JSONEncoder().encode(body)
        let data: Data
        let http: HTTPURLResponse
        do {
            let (received, response) = try await Self.session.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw AuthFailure.unreachable }
            data = received
            http = response
        } catch let failure as AuthFailure {
            throw failure
        } catch {
            throw AuthFailure.unreachable
        }
        if http.statusCode == 400 || http.statusCode == 401 {
            let message = Self.message(data) ?? ""
            if message.localizedCaseInsensitiveContains("password") {
                throw AuthFailure.server(http.statusCode, "A senha atual não confere.")
            }
        }
        try Self.ensure(data, http)
        if let fresh = http.value(forHTTPHeaderField: "set-auth-token"), !fresh.isEmpty { return fresh }
        return Self.object(data)["token"] as? String
    }

    func signIn(email: String, password: String, remember: Bool) async throws -> String {
        let (data, response) = try await send(
            "POST",
            "/api/auth/sign-in/email",
            json: ["email": .string(email), "password": .string(password), "rememberMe": .bool(remember)]
        )
        try Self.ensure(data, response)
        if let token = response.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty { return token }
        if let token = Self.object(data)["token"] as? String { return token }
        throw AuthFailure.server(response.statusCode, "O servidor não devolveu a sessão.")
    }

    static let setupTokenHeader = "x-setup-token"

    func setupOwner(name: String, email: String, password: String, setupToken: String?) async throws -> String {
        let headers = setupToken.map { [Self.setupTokenHeader: $0] } ?? [:]
        let (data, response) = try await send(
            "POST",
            "/auth/setup",
            body: ["name": name, "email": email, "password": password],
            headers: headers
        )
        if let failure = SetupFailure(status: response.statusCode, code: Self.object(data)["code"] as? String) {
            throw failure
        }
        try Self.ensure(data, response)
        guard let token = Self.object(data)["token"] as? String else {
            throw AuthFailure.server(response.statusCode, "O servidor não devolveu a sessão.")
        }
        return token
    }

    func profile(token: String) async throws -> AuthProfile {
        let (data, response) = try await send("GET", "/auth/me", token: token)
        try Self.ensure(data, response)
        let body = Self.object(data)
        guard let user = body["user"] as? [String: Any],
              let id = user["id"] as? String,
              let email = user["email"] as? String
        else { throw AuthFailure.server(response.statusCode, "Resposta estranha do servidor.") }
        let cookie = (body["cookie"] as? [String: Any]).flatMap { item -> AuthCookie? in
            guard let name = item["name"] as? String, let value = item["value"] as? String else { return nil }
            return AuthCookie(name: name, value: value)
        }
        let expiresAt = (body["expiresAt"] as? String).flatMap { ISO8601DateFormatter.withFraction.date(from: $0) }
        return AuthProfile(
            user: AuthUser(
                id: id,
                name: user["name"] as? String ?? email,
                email: email,
                role: user["role"] as? String ?? "member",
                image: user["image"] as? String
            ),
            expiresAt: expiresAt,
            cookie: cookie
        )
    }

    func updateName(token: String, name: String) async throws {
        let (data, response) = try await send("POST", "/api/auth/update-user", body: ["name": name], token: token)
        try Self.ensure(data, response)
    }

    func uploadAvatar(token: String, data: Data, mime: String) async throws -> String? {
        var request = URLRequest(url: try url("/auth/me/avatar"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(mime, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let origin = AuthStore.origin(of: baseURL) {
            request.setValue(origin, forHTTPHeaderField: "Origin")
        }
        let (received, response): (Data, URLResponse)
        do {
            (received, response) = try await Self.session.upload(for: request, from: data)
        } catch {
            throw AuthFailure.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw AuthFailure.unreachable }
        try Self.ensure(received, http)
        return Self.object(received)["image"] as? String
    }

    func removeAvatar(token: String) async throws {
        let (data, response) = try await send("DELETE", "/auth/me/avatar", token: token)
        try Self.ensure(data, response)
    }

    func avatar(path: String, token: String) async throws -> Data {
        let (data, response) = try await send("GET", path, token: token)
        try Self.ensure(data, response)
        return data
    }

    func runnerKey(token: String) async throws -> String {
        let (data, response) = try await send("POST", "/auth/runner-key", token: token)
        try Self.ensure(data, response)
        guard let key = Self.object(data)["key"] as? String else {
            throw AuthFailure.server(response.statusCode, "O servidor não devolveu a chave do runner.")
        }
        return key
    }

    func signOut(token: String) async {
        _ = try? await send("POST", "/api/auth/sign-out", body: [:], token: token)
    }

    func startDevice() async throws -> DeviceGrant {
        let (data, response) = try await send("POST", "/api/auth/device/code", body: ["client_id": Self.clientID])
        try Self.ensure(data, response)
        let body = Self.object(data)
        guard let deviceCode = body["device_code"] as? String,
              let userCode = body["user_code"] as? String,
              let complete = (body["verification_uri_complete"] as? String).flatMap(URL.init(string:))
        else { throw AuthFailure.server(response.statusCode, "Resposta estranha do servidor.") }
        return DeviceGrant(
            deviceCode: deviceCode,
            userCode: userCode,
            verificationURL: complete,
            interval: max(body["interval"] as? Int ?? 5, 1),
            expiresIn: body["expires_in"] as? Int ?? 600
        )
    }

    func pollDevice(_ grant: DeviceGrant) async throws -> DevicePoll {
        let (data, response) = try await send(
            "POST",
            "/api/auth/device/token",
            body: [
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": grant.deviceCode,
                "client_id": Self.clientID,
            ]
        )
        let body = Self.object(data)
        if (200..<300).contains(response.statusCode), let token = body["access_token"] as? String {
            return .approved(token)
        }
        switch body["error"] as? String {
        case "authorization_pending": return .pending
        case "slow_down": return .slowDown
        case "access_denied": return .denied
        case "expired_token": return .expired
        default: throw AuthFailure.server(response.statusCode, Self.message(data))
        }
    }
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
