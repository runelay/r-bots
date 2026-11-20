import CryptoKit
import Foundation

struct UsageIndexCursor: Codable, Sendable {
    var offset: UInt64
    var codex: UsageCodexState?
}

struct UsageCodexState: Codable, Sendable {
    var model: String
    var speed: String
    var session: String
    var start: Double
    var prev: [Double]?
}

struct UsageIndex: Codable, Sendable {
    var version: Int
    var files: [String: UsageIndexCursor]
    var buckets: [String: [Double]]
    var sessions: [String: UsageSessionEntry]
    var seen: [String: Int]
}

struct UsageSessionEntry: Codable, Sendable {
    var hour: Int
    var model: String
}

actor LocalUsageScanner {
    static let shared = LocalUsageScanner()

    private static let version = 1
    private static let keepSeconds = 100 * 86_400
    private var index: UsageIndex?

    private var indexURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/runelay bots/usage-index.json")
    }

    private var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    func buckets(since: Int) -> JSONValue {
        var index = load()
        let claude = Self.listJSONL(home.appending(path: ".claude/projects"))
        let codex = Self.listJSONL(home.appending(path: ".codex/sessions"))
        var changed = false
        for path in claude {
            if visit(path, provider: "claude", index: &index) { changed = true }
        }
        for path in codex {
            if visit(path, provider: "codex", index: &index) { changed = true }
        }
        if changed {
            prune(&index)
            save(index)
        }
        self.index = index
        var rows: [JSONValue] = []
        for (key, counters) in index.buckets {
            let parts = key.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 4, let hour = Int(parts[0]), hour >= since else { continue }
            rows.append(.object([
                "h": .number(Double(hour)),
                "p": .string(parts[1]),
                "m": .string(parts[2]),
                "s": .string(parts[3]),
                "c": .array(counters.map { .number($0) }),
            ]))
        }
        var sessions: [JSONValue] = []
        for (key, entry) in index.sessions where entry.hour >= since {
            let provider = key.split(separator: ":").first.map(String.init) ?? "claude"
            sessions.append(.object(["p": .string(provider), "h": .number(Double(entry.hour)), "m": .string(entry.model)]))
        }
        return .object([
            "rows": .array(rows),
            "sessions": .array(sessions),
            "scannedAt": .string(ISO8601DateFormatter().string(from: Date())),
            "files": .number(Double(claude.count + codex.count)),
        ])
    }

    private func load() -> UsageIndex {
        if let index { return index }
        if let data = try? Data(contentsOf: indexURL),
           let parsed = try? JSONDecoder().decode(UsageIndex.self, from: data),
           parsed.version == Self.version {
            return parsed
        }
        return UsageIndex(version: Self.version, files: [:], buckets: [:], sessions: [:], seen: [:])
    }

    private func save(_ index: UsageIndex) {
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? FileManager.default.createDirectory(at: indexURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: indexURL, options: .atomic)
    }

    private func prune(_ index: inout UsageIndex) {
        let floor = Int(Date().timeIntervalSince1970) - Self.keepSeconds
        index.seen = index.seen.filter { $0.value >= floor }
        index.buckets = index.buckets.filter { key, _ in
            (Int(key.split(separator: "|").first ?? "") ?? 0) >= floor
        }
        index.sessions = index.sessions.filter { $0.value.hour >= floor }
    }

    private static func listJSONL(_ root: URL) -> [String] {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]) else { return [] }
        var found: [String] = []
        for case let url as URL in enumerator where url.pathExtension == "jsonl" {
            found.append(url.path(percentEncoded: false))
        }
        return found
    }

    private func visit(_ path: String, provider: String, index: inout UsageIndex) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = (attributes[.size] as? NSNumber)?.uint64Value
        else { return false }
        var cursor = index.files[path] ?? UsageIndexCursor(offset: 0, codex: nil)
        if size < cursor.offset {
            cursor = UsageIndexCursor(offset: 0, codex: nil)
        }
        guard size > cursor.offset, let handle = FileHandle(forReadingAtPath: path) else { return false }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: cursor.offset)
        } catch {
            return false
        }
        if provider == "codex", cursor.codex == nil {
            cursor.codex = UsageCodexState(model: "", speed: "standard", session: "", start: 0, prev: nil)
        }
        var carry = Data()
        var consumed = cursor.offset
        var remaining = size - cursor.offset
        while remaining > 0 {
            let chunk = (try? handle.read(upToCount: Int(min(remaining, 4 * 1024 * 1024)))) ?? nil
            guard let chunk, !chunk.isEmpty else { break }
            remaining -= UInt64(chunk.count)
            carry.append(chunk)
            var start = carry.startIndex
            while let newline = carry[start...].firstIndex(of: 0x0A) {
                let line = carry[start..<newline]
                consumed += UInt64(newline - start + 1)
                if !line.isEmpty {
                    if provider == "claude" {
                        claudeLine(line, index: &index)
                    } else if var state = cursor.codex {
                        codexLine(line, state: &state, index: &index)
                        cursor.codex = state
                    }
                }
                start = newline + 1
            }
            carry = Data(carry[start...])
        }
        cursor.offset = consumed
        index.files[path] = cursor
        return true
    }

    private static let usageNeedle = Data("\"usage\"".utf8)
    private static let codexNeedles = ["\"token_count\"", "\"turn_context\"", "\"session_meta\"", "\"thread_settings_applied\""].map { Data($0.utf8) }

    private static func hour(_ value: Any?) -> Int? {
        guard let text = value as? String, let date = parseDate(text) else { return nil }
        return Int(date.timeIntervalSince1970) / 3600 * 3600
    }

    nonisolated(unsafe) private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plainFormatter = ISO8601DateFormatter()

    private static func parseDate(_ text: String) -> Date? {
        if let date = fractionalFormatter.date(from: text) { return date }
        return plainFormatter.date(from: text)
    }

    private static func number(_ value: Any?) -> Double {
        guard let value = value as? NSNumber else { return 0 }
        let double = value.doubleValue
        return double.isFinite && double > 0 ? double : 0
    }

    private func add(_ index: inout UsageIndex, hour: Int, provider: String, model: String, speed: String, values: [Double]) {
        let key = "\(hour)|\(provider)|\(model)|\(speed)"
        var bucket = index.buckets[key] ?? Array(repeating: 0, count: 7)
        for (offset, value) in values.enumerated() where offset < bucket.count {
            bucket[offset] += value
        }
        index.buckets[key] = bucket
    }

    private func session(_ index: inout UsageIndex, provider: String, id: String, hour: Int, model: String) {
        guard !id.isEmpty else { return }
        let key = "\(provider):\(id)"
        if let current = index.sessions[key], current.hour <= hour { return }
        index.sessions[key] = UsageSessionEntry(hour: hour, model: model)
    }

    private func claudeLine(_ line: Data, index: inout UsageIndex) {
        guard line.range(of: Self.usageNeedle) != nil,
              let record = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              record["type"] as? String == "assistant",
              let message = record["message"] as? [String: Any],
              let usage = message["usage"] as? [String: Any],
              let model = message["model"] as? String, !model.isEmpty, model != "<synthetic>",
              let hour = Self.hour(record["timestamp"])
        else { return }
        let raw = "\(message["id"] as? String ?? ""):\(record["requestId"] as? String ?? record["uuid"] as? String ?? "")"
        let digest = Insecure.SHA1.hash(data: Data(raw.utf8))
        let key = String(Data(digest).base64EncodedString().prefix(12))
        if index.seen[key] != nil { return }
        index.seen[key] = hour
        let creation = usage["cache_creation"] as? [String: Any]
        let write = Self.number(usage["cache_creation_input_tokens"])
        let write1h = min(write, Self.number(creation?["ephemeral_1h_input_tokens"]))
        let speed = usage["speed"] as? String == "fast" ? "fast" : "standard"
        add(&index, hour: hour, provider: "claude", model: model, speed: speed, values: [
            Self.number(usage["input_tokens"]),
            Self.number(usage["cache_read_input_tokens"]),
            write - write1h,
            write1h,
            Self.number(usage["output_tokens"]),
            0,
            1,
        ])
        session(&index, provider: "claude", id: record["sessionId"] as? String ?? "", hour: hour, model: model)
    }

    private func codexLine(_ line: Data, state: inout UsageCodexState, index: inout UsageIndex) {
        guard Self.codexNeedles.contains(where: { line.range(of: $0) != nil }),
              let record = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
        else { return }
        let type = record["type"] as? String
        let payload = record["payload"] as? [String: Any] ?? [:]
        if type == "session_meta" {
            if state.session.isEmpty {
                state.session = payload["id"] as? String ?? payload["session_id"] as? String ?? ""
                let stamp = payload["timestamp"] as? String ?? record["timestamp"] as? String ?? ""
                state.start = Self.parseDate(stamp)?.timeIntervalSince1970 ?? 0
            }
            return
        }
        if type == "turn_context" {
            if let model = payload["model"] as? String { state.model = model }
            if let tier = payload["service_tier"] as? String { state.speed = Self.speed(tier) }
            return
        }
        if payload["type"] as? String == "thread_settings_applied" {
            if let tier = (payload["thread_settings"] as? [String: Any])?["service_tier"] as? String {
                state.speed = Self.speed(tier)
            }
            return
        }
        guard type == "event_msg", payload["type"] as? String == "token_count",
              let info = payload["info"] as? [String: Any],
              let total = info["total_token_usage"] as? [String: Any]
        else { return }
        let last = info["last_token_usage"] as? [String: Any]
        let fields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"]
        let totals = fields.map { Self.number(total[$0]) }
        let previous = state.prev
        state.prev = totals
        let at = Self.parseDate(record["timestamp"] as? String ?? "")?.timeIntervalSince1970
        if state.start > 0, let at, at < state.start - 1 { return }
        var delta: [Double]
        if let previous, zip(totals, previous).allSatisfy({ $0 >= $1 }) {
            delta = zip(totals, previous).map { $0 - $1 }
        } else if previous != nil {
            delta = fields.map { Self.number(last?[$0]) }
        } else {
            delta = totals
        }
        guard delta[0] > 0 || delta[3] > 0, let hour = Self.hour(record["timestamp"]) else { return }
        let model = state.model.isEmpty ? "codex" : state.model
        let uncached = max(0, delta[0] - delta[1] - delta[2])
        add(&index, hour: hour, provider: "codex", model: model, speed: state.speed, values: [uncached, delta[1], delta[2], 0, delta[3], delta[4], 1])
        session(&index, provider: "codex", id: state.session, hour: hour, model: model)
    }

    private static func speed(_ tier: String) -> String {
        tier.contains("priority") || tier.contains("fast") ? "fast" : "standard"
    }
}

