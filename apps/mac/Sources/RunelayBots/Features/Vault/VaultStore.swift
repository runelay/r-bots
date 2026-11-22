import Foundation
import LocalAuthentication
import Observation
import Security

struct VaultFailure: Error, LocalizedError {
    let code: String
    let message: String

    var errorDescription: String? { message }
}

enum VaultKeychain {
    static let service = "com.runelay.bots.vault"

    struct Item {
        let name: String
        let policy: VaultPolicy
    }

    private static func base(_ name: String?, dataProtection: Bool) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        if let name {
            query[kSecAttrAccount as String] = name
        }
        if dataProtection {
            query[kSecUseDataProtectionKeychain as String] = true
            query[kSecAttrSynchronizable as String] = false
        }
        return query
    }

    static func save(name: String, value: Data, policy: VaultPolicy) throws {
        delete(name)
        let generic = (try? JSONEncoder().encode(policy)) ?? Data()
        var common: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrGeneric as String: generic,
            kSecAttrLabel as String: "r/bots · \(name)",
            kSecAttrDescription as String: "Segredo do r/bots",
        ]
        var modern = base(name, dataProtection: true)
        modern.merge(common) { _, new in new }
        if policy.touchId == .always, let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, nil) {
            modern[kSecAttrAccessControl as String] = access
        } else {
            modern[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        var status = SecItemAdd(modern as CFDictionary, nil)
        if status == errSecMissingEntitlement || status == errSecNotAvailable {
            common[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            var legacy = base(name, dataProtection: false)
            legacy.merge(common) { _, new in new }
            status = SecItemAdd(legacy as CFDictionary, nil)
            if status == errSecParam {
                legacy.removeValue(forKey: kSecAttrAccessible as String)
                status = SecItemAdd(legacy as CFDictionary, nil)
            }
        }
        guard status == errSecSuccess else {
            throw VaultFailure(code: "keychain", message: tr("O Keychain não aceitou o segredo (%lld).", Int(status)))
        }
    }

    static func read(_ name: String, context: LAContext?) throws -> Data {
        for dataProtection in [true, false] {
            var query = base(name, dataProtection: dataProtection)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            if dataProtection, let context {
                query[kSecUseAuthenticationContext as String] = context
            }
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecSuccess, let data = result as? Data {
                return data
            }
            if status == errSecUserCanceled || status == errSecAuthFailed {
                throw VaultFailure(code: "cancelled", message: tr("A pessoa cancelou o Touch ID."))
            }
            if status != errSecItemNotFound && status != errSecMissingEntitlement && status != errSecNotAvailable {
                throw VaultFailure(code: "keychain", message: tr("O Keychain não abriu o segredo (%lld).", Int(status)))
            }
        }
        throw VaultFailure(code: "not_found", message: tr("Esse segredo não está no Keychain deste Mac."))
    }

    static func list() -> [Item] {
        var items: [String: Item] = [:]
        for dataProtection in [true, false] {
            var query = base(nil, dataProtection: dataProtection)
            query[kSecReturnAttributes as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitAll
            var result: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let rows = result as? [[String: Any]] else { continue }
            for row in rows {
                guard let name = row[kSecAttrAccount as String] as? String, items[name] == nil else { continue }
                let policy = (row[kSecAttrGeneric as String] as? Data).flatMap { try? JSONDecoder().decode(VaultPolicy.self, from: $0) } ?? VaultPolicy()
                items[name] = Item(name: name, policy: policy)
            }
        }
        return items.values.sorted { $0.name < $1.name }
    }

    static func policy(_ name: String) -> VaultPolicy? {
        list().first { $0.name == name }?.policy
    }

    static func updatePolicy(_ name: String, policy: VaultPolicy) -> Bool {
        let generic = (try? JSONEncoder().encode(policy)) ?? Data()
        var updated = false
        for dataProtection in [true, false] {
            let status = SecItemUpdate(base(name, dataProtection: dataProtection) as CFDictionary, [kSecAttrGeneric as String: generic] as CFDictionary)
            if status == errSecSuccess { updated = true }
        }
        return updated
    }

    @discardableResult
    static func delete(_ name: String) -> Bool {
        var deleted = false
        for dataProtection in [true, false] {
            if SecItemDelete(base(name, dataProtection: dataProtection) as CFDictionary) == errSecSuccess { deleted = true }
        }
        return deleted
    }
}

struct VaultClient {
    private var token: String? { RunnerToken.read() }

    static func secureTransport(_ url: URL) -> Bool {
        if url.scheme == "https" || url.scheme == "wss" { return true }
        let host = url.host() ?? ""
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: JSONValue? = nil) async throws -> JSONValue {
        guard let token else { throw VaultFailure(code: "no_token", message: tr("Falta a chave do servidor neste Mac.")) }
        guard var components = URLComponents(url: ServerConfig.currentURL(), resolvingAgainstBaseURL: false) else {
            throw VaultFailure(code: "bad_url", message: tr("O endereço do servidor não parece válido."))
        }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw VaultFailure(code: "bad_url", message: tr("O endereço do servidor não parece válido.")) }
        var request = URLRequest(url: url)
        request.setAppLanguage()
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let parsed = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(status) else {
            throw VaultFailure(code: parsed["code"]?.stringValue ?? "http_\(status)", message: parsed["error"]?.stringValue ?? tr("O servidor respondeu %lld.", status))
        }
        return parsed
    }

    func list() async throws -> JSONValue {
        try await request("GET", "/vault/secrets")
    }

    func putMeta(_ name: String, policy: VaultPolicy, rotated: Bool = false) async throws {
        var body = policy.json.objectValue ?? [:]
        if rotated { body["rotated"] = .bool(true) }
        _ = try await request("PUT", "/vault/secrets/\(name)", body: .object(body))
    }

    func delete(_ name: String) async throws {
        _ = try await request("DELETE", "/vault/secrets/\(name)")
    }

    func putServerCopy(_ name: String, value: String) async throws {
        guard Self.secureTransport(ServerConfig.currentURL()) else {
            throw VaultFailure(code: "insecure", message: tr("O servidor não usa HTTPS, então o valor não sai deste Mac."))
        }
        _ = try await request("PUT", "/vault/secrets/\(name)/server-copy", body: .object(["value": .string(value)]))
    }

    func deleteServerCopy(_ name: String) async throws {
        _ = try await request("DELETE", "/vault/secrets/\(name)/server-copy")
    }

    func audit(_ name: String?) async throws -> [VaultAuditEntry] {
        let result = try await request("GET", "/vault/audit", query: [URLQueryItem(name: "limit", value: "200")] + (name.map { [URLQueryItem(name: "name", value: $0)] } ?? []))
        return (result.arrayValue ?? []).enumerated().compactMap { VaultAuditEntry($0.element, index: $0.offset) }
    }

    func postAudit(_ entry: [String: JSONValue]) async {
        _ = try? await request("POST", "/vault/audit", body: .object(entry))
    }
}

@MainActor
@Observable
final class VaultStore {
    static let shared = VaultStore()

    private(set) var secrets: [VaultSecret] = []
    private(set) var isLoading = false
    private(set) var serverStorage = true
    var lastError: String?
    @ObservationIgnored private var lastAuth: [String: Date] = [:]
    @ObservationIgnored private let client = VaultClient()

    func reload() async {
        isLoading = true
        defer { isLoading = false }
        let local = VaultKeychain.list()
        var remote: [String: JSONValue] = [:]
        do {
            let result = try await client.list()
            serverStorage = result["serverStorage"]?.boolValue ?? true
            for item in result["secrets"]?.arrayValue ?? [] {
                if let name = item["name"]?.stringValue { remote[name] = item }
            }
            lastError = nil
        } catch {
            lastError = tr("Não deu para falar com o servidor. A lista mostra só o que está neste Mac.")
        }
        var merged: [VaultSecret] = local.map { item in
            let server = remote[item.name]
            return VaultSecret(
                name: item.name,
                policy: item.policy,
                onMac: true,
                onServer: server?["storage"]?.stringValue == "mac+server",
                lastUsedAt: VaultDates.parse(server?["lastUsedAt"]?.stringValue),
                lastUsedBy: server?["lastUsedBy"]?.stringValue,
                lastTool: server?["lastTool"]?.stringValue,
                updatedAt: VaultDates.parse(server?["updatedAt"]?.stringValue)
            )
        }
        for (name, server) in remote where !local.contains(where: { $0.name == name }) {
            var policy = VaultPolicy()
            policy.description = server["description"]?.stringValue ?? ""
            policy.domains = server["domains"]?.arrayValue?.compactMap(\.stringValue) ?? []
            policy.bots = server["bots"]?.arrayValue?.compactMap(\.stringValue) ?? []
            policy.touchId = VaultTouchPolicy(rawValue: server["touchId"]?.stringValue ?? "") ?? .hourly
            policy.expiresAt = VaultDates.parse(server["expiresAt"]?.stringValue)
            policy.keepOnServer = server["storage"]?.stringValue == "mac+server"
            merged.append(
                VaultSecret(
                    name: name,
                    policy: policy,
                    onMac: false,
                    onServer: policy.keepOnServer,
                    lastUsedAt: VaultDates.parse(server["lastUsedAt"]?.stringValue),
                    lastUsedBy: server["lastUsedBy"]?.stringValue,
                    lastTool: server["lastTool"]?.stringValue,
                    updatedAt: VaultDates.parse(server["updatedAt"]?.stringValue)
                ))
        }
        secrets = merged.sorted { $0.name < $1.name }
    }

    func create(name: String, value: String, policy: VaultPolicy) async throws {
        guard VaultText.validName(name) else {
            throw VaultFailure(code: "bad_name", message: tr("Use só letras minúsculas, números, - e _ (até 64)."))
        }
        guard !value.isEmpty else { throw VaultFailure(code: "empty", message: tr("O valor está vazio.")) }
        var stored = policy
        stored.keepOnServer = false
        try VaultKeychain.save(name: name, value: Data(value.utf8), policy: stored)
        try await client.putMeta(name, policy: stored)
        if policy.keepOnServer {
            try await client.putServerCopy(name, value: value)
            stored.keepOnServer = true
            _ = VaultKeychain.updatePolicy(name, policy: stored)
        }
        lastAuth[name] = Date()
        await reload()
    }

    func update(_ secret: VaultSecret, policy: VaultPolicy) async throws {
        let touchChanged = (secret.policy.touchId == .always) != (policy.touchId == .always)
        let serverChanged = secret.policy.keepOnServer != policy.keepOnServer
        if touchChanged || (serverChanged && policy.keepOnServer) {
            let value = try await readValue(secret.name, reason: tr("Confirme para mudar as regras de “%@”.", secret.name), force: true)
            if touchChanged {
                try VaultKeychain.save(name: secret.name, value: Data(value.utf8), policy: policy)
            }
            try await client.putMeta(secret.name, policy: policy)
            if serverChanged && policy.keepOnServer {
                try await client.putServerCopy(secret.name, value: value)
            }
        } else {
            try await client.putMeta(secret.name, policy: policy)
            if serverChanged && !policy.keepOnServer {
                try await client.deleteServerCopy(secret.name)
            }
        }
        _ = VaultKeychain.updatePolicy(secret.name, policy: policy)
        await reload()
    }

    func rotate(_ secret: VaultSecret, value: String) async throws {
        guard !value.isEmpty else { throw VaultFailure(code: "empty", message: tr("O valor novo está vazio.")) }
        _ = try await readValue(secret.name, reason: tr("Confirme para trocar o valor de “%@”.", secret.name), force: true)
        try VaultKeychain.save(name: secret.name, value: Data(value.utf8), policy: secret.policy)
        try await client.putMeta(secret.name, policy: secret.policy, rotated: true)
        if secret.policy.keepOnServer {
            try await client.putServerCopy(secret.name, value: value)
        }
        await reload()
    }

    func delete(_ secret: VaultSecret) async throws {
        VaultKeychain.delete(secret.name)
        lastAuth.removeValue(forKey: secret.name)
        try await client.delete(secret.name)
        await reload()
    }

    func reveal(_ secret: VaultSecret) async throws -> String {
        let value = try await readValue(secret.name, reason: tr("Mostrar o valor de “%@”.", secret.name), force: true)
        await client.postAudit(["name": .string(secret.name), "outcome": .string("revealed")])
        return value
    }

    func history(_ name: String?) async throws -> [VaultAuditEntry] {
        try await client.audit(name)
    }

    func saveForm(_ form: SecretFormRequest, values: [String: String], keep: Bool) async throws {
        for field in form.fields where (values[field.id] ?? "").isEmpty {
            throw VaultFailure(code: "empty", message: tr("Preencha “%@”.", field.label))
        }
        for field in form.fields {
            let name = form.secretName(for: field)
            var policy = VaultKeychain.policy(name) ?? VaultPolicy()
            policy.description = form.description.isEmpty ? (form.fields.count > 1 ? "\(form.reason) (\(field.label))" : form.reason) : form.description
            if !form.domains.isEmpty { policy.domains = form.domains }
            policy.kind = field.secure ? form.kind : "text"
            policy.expiresAt = keep ? nil : Date().addingTimeInterval(3600)
            policy.keepOnServer = false
            try VaultKeychain.save(name: name, value: Data((values[field.id] ?? "").utf8), policy: policy)
            try await client.putMeta(name, policy: policy)
            lastAuth[name] = Date()
        }
        await reload()
    }

    private func authorize(_ name: String, policy: VaultTouchPolicy, reason: String, force: Bool) async throws -> LAContext? {
        if !force {
            if policy == .never { return nil }
            if policy == .hourly, let last = lastAuth[name], Date().timeIntervalSince(last) < 3600 { return nil }
        }
        let context = LAContext()
        context.localizedCancelTitle = tr("Cancelar")
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            guard ok else { throw VaultFailure(code: "cancelled", message: tr("A pessoa cancelou o Touch ID.")) }
        } catch let failure as VaultFailure {
            throw failure
        } catch {
            throw VaultFailure(code: "cancelled", message: tr("A pessoa cancelou o Touch ID ou ele não confirmou."))
        }
        lastAuth[name] = Date()
        return context
    }

    private func readValue(_ name: String, reason: String, force: Bool) async throws -> String {
        let policy = VaultKeychain.policy(name)?.touchId ?? .always
        let context = try await authorize(name, policy: policy, reason: reason, force: force)
        let data = try VaultKeychain.read(name, context: context)
        return String(decoding: data, as: UTF8.self)
    }

    private func check(_ name: String, botId: String, botName: String, tool: String, domain: String?) async throws -> String {
        guard let policy = VaultKeychain.policy(name) else {
            throw VaultFailure(code: "not_found", message: tr("O segredo:%@ não está no Keychain deste Mac.", name))
        }
        if let expiresAt = policy.expiresAt, expiresAt <= Date() {
            throw VaultFailure(code: "expired", message: tr("O segredo:%@ venceu. Peça um novo à pessoa.", name))
        }
        if !policy.bots.isEmpty, !policy.bots.contains(botId) {
            throw VaultFailure(code: "denied_bot", message: tr("O segredo:%1$@ não está liberado para %2$@.", name, botName))
        }
        if !VaultText.hostAllowed(policy.domains, host: domain) {
            let allowed = policy.domains.joined(separator: ", ")
            throw VaultFailure(
                code: "denied_domain",
                message: domain.map { tr("O segredo:%1$@ só pode ser usado em %2$@, não em %3$@.", name, allowed, $0) }
                    ?? tr("O segredo:%1$@ só pode ser usado em %2$@, e não deu para saber o site aberto.", name, allowed)
            )
        }
        let reason = domain.map { tr("%1$@ quer usar “%2$@” em %3$@.", botName, name, $0) } ?? tr("%1$@ quer usar “%2$@”.", botName, name)
        let context = try await authorize(name, policy: policy.touchId, reason: reason, force: false)
        return String(decoding: try VaultKeychain.read(name, context: context), as: UTF8.self)
    }

    func resolveForServer(_ body: JSONValue) async -> [String: JSONValue] {
        let name = body["name"]?.stringValue ?? ""
        let botId = body["botId"]?.stringValue ?? ""
        let botName = body["botName"]?.stringValue ?? botId
        let tool = body["tool"]?.stringValue ?? ""
        let domain = body["domain"]?.stringValue
        guard VaultClient.secureTransport(ServerConfig.currentURL()) else {
            return ["ok": .bool(false), "code": .string("insecure"), "error": .string(tr("A conexão com o servidor não usa TLS, então o Mac não manda segredos."))]
        }
        do {
            let value = try await check(name, botId: botId, botName: botName, tool: tool, domain: domain)
            return ["ok": .bool(true), "result": .object(["value": .string(value)])]
        } catch let failure as VaultFailure {
            return ["ok": .bool(false), "code": .string(failure.code), "error": .string(failure.message)]
        } catch {
            return ["ok": .bool(false), "code": .string("error"), "error": .string(tr("O Mac não conseguiu abrir o segredo."))]
        }
    }

    func substitute(_ text: String, botId: String, botName: String, tool: String, domain: String?) async throws -> String {
        var out = text
        for name in VaultText.refs(in: text) {
            var entry: [String: JSONValue] = ["name": .string(name), "botId": .string(botId), "botName": .string(botName), "tool": .string(tool)]
            if let domain { entry["domain"] = .string(domain) }
            do {
                let value = try await check(name, botId: botId, botName: botName, tool: tool, domain: domain)
                out = out.replacingOccurrences(of: "segredo:\(name)", with: value)
                entry["outcome"] = .string("used")
                await client.postAudit(entry)
            } catch let failure as VaultFailure {
                entry["outcome"] = .string("denied")
                entry["reason"] = .string(failure.code)
                await client.postAudit(entry)
                throw failure
            }
        }
        return out
    }
}
