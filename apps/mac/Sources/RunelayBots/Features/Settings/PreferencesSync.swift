import Foundation

@MainActor
enum PreferencesSync {
    private(set) static var applying = false

    private static var client: BotsClient { BotsClient(baseURL: ServerConfig.currentURL()) }

    static func start() {
        Task { @MainActor in
            guard let value = try? await send(method: "GET", body: nil) else { return }
            apply(value)
            let names = Microphones.all().map { JSONValue.string($0.name) }
            _ = try? await send(method: "PATCH", body: .object(["microphones": .array(names)]))
        }
    }

    static func push(_ body: JSONValue) {
        Task { @MainActor in
            _ = try? await send(method: "PATCH", body: body)
        }
    }

    static func apply(_ value: JSONValue) {
        applying = true
        defer { applying = false }
        if case .object(let notifications) = value["notifications"] ?? .null {
            for preference in NotificationPreference.allCases {
                guard let enabled = notifications[preference.rawValue]?.boolValue else { continue }
                if UserDefaults.standard.object(forKey: preference.key) as? Bool != enabled {
                    UserDefaults.standard.set(enabled, forKey: preference.key)
                }
            }
        }
        guard value["microphone"] != nil else { return }
        let wanted = value["microphone"]?.stringValue
        let catalog = MicrophoneCatalog.shared
        if let wanted {
            guard let device = Microphones.all().first(where: { $0.name == wanted }), device.uid != Microphones.savedUID else { return }
            catalog.adopt(device)
        } else if Microphones.savedUID != nil {
            catalog.adopt(nil)
        }
    }

    private static func send(method: String, body: JSONValue?) async throws -> JSONValue? {
        var request = try client.request(path: "/preferences")
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}