enum LocalUsageLimits {
    static func read() async -> JSONValue {
        async let claude = claudeLimits()
        async let codex = codexLimits()
        return .object(["claude": await claude, "codex": await codex])
    }

    private static func failure(_ message: String, label: String? = nil) -> JSONValue {
        var object: [String: JSONValue] = ["ok": .bool(false), "error": .string(message)]
        if let label { object["label"] = .string(label) }
        return .object(object)
    }

    private static func claudeIdentity() -> String? {
        let url = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude.json")
        guard let data = try? Data(contentsOf: url),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let account = json["oauthAccount"] as? [String: Any]
        else { return nil }
        let name = account["displayName"] as? String ?? account["organizationName"] as? String
        return name?.isEmpty == false ? name : nil
    }

    private static func claudeCredentials() async -> [String: Any]? {
        let file = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude/.credentials.json")
        if let data = try? Data(contentsOf: file),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            return json["claudeAiOauth"] as? [String: Any]
        }
        let result = await LocalCLI.capture("/usr/bin/security", ["find-generic-password", "-a", NSUserName(), "-s", "Claude Code-credentials", "-w"], timeout: .seconds(10))
        var text = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.code != 0 || text.isEmpty {
            let fallback = await LocalCLI.capture("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], timeout: .seconds(10))
            guard fallback.code == 0 else { return nil }
            text = fallback.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var data = Data(text.utf8)
        if !text.hasPrefix("{"), text.count.isMultiple(of: 2), let decoded = hexData(text) {
            data = decoded
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return json["claudeAiOauth"] as? [String: Any]
    }

    private static func hexData(_ text: String) -> Data? {
        var data = Data(capacity: text.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        return data
    }

    private static func claudeLimits() async -> JSONValue {
        let label = claudeIdentity()
        guard let oauth = await claudeCredentials(), let token = oauth["accessToken"] as? String, !token.isEmpty else {
            return failure("Não achei o login do Claude Code neste Mac.", label: label)
        }
        if let expires = (oauth["expiresAt"] as? NSNumber)?.doubleValue, expires < Date().timeIntervalSince1970 * 1000 {
            return failure("O login do Claude Code no Mac expirou. Ele renova quando o Claude rodar de novo.", label: label)
        }
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/usage") else { return failure("Endereço inválido.") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("claude-code/2.1.328", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status), let raw = try? JSONDecoder().decode(JSONValue.self, from: data) else {
                return failure("A Anthropic respondeu \(status) ao ler os limites do Mac.", label: label)
            }
            var object: [String: JSONValue] = ["ok": .bool(true), "raw": raw]
            if let label { object["label"] = .string(label) }
            if let plan = oauth["subscriptionType"] as? String { object["plan"] = .string(plan) }
            return .object(object)
        } catch {
            return failure("Não deu para falar com a Anthropic: \(error.localizedDescription)", label: label)
        }
    }

    private static func codexLimits() async -> JSONValue {
        guard let bin = LocalCLI.find(["codex"]) else { return failure("Codex CLI não está instalado no Mac.") }
        do {
            let raw = try await CodexRateLimitReader(bin: bin).read()
            return .object(["ok": .bool(true), "raw": raw, "label": .string("Mac")])
        } catch {
            return failure("Não deu para ler os limites do Codex no Mac: \(error.localizedDescription)")
        }
    }
}

struct CodexReadError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class CodexRateLimitReader: @unchecked Sendable {
    private let bin: String
    private let process = Process()
    private let lock = NSLock()
    private var continuation: CheckedContinuation<JSONValue, Error>?
    private var buffer = Data()

