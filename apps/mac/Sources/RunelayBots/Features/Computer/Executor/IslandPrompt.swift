import AppKit
import SwiftUI

struct IslandPrompt: Identifiable {
    let store: ConversationStore
    let approvalID: String
    let bot: Bot

    var id: String { approvalID }
    @MainActor var approval: Approval? { store.approvals[approvalID] }
    @MainActor var isOpen: Bool { approval?.isOpen == true }
    @MainActor var call: ToolCall? { approval?.callID.flatMap { store.toolCalls[$0] } }
}

struct IslandPromptCard: View {
    let prompt: IslandPrompt
    let width: CGFloat
    let avatar: Namespace.ID?
    var bodyLimits: [CGFloat]? = nil
    var wizard: QuestionWizard? = nil
    let open: @MainActor () -> Void

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        if let approval = prompt.approval {
            VStack(alignment: .leading, spacing: Spacing.m) {
                header(approval)
                Group {
                    switch approval.resolution {
                    case .open:
                        content(approval)
                    case .answering(let value):
                        ResolvedLabel(summary: approval.isQuestion ? (value, .approved) : approval.summary(for: value))
                    case .settled(let value, let tone):
                        ResolvedLabel(summary: (value, tone))
                    }
                }
                .transition(.opacity)
            }
            .frame(width: width, alignment: .leading)
            .animation(Motion.animation(reduceMotion: reduceMotion), value: approval.resolution)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(approval.isQuestion ? "\(prompt.bot.name) quer saber" : "\(prompt.bot.name) precisa de você")
        }
    }

    private func header(_ approval: Approval) -> some View {
        HStack(alignment: .center, spacing: Spacing.s) {
            IslandAvatar(bot: prompt.bot, namespace: avatar)
            Text(approval.isQuestion ? "\(prompt.bot.name) quer saber" : "\(prompt.bot.name) precisa de você")
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Spacing.s)
            Button(action: open) {
                Image(systemName: "arrow.up.forward.app")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 24, height: 24)
                    .background(Theme.selection, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .clickable()
            .help("Abrir a conversa")
            .accessibilityLabel("Abrir a conversa")
        }
    }

    @ViewBuilder
    private func content(_ approval: Approval) -> some View {
        if approval.isQuestion {
            questionBody(approval)
        } else if needsApp(approval) {
            openBody(approval.prompt.isEmpty ? approval.title : approval.prompt)
        } else if isSimple(approval) {
            approvalBody(approval)
        } else {
            optionsBody(approval)
        }
    }

    private func needsApp(_ approval: Approval) -> Bool {
        if approval.secretForm != nil || approval.integrationForm != nil || approval.signInURL != nil {
            return true
        }
        return approval.options.isEmpty
    }

    private func isSimple(_ approval: Approval) -> Bool {
        let ids = Set(approval.options.map(\.id))
        return approval.kind == "approval" && ids.isSubset(of: ["approve", "approve_always", "deny"])
    }

    private func approvalBody(_ approval: Approval) -> some View {
        let phrase = ActionPhrase(approval: approval, call: prompt.call)
        let headline = ApprovalHeadline(approval: approval, call: prompt.call)
        return VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(alignment: .top, spacing: Spacing.m) {
                if let image = approval.previewImage.flatMap(NSImage.init(data:)) {
                    ActionThumbnail(image: image, width: 56, height: 40)
                } else {
                    ActionIcon(phrase: phrase, connector: prompt.call?.connectorName, size: 16)
                        .frame(width: 32, height: 32)
                        .background(Theme.selection, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                }
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Group {
                        if let title = headline.title {
                            Text(title)
                        } else {
                            Text(phrase.text)
                        }
                    }
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    if let detail = headline.detail {
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                    if let reason = headline.reason {
                        Text(reason)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                Button("Agora não") { answer("deny") }
                    .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                if let always = approval.options.first(where: { $0.id == "approve_always" }) {
                    Button(approval.grant == nil ? always.label : tr("Sempre neste repo")) { answer("approve_always") }
                        .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                }
                Button("Permitir") { answer("approve") }
                    .buttonStyle(SmallPillButtonStyle(kind: .primary))
            }
        }
    }

    private func optionsBody(_ approval: Approval) -> some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            title(approval.prompt.isEmpty ? approval.title : approval.prompt)
            scrolling(bodyLimits?.first) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    ForEach(approval.options) { option in
                        IslandChoiceRow(label: option.label, detail: option.detail, recommended: option.isPrimary) {
                            answer(option.id)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func scrolling<Content: View>(_ limit: CGFloat?, @ViewBuilder content: () -> Content) -> some View {
        if let limit {
            ScrollView(.vertical) { content() }
                .frame(height: limit)
        } else {
            content()
        }
    }

    @ViewBuilder
    private func questionBody(_ approval: Approval) -> some View {
        if approval.questions.isEmpty {
            openBody(approval.prompt.isEmpty ? approval.title : approval.prompt)
        } else {
            QuestionWizardView(
                wizard: wizard ?? QuestionWizard.shared(store: prompt.store, approvalID: prompt.approvalID),
                style: .island,
                bodyLimits: bodyLimits
            )
        }
    }

    private func openBody(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            title(text)
            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                Button("Responder") { open() }
                    .buttonStyle(SmallPillButtonStyle(kind: .primary))
            }
        }
    }

    private func title(_ text: String) -> some View {
        Text(text)
            .font(TypeScale.rowTitle)
            .foregroundStyle(Theme.textPrimary)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func answer(_ optionID: String) {
        prompt.store.respond(approvalID: prompt.approvalID, optionID: optionID)
    }
}

struct ApprovalHeadline {
    private enum Category {
        case outbound
        case deploy
        case database
        case production
        case command

        var title: String {
            switch self {
            case .outbound: tr("Quer mandar algo para fora")
            case .deploy: tr("Quer fazer deploy")
            case .database: tr("Quer mexer no banco de produção")
            case .production: tr("Quer mexer em produção")
            case .command: tr("Quer rodar um comando")
            }
        }

        var reason: String? {
            switch self {
            case .outbound: tr("Isso fala com gente de fora ou mexe com dinheiro, então preciso do seu ok.")
            case .deploy: tr("Isso coloca algo no ar, então preciso do seu ok.")
            case .database, .production: tr("Isso mexe em produção, então preciso do seu ok.")
            case .command: nil
            }
        }
    }

    static let detailLimit = 48

    let title: String?
    let detail: String?
    let reason: String?

    init(approval: Approval, call: ToolCall?) {
        let category = Self.category(approval: approval, call: call)
        title = category?.title
        let label = call?.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        detail = category != nil && !label.isEmpty && label.count <= Self.detailLimit ? label : nil
        if let reason = approval.reason, reason.localizedCaseInsensitiveContains("lista dura") {
            self.reason = category?.reason ?? tr("Precisa do seu ok antes de seguir.")
        } else {
            reason = approval.reason
        }
    }

    private static func category(approval: Approval, call: ToolCall?) -> Category? {
        let text = "\(approval.prompt) \(approval.reason ?? "")".lowercased()
        let isCommand = call.map { $0.name == "Bash" || $0.name == "shell_run" } ?? false
        let guarded = ["lista dura", "produção", "deploy", "seu ok", "hard list", "production", "your ok"].contains(where: text.contains)
        guard isCommand || guarded else { return nil }
        if ["mandar para", "mensagem para fora", "dinheiro", "gente de fora", "outbound", "money", "send to"].contains(where: text.contains) {
            return .outbound
        }
        if ["deploy", "merge", "workflow", "release", "publica", "infraestrutura", "no ar", "publish", "infrastructure"].contains(where: text.contains) {
            return .deploy
        }
        if ["banco", "sql", "d1 ", "supabase", "database"].contains(where: text.contains) {
            return .database
        }
        if text.contains("produção") || text.contains("production") {
            return .production
        }
        return isCommand ? .command : nil
    }
}

private struct IslandAvatar: View {
    let bot: Bot
    let namespace: Namespace.ID?

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if let namespace {
                character.matchedGeometryEffect(id: "avatar", in: namespace)
            } else {
                character
            }
            dot
                .offset(x: 2, y: -2)
        }
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
    }

    private var character: some View {
        BotCharacter(bot: bot, mood: .waiting, size: 20)
            .frame(width: 20, height: 20)
            .frame(width: 24, height: 24)
    }

    @ViewBuilder
    private var dot: some View {
        let base = Circle()
            .fill(Theme.attention)
            .frame(width: 8, height: 8)
        if reduceMotion {
            base
        } else {
            base.phaseAnimator([false, true]) { content, lit in
                content
                    .scaleEffect(lit ? 1 : 0.7)
                    .opacity(lit ? 1 : 0.55)
            } animation: { _ in
                .easeInOut(duration: 0.9)
            }
        }
    }
}

private struct IslandChoiceRow: View {
    let label: String
    let detail: String?
    let recommended: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(spacing: Spacing.s) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: Spacing.s)
                if recommended {
                    Text("Recomendado")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.selection, in: Capsule())
                }
            }
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, Spacing.s)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isHovering ? Theme.selection : Theme.hover, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .background(
            AlwaysHover { hovering in
                isHovering = hovering
            }
        )
        .springAnimation(value: isHovering)
        .accessibilityLabel(recommended ? tr("%@, recomendado", label) : label)
    }
}
