import Foundation
import os

struct CachedTranscript: Sendable {
    var lines: [[StreamFact]]
    var total: Int
    var reactions: [MessageReaction] = []

    var start: Int {
        max(0, total - lines.count)
    }
}

final class TranscriptCache: Sendable {
    static let shared = TranscriptCache()
    static let pageSize = 60
    private static let maxBytes = 1_500_000

    private struct State {
        var memory: [String: CachedTranscript] = [:]
        var order: [String] = []
        var warming: Set<String> = []
        var warmedAt: [String: Date] = [:]
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let queue = DispatchQueue(label: "com.runelay.bots.transcript-cache", qos: .utility)

    func read(server: URL, sessionID: String) -> CachedTranscript? {
        let key = Self.key(server: server, sessionID: sessionID)
        if let hit = state.withLock({ $0.memory[key] }) {
            return hit
        }
        guard let url = Self.fileURL(server: server, sessionID: sessionID),
            let data = try? Data(contentsOf: url),
            let cached = Self.decode(data)
        else { return nil }
        remember(cached, key: key)
        return cached
    }

    func write(_ cached: CachedTranscript, server: URL, sessionID: String) {
        let key = Self.key(server: server, sessionID: sessionID)
        remember(cached, key: key)
        queue.async {
            guard let url = Self.fileURL(server: server, sessionID: sessionID),
                let data = Self.encode(cached)
            else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    func warm(client: BotsClient, basePath: String, sessionID: String) {
        let server = client.baseURL
        let key = Self.key(server: server, sessionID: sessionID)
        let skip = state.withLock { state -> Bool in
            if state.warming.contains(key) { return true }
            if let at = state.warmedAt[key], Date().timeIntervalSince(at) < 30 { return true }
            state.warming.insert(key)
            return false
        }
        guard !skip else { return }
        Task.detached(priority: .utility) { [self] in
            let page = try? await client.events(basePath: basePath, sessionId: sessionID, before: nil, limit: Self.pageSize)
            state.withLock { state in
                state.warming.remove(key)
                state.warmedAt[key] = Date()
            }
            guard let page, let total = page.total else { return }
            write(CachedTranscript(lines: page.lines, total: total, reactions: page.reactions ?? []), server: server, sessionID: sessionID)
        }
    }

    func forgetMemory() {
        state.withLock { $0 = State() }
    }

    private func remember(_ cached: CachedTranscript, key: String) {
        state.withLock { state in
            state.memory[key] = cached
            state.order.removeAll { $0 == key }
            state.order.append(key)
            while state.order.count > 24 {
                state.memory[state.order.removeFirst()] = nil
            }
        }
    }

    private static func key(server: URL, sessionID: String) -> String {
        "\(folderName(server))/\(fileName(sessionID))"
    }

    private static func folderName(_ server: URL) -> String {
        let scope = ServerConfig.keychainScope(for: server).map { "\($0)-" } ?? ""
        let raw = "\(scope)\(server.host() ?? "local")-\(server.port.map(String.init) ?? "")"
        return String(raw.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." ? $0 : "_" })
    }

    private static func fileName(_ sessionID: String) -> String {
        String(sessionID.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    }

    private static func fileURL(server: URL, sessionID: String) -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appending(path: "runelay bots", directoryHint: .isDirectory)
            .appending(path: "transcripts", directoryHint: .isDirectory)
            .appending(path: folderName(server), directoryHint: .isDirectory)
            .appending(path: "\(fileName(sessionID)).json")
    }

    private static func encode(_ cached: CachedTranscript) -> Data? {
        var lines = cached.lines.map { line in
            line.map { fact -> [String: Any] in
                var object: [String: Any] = ["t": fact.type, "d": fact.data.foundationObject, "k": fact.key]
                if let scope = fact.scope {
                    object["s"] = scope.foundationObject
                }
                if let at = fact.at {
                    object["a"] = at
                }
                return object
            }
        }
        while !lines.isEmpty {
            let object: [String: Any] = [
                "v": 1,
                "total": cached.total,
                "lines": lines,
                "r": cached.reactions.suffix(400).map(\.json.foundationObject),
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
            if data.count <= maxBytes || lines.count == 1 {
                return data
            }
            lines.removeFirst(max(1, lines.count / 4))
        }
        return nil
    }

    private static func decode(_ data: Data) -> CachedTranscript? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["v"] as? Int == 1,
            let total = object["total"] as? Int,
            let rawLines = object["lines"] as? [[[String: Any]]]
        else { return nil }
        let lines = rawLines.map { line in
            line.compactMap { raw -> StreamFact? in
                guard let type = raw["t"] as? String, let key = raw["k"] as? String else { return nil }
                return StreamFact(
                    type: type,
                    data: JSONValue(foundation: raw["d"] as Any),
                    scope: raw["s"].map { JSONValue(foundation: $0) },
                    key: key,
                    at: raw["a"] as? String
                )
            }
        }
        let reactions = (object["r"] as? [Any] ?? []).compactMap { MessageReaction(json: JSONValue(foundation: $0)) }
        return CachedTranscript(lines: lines, total: total, reactions: reactions)
    }
}

extension JSONValue {
    fileprivate var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case .bool(let value): value
        case .number(let value): value
        case .string(let value): value
        case .array(let value): value.map(\.foundationObject)
        case .object(let value): value.mapValues(\.foundationObject)
        }
    }

    fileprivate init(foundation: Any) {
        switch foundation {
        case let value as String:
            self = .string(value)
        case let value as NSNumber:
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                self = .bool(value.boolValue)
            } else {
                self = .number(value.doubleValue)
            }
        case let value as [Any]:
            self = .array(value.map { JSONValue(foundation: $0) })
        case let value as [String: Any]:
            self = .object(value.mapValues { JSONValue(foundation: $0) })
        default:
            self = .null
        }
    }
}
