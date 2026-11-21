import Foundation

struct MessageReaction: Equatable, Hashable, Sendable {
    enum AuthorKind: String, Sendable {
        case user
        case bot
    }

    let target: String
    let emoji: String
    let authorKind: AuthorKind
    let authorID: String
    var at: String

    var identity: String {
        "\(target)|\(emoji)|\(authorKind.rawValue)|\(authorID)"
    }

    init(target: String, emoji: String, authorKind: AuthorKind, authorID: String, at: String) {
        self.target = target
        self.emoji = emoji
        self.authorKind = authorKind
        self.authorID = authorID
        self.at = at
    }

    init?(json: JSONValue) {
        guard let target = json["target"]?.stringValue,
              let emoji = json["emoji"]?.stringValue,
              let kind = json["author"]?["kind"]?.stringValue.flatMap(AuthorKind.init(rawValue:)),
              let author = json["author"]?["id"]?.stringValue
        else { return nil }
        self.init(target: target, emoji: emoji, authorKind: kind, authorID: author, at: json["at"]?.stringValue ?? "")
    }

    var json: JSONValue {
        .object([
            "target": .string(target),
            "emoji": .string(emoji),
            "author": .object(["kind": .string(authorKind.rawValue), "id": .string(authorID)]),
            "at": .string(at)
        ])
    }

    static func list(in value: JSONValue?) -> [MessageReaction] {
        (value?.arrayValue ?? []).compactMap(MessageReaction.init(json:))
    }

    static func targets(in lines: [[StreamFact]]) -> Set<String> {
        var targets = Set<String>()
        for fact in lines.joined() {
            if fact.type == "delivery.consumed", let id = fact.data["deliveryId"]?.stringValue {
                targets.insert(id)
            } else if fact.type == "content.completed", fact.data["kind"]?.stringValue == "text", let id = fact.data["partId"]?.stringValue {
                targets.insert(id)
            }
        }
        return targets
    }
}

struct ReactionGroup: Identifiable, Equatable {
    let emoji: String
    var count: Int
    var mine: Bool
    var botIDs: [String]
    var userCount: Int

    var id: String { emoji }

    static func groups(_ reactions: [MessageReaction], me: String?) -> [ReactionGroup] {
        var order: [String] = []
        var groups: [String: ReactionGroup] = [:]
        for reaction in reactions {
            if groups[reaction.emoji] == nil {
                order.append(reaction.emoji)
                groups[reaction.emoji] = ReactionGroup(emoji: reaction.emoji, count: 0, mine: false, botIDs: [], userCount: 0)
            }
            groups[reaction.emoji]?.count += 1
            switch reaction.authorKind {
            case .bot:
                groups[reaction.emoji]?.botIDs.append(reaction.authorID)
            case .user:
                groups[reaction.emoji]?.userCount += 1
                if me == nil || reaction.authorID == me {
                    groups[reaction.emoji]?.mine = true
                }
            }
        }
        return order.compactMap { groups[$0] }
    }
}

enum QuickReactions {
    static let emojis = ["👍", "❤️", "😂", "🎉", "👀", "✅"]
}
