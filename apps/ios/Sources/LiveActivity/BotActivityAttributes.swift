import ActivityKit
import Foundation

// Compartilhado entre o app e a extensão de widgets (Live Activity na ilha e na tela bloqueada).
struct BotActivityAttributes: ActivityAttributes {
    enum Phase: String, Codable, Hashable, Sendable {
        case working
        case approval
        case question
        case done
        case failed
    }

    struct Choice: Codable, Hashable, Sendable {
        let id: String
        let label: String
    }

    struct ContentState: Codable, Hashable, Sendable {
        var phase: Phase
        var headline: String
        var startedAt: Date
        var interactionID: String? = nil
        var questionID: String? = nil
        var choices: [Choice] = []
        var answering: String? = nil
    }

    let botID: String
    let botName: String
    let accent: String
    let sessionID: String
    let basePath: String
    var language: String? = nil

    var url: URL {
        var parts = URLComponents()
        parts.scheme = BotActivityLink.scheme
        parts.host = BotActivityLink.host
        parts.queryItems = [URLQueryItem(name: "bot", value: botID), URLQueryItem(name: "session", value: sessionID)]
        return parts.url ?? URL(string: "\(BotActivityLink.scheme)://")!
    }
}

enum BotActivityLink {
    static let scheme = "rbots"
    static let host = "conversation"

    static func parse(_ url: URL) -> (botID: String, sessionID: String?)? {
        guard url.scheme == scheme, url.host() == host,
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            let botID = items.first(where: { $0.name == "bot" })?.value, !botID.isEmpty
        else { return nil }
        return (botID, items.first { $0.name == "session" }?.value)
    }
}
