import Foundation
import Observation

enum AuthState: Equatable {
    case checking
    case unreachable
    case signedOut
    case signedIn(AuthUser)
}

@MainActor
@Observable
final class AuthSession {
    static let shared = AuthSession()

    private(set) var state: AuthState = .checking
    private(set) var expired = false
    private(set) var serverRevision = 0

    var user: AuthUser? {
        if case .signedIn(let user) = state { return user }
        return nil
    }

    var hasServer: Bool {
        UserDefaults.standard.string(forKey: ServerConfig.storageKey).flatMap(ServerConfig.parse) != nil
    }

    private var server: URL { ServerConfig.currentURL() }
    private var cachedUserKey: String { "auth.user.\(AuthStore.origin(of: server) ?? "")" }

    func bootstrap() async {
        guard hasServer, let token = AuthStore.read(.session) else {
            state = .signedOut
            return
        }
        do {
            let profile = try await AuthClient(baseURL: server).profile(token: token)
            apply(profile.user)
        } catch AuthFailure.server(401, _) {
            AuthStore.remove(.session)
            state = .signedOut
        } catch {
            state = cachedUser().map(AuthState.signedIn) ?? .unreachable
        }
    }

    func signIn(server address: String, email: String, password: String) async throws {
        guard let url = ServerConfig.parse(Self.normalized(address)) else { throw AuthFailure.invalidURL }
        let client = AuthClient(baseURL: url)
        let token = try await client.signIn(
            email: email.trimmingCharacters(in: .whitespaces).lowercased(),
            password: password,
            remember: true
        )
        let profile = try await client.profile(token: token)
        Self.activate(url: url)
        AuthStore.save(token, as: .session, server: url)
        var recent = UserDefaults.standard.stringArray(forKey: "servers.recent") ?? []
        recent.removeAll { $0 == url.absoluteString }
        recent.insert(url.absoluteString, at: 0)
        UserDefaults.standard.set(Array(recent.prefix(6)), forKey: "servers.recent")
        expired = false
        apply(profile.user)
    }

    func signOut() async {
        if let token = AuthStore.read(.session) {
            await AuthClient(baseURL: server).signOut(token: token)
        }
        AuthStore.remove(.session)
        UserDefaults.standard.removeObject(forKey: cachedUserKey)
        expired = false
        state = .signedOut
    }

    func sessionExpired() {
        guard user != nil else { return }
        AuthStore.remove(.session)
        expired = true
        state = .signedOut
    }

    private func apply(_ user: AuthUser) {
        if let data = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(data, forKey: cachedUserKey)
        }
        state = .signedIn(user)
    }

    private func cachedUser() -> AuthUser? {
        guard let data = UserDefaults.standard.data(forKey: cachedUserKey) else { return nil }
        return try? JSONDecoder().decode(AuthUser.self, from: data)
    }

    static func normalized(_ address: String) -> String {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        if !text.isEmpty, !text.contains("://") { text = "http://" + text }
        return text
    }

    func webCookie(for url: URL) async -> HTTPCookie? {
        guard let token = AuthStore.read(.session), let host = url.host() else { return nil }
        guard let profile = try? await AuthClient(baseURL: server).profile(token: token), let cookie = profile.cookie else { return nil }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: cookie.name,
            .value: cookie.value,
            .domain: host,
            .path: "/",
        ]
        if url.scheme == "https" { properties[.secure] = "TRUE" }
        return HTTPCookie(properties: properties)
    }

    static func activate(url: URL) {
        var book = ServerConfig.book()
        let origin = AuthStore.origin(of: url)
        if let existing = book.profiles.first(where: { $0.origin == origin }) {
            book.activeID = existing.id
        } else if book.profiles.count == 1, AuthStore.read(.session, server: book.profiles[0].url ?? url) == nil {
            book.profiles[0].address = url.absoluteString
            book.profiles[0].name = url.host() ?? "Principal"
        } else {
            let colors = ServerProfile.colors
            let profile = ServerProfile(
                id: UUID().uuidString,
                name: url.host() ?? "Servidor",
                address: url.absoluteString,
                color: colors[book.profiles.count % colors.count],
                symbol: ServerProfile.symbols[book.profiles.count % ServerProfile.symbols.count]
            )
            book.profiles.append(profile)
            book.activeID = profile.id
        }
        ServerConfig.save(book)
    }

    func switchServer(to profile: ServerProfile) async {
        var book = ServerConfig.book()
        guard book.activeID != profile.id else { return }
        book.activeID = profile.id
        ServerConfig.save(book)
        serverRevision += 1
        state = .checking
        await bootstrap()
    }

    func addServer(name: String, address: String) -> ServerProfile? {
        guard let url = ServerConfig.parse(Self.normalized(address)) else { return nil }
        var book = ServerConfig.book()
        let profile = ServerProfile(
            id: UUID().uuidString,
            name: name.isEmpty ? (url.host() ?? "Servidor") : name,
            address: url.absoluteString,
            color: ServerProfile.colors[book.profiles.count % ServerProfile.colors.count],
            symbol: ServerProfile.symbols[book.profiles.count % ServerProfile.symbols.count]
        )
        book.profiles.append(profile)
        ServerConfig.save(book)
        return profile
    }

    func removeServer(_ profile: ServerProfile) {
        var book = ServerConfig.book()
        guard book.profiles.count > 1, profile.id != book.activeID else { return }
        if let url = profile.url { AuthStore.remove(.session, server: url) }
        book.profiles.removeAll { $0.id == profile.id }
        ServerConfig.save(book)
        serverRevision += 1
    }
}
