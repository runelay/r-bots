import Foundation

struct StreamFact: Sendable {
    let type: String
    let data: JSONValue
    let scope: JSONValue?
    let key: String
    var at: String? = nil
}

enum StreamRecord: Sendable {
    case connected
    case reconnecting
    case ended
    case unavailable(String)
    case facts([StreamFact])
    case progress(StreamFact)
}

struct EventsPage: Sendable {
    let lines: [[StreamFact]]
    let nextBefore: Int?
    let total: Int?
    var reactions: [MessageReaction]? = nil

    static func parse(_ value: JSONValue) -> EventsPage {
        let raw = value["events"]?.arrayValue ?? value["lines"]?.arrayValue ?? value.arrayValue ?? []
        var lines: [[StreamFact]] = []
        var loose: [StreamFact] = []
        for (offset, item) in raw.enumerated() {
            if item["facts"] != nil {
                if !loose.isEmpty {
                    lines.append(loose)
                    loose = []
                }
                if case .facts(let facts) = StreamLine.parse(value: item) {
                    lines.append(facts)
                }
            } else if let type = item["type"]?.stringValue {
                let at = item["meta"]?["at"]?.stringValue ?? item["at"]?.stringValue
                let line = item["meta"]?["position"]?["line"]?.intValue
                let index = item["meta"]?["position"]?["index"]?.intValue ?? offset
                let key = "\(at ?? "page")#\(line.map(String.init) ?? "p")#\(index)#\(type)"
                loose.append(StreamFact(type: type, data: item["data"] ?? .null, scope: item["scope"], key: key, at: at))
            }
        }
        if !loose.isEmpty {
            lines.append(loose)
        }
        return EventsPage(
            lines: lines,
            nextBefore: value["nextBefore"]?.intValue,
            total: value["total"]?.intValue,
            reactions: value["reactions"].map { MessageReaction.list(in: $0) }
        )
    }
}

enum StreamLine {
    case facts([StreamFact])
    case progress(StreamFact)
    case heartbeat
    case leaseEnded
    case streamEnded
    case unknown

    static func parse(_ line: String) -> StreamLine {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = JSONValue.parse(trimmed) else { return .unknown }
        return parse(value: value)
    }

    static func parse(value: JSONValue) -> StreamLine {

        if let marker = value["$eve"]?.stringValue {
            switch marker {
            case "heartbeat": return .heartbeat
            case "stream.lease-ended": return .leaseEnded
            case "stream.ended": return .streamEnded
            default: return .unknown
            }
        }

        if let progress = value["progress"], let type = progress["type"]?.stringValue {
            let fact = StreamFact(
                type: type,
                data: progress["data"] ?? .null,
                scope: progress["scope"],
                key: ""
            )
            return .progress(fact)
        }

        if let rawFacts = value["facts"]?.arrayValue {
            let at = value["at"]?.stringValue ?? UUID().uuidString
            var facts: [StreamFact] = []
            for (index, raw) in rawFacts.enumerated() {
                guard let type = raw["type"]?.stringValue else { continue }
                facts.append(
                    StreamFact(
                        type: type,
                        data: raw["data"] ?? .null,
                        scope: raw["scope"],
                        key: "\(at)#\(index)#\(type)",
                        at: value["at"]?.stringValue
                    )
                )
            }
            return .facts(facts)
        }

        return .unknown
    }
}
