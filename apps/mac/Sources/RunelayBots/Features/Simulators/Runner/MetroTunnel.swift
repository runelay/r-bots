import Foundation
import Network

final class MetroTunnel: @unchecked Sendable {
    static let shared = MetroTunnel()

    private let lock = NSLock()
    private var listeners: [Int: (local: Int, listener: NWListener)] = [:]
    private let queue = DispatchQueue(label: "runelay.metro-tunnel")
    private let session = URLSession(configuration: .default)

    func localPort(for remote: Int) -> Int? {
        lock.lock()
        defer { lock.unlock() }
        return listeners[remote]?.local
    }

    func ensure(remote: Int) async throws -> Int {
        if let existing = localPort(for: remote) { return existing }
        for candidate in [remote, 0] {
            if let port = try? await open(remote: remote, local: candidate) {
                return port
            }
        }
        throw NSError(domain: "runelay.tunnel", code: 1, userInfo: [NSLocalizedDescriptionKey: "Não consegui abrir a porta local para o Metro."])
    }

    func closeAll() {
        lock.lock()
        let all = listeners.values.map(\.listener)
        listeners.removeAll()
        lock.unlock()
        for listener in all { listener.cancel() }
    }

    private func open(remote: Int, local: Int) async throws -> Int {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: UInt16(local)) ?? .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.pipe(connection, remote: remote)
        }
        let port: Int = try await withCheckedThrowingContinuation { continuation in
            let once = TunnelOnce()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if once.take() { continuation.resume(returning: Int(listener.port?.rawValue ?? 0)) }
                case .failed(let error):
                    if once.take() { continuation.resume(throwing: error) }
                    listener.cancel()
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
        store(remote: remote, local: port, listener: listener)
        return port
    }

    private func store(remote: Int, local: Int, listener: NWListener) {
        lock.lock()
        listeners[remote] = (local, listener)
        lock.unlock()
    }

    private func endpoint(remote: Int) -> URL? {
        guard var components = URLComponents(url: ServerConfig.currentURL(), resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/runner/tunnel"
        components.queryItems = [URLQueryItem(name: "port", value: String(remote))]
        return components.url
    }

    private func pipe(_ connection: NWConnection, remote: Int) {
        guard let url = endpoint(remote: remote), let token = RunnerToken.read() else {
            connection.cancel()
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 64 * 1024 * 1024
        socket.resume()
        connection.start(queue: queue)
        let closed = TunnelOnce()
        let close: @Sendable () -> Void = {
            if closed.take() {
                socket.cancel(with: .normalClosure, reason: nil)
                connection.cancel()
            }
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled: close()
            default: break
            }
        }
        @Sendable func readLocal() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { data, _, complete, error in
                if let data, !data.isEmpty {
                    socket.send(.data(data)) { error in
                        if error != nil { close() }
                    }
                }
                if complete || error != nil {
                    close()
                    return
                }
                readLocal()
            }
        }
        @Sendable func readRemote() {
            socket.receive { result in
                switch result {
                case .success(let message):
                    let data: Data
                    switch message {
                    case .data(let bytes): data = bytes
                    case .string(let text): data = Data(text.utf8)
                    @unknown default: data = Data()
                    }
                    connection.send(
                        content: data,
                        completion: .contentProcessed { error in
                            if error != nil { close() }
                        })
                    readRemote()
                case .failure:
                    close()
                }
            }
        }
        readLocal()
        readRemote()
    }
}

final class TunnelOnce: @unchecked Sendable {
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
