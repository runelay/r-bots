import Foundation
import Security
import Synchronization

enum AuthSecret: String, Sendable {
    case session
    case runner
    case device
}

enum AuthStore {
    private static let service = "com.runelay.bots.auth"
    private static let cache = Mutex<[String: String]>([:])

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

    static func read(_ kind: AuthSecret, profile: ServerProfile) -> String? {
        account(kind, origin: profile.origin, scope: profile.keychainScope).flatMap(read(account:))
    }

    static func removeAll(profile: ServerProfile) {
        for kind in [AuthSecret.session, .runner, .device] {
            if let account = account(kind, origin: profile.origin, scope: profile.keychainScope) {
                remove(account: account)
            }
        }
    }

    static func read(_ kind: AuthSecret, server: URL = ServerConfig.currentURL()) -> String? {
        account(kind, server: server).flatMap(read(account:))
    }

    private static func read(account: String) -> String? {
        if let cached = cache.withLock({ $0[account] }) {
            return cached.isEmpty ? nil : cached
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        let value = status == errSecSuccess ? (item as? Data).map { String(decoding: $0, as: UTF8.self) } : nil
        cache.withLock { $0[account] = value ?? "" }
        return value
    }

    @discardableResult
    static func save(_ value: String, as kind: AuthSecret, server: URL = ServerConfig.currentURL()) -> Bool {
        guard let account = account(kind, server: server) else { return false }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        cache.withLock { $0[account] = status == errSecSuccess ? value : "" }
        return status == errSecSuccess
    }

    static func remove(_ kind: AuthSecret, server: URL = ServerConfig.currentURL()) {
        guard let account = account(kind, server: server) else { return }
        remove(account: account)
    }

    private static func remove(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        cache.withLock { $0[account] = "" }
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