    init(bin: String) {
        self.bin = bin
    }

    func read() async throws -> JSONValue {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            start()
        }
    }

    private func finish(_ result: Result<JSONValue, Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        guard let pending else { return }
        if process.isRunning {
            process.terminate()
        }
        pending.resume(with: result)
    }

    private func start() {
        let output = Pipe()
        let input = Pipe()
        process.executableURL = URL(fileURLWithPath: bin)
        process.arguments = ["app-server"]
        process.environment = LocalCLI.environment(["CODEX_INTERNAL_ORIGINATOR_OVERRIDE": "runelay_bots"])
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.standardOutput = output
        process.standardInput = input
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in
            self?.finish(.failure(CodexReadError(message: "o Codex fechou sem responder")))
        }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard let self else { return }
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self.consume(chunk, writer: input.fileHandleForWriting)
        }
        do {
            try process.run()
        } catch {
            finish(.failure(error))
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) { [weak self] in
            self?.finish(.failure(CodexReadError(message: "o Codex não respondeu a tempo")))
        }
        write(["jsonrpc": .string("2.0"), "id": .number(1), "method": .string("initialize"), "params": .object(["clientInfo": .object(["name": .string("runelay_bots"), "title": .string("r/bots"), "version": .string(AppInfo.version)])])], to: input.fileHandleForWriting)
    }

    private func write(_ object: [String: JSONValue], to handle: FileHandle) {
        guard var data = try? JSONEncoder().encode(JSONValue.object(object)) else { return }
        data.append(0x0A)
        try? handle.write(contentsOf: data)
    }

    private func consume(_ chunk: Data, writer: FileHandle) {
        lock.lock()
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            lines.append(Data(buffer[buffer.startIndex..<newline]))
            buffer.removeSubrange(buffer.startIndex...newline)
        }
        lock.unlock()
        for line in lines {
            guard let message = try? JSONDecoder().decode(JSONValue.self, from: line) else { continue }
            switch message["id"]?.intValue {
            case 1:
                write(["jsonrpc": .string("2.0"), "method": .string("initialized")], to: writer)
                write(["jsonrpc": .string("2.0"), "id": .number(2), "method": .string("account/rateLimits/read"), "params": .null], to: writer)
            case 2:
                if let error = message["error"]?["message"]?.stringValue {
                    finish(.failure(CodexReadError(message: error)))
                } else {
                    let result = message["result"]
                    finish(.success(result?["rateLimitsByLimitId"]?["codex"] ?? result?["rateLimits"] ?? .object([:])))
                }
            default:
                break
            }
        }
    }
}
