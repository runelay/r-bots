import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class ConnectorLogoStore {
    static let shared = ConnectorLogoStore()

    private(set) var version = 0
    @ObservationIgnored private var cache: [String: NSImage] = [:]
    @ObservationIgnored private var missing: Set<String> = []
    @ObservationIgnored private var inFlight: Set<String> = []

    func image(for icon: String) -> NSImage? {
        guard let file = Self.file(of: icon) else { return nil }
        let key = ServerConfig.currentURL().absoluteString + "|" + file
        _ = version
        if let cached = cache[key] {
            return cached
        }
        if !missing.contains(key) {
            fetch(file, key: key)
        }
        return nil
    }

    private static func file(of icon: String) -> String? {
        guard icon.hasPrefix("/logos/") else { return nil }
        let file = String(icon.dropFirst("/logos/".count)).lowercased()
        guard file.range(of: "^[a-z0-9_-]{1,60}\\.(png|svg)$", options: .regularExpression) != nil else { return nil }
        return file
    }

    private func fetch(_ file: String, key: String) {
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)
        let client = BotsClient(baseURL: ServerConfig.currentURL())
        Task {
            defer { inFlight.remove(key) }
            guard let request = try? client.request(path: "/connectors/logos/\(file)"),
                let (data, response) = try? await URLSession.shared.data(for: request),
                (response as? HTTPURLResponse)?.statusCode == 200,
                let image = NSImage(data: data)
            else {
                missing.insert(key)
                return
            }
            cache[key] = image
            version += 1
        }
    }
}
