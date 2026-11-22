import Foundation
import SwiftUI

struct GHPerson: Decodable, Hashable, Sendable {
    let login: String
    let avatarUrl: String?
}

struct GHLabel: Decodable, Hashable, Sendable {
    let name: String
    let color: String
}

struct GHPull: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let repo: String
    let number: Int
    let title: String
    let url: String
    let author: GHPerson
    let draft: Bool
    let state: String
    let head: String
    let base: String
    let ci: String
    let review: String?
    let mergeable: String
    let additions: Int
    let deletions: Int
    let comments: Int
    let labels: [GHLabel]
    let updatedAt: String
    let mergedAt: String?
    let linear: String?

    var key: String { "\(repo)#\(number)" }
    var repoName: String { repo.split(separator: "/").last.map(String.init) ?? repo }
    var isOpen: Bool { state == "open" }
}

struct GHRepoGroup: Decodable, Hashable, Identifiable, Sendable {
    let name: String
    let owner: String
    let avatarUrl: String?
    let count: Int

    var id: String { name }
    var shortName: String { name.split(separator: "/").last.map(String.init) ?? name }
}

struct GHCounts: Decodable, Hashable, Sendable {
    let mine: Int
    let review: Int
    let mentions: Int
    let merged: Int

    static let zero = GHCounts(mine: 0, review: 0, mentions: 0, merged: 0)

    func count(_ filter: GHFilter) -> Int {
        switch filter {
        case .mine: mine
        case .review: review
        case .mentions: mentions
        case .merged: merged
        }
    }
}

struct GHOverview: Decodable, Sendable {
    let viewer: GHPerson
    let filter: String
    let repo: String?
    let counts: GHCounts
    let repos: [GHRepoGroup]
    let items: [GHPull]
    let total: Int
    let nextCursor: String?
}

struct GHSummaryReply: Decodable, Sendable {
    let counts: GHCounts
}

struct GHCheck: Decodable, Hashable, Sendable {
    let name: String
    let workflow: String?
    let status: String
    let url: String?
    let runId: Int?
    let startedAt: String?
    let completedAt: String?
}

struct GHComment: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let author: GHPerson
    let body: String
    let createdAt: String
    let url: String?
}

struct GHReview: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let author: GHPerson
    let state: String
    let body: String
    let submittedAt: String?
}

struct GHThread: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let path: String
    let line: Int?
    let resolved: Bool
    let outdated: Bool
    let comments: [GHComment]
}

struct GHFile: Decodable, Hashable, Sendable {
    let path: String
    let additions: Int
    let deletions: Int
    let change: String
}

struct GHCommit: Decodable, Hashable, Sendable {
    let oid: String
    let short: String
    let message: String
    let date: String?
    let author: GHPerson
    let url: String?
}

struct GHPullDetail: Decodable, Sendable {
    let pull: GHPull
    let body: String
    let headOid: String
    let crossRepository: Bool
    let mergeState: String
    let mergeMethods: [String]
    let defaultMergeMethod: String
    let deleteBranchOnMerge: Bool
    let viewerIsAuthor: Bool
    let files: [GHFile]
    let fileCount: Int
    let reviews: [GHReview]
    let threads: [GHThread]
    let conversation: [GHComment]
    let commits: [GHCommit]
    let commitCount: Int
    let checks: [GHCheck]

    private enum CodingKeys: String, CodingKey {
        case body, headOid, crossRepository, mergeState, mergeMethods, defaultMergeMethod, deleteBranchOnMerge, viewerIsAuthor
        case files, fileCount, reviews, threads, conversation, commits, commitCount, checks
    }

    init(from decoder: any Decoder) throws {
        pull = try GHPull(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        body = try container.decodeIfPresent(String.self, forKey: .body) ?? ""
        headOid = try container.decodeIfPresent(String.self, forKey: .headOid) ?? ""
        crossRepository = try container.decodeIfPresent(Bool.self, forKey: .crossRepository) ?? false
        mergeState = try container.decodeIfPresent(String.self, forKey: .mergeState) ?? "unknown"
        mergeMethods = try container.decodeIfPresent([String].self, forKey: .mergeMethods) ?? []
        defaultMergeMethod = try container.decodeIfPresent(String.self, forKey: .defaultMergeMethod) ?? "merge"
        deleteBranchOnMerge = try container.decodeIfPresent(Bool.self, forKey: .deleteBranchOnMerge) ?? false
        viewerIsAuthor = try container.decodeIfPresent(Bool.self, forKey: .viewerIsAuthor) ?? false
        files = try container.decodeIfPresent([GHFile].self, forKey: .files) ?? []
        fileCount = try container.decodeIfPresent(Int.self, forKey: .fileCount) ?? 0
        reviews = try container.decodeIfPresent([GHReview].self, forKey: .reviews) ?? []
        threads = try container.decodeIfPresent([GHThread].self, forKey: .threads) ?? []
        conversation = try container.decodeIfPresent([GHComment].self, forKey: .conversation) ?? []
        commits = try container.decodeIfPresent([GHCommit].self, forKey: .commits) ?? []
        commitCount = try container.decodeIfPresent(Int.self, forKey: .commitCount) ?? 0
        checks = try container.decodeIfPresent([GHCheck].self, forKey: .checks) ?? []
    }

    var failedChecks: Int { checks.filter { $0.status == "failure" }.count }
    var pendingChecks: Int { checks.filter { $0.status == "pending" }.count }
}

struct GHPullReply: Decodable, Sendable {
    let pull: GHPullDetail
}

struct GHMergeReply: Decodable, Sendable {
    let pull: GHPullDetail
    let branchDeleted: Bool
}

struct GHRerunReply: Decodable, Sendable {
    let pull: GHPullDetail
    let reruns: Int
}

enum GHFilter: String, CaseIterable, Identifiable, Hashable {
    case mine
    case review
    case mentions
    case merged

