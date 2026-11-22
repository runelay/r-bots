import Foundation

enum VaultTouchPolicy: String, CaseIterable, Identifiable, Codable, Sendable {
    case always
    case hourly
    case never

    var id: String { rawValue }

    var label: String {
        switch self {
        case .always: tr("Sempre")
        case .hourly: tr("A cada 1 h")
        case .never: tr("Nunca")
        }
    }

    var detail: String {
        switch self {
        case .always: tr("Touch ID a cada uso.")
        case .hourly: tr("Touch ID no primeiro uso de cada hora.")
        case .never: tr("Usa sem pedir Touch ID.")
        }
    }
}

struct VaultPolicy: Codable, Equatable, Sendable {
    var description: String = ""
    var domains: [String] = []
    var bots: [String] = []
    var touchId: VaultTouchPolicy = .hourly
    var expiresAt: Date? = nil
    var kind: String = "password"
    var keepOnServer = false

    var json: JSONValue {
        var object: [String: JSONValue] = [
            "description": .string(description),
            "domains": .array(domains.map { .string($0) }),
            "bots": .array(bots.map { .string($0) }),
            "touchId": .string(touchId.rawValue),
            "kind": .string(kind),
        ]
        object["expiresAt"] = expiresAt.map { .string(VaultDates.iso($0)) } ?? .null
        return .object(object)
    }
}

struct VaultSecret: Identifiable, Equatable {
    let name: String
    var policy: VaultPolicy
    var onMac: Bool
    var onServer: Bool
    var lastUsedAt: Date?
    var lastUsedBy: String?
    var lastTool: String?
    var updatedAt: Date?

    var id: String { name }
    var reference: String { "segredo:\(name)" }

    var isExpired: Bool {
        guard let expiresAt = policy.expiresAt else { return false }
        return expiresAt <= Date()
    }
}

struct VaultAuditEntry: Identifiable, Equatable {
    let id: String
    let at: Date
    let name: String
    let outcome: String
    let botId: String?
    let botName: String?
    let tool: String?
    let domain: String?
    let reason: String?
    let source: String?

    init?(_ value: JSONValue, index: Int) {
        guard let name = value["name"]?.stringValue, let outcome = value["outcome"]?.stringValue else { return nil }
        let atText = value["at"]?.stringValue ?? ""
        self.id = "\(atText)#\(index)"
        self.at = VaultDates.parse(atText) ?? Date.distantPast
        self.name = name
        self.outcome = outcome
        self.botId = value["botId"]?.stringValue
        self.botName = value["botName"]?.stringValue
        self.tool = value["tool"]?.stringValue
        self.domain = value["domain"]?.stringValue
        self.reason = value["reason"]?.stringValue
        self.source = value["source"]?.stringValue
    }

    var headline: String {
        let who = botName ?? botId
        switch outcome {
        case "used": return who.map { tr("%@ usou", $0) } ?? tr("Usado")
        case "denied": return who.map { tr("%@ não conseguiu usar", $0) } ?? tr("Uso negado")
        case "revealed": return tr("Você viu o valor")
        case "created": return tr("Criado")
        case "updated": return tr("Regras mudaram")
        case "rotated": return tr("Valor trocado")
        case "deleted": return tr("Apagado")
        case "server_copy_on": return tr("Passou a funcionar com o Mac fechado")
        case "server_copy_off": return tr("Voltou a ficar só no Mac")
        default: return outcome
        }
    }

    var detail: String {
        var parts: [String] = []
        if let tool { parts.append(VaultText.toolLabel(tool)) }
        if let domain, !domain.isEmpty { parts.append(domain) }
        if outcome == "denied", let reason { parts.append(VaultText.reasonLabel(reason)) }
        if source == "server" { parts.append(tr("cópia do servidor")) }
        return parts.joined(separator: " · ")
    }

    var isProblem: Bool { outcome == "denied" }
}

struct SecretFormField: Identifiable, Equatable {
    let id: String
    let label: String
    let secure: Bool
}

