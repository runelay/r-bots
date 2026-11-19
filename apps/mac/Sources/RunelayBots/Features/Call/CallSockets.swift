import Foundation

final class ScribeSocket: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let sampleRate: Int
    private let lock = NSLock()
    private var closed = false
    private var started = false

    var onPartial: (@Sendable (String) -> Void)?
    var onCommitted: (@Sendable (String) -> Void)?
    var onStarted: (@Sendable () -> Void)?
    var onClose: (@Sendable (String) -> Void)?

    init(url: URL, sampleRate: Double) {
        var request = URLRequest(url: url)
        AuthStore.authorize(&request)
        task = URLSession.shared.webSocketTask(with: request)
        self.sampleRate = Int(sampleRate)
    }

    var isOpen: Bool {
        lock.withLock { !closed }
    }

    var hasStarted: Bool {
        lock.withLock { started }
    }

    func open() {
        task.resume()
        receive()
    }

    func send(audio: Data) {
        guard isOpen else { return }
        let payload = "{\"message_type\":\"input_audio_chunk\",\"audio_base_64\":\"\(audio.base64EncodedString())\",\"commit\":false,\"sample_rate\":\(sampleRate)}"
        task.send(.string(payload)) { [weak self] error in
            if let error {
                self?.fail("envio falhou: \(error.localizedDescription)")
            }
        }
    }

    func close() {
        let first = lock.withLock {
            let value = !closed
            closed = true
            return value
        }
        guard first else { return }
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func fail(_ message: String) {
        let first = lock.withLock {
            let value = !closed
            closed = true
            return value
        }
        guard first else { return }
        let code = task.closeCode.rawValue
        let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
        task.cancel(with: .goingAway, reason: nil)
        onClose?("\(message) · código \(code)\(reason.isEmpty ? "" : " · \(reason)")")
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.fail("recebimento falhou: \(error.localizedDescription)")
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handle(text)
                case .data(let data):
                    self.handle(String(decoding: data, as: UTF8.self))
                @unknown default:
                    break
                }
                if self.isOpen {
                    self.receive()
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let json = JSONValue.parse(text) else { return }
        let type = json["message_type"]?.stringValue ?? ""
        switch type {
        case "partial_transcript":
            onPartial?(json["text"]?.stringValue ?? "")
        case "committed_transcript", "committed_transcript_with_timestamps":
            onCommitted?(json["text"]?.stringValue ?? "")
        case "session_started":
            lock.withLock { started = true }
            onStarted?()
        case "warning":
            break
        default:
            if json["error"] != nil || type.hasSuffix("error") || type.contains("exceeded") || type.contains("limit") {
                fail("\(type): \(json["error"]?.stringValue ?? json["message"]?.stringValue ?? "")")
            }
        }
    }
}