    var id: String { rawValue }

    var title: String {
        switch self {
        case .mine: tr("Meus")
        case .review: tr("Para revisar")
        case .mentions: tr("Menções")
        case .merged: tr("Mergeados")
        }
    }

    var emptyTitle: String {
        switch self {
        case .mine: tr("Nenhum PR seu aberto")
        case .review: tr("Nada esperando sua revisão")
        case .mentions: tr("Ninguém te chamou")
        case .merged: tr("Nada mergeado nesta semana")
        }
    }

    var emptyMessage: String {
        switch self {
        case .mine: tr("Quando você abrir um PR, ele aparece aqui.")
        case .review: tr("Os PRs em que pedirem sua revisão aparecem aqui.")
        case .mentions: tr("PRs em que você foi marcado ou comentou aparecem aqui.")
        case .merged: tr("Os PRs que você mergear nos últimos 7 dias aparecem aqui.")
        }
    }
}

enum GHMergeMethod: String, CaseIterable, Hashable {
    case squash
    case merge
    case rebase

    var title: String {
        switch self {
        case .squash: tr("Squash e merge")
        case .merge: tr("Merge commit")
        case .rebase: tr("Rebase e merge")
        }
    }

    var subtitle: String {
        switch self {
        case .squash: tr("Junta os commits em um só")
        case .merge: tr("Mantém todos os commits")
        case .rebase: tr("Reaplica os commits na base")
        }
    }
}

enum GHStyle {
    static func stateColor(_ pull: GHPull) -> Color {
        if pull.state == "merged" { return Theme.merged }
        if pull.state == "closed" { return Theme.danger }
        if pull.draft { return Theme.textTertiary }
        return Theme.success
    }

    static func stateSymbol(_ pull: GHPull) -> String {
        if pull.state == "merged" { return "arrow.triangle.merge" }
        if pull.state == "closed" { return "xmark.circle" }
        if pull.draft { return "pencil.circle" }
        return "arrow.triangle.pull"
    }

    static func stateTitle(_ pull: GHPull) -> String {
        if pull.state == "merged" { return tr("Mergeado") }
        if pull.state == "closed" { return tr("Fechado") }
        if pull.draft { return tr("Rascunho") }
        return tr("Aberto")
    }

    static func ciColor(_ ci: String) -> Color {
        switch ci {
        case "success": Theme.success
        case "failure": Theme.danger
        case "pending": Theme.warning
        default: Theme.textTertiary
        }
    }

    static func ciTitle(_ ci: String) -> String {
        switch ci {
        case "success": tr("CI passou")
        case "failure": tr("CI falhou")
        case "pending": tr("CI rodando")
        default: tr("Sem CI")
        }
    }

    static func reviewTitle(_ review: String?) -> String? {
        switch review {
        case "approved": tr("Aprovado")
        case "changes_requested": tr("Pediram mudanças")
        case "review_required": tr("Falta revisão")
        default: nil
        }
    }

    static func reviewColor(_ review: String?) -> Color {
        switch review {
        case "approved": Theme.success
        case "changes_requested": Theme.danger
        default: Theme.textSecondary
        }
    }

    static func reviewSymbol(_ review: String?) -> String {
        switch review {
        case "approved": "checkmark.seal"
        case "changes_requested": "exclamationmark.bubble"
        default: "eye"
        }
    }

    static func checkSymbol(_ status: String) -> String {
        switch status {
        case "success": "checkmark.circle.fill"
        case "failure": "xmark.circle.fill"
        case "pending": "circle.dotted"
        case "skipped": "arrow.uturn.right.circle"
        default: "minus.circle"
        }
    }

    static func checkColor(_ status: String) -> Color {
        switch status {
        case "success": Theme.success
        case "failure": Theme.danger
        case "pending": Theme.warning
        default: Theme.textTertiary
        }
    }

    static func reviewStateTitle(_ state: String) -> String {
        switch state {
        case "approved": tr("aprovou")
        case "changes_requested": tr("pediu mudanças")
        case "dismissed": tr("teve a revisão descartada")
        default: tr("comentou")
        }
    }

    static func fileSymbol(_ change: String) -> String {
        switch change {
        case "added": "plus.square"
        case "deleted": "minus.square"
        case "renamed": "arrow.right.square"
        default: "square.and.pencil"
        }
    }
}
