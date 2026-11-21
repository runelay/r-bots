import Foundation

enum StoreNotification {
    case reply(text: String, speakerID: String?, schedule: Bool)
    case approval(id: String, prompt: String)
    case question(id: String, title: String, sessionID: String?)
    case failed(String)
    case ciFailed(number: Int, check: String)
}

struct ArtifactRef: Equatable, Hashable, Sendable {
    let botID: String
    let id: String
    var title: String
    let kind: String
    var version: Int
}

struct IntegrationFormRequest: Equatable {
    let id: String
    let name: String
    let description: String
    let unlocks: String
    let keyURL: URL?
    let needsURL: Bool
    let url: String?
    let reason: String

    init?(_ value: JSONValue?) {
        guard let value, let id = value["id"]?.stringValue else { return nil }
        self.id = id
        name = value["name"]?.stringValue ?? id
        description = value["description"]?.stringValue ?? ""
        unlocks = value["unlocks"]?.stringValue ?? ""
        keyURL = value["keyUrl"]?.stringValue.flatMap(URL.init(string:))
        needsURL = value["needsUrl"]?.boolValue ?? false
        url = value["url"]?.stringValue
        reason = value["reason"]?.stringValue ?? ""
    }
}

struct SettingsUndoStep: Equatable, Sendable {
    let method: String
    let path: String
    let body: JSONValue?
}

struct SettingsChange: Equatable, Identifiable {
    static let lineTools: Set<String> = [
        "bot_update", "bot_archive", "section_update", "schedule_update", "schedule_run", "server_profile_save",
        "server_profile_delete", "repo_remove", "vault_update_meta", "account_update", "integration_setup",
        "connector_connect", "preferences_set",
    ]

    enum UndoState: Equatable {
        case available
        case running
        case done
        case failed(String)
    }

    let id: String
    let area: String
    let areas: [String]
    let text: String
    let targetID: String
    let targetName: String
    let thumbnailKind: String?
    let thumbnailID: String?
    let undo: [SettingsUndoStep]
    let actionLabel: String?
    let actionURL: URL?
    let otherBot: Bool

    init?(id: String, _ data: JSONValue) {
        guard let text = data["text"]?.stringValue, let area = data["area"]?.stringValue else { return nil }
        self.id = id
        self.area = area
        let areas = data["areas"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.areas = areas.isEmpty ? [area] : areas
        self.text = text
        targetID = data["target"]?["id"]?.stringValue ?? ""
        targetName = data["target"]?["name"]?.stringValue ?? ""
        thumbnailKind = data["thumbnail"]?["kind"]?.stringValue
        thumbnailID = data["thumbnail"]?["id"]?.stringValue
        undo = (data["undo"]?.arrayValue ?? []).compactMap { step in
            guard let method = step["method"]?.stringValue, let path = step["path"]?.stringValue else { return nil }
            return SettingsUndoStep(method: method, path: path, body: step["body"])
        }
        actionLabel = data["action"]?["label"]?.stringValue
        actionURL = data["action"]?["url"]?.stringValue.flatMap(URL.init(string:))
        otherBot = data["otherBot"]?.boolValue ?? false
    }
}

extension BotsClient {
    func runUndo(_ step: SettingsUndoStep) async throws {
        var urlRequest = try request(path: step.path)
        urlRequest.httpMethod = step.method
        if let body = step.body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        AuthStore.reportUnauthorized(response)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ClientError.http(status, (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue)
        }
    }
}

struct TranscriptScrollMemory: Equatable {
    var anchorID: String
    var anchorOffset: CGFloat
}

struct ThreadActivity: Equatable {
    let text: String
    let isUser: Bool
    let date: Date?
    var speakerID: String? = nil
}
