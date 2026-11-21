import Foundation

struct BotVoiceSettings: Sendable, Equatable {
    var voiceId: String
    var speed: Double
    var language: String

    static let fallback = BotVoiceSettings(voiceId: "VNaz9wbhLsh3lLuHzAVP", speed: 1, language: "pt")

    init(voiceId: String, speed: Double, language: String) {
        self.voiceId = voiceId
        self.speed = speed
        self.language = language
    }

    init(json: JSONValue?) {
        voiceId = json?["voiceId"]?.stringValue ?? Self.fallback.voiceId
        speed = json?["speed"]?.doubleValue ?? 1
        language = json?["language"]?.stringValue ?? "pt"
    }

    static let languages: [(id: String, label: String)] = [("pt", "Português"), ("en", "Inglês"), ("es", "Espanhol")]
}

struct VoiceSocketInfo: Sendable {
    let url: URL
    let sampleRate: Double
}

struct VoiceCredentials: Sendable {
    let voice: BotVoiceSettings
    let stt: VoiceSocketInfo?
    let tts: VoiceSocketInfo?

    init(json: JSONValue) {
        voice = BotVoiceSettings(json: json["voice"])
        stt = Self.socket(json["stt"], fallbackRate: 16_000)
        tts = Self.socket(json["tts"], fallbackRate: 24_000)
    }

    private static func socket(_ json: JSONValue?, fallbackRate: Double) -> VoiceSocketInfo? {
        guard let raw = json?["url"]?.stringValue, let url = URL(string: raw) else { return nil }
        return VoiceSocketInfo(url: url, sampleRate: json?["sampleRate"]?.doubleValue ?? fallbackRate)
    }
}

struct VoiceCallTicket: Sendable {
    let callID: String
    let sessionID: String
    let credentials: VoiceCredentials
}

struct VoiceOption: Identifiable, Sendable, Equatable {
    let voiceId: String
    let name: String
    let language: String?
    let accent: String?
    let gender: String?
    let detail: String?
    let previewURL: URL?

    var id: String { voiceId }

    var shortName: String {
        name.components(separatedBy: " - ").first ?? name
    }

    var subtitle: String {
        var parts: [String] = []
        switch gender {
        case "female": parts.append("Feminina")
        case "male": parts.append("Masculina")
        case "neutral": parts.append("Neutra")
        default: break
        }
        switch language {
        case "pt": parts.append("português")
        case "en": parts.append("inglês")
        case "es": parts.append("espanhol")
        case let value?: parts.append(value)
        default: break
        }
        return parts.joined(separator: " · ")
    }
}

enum UtteranceOutcome: Sendable {
    case message
    case answer(interactionID: String, optionID: String)
    case repeatQuestion
}

enum CallEvent: Sendable {
    case ready
    case speechStarted(id: String, kind: String, elapsedMs: Int?)
    case speechDelta(id: String, text: String)
    case speechDone(id: String, text: String)
    case speechCancelled(id: String)
    case botState(String)
    case approvalAsked(id: String, prompt: String)
    case approvalSettled(id: String)
    case hangup(speechID: String)
    case ended
}

struct VoiceCallClient: Sendable {
    let client: BotsClient

    private static func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func root(_ botID: String) -> String {
        "/bots/\(Self.escape(botID))/voice/session"
    }

    func start(botID: String) async throws -> VoiceCallTicket {
        let json = try await send(root(botID), method: "POST", body: .object([:]))
        guard let callID = json["callId"]?.stringValue, let sessionID = json["sessionId"]?.stringValue else {
            throw BotsClient.ClientError.invalidResponse
        }
        return VoiceCallTicket(callID: callID, sessionID: sessionID, credentials: VoiceCredentials(json: json))
    }

    func credentials(botID: String, callID: String, types: [String]) async throws -> VoiceCredentials {
        let json = try await send("\(root(botID))/\(Self.escape(callID))/tokens", method: "POST", body: .object(["types": .array(types.map { .string($0) })]))
        return VoiceCredentials(json: json)
    }

    func utterance(botID: String, callID: String, text: String, interrupted: Bool = false, language: String? = nil, confidence: Double? = nil) async throws -> UtteranceOutcome {
        var body: [String: JSONValue] = ["text": .string(text), "interrupted": .bool(interrupted)]
        if let language {
            body["language"] = .string(language)
        }
        if let confidence, confidence.isFinite {
            body["confidence"] = .number(confidence)
        }
        let json = try await send("\(root(botID))/\(Self.escape(callID))/utterance", method: "POST", body: .object(body))
        switch json["action"]?.stringValue {
        case "answer":
            guard let interaction = json["interactionId"]?.stringValue, let option = json["optionId"]?.stringValue else { return .message }
            return .answer(interactionID: interaction, optionID: option)
        case "repeat":
            return .repeatQuestion
        default:
            return .message
        }
    }

