import Foundation
import Synchronization

enum AuthSecret: String, Sendable {
    case session
    case runner
    case device
}

enum AuthStore {
    private static let book = Mutex<CredentialBook?>(nil)

    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased() else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    private static func account(_ kind: AuthSecret, server: URL) -> String? {
        account(kind, origin: origin(of: server), scope: ServerConfig.keychainScope(for: server))
    }

    private static func account(_ kind: AuthSecret, origin: String?, scope: String?) -> String? {
        guard let origin else { return nil }
        let base = "\(origin)|\(kind.rawValue)"
        return scope.map { "profile:\($0)|\(base)" } ?? base
    }

    static func read(_ kind: AuthSecret, profile: ServerProfile, migrate: Bool = true) -> String? {
        account(kind, origin: profile.origin, scope: profile.keychainScope).flatMap { read(account: $0, kind: kind, migrate: migrate) }
    }

    static func hasLegacy(_ kind: AuthSecret, profile: ServerProfile) -> Bool {
        guard let account = account(kind, origin: profile.origin, scope: profile.keychainScope) else { return false }
        let settled = book.withLock { current in
            let loaded = current ?? CredentialFile.load()
            current = loaded
            return loaded.settled.contains(account)
        }
        return !settled && LegacyAuthKeychain.exists(account: account)
    }

    static func removeAll(profile: ServerProfile) {
        for kind in [AuthSecret.session, .runner, .device] {
            if let account = account(kind, origin: profile.origin, scope: profile.keychainScope) {
                remove(account: account)
            }
        }
    }

    static func read(_ kind: AuthSecret, server: URL = ServerConfig.currentURL()) -> String? {
        account(kind, server: server).flatMap { read(account: $0, kind: kind, migrate: true) }
    }

    private static func read(account: String, kind: AuthSecret, migrate: Bool) -> String? {
        book.withLock { current in
            var loaded = current ?? CredentialFile.load()
            defer { current = loaded }
            if let token = loaded.tokens[account] { return token }
            guard migrate, !loaded.settled.contains(account) else { return nil }
            guard LegacyAuthKeychain.exists(account: account) else {
                loaded.settled.insert(account)
                CredentialFile.save(loaded)
                return nil
            }
            let token = kind == .session ? LegacyAuthKeychain.readOnce(account: account) : nil
            CredentialFile.logger.notice("migrating legacy \(kind.rawValue, privacy: .public) found=\(token != nil, privacy: .public)")
            if let token { loaded.tokens[account] = token }
            loaded.settled.insert(account)
            if CredentialFile.save(loaded) {
                LegacyAuthKeychain.purge(account: account)
            }
            return token
        }
    }

    @discardableResult
    static func save(_ value: String, as kind: AuthSecret, server: URL = ServerConfig.currentURL()) -> Bool {
        guard let account = account(kind, server: server) else { return false }
        return write(account: account, value: value)
    }

    static func remove(_ kind: AuthSecret, server: URL = ServerConfig.currentURL()) {
        guard let account = account(kind, server: server) else { return }
        remove(account: account)
    }

    private static func remove(account: String) {
        write(account: account, value: nil)
    }

    @discardableResult
    private static func write(account: String, value: String?) -> Bool {
        let (saved, legacy) = book.withLock { current in
            var loaded = current ?? CredentialFile.load()
            let legacy = !loaded.settled.contains(account)
            loaded.tokens[account] = value
            loaded.settled.insert(account)
            let saved = CredentialFile.save(loaded)
            current = loaded
            return (saved, legacy)
        }
        if saved, legacy, LegacyAuthKeychain.exists(account: account) {
            LegacyAuthKeychain.purge(account: account)
        }
        return saved
    }

    static func authorize(_ request: inout URLRequest) {
        guard request.value(forHTTPHeaderField: "Authorization") == nil,
            let url = request.url,
            let target = origin(of: url),
            target == origin(of: ServerConfig.currentURL()) || target == socketOrigin(),
            let token = read(.session)
        else { return }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    private static func socketOrigin() -> String? {
        guard var components = URLComponents(url: ServerConfig.currentURL(), resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        return components.url.flatMap(origin(of:))
    }

    static func reportUnauthorized(_ response: URLResponse?) {
        guard (response as? HTTPURLResponse)?.statusCode == 401 else { return }
        Task { @MainActor in
            AuthSession.shared.sessionExpired()
        }
    }
}
