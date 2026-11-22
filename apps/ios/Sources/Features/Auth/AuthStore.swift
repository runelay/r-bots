import Foundation
import Security

enum AuthSecret: String, Sendable {
    case session
}

enum AuthStore {
    private static let service = "com.runelay.bots.ios.auth"

    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased() else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    private static func account(_ kind: AuthSecret, server: URL) -> String? {
        origin(of: server).map { "\($0)|\(kind.rawValue)" }
    }

    static func read(_ kind: AuthSecret, server: URL = ServerConfig.currentURL()) -> String? {
        guard let account = account(kind, server: server) else { return nil }
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func save(_ value: String, as kind: AuthSecret, server: URL = ServerConfig.currentURL()) -> Bool {
        guard let account = account(kind, server: server) else { return false }
        let data = Data(value.utf8)
        let query = baseQuery(account)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    static func remove(_ kind: AuthSecret, server: URL = ServerConfig.currentURL()) {
        guard let account = account(kind, server: server) else { return }
        SecItemDelete(baseQuery(account) as CFDictionary)
    }

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func authorize(_ request: inout URLRequest) {
        request.setAppLanguage()
        guard request.value(forHTTPHeaderField: "Authorization") == nil,
            let url = request.url,
            let target = origin(of: url),
            target == origin(of: ServerConfig.currentURL()),
            let token = read(.session)
        else { return }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    static func reportUnauthorized(_ response: URLResponse?) {
        guard (response as? HTTPURLResponse)?.statusCode == 401 else { return }
        Task { @MainActor in
            AuthSession.shared.sessionExpired()
        }
    }
}