final class SpeechSocket: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let speed: Double
    private let lock = NSLock()
    private var closed = false
    private var order: [String] = []
    private var buffered: [String: [Data]] = [:]
    private var finished: Set<String> = []
    private var cancelled: Set<String> = []
    private var heard: Set<String> = []
    private var texts: [String: String] = [:]

    var onAudio: (@Sendable (String, Data) -> Void)?
    var onFirstAudio: (@Sendable (String) -> Void)?
    var onContextDone: (@Sendable (String) -> Void)?
    var onClose: (@Sendable () -> Void)?

    init(url: URL, speed: Double) {
        var request = URLRequest(url: url)
        AuthStore.authorize(&request)
        task = URLSession.shared.webSocketTask(with: request)
        self.speed = speed
    }

    var isOpen: Bool {
        lock.withLock { !closed }
    }

    func open() {
        task.resume()
        receive()
    }

    func begin(_ id: String) {
        lock.withLock {
            order.append(id)
            texts[id] = ""
        }
        send([
            "text": .string(" "),
            "context_id": .string(id),
            "voice_settings": .object([
                "stability": .number(0.5),
                "similarity_boost": .number(0.8),
                "speed": .number(speed)
            ])
        ])
    }

    func append(_ id: String, text: String) {
        let ready: String? = lock.withLock {
            guard texts[id] != nil, !cancelled.contains(id) else { return nil }
            let joined = (texts[id] ?? "") + text
            guard let cut = Self.boundary(in: joined) else {
                texts[id] = joined
                return nil
            }
            texts[id] = String(joined[cut...])
            return String(joined[..<cut])
        }
        if let ready, !ready.trimmingCharacters(in: .whitespaces).isEmpty {
            send(["text": .string(ready.hasSuffix(" ") ? ready : ready + " "), "context_id": .string(id), "flush": .bool(true)])
        }
    }

    func finish(_ id: String) {
        let rest: String? = lock.withLock {
            guard let value = texts[id], !cancelled.contains(id) else { return nil }
            texts[id] = nil
            return value
        }
        guard let rest else { return }
        if !rest.trimmingCharacters(in: .whitespaces).isEmpty {
            send(["text": .string(rest.hasSuffix(" ") ? rest : rest + " "), "context_id": .string(id), "flush": .bool(true)])
        }
        send(["context_id": .string(id), "close_context": .bool(true)])
    }

    func cancel(_ id: String) {
        let known = lock.withLock { () -> Bool in
            guard order.contains(id) || texts[id] != nil else { return false }
            cancelled.insert(id)
            texts[id] = nil
            buffered[id] = nil
            order.removeAll { $0 == id }
            return true
        }
        guard known else { return }
        send(["context_id": .string(id), "close_context": .bool(true)])
        drain()
    }

    func cancelAll() {
        let ids = lock.withLock { order }
        for id in ids {
            cancel(id)
        }
    }

    var hasActiveContext: Bool {
        lock.withLock { !order.isEmpty }
    }

    func close() {
        let first = lock.withLock {
            let value = !closed
            closed = true
            return value
        }
        guard first else { return }
        task.send(.string("{\"close_socket\":true}")) { _ in }
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func send(_ object: [String: JSONValue]) {
        guard isOpen, let data = try? JSONEncoder().encode(JSONValue.object(object)), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if error != nil {
                self?.fail()
            }
        }
    }

    private func fail() {
        let first = lock.withLock {
            let value = !closed
            closed = true
            return value
        }
        guard first else { return }
        task.cancel(with: .goingAway, reason: nil)
        onClose?()
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.fail()
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handle(text)
                case .data(let data):
                    self.handle(String(decoding: data, as: UTF8.self))
                @unknown default:
                    break
                }
                if self.isOpen {
                    self.receive()
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let json = JSONValue.parse(text) else { return }
        let id = json["contextId"]?.stringValue ?? json["context_id"]?.stringValue ?? ""
        if let base64 = json["audio"]?.stringValue, let data = Data(base64Encoded: base64), !data.isEmpty {
            enum Route { case drop, play(first: Bool), hold }
            let route: Route = lock.withLock {
                if cancelled.contains(id) || !order.contains(id) {
                    return .drop
                }
                if order.first == id {
                    return .play(first: heard.insert(id).inserted)
                }
                buffered[id, default: []].append(data)
                return .hold
            }
            if case .play(let first) = route {
                if first {
                    onFirstAudio?(id)
                }
                onAudio?(id, data)
            }
        }
        if json["isFinal"]?.boolValue == true {
            _ = lock.withLock {
                finished.insert(id)
            }
            drain()
        }
    }

    private func drain() {
        while true {
            enum Step { case stop, play(String, [Data], Bool), done(String) }
            let step: Step = lock.withLock {
                guard let head = order.first else { return .stop }
                if let pendingAudio = buffered[head], !pendingAudio.isEmpty {
                    buffered[head] = nil
                    return .play(head, pendingAudio, heard.insert(head).inserted)
                }
                if finished.contains(head) {
                    order.removeFirst()
                    finished.remove(head)
                    return .done(head)
                }
                return .stop
            }
            switch step {
            case .stop:
                return
            case .play(let id, let chunks, let first):
                if first {
                    onFirstAudio?(id)
                }
                for chunk in chunks {
                    onAudio?(id, chunk)
                }
            case .done(let id):
                onContextDone?(id)
            }
        }
    }

    private static func boundary(in text: String) -> String.Index? {
        var result: String.Index?
        var index = text.startIndex
        var count = 0
        while index < text.endIndex {
            let character = text[index]
            let next = text.index(after: index)
            count += 1
            if next < text.endIndex, text[next].isWhitespace {
                if ".!?…;:".contains(character) || (character == "," && count >= 24) {
                    result = next
                }
            }
            index = next
        }
        return result
    }
}
