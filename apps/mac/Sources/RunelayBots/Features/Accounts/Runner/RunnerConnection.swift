import Foundation
import Observation

enum RunnerLinkState: Equatable {
    case connecting
    case connected
    case offline(String)
}

enum RunnerToken {
    static var file: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/runelay bots/runner.token")
    }

    static func read() -> String? {
        AuthStore.read(.device)
    }
}

struct RunnerSender: @unchecked Sendable {
    let socket: URLSessionWebSocketTask

    func send(_ object: [String: JSONValue]) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(JSONValue.object(object)) else { return }
        socket.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }
}

@MainActor
@Observable
final class RunnerConnection {
    static let shared = RunnerConnection()

    var state: RunnerLinkState = .connecting
    var revoked = false
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var mcpWaiting: [String: CheckedContinuation<McpReply, Never>] = [:]
    @ObservationIgnored private var sender: RunnerSender?
    @ObservationIgnored private var turns: [String: TurnHandle] = [:]
    @ObservationIgnored private let session = URLSession(configuration: .default)

    func start() {
        guard loop == nil else { return }
        signal(SIGPIPE, SIG_IGN)
        McpProxy.shared.start()
        ComputerExecutor.shared.eventSink = { event in
            RunnerConnection.shared.sender?.send(["type": .string("computer.event"), "event": event])
        }
        loop = Task { @MainActor [weak self] in
            await self?.run()
        }
    }

    func restart() {
        loop?.cancel()
        loop = nil
        sender?.socket.cancel(with: .goingAway, reason: nil)
        sender = nil
        start()
    }