    func interrupt(botID: String, callID: String) async {
        _ = try? await send("\(root(botID))/\(Self.escape(callID))/interrupt", method: "POST", body: .object([:]))
    }

    func end(botID: String, callID: String) async {
        _ = try? await send("\(root(botID))/\(Self.escape(callID))", method: "DELETE", body: nil)
    }

    func rate(botID: String, callID: String, rating: String?) async throws {
        _ = try await send("\(root(botID))/\(Self.escape(callID))/rating", method: "POST", body: .object(["rating": rating.map { .string($0) } ?? .null]))
    }

    func voices() async throws -> [VoiceOption] {
        let json = try await send("/voice/voices", method: "GET", body: nil)
        return (json.arrayValue ?? []).compactMap { item in
            guard let id = item["voiceId"]?.stringValue else { return nil }
            return VoiceOption(
                voiceId: id,
                name: item["name"]?.stringValue ?? id,
                language: item["language"]?.stringValue,
                accent: item["accent"]?.stringValue,
                gender: item["gender"]?.stringValue,
                detail: item["description"]?.stringValue,
                previewURL: item["previewUrl"]?.stringValue.flatMap(URL.init(string:))
            )
        }
    }

    func voiceSettings(botID: String) async throws -> BotVoiceSettings {
        let json = try await send("/bots/\(Self.escape(botID))", method: "GET", body: nil)
        return BotVoiceSettings(json: json["voice"])
    }

    func updateVoice(botID: String, settings: BotVoiceSettings) async throws -> BotVoiceSettings {
        let json = try await send(
            "/bots/\(Self.escape(botID))", method: "PATCH",
            body: .object([
                "voice": .object([
                    "voiceId": .string(settings.voiceId),
                    "speed": .number(settings.speed),
                    "language": .string(settings.language),
                ])
            ]))
        return BotVoiceSettings(json: json["voice"])
    }

    func events(botID: String, callID: String) -> AsyncStream<CallEvent> {
        let request = try? client.request(path: "\(root(botID))/\(Self.escape(callID))/stream")
        return AsyncStream { continuation in
            let task = Task {
                guard var request else {
                    continuation.finish()
                    return
                }
                request.timeoutInterval = 600
                request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
                do {
                    let (bytes, response) = try await HTTPSessions.streaming.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        continuation.yield(.ended)
                        continuation.finish()
                        return
                    }
                    for try await line in bytes.lines {
                        guard let json = JSONValue.parse(line), let event = Self.event(json) else { continue }
                        continuation.yield(event)
                    }
                } catch {}
                continuation.finish()
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private static func event(_ json: JSONValue) -> CallEvent? {
        let id = json["id"]?.stringValue ?? ""
        switch json["type"]?.stringValue {
        case "call.ready":
            return .ready
        case "speech.started":
            return .speechStarted(id: id, kind: json["kind"]?.stringValue ?? "", elapsedMs: json["elapsedMs"]?.intValue)
        case "speech.delta":
            return .speechDelta(id: id, text: json["text"]?.stringValue ?? "")
        case "speech.done":
            return .speechDone(id: id, text: json["text"]?.stringValue ?? "")
        case "speech.cancelled":
            return .speechCancelled(id: id)
        case "bot.state":
            return .botState(json["state"]?.stringValue ?? "idle")
        case "approval.asked":
            return .approvalAsked(id: json["interactionId"]?.stringValue ?? "", prompt: json["prompt"]?.stringValue ?? "")
        case "approval.settled":
            return .approvalSettled(id: json["interactionId"]?.stringValue ?? "")
        case "call.hangup":
            return .hangup(speechID: json["speechId"]?.stringValue ?? "")
        case "call.ended":
            return .ended
        default:
            return nil
        }
    }

    private func send(_ path: String, method: String, body: JSONValue?) async throws -> JSONValue {
        var request = try client.request(path: path)
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BotsClient.ClientError.invalidResponse }
        let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(http.statusCode) else {
            throw BotsClient.ClientError.http(http.statusCode, json["error"]?.stringValue)
        }
        return json
    }
}