struct SecretFormRequest: Equatable {
    let name: String
    let names: [String]
    let reason: String
    let description: String
    let kind: String
    let fields: [SecretFormField]
    let domains: [String]
    let botId: String?
    let botName: String?

    init?(_ value: JSONValue?) {
        guard let value, let name = value["name"]?.stringValue else { return nil }
        self.name = name
        let names = value["names"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.names = names.isEmpty ? [name] : names
        self.reason = value["reason"]?.stringValue ?? ""
        self.description = value["description"]?.stringValue ?? ""
        self.kind = value["kind"]?.stringValue ?? "password"
        let fields: [SecretFormField] = (value["fields"]?.arrayValue ?? []).compactMap { field in
            guard let id = field["id"]?.stringValue else { return nil }
            return SecretFormField(id: id, label: field["label"]?.stringValue ?? id, secure: field["secure"]?.boolValue ?? true)
        }
        self.fields = fields.isEmpty ? [SecretFormField(id: "valor", label: tr("Valor"), secure: true)] : fields
        self.domains = value["domains"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.botId = value["botId"]?.stringValue
        self.botName = value["botName"]?.stringValue
    }

    func secretName(for field: SecretFormField) -> String {
        fields.count > 1 ? "\(name)-\(field.id)" : name
    }
}

enum VaultDates {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return fractional.date(from: text) ?? plain.date(from: text)
    }

    static func iso(_ date: Date) -> String {
        fractional.string(from: date)
    }
}

enum VaultText {
    static func toolLabel(_ tool: String) -> String {
        switch tool {
        case "browser_fill": tr("preencheu no navegador")
        case "computer_type": tr("digitou no Mac")
        case "http_request": tr("chamada a uma API")
        case "Bash": tr("comando no terminal")
        default: tool
        }
    }

    static func reasonLabel(_ reason: String) -> String {
        switch reason {
        case "denied_domain": tr("site não liberado")
        case "denied_bot": tr("bot não liberado")
        case "expired": tr("segredo vencido")
        case "cancelled": tr("Touch ID cancelado")
        case "mac_offline": tr("Mac offline")
        case "not_found": tr("não existe no cofre")
        case "insecure": tr("conexão sem TLS")
        default: reason
        }
    }

    static func normalizeDomains(_ text: String) -> [String] {
        let pieces = text.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" || $0 == ";" })
        var out: [String] = []
        for piece in pieces {
            var value = piece.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if value.contains("://"), let host = URL(string: value)?.host() {
                value = host
            }
            if let slash = value.firstIndex(of: "/") {
                value = String(value[..<slash])
            }
            if value.hasPrefix("www.") {
                value = String(value.dropFirst(4))
            }
            guard !value.isEmpty, !out.contains(value) else { continue }
            out.append(value)
        }
        return out
    }

    static func hostAllowed(_ patterns: [String], host: String?) -> Bool {
        guard !patterns.isEmpty else { return true }
        guard let host = host?.lowercased(), !host.isEmpty else { return false }
        return patterns.contains { pattern in
            if pattern.hasPrefix("*.") {
                let base = String(pattern.dropFirst(2))
                return host == base || host.hasSuffix(".\(base)")
            }
            return host == pattern || host == "www.\(pattern)"
        }
    }

    static func refs(in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: "segredo:([a-z0-9][a-z0-9_-]{0,63})") else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        var names: [String] = []
        for match in regex.matches(in: text, range: range) {
            guard let swiftRange = Range(match.range(at: 1), in: text) else { continue }
            let name = String(text[swiftRange])
            if !names.contains(name) { names.append(name) }
        }
        return names
    }

    static func validName(_ name: String) -> Bool {
        name.range(of: "^[a-z0-9][a-z0-9_-]{0,63}$", options: .regularExpression) != nil
    }

    static func relative(_ date: Date?) -> String {
        guard let date else { return tr("Nunca usado") }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = LanguageStore.shared.locale
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
