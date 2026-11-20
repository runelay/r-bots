import Foundation
import Observation

struct DeviceInfo: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let model: String?
    let osVersion: String?
    let appVersion: String?
    let userId: String
    let registeredAt: String
    let connected: Bool
    let connectedAt: String?
    let lastSeenAt: String?
}

private struct DeviceList: Decodable {
    let devices: [DeviceInfo]
}

private struct DeviceRegistration: Decodable {
    let device: DeviceInfo
    let token: String
}

enum DeviceIdentity {
    private static let machineKey = "device.machineId"

    static var machineId: String {
        if let stored = UserDefaults.standard.string(forKey: machineKey), !stored.isEmpty { return stored }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: machineKey)
        return created
    }

    static var name: String {
        Host.current().localizedName ?? "Mac"
    }

    static var model: String {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        guard size > 0 else { return "Mac" }
        var buffer = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &buffer, &size, nil, 0)
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    static var osVersion: String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    private static func key(_ suffix: String) -> String {
        let scope = ServerConfig.activeProfile.keychainScope.map { "\($0)." } ?? ""
        return "device.\(suffix).\(scope)\(AuthStore.origin(of: ServerConfig.currentURL()) ?? "default")"
    }

    static var currentId: String? {
        UserDefaults.standard.string(forKey: key("id"))
    }

    static func setCurrentId(_ id: String?) {
        UserDefaults.standard.set(id, forKey: key("id"))
    }

    static var revoked: Bool {
        UserDefaults.standard.bool(forKey: key("revoked"))
    }

    static func setRevoked(_ value: Bool) {
        UserDefaults.standard.set(value, forKey: key("revoked"))
    }
}

extension BotsClient {
    func devices() async throws -> [DeviceInfo] {
        let (data, response) = try await URLSession.shared.data(for: try request(path: "/devices"))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ClientError.http(status, Self.deviceMessage(data)) }
        return try JSONDecoder().decode(DeviceList.self, from: data).devices
    }

    func revokeDevice(id: String) async throws {
        var urlRequest = try request(path: "/devices/\(id)")
        urlRequest.httpMethod = "DELETE"
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ClientError.http(status, Self.deviceMessage(data)) }
    }

    fileprivate func registerDevice(sessionToken: String) async throws -> DeviceRegistration {
        var urlRequest = try request(path: "/devices")
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: JSONValue = .object([
            "name": .string(String(DeviceIdentity.name.prefix(80))),
            "model": .string(String(DeviceIdentity.model.prefix(80))),
            "osVersion": .string(DeviceIdentity.osVersion),
            "appVersion": .string(AppInfo.version),
            "machineId": .string(DeviceIdentity.machineId),
        ])
        urlRequest.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ClientError.http(status, Self.deviceMessage(data)) }
        return try JSONDecoder().decode(DeviceRegistration.self, from: data)
    }

    private static func deviceMessage(_ data: Data) -> String? {
        (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue
    }
}

@MainActor
@Observable
final class DeviceStore {
    static let shared = DeviceStore()

    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    var state: LoadState = .loading
    var items: [DeviceInfo] = []
    var busy: String?
    var error: String?
    var registering = false

    var currentId: String? { DeviceIdentity.currentId }

    private var client: BotsClient { BotsClient(baseURL: ServerConfig.currentURL()) }

    func register(sessionToken: String, automatic: Bool) async {
        if automatic, DeviceIdentity.revoked { return }
        registering = true
        defer { registering = false }
        do {
            let registered = try await client.registerDevice(sessionToken: sessionToken)
            guard AuthStore.save(registered.token, as: .device) else {
                error = "Não deu para guardar a chave deste Mac."
                return
            }
            DeviceIdentity.setCurrentId(registered.device.id)
            error = nil
            RunnerConnection.shared.deviceRegistered()
        } catch {
            self.error = ErrorMessage.describe(error)
        }
    }

    func connectThisMac() async {
        guard let token = AuthStore.read(.session) else {
            error = "Entre na sua conta para conectar este Mac."
            return
        }
        await register(sessionToken: token, automatic: false)
        await load()
    }

    func load() async {
        do {
            items = try await client.devices()
            state = .loaded
        } catch {
            if items.isEmpty { state = .failed(ErrorMessage.describe(error)) }
        }
    }

    func revoke(_ device: DeviceInfo) async {
        busy = device.id
        error = nil
        defer { busy = nil }
        do {
            try await client.revokeDevice(id: device.id)
            items.removeAll { $0.id == device.id }
            if device.id == currentId {
                DeviceIdentity.setCurrentId(nil)
                RunnerConnection.shared.forgetDevice()
            }
        } catch {
            self.error = ErrorMessage.describe(error)
        }
    }
}
