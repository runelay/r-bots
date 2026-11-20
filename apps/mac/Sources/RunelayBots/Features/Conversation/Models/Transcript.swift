import Foundation

struct TranscriptEntry: Identifiable, Equatable {
    enum Kind: Equatable {
        case user
        case text
        case toolCall
        case approval
        case notice(TranscriptNotice)
        case schedule(String)
        case update(String)
        case route(String, Double?)
        case handoff(String, String, String?)
        case memory([String])
        case voiceCall(String, Int)
        case artifact(ArtifactRef)
        case codeEdit(String)
        case codeBulk(String)
        case codeLine(String, String)
        case pullRequest(PullRequestEvent)
        case contextHandoff(ContextHandoff)
        case file(AttachmentRef)
    }

    let id: String
    let kind: Kind
}

struct TranscriptNotice: Equatable {
    enum Tone: Equatable {
        case info
        case error
    }

    let text: String
    let detail: String?
    let tone: Tone
    var action: FallbackOffer? = nil
}

struct ContextHandoff: Equatable {
    let reason: String
    let fromAccount: String?
    let fromModel: String?
    let toAccount: String
    let toModel: String?
    let detail: String?
}

struct FallbackOffer: Equatable {
    let label: String
    let account: String
    let model: String?
}

enum DeliveryState: Equatable {
    case sending
    case queued
    case sent
    case failed(String)
}

struct UserMessage: Identifiable, Equatable {
    let id: String
    var text: String
    var state: DeliveryState
    var isConfirmed: Bool
    var isVoice = false
    var skills: [SkillSummary] = []
    var attachments: [AttachmentRef] = []
    var fromBotID: String? = nil
    var fromName: String? = nil

    var isSkillOnly: Bool {
        !skills.isEmpty && text == skills.map(\.invocation).joined(separator: " ")
    }
}

enum TextPhase: Equatable {
    case reply
    case narration
}

struct CodeBulk: Identifiable, Equatable {
    let id: String
    let files: Int
    let added: Int
    let removed: Int
    let paths: [String]
}

struct TranscriptSnapshot {
    let items: [TranscriptItem]
    let bubbles: [String: BubbleMeta]
}

struct TextPart: Identifiable, Equatable {
    let id: String
    var text: String
    var phase: TextPhase
    var isStreaming: Bool
    var account: String? = nil
    var botID: String? = nil
    var isVoice = false
}

enum ToolCallStatus: Equatable {
    case requested
    case running
    case completed
    case failed
    case rejected
    case interrupted
    case other(String)

    init(outcome: String?) {
        let value = outcome ?? ""
        switch value {
        case "", "completed", "succeeded", "success": self = .completed
        case "failed", "error": self = .failed
        case "rejected", "denied": self = .rejected
        case "interrupted", "cancelled", "abandoned": self = .interrupted
        default: self = .other(value)
        }
    }

    var isActive: Bool {
        self == .requested || self == .running
    }

    var label: String {
        switch self {
        case .requested: "na fila"
        case .running: "rodando"
        case .completed: "feito"
        case .failed: "falhou"
        case .rejected: "recusado"
        case .interrupted: "interrompido"
        case .other(let value): value
        }
    }

    var symbol: String {
        switch self {
        case .requested: "circle.dashed"
        case .running: "circle.dotted"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .rejected: "hand.raised.fill"
        case .interrupted: "pause.circle"
        case .other: "circle"
        }
    }
}

enum DelegationState: String, Equatable {
    case starting
    case queued
    case working
    case awaiting
    case completed
    case failed
    case cancelled

    var isActive: Bool {
        self == .starting || self == .queued || self == .working || self == .awaiting
    }
}

struct DelegationLink: Equatable {
    let botID: String
    var sessionID: String? = nil
    var state: DelegationState = .starting
    var summary: String? = nil
    var error: String? = nil
}

struct ToolCall: Identifiable, Equatable {
    let id: String
    let name: String
    let kind: String
    var label: String?
    let input: JSONValue
    var status: ToolCallStatus
    var output: JSONValue?
    var errorMessage: String?
    var viaAgent: String? = nil
    var decisionNote: String? = nil
    var decisionDetail: String? = nil
    var turnID: String? = nil
    var ownerCallID: String? = nil
    var requestedAt: Date? = nil
    var settledAt: Date? = nil
    var screenshotPath: String? = nil
    var delegation: DelegationLink? = nil

    var connectorName: String? {
        guard name.hasPrefix("connector:") else { return nil }
        let rest = name.dropFirst("connector:".count)
        return rest.split(separator: ".").first.map(String.init)
    }

    var connectorTool: String? {
        guard name.hasPrefix("connector:"), let dot = name.firstIndex(of: ".") else { return nil }
        return String(name[name.index(after: dot)...])
    }

    var shortLabel: String {
        if let tool = connectorTool, label == nil {
            return tool
        }
        if let label, let colon = label.range(of: ": ")?.lowerBound {
            let head = label[..<colon].trimmingCharacters(in: .whitespaces)
            if !head.isEmpty {
                return head
            }
        }
        return displayName
    }

