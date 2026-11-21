import Foundation
import Synchronization

struct ServerProfile: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var address: String
    var color: String
    var symbol: String
    var sharesLegacySession = false

    var url: URL? { ServerConfig.parse(address) }
    var origin: String? { url.flatMap(AuthStore.origin(of:)) }

    var keychainScope: String? { sharesLegacySession ? nil : id }

    static let colors = ["orange", "blue", "green", "violet", "pink", "teal", "amber", "grey"]
    static let symbols = ["server.rack", "laptopcomputer", "cloud", "network", "house", "building.2", "flask", "bolt"]
}

struct ServerProfileBook: Codable, Equatable, Sendable {
    var profiles: [ServerProfile]
    var activeID: String
    var defaultID: String

    var active: ServerProfile {
        profiles.first { $0.id == activeID } ?? profiles[0]
    }
}

enum ServerConfig {
    static let storageKey = "serverURL"
    static let profilesKey = "serverProfiles.v1"
    static let defaultURL = "http://127.0.0.1:2000"
    static let principalID = "principal"

    private static let cache = Mutex<ServerProfileBook?>(nil)

    static func currentURL() -> URL {
        let stored = UserDefaults.standard.string(forKey: storageKey) ?? ""
        if let url = parse(stored) {
            return url
        }
        guard let fallback = URL(string: defaultURL) else {
            preconditionFailure("defaultURL is a valid literal URL")
        }
        return fallback
    }

    static func parse(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), url.scheme != nil, url.host() != nil else { return nil }
        return url
    }

    static var activeProfile: ServerProfile { book().active }

    static var cacheNamespace: String { activeProfile.id }

    static func book() -> ServerProfileBook {
        if let cached = cache.withLock({ $0 }) {
            return cached
        }
        let loaded = load()
        cache.withLock { $0 = loaded }
        return loaded
    }

    @discardableResult
    static func adoptStoredURL() -> ServerProfileBook {
        var current = book()
        let stored = UserDefaults.standard.string(forKey: storageKey) ?? ""
        guard parse(stored) != nil,
            let index = current.profiles.firstIndex(where: { $0.id == current.activeID }),
            current.profiles[index].address != stored
        else { return current }
        current.profiles[index].address = stored
        persist(current)
        return current
    }

    static func save(_ book: ServerProfileBook) {
        persist(book)
        if UserDefaults.standard.string(forKey: storageKey) != book.active.address {
            UserDefaults.standard.set(book.active.address, forKey: storageKey)
        }
    }

    static func keychainScope(for server: URL) -> String? {
        guard let origin = AuthStore.origin(of: server) else { return nil }
        let current = book()
        let matches = current.profiles.filter { $0.origin == origin }
        let chosen = matches.first { $0.id == current.activeID } ?? matches.first
        return chosen?.keychainScope
    }

    private static func persist(_ book: ServerProfileBook) {
        cache.withLock { $0 = book }
        if let data = try? JSONEncoder().encode(book) {
            UserDefaults.standard.set(data, forKey: profilesKey)
        }
    }

    private static func load() -> ServerProfileBook {
        if let data = UserDefaults.standard.data(forKey: profilesKey),
            let decoded = try? JSONDecoder().decode(ServerProfileBook.self, from: data),
            !decoded.profiles.isEmpty
        {
            return decoded
        }
        let address = UserDefaults.standard.string(forKey: storageKey).flatMap { parse($0) != nil ? $0 : nil } ?? defaultURL
        let principal = ServerProfile(
            id: principalID,
            name: "Principal",
            address: address,
            color: "orange",
            symbol: "server.rack",
            sharesLegacySession: true
        )
        let migrated = ServerProfileBook(profiles: [principal], activeID: principalID, defaultID: principalID)
        persist(migrated)
        return migrated
    }
}