    private var endpoint: URL? {
        guard var components = URLComponents(url: ServerConfig.currentURL(), resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/runner/connect"
        components.query = nil
        return components.url
    }

    private func run() async {
        var delay: Double = 1
        while !Task.isCancelled {
            guard let token = RunnerToken.read() else {
                state = .offline(revoked ? "Este Mac foi desconectado da conta. Conecte de novo em Ajustes › Dispositivos." : "Entre na sua conta para conectar este Mac.")
                try? await Task.sleep(for: .seconds(10))
                continue
            }
            guard let endpoint else {
                state = .offline("O endereço do servidor não parece válido.")
                try? await Task.sleep(for: .seconds(10))
                continue
            }
            if state != .connected {
                state = .connecting
            }
            var request = URLRequest(url: endpoint)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 20
            let socket = session.webSocketTask(with: request)
            socket.maximumMessageSize = 32 * 1024 * 1024
            socket.resume()
            let sender = RunnerSender(socket: socket)
            do {
                try await socket.send(.string(Self.helloText))
            } catch {
                let status = (socket.response as? HTTPURLResponse)?.statusCode ?? 0
                socket.cancel()
                if status == 401 || status == 403 {
                    forgetDevice()
                    continue
                }
                state = .offline("Não deu para falar com o servidor.")
                try? await Task.sleep(for: .seconds(delay))
                delay = min(delay * 2, 15)
                continue
            }
            self.sender = sender
            state = .connected
            delay = 1
            let pinger = Task { @MainActor in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(20))
                    guard !Task.isCancelled else { return }
                    let alive = await Self.ping(socket)
                    if !alive {
                        socket.cancel(with: .abnormalClosure, reason: nil)
                        return
                    }
                }
            }
            while !Task.isCancelled {
                guard let message = try? await socket.receive() else { break }
                if case .string(let text) = message {
                    handle(text, sender: sender)
                }
            }
            pinger.cancel()
            let closeCode = socket.closeCode.rawValue
            let status = (socket.response as? HTTPURLResponse)?.statusCode ?? 0
            socket.cancel()
            if self.sender?.socket === socket {
                self.sender = nil
            }
            for handle in turns.values {
                handle.cancel()
            }
            turns.removeAll()
            failMcp()
            guard !Task.isCancelled else { return }
            if closeCode == 4001 || closeCode == 4003 || status == 401 || status == 403 {
                forgetDevice()
                continue
            }
            state = .offline("A conexão com o servidor caiu. Tentando de novo…")
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 15)
        }
    }

    private static var helloText: String {
        let hello: JSONValue = .object([
            "type": .string("hello"),
            "app": .string("runelay bots"),
            "version": .string(AppInfo.version),
            "capabilities": .array([
                .string("turns"), .string("accounts"), .string("computer"), .string("transcribe"), .string("vault"), .string("usage"), .string("files"), .string("mcp-proxy"), .string("simulators"),
            ]),
        ])
        return String(decoding: (try? JSONEncoder().encode(hello)) ?? Data(), as: UTF8.self)
    }

    nonisolated private static func ping(_ socket: URLSessionWebSocketTask) async -> Bool {
        await withCheckedContinuation { continuation in
            let once = OnceFlag()
            socket.sendPing { error in
                if once.take() { continuation.resume(returning: error == nil) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
                if once.take() { continuation.resume(returning: false) }
            }
        }
    }

    private func handle(_ text: String, sender: RunnerSender) {
        guard let message = JSONValue.parse(text), let type = message["type"]?.stringValue else { return }
        let id = message["id"]?.stringValue ?? ""
        switch type {
        case "request":
            respond(to: message, id: id, sender: sender)
        case "turn.start":
            guard let turnValue = message["turn"], let turn = LocalTurn(turnValue) else {
                sender.send(["type": .string("turn.event"), "id": .string(id), "event": LocalProviders.done(false, "Turno inválido.")])
                sender.send(["type": .string("turn.end"), "id": .string(id)])
                return
            }
            let handle = TurnHandle()
            turns[id] = handle
            Task.detached(priority: .userInitiated) {
                await LocalProviders.runTurn(turn, handle: handle) { event in
                    sender.send(["type": .string("turn.event"), "id": .string(id), "event": event])
                }
                sender.send(["type": .string("turn.end"), "id": .string(id)])
                await MainActor.run {
                    RunnerConnection.shared.finishTurn(id, handle: handle)
                }
            }
        case "turn.cancel":
            turns[id]?.cancel()
        case "mcp.response":
            resolveMcp(id, message)
        default:
            break
        }
    }

    func forgetDevice() {
        AuthStore.remove(.device)
        DeviceIdentity.setRevoked(true)
        revoked = true
        state = .offline("Este Mac foi desconectado da conta. Conecte de novo em Ajustes › Dispositivos.")
    }

    func deviceRegistered() {
        DeviceIdentity.setRevoked(false)
        revoked = false
        restart()
    }

    func forwardMcp(method: String, path: String, headers: [String: String], body: Data) async -> McpReply {
        guard let sender else { return .failure(503, "Mac desconectado do servidor.") }
        let id = UUID().uuidString
        var forwarded: [String: JSONValue] = [:]
        for name in ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"] {
            if let value = headers[name] { forwarded[name] = .string(value) }
        }
        return await withCheckedContinuation { continuation in
            mcpWaiting[id] = continuation
            sender.send([
                "type": .string("mcp.request"),
                "id": .string(id),
                "method": .string(method),
                "path": .string(path),
                "headers": .object(forwarded),
                "body": .string(String(decoding: body, as: UTF8.self)),
            ])
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(905))
                self?.resolveMcp(id, nil)
            }
        }
    }

    private func resolveMcp(_ id: String, _ message: JSONValue?) {
        guard let continuation = mcpWaiting.removeValue(forKey: id) else { return }
        guard let message else {
            continuation.resume(returning: .failure(504, "O servidor não respondeu a tempo."))
            return
        }
        var headers: [String: String] = [:]
        if case .object(let object) = message["headers"] ?? .null {
            for (name, value) in object {
                if let text = value.stringValue { headers[name] = text }
            }
        }
        let status = message["status"]?.intValue ?? 502
        let body = Data((message["body"]?.stringValue ?? "").utf8)
        continuation.resume(returning: McpReply(status: status, headers: headers, body: body))
    }

    private func failMcp() {
        let waiting = mcpWaiting
        mcpWaiting.removeAll()
        for continuation in waiting.values {
            continuation.resume(returning: .failure(502, "A conexão com o servidor caiu."))
        }
    }

    private func finishTurn(_ id: String, handle: TurnHandle) {
        if turns[id] === handle {
            turns.removeValue(forKey: id)
        }
    }

    private func respond(to message: JSONValue, id: String, sender: RunnerSender) {
        let op = message["op"]?.stringValue ?? ""
        switch op {
        case "accounts":
            Task.detached(priority: .utility) {
                let result = await LocalProviders.probeAll()
                sender.send(["type": .string("response"), "id": .string(id), "ok": .bool(true), "result": result])
            }
        case "computer.health":
            let body = ComputerExecutor.shared.health()
            sender.send(["type": .string("response"), "id": .string(id), "status": .number(200), "body": body])
        case "computer.tool":
            let tool = message["tool"]?.stringValue ?? ""
            let body = message["body"] ?? .object([:])
            Task { @MainActor in
                let reply = await ComputerExecutor.shared.perform(tool: tool, body: body)
                sender.send(["type": .string("response"), "id": .string(id), "status": .number(Double(reply.status)), "body": reply.body])
            }
        case "secret.resolve":
            let body = message["body"] ?? .object([:])
            Task { @MainActor in
                var reply = await VaultStore.shared.resolveForServer(body)
                reply["type"] = .string("response")
                reply["id"] = .string(id)
                sender.send(reply)
            }
        case "usage.limits":
            Task.detached(priority: .utility) {
                let result = await LocalUsageLimits.read()
                sender.send(["type": .string("response"), "id": .string(id), "ok": .bool(true), "result": result])
            }
        case "usage.buckets":
            let since = message["body"]?["since"]?.intValue ?? 0
            Task.detached(priority: .utility) {
                let result = await LocalUsageScanner.shared.buckets(since: since)
                sender.send(["type": .string("response"), "id": .string(id), "ok": .bool(true), "result": result])
            }
        case "file.read":
            let body = message["body"] ?? .object([:])
            let path = body["path"]?.stringValue ?? ""
            let maxBytes = body["maxBytes"]?.intValue ?? 20 * 1_048_576
            Task.detached(priority: .userInitiated) {
                var reply = RunnerFiles.read(path: path, maxBytes: maxBytes)
                reply["type"] = .string("response")
                reply["id"] = .string(id)
                sender.send(reply)
            }
        case "transcribe_file":
            let body = message["body"] ?? .object([:])
            let audio = body["audioBase64"]?.stringValue ?? ""
            let name = body["name"]?.stringValue ?? "audio.mp3"
            let locale = body["locale"]?.stringValue ?? "pt-BR"
            Task.detached(priority: .userInitiated) {
                do {
                    let text = try await FileTranscriber.transcribe(base64: audio, name: name, locale: locale)
                    sender.send(["type": .string("response"), "id": .string(id), "ok": .bool(true), "result": .object(["text": .string(text)])])
                } catch {
                    sender.send(["type": .string("response"), "id": .string(id), "ok": .bool(false), "error": .string(error.localizedDescription)])
                }
            }
        case let name where name.hasPrefix("sim.") || name.hasPrefix("maestro."):
            let body = message["body"] ?? .object([:])
            Task.detached(priority: .userInitiated) {
                var reply = await SimulatorRunner.perform(op: name, body: body)
                reply["type"] = .string("response")
                reply["id"] = .string(id)
                sender.send(reply)
            }
        default:
            sender.send(["type": .string("response"), "id": .string(id), "ok": .bool(false), "error": .string("Pedido desconhecido: \(op).")])
        }
    }
}

private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var used = false

    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if used { return false }
        used = true
        return true
    }
}
