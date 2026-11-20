import Foundation
import Observation

enum TabPlacement {
    case current
    case new
}

struct ClosedTab: Equatable {
    let botID: String
    let sessionID: String?
    let index: Int
}

@MainActor
@Observable
final class BotTabs {
    private struct Saved: Codable {
        var order: [String]
        var sessions: [String: String]
        var active: String?
    }

    private(set) var order: [String] = []
    private(set) var attention: Set<String> = []
    @ObservationIgnored private(set) var sessions: [String: String] = [:]
    @ObservationIgnored var artifacts: [String: ArtifactRef] = [:]
    @ObservationIgnored var placement: TabPlacement?
    @ObservationIgnored private(set) var savedActive: String?
    @ObservationIgnored private(set) var hasSavedState = false
    @ObservationIgnored private var closed: [ClosedTab] = []
    @ObservationIgnored private let storageKey: String

    init(profileID: String) {
        storageKey = "tabs.\(profileID)"
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let saved = try? JSONDecoder().decode(Saved.self, from: data)
        else { return }
        hasSavedState = true
        order = Self.unique(saved.order)
        sessions = saved.sessions
        savedActive = saved.active
    }

    var canReopen: Bool {
        !closed.isEmpty
    }

    func contains(_ botID: String) -> Bool {
        order.contains(botID)
    }

    func index(of botID: String) -> Int? {
        order.firstIndex(of: botID)
    }

    func place(_ botID: String, current: String?) {
        defer { placement = nil }
        guard !order.contains(botID) else { return }
        guard let current, let index = order.firstIndex(of: current) else {
            order.append(botID)
            return
        }
        let replaces = placement == .current || current.contains("pending")
        if replaces {
            artifacts.removeValue(forKey: current)
            attention.remove(current)
            order[index] = botID
        } else {
            order.insert(botID, at: index + 1)
        }
    }

    func insert(_ botID: String, at index: Int) {
        guard !order.contains(botID) else { return }
        order.insert(botID, at: min(max(index, 0), order.count))
    }

    func close(_ botID: String, sessionID: String?, remember: Bool = true) {
        guard let index = order.firstIndex(of: botID) else { return }
        order.remove(at: index)
        attention.remove(botID)
        artifacts.removeValue(forKey: botID)
        closed.removeAll { $0.botID == botID }
        guard remember else { return }
        closed.append(ClosedTab(botID: botID, sessionID: sessionID, index: index))
        if closed.count > 20 {
            closed.removeFirst()
        }
    }

    func popClosed(where isValid: (ClosedTab) -> Bool) -> ClosedTab? {
        while let last = closed.popLast() {
            if isValid(last), !order.contains(last.botID) {
                return last
            }
        }
        return nil
    }

    func move(_ botID: String, to target: Int) {
        guard let from = order.firstIndex(of: botID) else { return }
        let clamped = min(max(target, 0), order.count - 1)
        guard clamped != from else { return }
        order.remove(at: from)
        order.insert(botID, at: clamped)
    }

    func remove(where shouldRemove: (String) -> Bool) -> [String] {
        let removed = order.filter(shouldRemove)
        guard !removed.isEmpty else { return [] }
        order.removeAll(where: shouldRemove)
        for id in removed {
            attention.remove(id)
            artifacts.removeValue(forKey: id)
            sessions.removeValue(forKey: id)
        }
        return removed
    }

    func flag(_ botID: String) {
        guard order.contains(botID), !attention.contains(botID) else { return }
        attention.insert(botID)
    }

    func clearFlag(_ botID: String) {
        guard attention.contains(botID) else { return }
        attention.remove(botID)
    }

    func session(for botID: String) -> String? {
        sessions[botID]
    }

    func save(active: String?, sessions current: [String: String]) {
        for id in order {
            if let session = current[id] {
                sessions[id] = session
            }
        }
        sessions = sessions.filter { order.contains($0.key) }
        hasSavedState = true
        let saved = Saved(order: order, sessions: sessions, active: active)
        guard let data = try? JSONEncoder().encode(saved) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    private static func unique(_ ids: [String]) -> [String] {
        var seen: Set<String> = []
        return ids.filter { !$0.contains("pending") && seen.insert($0).inserted }
    }
}