    var argument: String {
        if let label, let colon = label.range(of: ": ")?.upperBound {
            let tail = label[colon...].trimmingCharacters(in: .whitespaces)
            if !tail.isEmpty {
                return tail
            }
        }
        return inputSummary
    }

    var groupNoun: String {
        let lowered = name.lowercased()
        if lowered.contains("query") || lowered.contains("sql") { return "consultas" }
        if lowered.hasPrefix("browser") { return "ações no navegador" }
        if ["Read", "Edit", "MultiEdit", "Write", "Bash", "Glob", "Grep", "TodoWrite", "NotebookEdit"].contains(name) { return "passos no código" }
        return "ferramentas"
    }

    var isDelegation: Bool {
        kind == "agent" || label?.hasPrefix("Delegar") == true
    }

    var displayName: String {
        if let label, !label.isEmpty {
            return label
        }
        return name
    }

    var symbol: String {
        let lowered = name.lowercased()
        if kind == "agent" || label?.hasPrefix("Delegar") == true { return "person.2.fill" }
        if kind == "skill" { return "book.closed" }
        if lowered.hasPrefix("browser") {
            if lowered.contains("screenshot") { return "camera" }
            if lowered.contains("click") { return "cursorarrow.click" }
            if lowered.contains("type") || lowered.contains("fill") { return "keyboard" }
            if lowered.contains("open") || lowered.contains("navigate") { return "safari" }
            return "globe"
        }
        if lowered.contains("query") || lowered.contains("sql") { return "cylinder.split.1x2" }
        if lowered.hasPrefix("note_") { return "doc.text" }
        if lowered.hasPrefix("sheet_") { return "tablecells" }
        if lowered.hasPrefix("agenda_") { return "calendar" }
        if lowered.hasPrefix("export_") { return "arrow.down.doc" }
        switch name {
        case "Read": return "doc.text"
        case "Edit", "MultiEdit", "NotebookEdit": return "pencil"
        case "Write": return "doc.badge.plus"
        case "Bash": return "terminal"
        case "Glob", "Grep": return "magnifyingglass"
        case "TodoWrite": return "checklist"
        case "workspace_open", "workspace_close": return "arrow.triangle.branch"
        case "workspace_deliver": return "arrow.up.circle"
        case "dev_server_start", "dev_server_stop", "dev_server_logs": return "play.circle"
        default: break
        }
        return "wrench.and.screwdriver"
    }

    var inputSummary: String {
        switch input {
        case .object(let object):
            let preferred = ["url", "query", "sql", "selector", "text", "message", "question", "name", "ref"]
            for key in preferred {
                if let value = object[key]?.inlineDescription {
                    return value
                }
            }
            return object.keys.sorted().prefix(2).compactMap { key in
                object[key]?.inlineDescription.map { "\(key): \($0)" }
            }
            .joined(separator: " · ")
        default:
            return input.inlineDescription ?? ""
        }
    }
}

struct ApprovalTarget: Equatable {
    let label: String
    let role: String
    var app: String? = nil
    var bundleID: String? = nil
    var url: String? = nil
}

struct ApprovalOption: Identifiable, Equatable {
    let id: String
    let label: String
    let isPrimary: Bool
    var detail: String? = nil
}

enum ApprovalTone: Equatable {
    case approved
    case denied
    case neutral
}

enum ApprovalResolution: Equatable {
    case open
    case answering(String)
    case settled(String, ApprovalTone)
}

struct QuestionChoice: Identifiable, Equatable {
    let id: String
    let label: String
    var detail: String? = nil
    var recommended = false
}

struct QuestionPrompt: Identifiable, Equatable {
    let id: String
    let title: String
    var header: String? = nil
    var multiSelect = false
    let choices: [QuestionChoice]
}

struct QuestionAnswerDraft: Equatable {
    let questionID: String
    var optionIDs: [String] = []
    var text: String = ""
    var skipped = false

    var isEmpty: Bool { optionIDs.isEmpty && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

struct Approval: Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let prompt: String
    let options: [ApprovalOption]
    let callID: String?
    let signInURL: URL?
    var resolution: ApprovalResolution
    var viaAgent: String? = nil
    var target: ApprovalTarget? = nil
    var previewImage: Data? = nil
    var reason: String? = nil
    var grant: String? = nil
    var secretForm: SecretFormRequest? = nil
    var questions: [QuestionPrompt] = []

    var isOpen: Bool { resolution == .open }
    var isQuestion: Bool { kind == "question" }

    func summary(for optionID: String) -> (String, ApprovalTone) {
        if secretForm != nil {
            return optionID == "approve" ? ("Salvo no cofre", .approved) : ("Não informado", .neutral)
        }
        switch optionID {
        case "approve": return ("Aprovado", .approved)
        case "approve_always": return ("Sempre permitido neste repositório", .approved)
        case "deny": return ("Negado", .denied)
        default:
            let label = options.first { $0.id == optionID }?.label ?? optionID
            return ("Respondido: \(label)", .neutral)
        }
    }
}
