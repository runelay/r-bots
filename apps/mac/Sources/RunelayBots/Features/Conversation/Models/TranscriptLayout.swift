import Foundation

struct BubbleMeta: Equatable {
    var isFirst = true
    var isLast = true
    var lastDate: Date?
}

enum BubbleSide: Equatable {
    case user
    case bot(String?)
}

@MainActor
enum BubbleGrouping {
    static func side(of entry: TranscriptEntry, in store: ConversationStore) -> BubbleSide? {
        switch entry.kind {
        case .user:
            return store.userMessages[entry.id]?.fromBotID == nil ? .user : nil
        case .text:
            guard let part = store.textParts[entry.id], part.phase == .reply else { return nil }
            return .bot(part.botID)
        default:
            return nil
        }
    }

    static func compute(_ store: ConversationStore) -> [String: BubbleMeta] {
        var result: [String: BubbleMeta] = [:]
        var previous: (id: String, side: BubbleSide, date: Date?)?
        for entry in store.entries where TranscriptItem.isVisible(entry, in: store) {
            guard let side = side(of: entry, in: store) else {
                previous = nil
                continue
            }
            let date = store.entryDates[entry.id]
            var meta = BubbleMeta(isFirst: true, isLast: true, lastDate: date)
            if let previous, previous.side == side {
                let close: Bool
                if let date, let earlier = previous.date {
                    close = date.timeIntervalSince(earlier) < 120
                } else {
                    close = true
                }
                if close {
                    meta.isFirst = false
                    result[previous.id]?.isLast = false
                }
            }
            result[entry.id] = meta
            previous = (entry.id, side, date)
        }
        return result
    }
}

enum TranscriptItem: Identifiable {
    case day(String, String)
    case entry(TranscriptEntry)
    case delegation(String, [String])
    case delegateCard(String, [String])
    case tools(String, [String])
    case caption(String, String)

    var id: String {
        switch self {
        case .day(let id, _): id
        case .entry(let entry): entry.id
        case .delegation(let id, _): "group-\(id)"
        case .delegateCard(let id, _): "delegate-\(id)"
        case .tools(let id, _): "tools-\(id)"
        case .caption(let id, _): id
        }
    }

    @MainActor
    static func build(from store: ConversationStore, now: Date) -> [TranscriptItem] {
        let calendar = Calendar.current
        var items: [TranscriptItem] = []
        var lastDay: Date?
        var group: [String] = []
        var tools: [String] = []
        var toolsTurn: String?

        func flushTools() {
            if tools.count == 1, let only = store.entries.first(where: { $0.id == tools[0] }) {
                items.append(.entry(only))
            } else if let first = tools.first {
                items.append(.tools(first, tools))
            }
            tools = []
            toolsTurn = nil
        }

        func flush() {
            flushTools()
            if let first = group.first {
                items.append(.delegation(first, group))
            }
            group = []
        }

        let visible = store.entries.filter { isVisible($0, in: store) }
        var delegatesByTurn: [String: [String]] = [:]
        for entry in visible where entry.kind == .toolCall {
            guard let call = store.toolCalls[entry.id], call.delegation != nil else { continue }
            delegatesByTurn[call.turnID ?? entry.id, default: []].append(entry.id)
        }
        var summarized: Set<String> = []
        for (index, entry) in visible.enumerated() {
            if store.bot.isGroup, entry.kind == .text, let part = store.textParts[entry.id], part.phase == .reply,
               !summarized.contains(entry.id) {
                var replies = 0
                var speakers: Set<String> = []
                for later in visible[index...] {
                    if later.kind == .user {
                        break
                    }
                    if later.kind == .text, let reply = store.textParts[later.id], reply.phase == .reply {
                        replies += 1
                        speakers.insert(reply.botID ?? "")
                        summarized.insert(later.id)
                    }
                }
                if speakers.count >= 2 {
                    flush()
                    items.append(.caption("summary-\(entry.id)", "\(replies) mensagens com \(speakers.count) agentes"))
                }
            }
            if let date = store.entryDates[entry.id] {
                let day = calendar.startOfDay(for: date)
                if day != lastDay {
                    flush()
                    items.append(.day("day-\(Int(day.timeIntervalSince1970))", ShortStamp.dayLabel(for: date, now: now)))
                    lastDay = day
                }
            }
            if entry.kind == .toolCall, let call = store.toolCalls[entry.id], call.delegation != nil {
                let siblings = delegatesByTurn[call.turnID ?? entry.id] ?? [entry.id]
                if siblings.first == entry.id {
                    flush()
                    items.append(.delegateCard(entry.id, siblings))
                }
                continue
            }
            if entry.kind == .toolCall, let call = store.toolCalls[entry.id],
               call.isDelegation || call.ownerCallID != nil || call.viaAgent != nil {
                flushTools()
                group.append(entry.id)
                continue
            }
            if entry.kind == .toolCall, let call = store.toolCalls[entry.id] {
                if group.isEmpty == false {
                    flush()
                }
                if !tools.isEmpty && toolsTurn != call.turnID {
                    flushTools()
                }
                tools.append(entry.id)
                toolsTurn = call.turnID
                continue
            }
            flush()
            items.append(.entry(entry))
        }
        flush()
        return items
    }

    @MainActor
    static func isVisible(_ entry: TranscriptEntry, in store: ConversationStore) -> Bool {
        if store.isReverted(entry.id) {
            return false
        }
        switch entry.kind {
        case .user:
            return store.userMessages[entry.id] != nil
        case .text:
            guard let part = store.textParts[entry.id] else { return false }
            return !part.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .toolCall:
            guard let call = store.toolCalls[entry.id] else { return false }
            if call.name == "request_secret" { return false }
            if call.status == .completed, SettingsChange.lineTools.contains(call.name) { return false }
            return !((call.name.hasPrefix("artifact_") || call.name == "canvas_create" || call.name == "canvas_update" || call.name == "send_file") && call.status == .completed)
        case .approval:
            return store.approvals[entry.id] != nil
        case .notice(let notice):
            return !notice.text.isEmpty
        case .schedule, .update, .route, .handoff, .memory, .voiceCall, .artifact, .codeLine, .file, .pullRequest, .contextHandoff:
            return true
        case .settingsChange(let id):
            return store.settingsChanges[id] != nil
        case .codeEdit(let editID):
            return store.codeEdits[editID] != nil
        case .codeBulk(let bulkID):
            return store.codeBulks[bulkID] != nil
        }
    }
}
