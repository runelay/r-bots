import Foundation
import Network
import Synchronization

struct McpReply: Sendable {
    let status: Int
    let headers: [String: String]
    let body: Data

    static func failure(_ status: Int, _ message: String) -> McpReply {
        let text = "{\"ok\":false,\"error\":\"\(message)\"}"
        return McpReply(status: status, headers: ["content-type": "application/json"], body: Data(text.utf8))
    }
}

final class McpProxy: @unchecked Sendable {
    static let shared = McpProxy()

    private let port = Mutex<UInt16>(0)
    private let queue = DispatchQueue(label: "com.runelay.bots.mcp-proxy")
    private var listener: NWListener?
    private static let maxBody = 32 * 1024 * 1024

    func url(for path: String) -> String? {
        let current = port.withLock { $0 }
        guard current > 0, path.hasPrefix("/") else { return nil }
        return "http://127.0.0.1:\(current)\(path)"
    }

    func start() {
        queue.async { [self] in
            guard listener == nil else { return }
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
            parameters.acceptLocalOnly = true
            guard let created = try? NWListener(using: parameters) else { return }
            created.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    let value = created.port?.rawValue ?? 0
                    self.port.withLock { $0 = value }
                case .failed, .cancelled:
                    self.port.withLock { $0 = 0 }
                    self.queue.async {
                        self.listener = nil
                        if case .failed = state {
                            self.queue.asyncAfter(deadline: .now() + 2) { self.start() }
                        }
                    }
                default:
                    break
                }
            }
            created.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener = created
            created.start(queue: queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] chunk, _, complete, error in
            guard let self else { return }
            var data = buffer
            if let chunk { data.append(chunk) }
            if let request = HTTPRequest.parse(data) {
                self.forward(request, on: connection)
                return
            }
            if error != nil || complete || data.count > Self.maxBody {
                self.respond(connection, .failure(400, tr("Pedido inválido.")))
                return
            }
            self.read(connection, buffer: data)
        }
    }

    private func forward(_ request: HTTPRequest, on connection: NWConnection) {
        Task {
            let reply = await RunnerConnection.shared.forwardMcp(
                method: request.method,
                path: request.path,
                headers: request.headers,
                body: request.body
            )
            self.queue.async { self.respond(connection, reply) }
        }
    }

    private func respond(_ connection: NWConnection, _ reply: McpReply) {
        var head = "HTTP/1.1 \(reply.status) \(HTTPURLResponse.localizedString(forStatusCode: reply.status).capitalized)\r\n"
        for (name, value) in reply.headers where name != "content-length" && name != "connection" {
            head += "\(name): \(value)\r\n"
        }
        head += "content-length: \(reply.body.count)\r\nconnection: close\r\n\r\n"
        var payload = Data(head.utf8)
        payload.append(reply.body)
        connection.send(
            content: payload,
            completion: .contentProcessed { _ in
                connection.cancel()
            })
    }
}

struct HTTPRequest: Sendable {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    static func parse(_ data: Data) -> HTTPRequest? {
        guard let marker = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[data.startIndex..<marker.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let start = lines.removeFirst().split(separator: " ")
        guard start.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        let bodyStart = marker.upperBound
        let body: Data
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            guard let decoded = dechunk(Data(data[bodyStart...])) else { return nil }
            body = decoded
        } else {
            let length = Int(headers["content-length"] ?? "0") ?? 0
            guard data.count - bodyStart >= length else { return nil }
            body = Data(data[bodyStart..<(bodyStart + length)])
        }
        let target = String(start[1])
        let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
        return HTTPRequest(method: String(start[0]).uppercased(), path: path, headers: headers, body: body)
    }

    private static func dechunk(_ data: Data) -> Data? {
        var output = Data()
        var index = data.startIndex
        let newline = Data("\r\n".utf8)
        while true {
            guard let end = data.range(of: newline, in: index..<data.endIndex) else { return nil }
            let sizeText =
                String(decoding: data[index..<end.lowerBound], as: UTF8.self)
                .split(separator: ";").first.map(String.init) ?? ""
            guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16) else { return nil }
            let chunkStart = end.upperBound
            if size == 0 { return output }
            guard data.endIndex - chunkStart >= size + 2 else { return nil }
            output.append(data[chunkStart..<(chunkStart + size)])
            index = chunkStart + size + 2
        }
    }
}
