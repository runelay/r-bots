import Foundation
import SwiftUI

enum PullRequestStatus: String, Hashable, Sendable {
    case open
    case draft
    case merged
    case closed

    var label: String {
        switch self {
        case .open: "Aberto"
        case .draft: "Rascunho"
        case .merged: "Mergeado"
        case .closed: "Fechado"
        }
    }

    var symbol: String {
        switch self {
        case .open: "arrow.triangle.pull"
        case .draft: "pencil.circle"
        case .merged: "arrow.triangle.merge"
        case .closed: "xmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .open: Theme.success
        case .draft: Theme.textTertiary
        case .merged: Theme.merged
        case .closed: Theme.danger
        }
    }
}

enum CIStatus: String, Hashable, Sendable {
    case none
    case pending
    case success
    case failure

    var color: Color {
        switch self {
        case .none: Theme.textTertiary
        case .pending: Theme.warning
        case .success: Theme.success
        case .failure: Theme.danger
        }
    }

    var label: String {
        switch self {
        case .none: "Sem CI"
        case .pending: "CI rodando"
        case .success: "CI passou"
        case .failure: "CI falhou"
        }
    }
}

struct PullRequestCheck: Identifiable, Hashable, Sendable {
    let name: String
    let workflow: String?
    let status: String
    let durationMs: Int?
    let startedAt: Date?
    let url: URL?

    var id: String { "\(workflow ?? "")/\(name)" }

    init?(_ value: JSONValue) {
        guard let name = value["name"]?.stringValue else { return nil }
        self.name = name
        workflow = value["workflow"]?.stringValue
        status = value["status"]?.stringValue ?? "pending"
        durationMs = value["durationMs"]?.intValue
        startedAt = value["startedAt"]?.stringValue.flatMap(ISODate.parse)
        url = value["url"]?.stringValue.flatMap(URL.init(string:))
    }

    var symbol: String {
        switch status {
        case "success": "checkmark.circle.fill"
        case "failure": "xmark.circle.fill"
        case "skipped", "neutral": "minus.circle"
        default: "circle.dotted"
        }
    }

    var color: Color {
        switch status {
        case "success": Theme.success
        case "failure": Theme.danger
        case "skipped", "neutral": Theme.textTertiary
        default: Theme.warning
        }
    }

    var durationText: String? {
        if let durationMs {
            return Self.format(seconds: durationMs / 1000)
        }
        if status == "pending", let startedAt {
            return Self.format(seconds: Int(Date().timeIntervalSince(startedAt)))
        }
        return nil
    }

    static func format(seconds: Int) -> String {
        let total = max(0, seconds)
        if total < 60 { return "\(total) s" }
        let minutes = total / 60
        let rest = total % 60
        return rest == 0 ? "\(minutes) min" : "\(minutes) min \(rest) s"
    }
}

struct PullRequestCategory: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let files: Int
    let added: Int
    let removed: Int
}

struct PullRequestInfo: Hashable, Sendable {
    let number: Int
    let title: String
    let url: URL?
    let status: PullRequestStatus
    let base: String
    let head: String
    let additions: Int
    let deletions: Int
    let files: Int
    let categories: [PullRequestCategory]
    let checks: [PullRequestCheck]
    let ci: CIStatus
    let review: String?
    let mergedAt: Date?

    init?(_ value: JSONValue?) {
        guard let value, let number = value["number"]?.intValue else { return nil }
        self.number = number
        title = value["title"]?.stringValue ?? "PR #\(number)"
        url = value["url"]?.stringValue.flatMap(URL.init(string:))
        status = PullRequestStatus(rawValue: value["status"]?.stringValue ?? "") ?? .open
        base = value["base"]?.stringValue ?? ""
        head = value["head"]?.stringValue ?? ""
        additions = value["additions"]?.intValue ?? 0
        deletions = value["deletions"]?.intValue ?? 0
        files = value["files"]?.intValue ?? 0
        let labels = [("code", "Código"), ("tests", "Testes"), ("generated", "Gerado"), ("docs", "Docs")]
        categories = labels.compactMap { key, label in
            guard let item = value["categories"]?[key], let files = item["files"]?.intValue, files > 0 else { return nil }
            return PullRequestCategory(id: key, label: label, files: files, added: item["added"]?.intValue ?? 0, removed: item["removed"]?.intValue ?? 0)
        }
        checks = value["checks"]?.arrayValue?.compactMap(PullRequestCheck.init) ?? []
        ci = CIStatus(rawValue: value["ci"]?.stringValue ?? "") ?? .none
        review = value["review"]?.stringValue
        mergedAt = value["mergedAt"]?.stringValue.flatMap(ISODate.parse)
    }

    var shortTitle: String {
        title.count > 48 ? String(title.prefix(47)) + "…" : title
    }

    var reviewLabel: (text: String, symbol: String, color: Color)? {
        switch review {
        case "approved": ("Aprovado", "checkmark.seal.fill", Theme.success)
        case "changes_requested": ("Mudanças pedidas", "exclamationmark.bubble.fill", Theme.danger)
        case "review_required": ("Aguardando review", "eye", Theme.textTertiary)
        default: nil
        }
    }
}

struct PullRequestEvent: Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        case ciFailed
        case ciPassed
        case changesRequested
        case approved
    }

    let kind: Kind
    let number: Int
    let check: String?
    let logURL: URL?
    let prURL: URL?
    let log: String?
    let comments: [String]

    init?(type: String, data: JSONValue) {
        number = data["number"]?.intValue ?? 0
        prURL = data["prUrl"]?.stringValue.flatMap(URL.init(string:))
        switch type {
        case "code.ci":
            kind = data["outcome"]?.stringValue == "failure" ? .ciFailed : .ciPassed
            let failed = data["failed"]?.arrayValue?.compactMap { $0["name"]?.stringValue } ?? []
            check = failed.isEmpty ? data["check"]?["name"]?.stringValue : failed.joined(separator: ", ")
            logURL = data["check"]?["url"]?.stringValue.flatMap(URL.init(string:))
            log = data["log"]?.stringValue
            comments = []
        case "code.review":
            kind = data["state"]?.stringValue == "approved" ? .approved : .changesRequested
            check = data["author"]?.stringValue
            logURL = nil
            log = data["body"]?.stringValue
            comments =
                data["comments"]?.arrayValue?.compactMap { item in
                    guard let body = item["body"]?.stringValue, !body.isEmpty else { return nil }
                    let path = (item["path"]?.stringValue ?? "") as NSString
                    let line = item["line"]?.intValue.map { ":\($0)" } ?? ""
                    return path.length > 0 ? "\(path.lastPathComponent)\(line) — \(body)" : body
                } ?? []
        default:
            return nil
        }
    }

    var fixRequest: String {
        var text = "O CI do PR #\(number) falhou em \(check ?? "um check"). Corrige."
        if let log, !log.isEmpty {
            text += "\n\nLog resumido:\n```\n\(log)\n```"
        }
        return text
    }

    var reviewRequest: String {
        var text = "O review do PR #\(number) pediu mudanças. Corrige."
        if let log, !log.isEmpty { text += "\n\nResumo: \(log)" }
        if !comments.isEmpty { text += "\n\nComentários:\n" + comments.map { "- \($0)" }.joined(separator: "\n") }
        return text
    }
}
