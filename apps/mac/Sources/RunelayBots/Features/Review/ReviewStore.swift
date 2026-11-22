import Foundation
import Observation

struct ReviewPreset: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var prompt: String
    var scope: String
    var days: Int
    var linear: Bool
    var github: Bool
    var botId: String?

    static func draft() -> ReviewPreset {
        ReviewPreset(
            id: "p\(Int(Date().timeIntervalSince1970) % 1_000_000)",
            name: tr("Novo review"),
            prompt: tr("Faça um resumo simples do período, juntando o que foi feito e o que está em andamento."),
            scope: "today",
            days: 1,
            linear: true,
            github: true,
            botId: nil
        )
    }

    var scopeTitle: String {
        switch scope {
        case "today": tr("Hoje")
        case "week": tr("Semana")
        default: days == 1 ? tr("Último dia") : tr("Últimos %lld dias", days)
        }
    }

    var sourcesTitle: String {
        switch (linear, github) {
        case (true, true): tr("Linear e GitHub")
        case (true, false): "Linear"
        default: "GitHub"
        }
    }

    var jsonValue: JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(id),
            "name": .string(name),
            "prompt": .string(prompt),
            "scope": .string(scope),
            "days": .number(Double(days)),
            "linear": .bool(linear),
            "github": .bool(github),
        ]
        object["botId"] = botId.map(JSONValue.string) ?? .null
        return .object(object)
    }
}

struct ReviewPresetsReply: Decodable, Sendable {
    let presets: [ReviewPreset]
    let defaultBotId: String?
}

struct ReviewRunReply: Decodable, Sendable {
    let botId: String
    let sessionId: String
    let title: String
    let warnings: [String]
}

extension BotsClient {
    func reviewPresets() async throws -> ReviewPresetsReply {
        try await boardRequest("/review", as: ReviewPresetsReply.self)
    }

    func saveReviewPresets(_ presets: [ReviewPreset]) async throws -> ReviewPresetsReply {
        try await boardRequest("/review/presets", method: "PUT", body: ["presets": .array(presets.map(\.jsonValue))], as: ReviewPresetsReply.self)
    }

    func runReview(presetID: String, botID: String?, view: String?, project: String?) async throws -> ReviewRunReply {
        var body: [String: JSONValue] = ["presetId": .string(presetID)]
        if let botID { body["botId"] = .string(botID) }
        if let view { body["view"] = .string(view) }
        if let project { body["project"] = .string(project) }
        return try await boardRequest("/review/run", method: "POST", body: body, timeout: 120, as: ReviewRunReply.self)
    }
}

@MainActor
@Observable
final class ReviewStore {
    static let shared = ReviewStore()

    private(set) var presets: [ReviewPreset] = []
    private(set) var defaultBotID: String?
    private(set) var running: String?
    private(set) var saving = false
    private(set) var loadError: String?

    @ObservationIgnored private var client: BotsClient?

    func attach(_ client: BotsClient) {
        self.client = client
    }

    func load() async {
        guard let client else { return }
        do {
            let reply = try await client.reviewPresets()
            presets = reply.presets
            defaultBotID = reply.defaultBotId
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    func save(_ next: [ReviewPreset]) async -> String? {
        guard let client else { return tr("Sem conexão com o servidor.") }
        let previous = presets
        presets = next
        saving = true
        defer { saving = false }
        do {
            let reply = try await client.saveReviewPresets(next)
            presets = reply.presets
            defaultBotID = reply.defaultBotId
            return nil
        } catch {
            presets = previous
            return error.localizedDescription
        }
    }

    func run(_ preset: ReviewPreset, view: String?, project: String?) async throws -> ReviewRunReply {
        guard let client else { throw BotsClient.ClientError.invalidResponse }
        running = preset.id
        defer { running = nil }
        return try await client.runReview(presetID: preset.id, botID: preset.botId, view: view, project: project)
    }
}
