import Foundation
import Observation

enum ServerProfileStatus: Equatable {
    case checking
    case connected(latency: Int)
    case signedOut
    case needsOwner
    case offline

    var label: String {
        switch self {
        case .checking: tr("Verificando")
        case .connected: tr("Conectado")
        case .signedOut: tr("Sem login")
        case .needsOwner: tr("Sem dono")
        case .offline: tr("Fora do ar")
        }
    }
}

@MainActor
@Observable
final class ServerProfiles {
    static let shared = ServerProfiles()

    private(set) var book: ServerProfileBook
    private(set) var statuses: [String: ServerProfileStatus] = [:]
    private(set) var switching = false

    @ObservationIgnored var onActivate: (() -> Void)?
    @ObservationIgnored private var checkTask: Task<Void, Never>?

    private init() {
        var loaded = ServerConfig.adoptStoredURL()
        if loaded.activeID != loaded.defaultID, loaded.profiles.contains(where: { $0.id == loaded.defaultID }) {
            loaded.activeID = loaded.defaultID
            ServerConfig.save(loaded)
        }
        book = loaded
    }

    var profiles: [ServerProfile] { book.profiles }
    var active: ServerProfile { book.active }

    func status(of profile: ServerProfile) -> ServerProfileStatus {
        statuses[profile.id] ?? .checking
    }

    func profile(id: String) -> ServerProfile? {
        book.profiles.first { $0.id == id }
    }

    func reload() {
        book = ServerConfig.adoptStoredURL()
    }

    func activate(_ id: String) {
        reload()
        guard id != book.activeID, book.profiles.contains(where: { $0.id == id }) else { return }
        var next = book
        next.activeID = id
        commit(next)
        switching = true
        onActivate?()
        switching = false
        refreshStatuses()
    }

    func activate(index: Int) {
        guard book.profiles.indices.contains(index) else { return }
        activate(book.profiles[index].id)
    }

    @discardableResult
    func add(name: String, address: String, color: String, symbol: String) -> ServerProfile {
        let profile = ServerProfile(
            id: UUID().uuidString.lowercased(),
            name: name,
            address: address,
            color: color,
            symbol: symbol
        )
        var next = book
        next.profiles.append(profile)
        commit(next)
        refreshStatuses()
        return profile
    }

    func update(_ profile: ServerProfile) {
        guard let index = book.profiles.firstIndex(where: { $0.id == profile.id }) else { return }
        let previous = book.profiles[index]
        var next = book
        next.profiles[index] = profile
        commit(next)
        if profile.id == book.activeID, previous.address != profile.address {
            switching = true
            onActivate?()
            switching = false
        }
        refreshStatuses()
    }

    func remove(_ id: String) {
        guard book.profiles.count > 1, let removed = profile(id: id) else { return }
        var next = book
        next.profiles.removeAll { $0.id == id }
        if next.defaultID == id {
            next.defaultID = next.profiles[0].id
        }
        let wasActive = next.activeID == id
        if wasActive {
            next.activeID = next.defaultID
        }
        commit(next)
        if !removed.sharesLegacySession {
            AuthStore.removeAll(profile: removed)
        }
        statuses[id] = nil
        if wasActive {
            onActivate?()
        }
    }

    func setDefault(_ id: String) {
        guard book.profiles.contains(where: { $0.id == id }) else { return }
        var next = book
        next.defaultID = id
        commit(next)
    }

    func move(from source: IndexSet, to destination: Int) {
        var next = book
        next.profiles.move(fromOffsets: source, toOffset: destination)
        commit(next)
    }

    func refreshStatuses() {
        checkTask?.cancel()
        let profiles = book.profiles
        let activeID = book.active.id
        checkTask = Task { [weak self] in
            await withTaskGroup(of: (String, ServerProfileStatus).self) { group in
                for profile in profiles {
                    let active = profile.id == activeID
                    let token = AuthStore.read(.session, profile: profile, migrate: active)
                    let pending = token == nil && !active && AuthStore.hasLegacy(.session, profile: profile)
                    group.addTask {
                        (profile.id, await Self.probe(profile, token: token, pendingLogin: pending))
                    }
                }
                for await (id, status) in group {
                    guard !Task.isCancelled else { return }
                    self?.statuses[id] = status
                }
            }
        }
    }

    nonisolated static func probe(_ profile: ServerProfile, token: String?, pendingLogin: Bool = false) async -> ServerProfileStatus {
        guard let url = profile.url else { return .offline }
        let client = AuthClient(baseURL: url)
        let clock = ContinuousClock()
        let started = clock.now
        do {
            try await client.health()
        } catch {
            return .offline
        }
        let latency = milliseconds(started.duration(to: clock.now))
        guard let setup = try? await client.setupStatus() else {
            return .connected(latency: latency)
        }
        if setup.needsOwner {
            return .needsOwner
        }
        guard let token else {
            return pendingLogin ? .connected(latency: latency) : .signedOut
        }
        do {
            _ = try await client.profile(token: token)
            return .connected(latency: latency)
        } catch AuthFailure.server(401, _) {
            return .signedOut
        } catch {
            return .connected(latency: latency)
        }
    }

    nonisolated static func test(address: String) async -> Result<Int, ServerTestFailure> {
        guard let url = ServerConfig.parse(address) else { return .failure(.invalid) }
        let client = AuthClient(baseURL: url)
        let clock = ContinuousClock()
        let started = clock.now
        do {
            try await client.health()
            return .success(max(milliseconds(started.duration(to: clock.now)), 1))
        } catch {
            return .failure(.unreachable)
        }
    }

    nonisolated private static func milliseconds(_ duration: Duration) -> Int {
        let parts = duration.components
        return Int(parts.seconds) * 1000 + Int(parts.attoseconds / 1_000_000_000_000_000)
    }

    private func commit(_ next: ServerProfileBook) {
        ServerConfig.save(next)
        book = next
    }
}

enum ServerTestFailure: Error, Equatable {
    case invalid
    case unreachable

    var message: String {
        switch self {
        case .invalid: tr("Endereço inválido. Use http:// ou https://")
        case .unreachable: tr("Não respondeu. Confira o endereço e se o servidor está ligado.")
        }
    }
}
