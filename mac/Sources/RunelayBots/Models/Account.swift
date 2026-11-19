import Foundation

struct AccountModel: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    let label: String

    private enum CodingKeys: String, CodingKey {
        case id, label
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? ModelNames.pretty(id)
    }
}

struct AIAccount: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    let runner: String
    let provider: String
    let label: String
    let status: String
    let models: [AccountModel]
    let detail: String?

    private enum CodingKeys: String, CodingKey {
        case id, runner, provider, label, status, models, detail
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        runner = (try? container.decodeIfPresent(String.self, forKey: .runner)) ?? id.split(separator: ":").first.map(String.init) ?? ""
        provider = (try? container.decodeIfPresent(String.self, forKey: .provider)) ?? id.split(separator: ":").last.map(String.init) ?? ""
        label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? id
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "offline"
        models = ((try? container.decodeIfPresent([Lossy<AccountModel>].self, forKey: .models)) ?? []).compactMap(\.value)
        detail = try? container.decodeIfPresent(String.self, forKey: .detail)
    }

    var isReady: Bool { status == "ready" }

    var providerTitle: String {
        label
            .replacingOccurrences(of: " (VPS)", with: "")
            .replacingOccurrences(of: " (Mac)", with: "")
    }

    var supportsEffort: Bool {
        provider == "claude" || provider == "codex"
    }

    var machineLabel: String {
        switch runner {
        case "vps": "VPS"
        case "mac": "Mac"
        default: runner.uppercased()
        }
    }

    var statusLabel: String {
        switch status {
        case "ready": "Pronta"
        case "logged_out": "Deslogada"
        case "offline": "Offline"
        case "missing": "Não instalada"
        default: status
        }
    }

    var symbol: String {
        switch provider {
        case "claude": "sparkle"
        case "codex": "chevron.left.forwardslash.chevron.right"
        case "grok": "bolt"
        case "cursor": "cursorarrow.rays"
        default: "cpu"
        }
    }
}

struct EngineFallback: Hashable, Sendable, Decodable {
    var account: String
    var model: String?
}

struct BotEngine: Hashable, Sendable, Decodable {
    var account: String
    var model: String?
    var effort: String?
    var fallback: EngineFallback?
    var sendsFallback = false

    init(account: String, model: String?, effort: String?, fallback: EngineFallback? = nil, sendsFallback: Bool = false) {
        self.account = account
        self.model = model
        self.effort = effort
        self.fallback = fallback
        self.sendsFallback = sendsFallback
    }

    private enum CodingKeys: String, CodingKey {
        case account, model, effort, fallback
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        account = (try? container.decodeIfPresent(String.self, forKey: .account)) ?? "vps:claude"
        model = try? container.decodeIfPresent(String.self, forKey: .model)
        effort = try? container.decodeIfPresent(String.self, forKey: .effort)
        fallback = try? container.decodeIfPresent(EngineFallback.self, forKey: .fallback)
    }

    var json: JSONValue {
        var object: [String: JSONValue] = ["account": .string(account)]
        if let model {
            object["model"] = .string(model)
        }
        if let effort {
            object["effort"] = .string(effort)
        }
        if sendsFallback {
            if let fallback {
                var target: [String: JSONValue] = ["account": .string(fallback.account)]
                if let model = fallback.model {
                    target["model"] = .string(model)
                }
                object["fallback"] = .object(target)
            } else {
                object["fallback"] = .null
            }
        }
        return .object(object)
    }
}

enum EngineEffort: String, CaseIterable, Identifiable {
    case low
    case medium
    case high

    var id: String { rawValue }

    var title: String {
        switch self {
        case .low: "Baixo"
        case .medium: "Médio"
        case .high: "Alto"
        }
    }
}

enum ModelNames {
    static func pretty(_ id: String) -> String {
        let lowered = id.lowercased()
        for family in ["opus", "sonnet", "haiku"] where lowered.contains(family) {
            let digits = lowered.split(separator: "-").filter { $0.allSatisfy(\.isNumber) }
            let version = digits.joined(separator: ".")
            return version.isEmpty ? family.capitalized : "\(family.capitalized) \(version)"
        }
        return id
    }

    static func provider(_ account: String) -> String {
        account.split(separator: ":").last.map(String.init) ?? account
    }

    static func providerName(_ account: String) -> String {
        let provider = account.split(separator: ":").last.map(String.init) ?? account
        switch provider {
        case "claude": return "Claude"
        case "codex": return "ChatGPT"
        case "grok": return "Grok"
        case "cursor": return "Cursor"
        default: return provider.capitalized
        }
    }
}
