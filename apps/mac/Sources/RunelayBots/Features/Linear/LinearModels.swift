import Foundation
import SwiftUI

struct LNTeam: Decodable, Hashable, Sendable {
    let id: String
    let key: String
    let name: String
}

struct LNView: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let kind: String
    let description: String?
    let team: LNTeam?
    let url: String?
    let icon: String?
    let color: String?
}

struct LNLabel: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let color: String?
}

struct LNLabelsReply: Decodable, Sendable {
    let labels: [LNLabel]
}

struct LNProject: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let icon: String?
    let color: String?
    let url: String?
    let summary: String?
    let state: String?
    let stateType: String?
}

struct LNProjectsReply: Decodable, Sendable {
    let projects: [LNProject]
}

struct LNViewsReply: Decodable, Sendable {
    let views: [LNView]
}

struct LNColumn: Decodable, Hashable, Identifiable, Sendable {
    let key: String
    let name: String
    let type: String
    var count: Int

    var id: String { key }
}

struct LNPullLink: Decodable, Hashable, Sendable {
    let repo: String
    let number: Int
    let title: String
    let url: String
    let state: String
    let draft: Bool
    let ci: String
    let review: String?
}

struct LNCard: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let uuid: String
    let title: String
    let priority: Int
    let priorityName: String
    let estimate: Double?
    let url: String
    let branch: String?
    let updatedAt: String
    var state: String
    var stateType: String
    var column: String
    let labels: [String]
    var assignee: String?
    let teamId: String?
    let team: String?
    let parentId: String?
    let project: String?
    let pr: LNPullLink?
}

struct LNBoard: Decodable, Sendable {
    let view: LNView
    let columns: [LNColumn]
    let issues: [LNCard]
    let nextCursor: String?
    let searchable: Bool
}

struct LNComment: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let author: String
    let body: String
    let createdAt: String
    let parentId: String?
    let quotedText: String?
}

struct LNAttachment: Decodable, Hashable, Sendable {
    let title: String
    let subtitle: String?
    let url: String
}

struct LNState: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let type: String
}

struct LNIssueDetail: Decodable, Sendable {
    var card: LNCard
    let description: String
    let createdAt: String?
    let startedAt: String?
    let completedAt: String?
    let dueDate: String?
    let createdBy: String?
    let comments: [LNComment]
    let children: [LNCard]
    let attachments: [LNAttachment]
    let states: [LNState]

    private enum CodingKeys: String, CodingKey {
        case description, createdAt, startedAt, completedAt, dueDate, createdBy, comments, children, attachments, states
    }

    init(from decoder: any Decoder) throws {
        card = try LNCard(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try container.decodeIfPresent(String.self, forKey: .completedAt)
        dueDate = try container.decodeIfPresent(String.self, forKey: .dueDate)
        createdBy = try container.decodeIfPresent(String.self, forKey: .createdBy)
        comments = try container.decodeIfPresent([LNComment].self, forKey: .comments) ?? []
        children = try container.decodeIfPresent([LNCard].self, forKey: .children) ?? []
        attachments = try container.decodeIfPresent([LNAttachment].self, forKey: .attachments) ?? []
        states = try container.decodeIfPresent([LNState].self, forKey: .states) ?? []
    }
}

struct LNIssueReply: Decodable, Sendable {
    let issue: LNIssueDetail
}

struct LNMoveReply: Decodable, Sendable {
    let id: String
    let state: String
    let stateType: String
    let column: String
    let branch: String?
}

struct LNSummary: Decodable, Hashable, Sendable {
    let started: Int
    let more: Bool
}

enum LNStyle {
    static func stateSymbol(_ type: String) -> String {
        switch type {
        case "triage": "tray"
        case "backlog": "circle.dashed"
        case "unstarted": "circle"
        case "started": "circle.lefthalf.filled"
        case "completed": "checkmark.circle.fill"
        case "canceled": "xmark.circle.fill"
        case "duplicate": "square.on.square"
        default: "circle"
        }
    }

    static func stateColor(_ type: String, name: String = "") -> Color {
        LinearPalette.state(type: type, name: name)
    }

    static func priorityLevel(_ priority: Int) -> Double {
        switch priority {
        case 2: 1
        case 3: 0.66
        case 4: 0.33
        default: 0
        }
    }

    static func priorityTitle(_ priority: Int) -> String {
        switch priority {
        case 1: "Urgente"
        case 2: "Alta"
        case 3: "Média"
        case 4: "Baixa"
        default: "Sem prioridade"
        }
    }
}

struct PriorityIcon: View {
    let priority: Int

    var body: some View {
        Group {
            if priority == 1 {
                Image(systemName: "exclamationmark.square.fill")
                    .foregroundStyle(LinearPalette.urgent)
            } else if priority == 0 {
                Image(systemName: "ellipsis")
                    .foregroundStyle(Theme.textTertiary)
            } else {
                Image(systemName: "cellularbars", variableValue: LNStyle.priorityLevel(priority))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .font(.system(size: 10.5, weight: .semibold))
        .frame(width: 14, height: 14)
        .help(LNStyle.priorityTitle(priority))
    }
}

struct StateIcon: View {
    let type: String
    var name: String = ""
    var size: CGFloat = 12

    var body: some View {
        LinearStateGlyph(type: type, name: name, size: size)
    }
}
