import Foundation

struct ServerVersionInfo: Decodable, Equatable, Sendable {
    let current: String
    let channel: String?
    let latest: String?
    let updateAvailable: Bool
    let releaseUrl: String?
    let publishedAt: String?
    let notes: String?
    let updateCommand: String?

    var isDevelopment: Bool { current == "dev" }
    var isBeta: Bool { channel == "beta" }
    var command: String {
        guard let updateCommand, !updateCommand.isEmpty else { return "rbots update" }
        return updateCommand
    }

    var releaseLink: URL? {
        releaseUrl.flatMap(URL.init(string:))
    }

    var publishedDate: Date? {
        guard let publishedAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: publishedAt) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: publishedAt)
    }
}

struct CliVersion: Decodable, Identifiable, Equatable, Sendable {
    let provider: String
    let installed: String?
    let source: String
    let latest: String?
    let updateAvailable: Bool
    var updating: Bool
    let lastError: String?
    let previous: String?

    var id: String { provider }
    var isManaged: Bool { source == "managed" }

    var displayName: String {
        switch provider {
        case "claude": "Claude Code"
        case "codex": "Codex"
        case "cursor": "Cursor"
        case "grok": "Grok"
        default: provider.capitalized
        }
    }
}
