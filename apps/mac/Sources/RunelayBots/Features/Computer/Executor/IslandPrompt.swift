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
    static let visibleChoices = 4
    static let otherID = "other"

    let prompt: IslandPrompt
    let open: @MainActor () -> Void

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var text = ""

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
            .padding(Spacing.l)
            .frame(width: ComputerControlTab.cardWidth, alignment: .leading)
            .glassPane(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .softElevation(lifted: true)
            .animation(Motion.animation(reduceMotion: reduceMotion), value: approval.resolution)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(approval.isQuestion ? "\(prompt.bot.name) quer saber" : "\(prompt.bot.name) precisa de você")
        }
    }

    private func header(_ approval: Approval) -> some View {
        HStack(spacing: Spacing.s) {
            BotCharacter(bot: prompt.bot, mood: .waiting, size: 18)
                .frame(width: 18, height: 18)
            Text(approval.isQuestion ? "\(prompt.bot.name) quer saber" : "\(prompt.bot.name) precisa de você")
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
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
        if approval.options.isEmpty {
            return true
        }
        return approval.options.count > Self.visibleChoices
    }

    private func isSimple(_ approval: Approval) -> Bool {
        let ids = Set(approval.options.map(\.id))
        return approval.kind == "approval" && ids.isSubset(of: ["approve", "approve_always", "deny"])
    }

    private func approvalBody(_ approval: Approval) -> some View {
        let phrase = ActionPhrase(approval: approval, call: prompt.call)
        return VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(spacing: Spacing.m) {
                if let image = approval.previewImage.flatMap(NSImage.init(data:)) {
                    ActionThumbnail(image: image, width: 56, height: 38)
                } else {
                    ActionIcon(phrase: phrase, connector: prompt.call?.connectorName, size: 18)
                        .frame(width: 32, height: 32)
                        .background(Theme.selection, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(phrase.text)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let reason = approval.reason {
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
                if approval.options.contains(where: { $0.id == "approve_always" }) {
                    Button("Sempre neste repo") { answer("approve_always") }
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
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                ForEach(approval.options) { option in
                    IslandChoiceRow(label: option.label, detail: option.detail, recommended: option.isPrimary) {
                        answer(option.id)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func questionBody(_ approval: Approval) -> some View {
        if let question = approval.questions.first, approval.questions.count == 1, !question.multiSelect {
            VStack(alignment: .leading, spacing: Spacing.m) {
                title(question.title)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    ForEach(question.choices.prefix(Self.visibleChoices)) { choice in
                        IslandChoiceRow(label: choice.label, detail: choice.detail, recommended: choice.recommended) {
                            submit(question, optionIDs: [choice.id], text: "")
                        }
                    }
                }
                HStack(spacing: Spacing.s) {
                    TextField("Ou escreva sua resposta", text: $text)
                        .textFieldStyle(.plain)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .onSubmit { sendText(question) }
                    Button("Enviar") { sendText(question) }
                        .buttonStyle(SmallPillButtonStyle(kind: .primary))
                        .disabled(trimmed.isEmpty)
                }
                .padding(.leading, Spacing.m)
                .padding(.trailing, Spacing.xs)
                .padding(.vertical, Spacing.xs)
                .background(Theme.selection, in: Capsule())
                HStack(spacing: Spacing.s) {
                    Spacer(minLength: 0)
                    Button("Pular") { skip(approval) }
                        .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                    Button("Responder") { open() }
                        .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                }
            }
        } else {
            let first = approval.questions.first?.title ?? approval.prompt
            let extra = approval.questions.count > 1 ? " (+\(approval.questions.count - 1))" : ""
            VStack(alignment: .leading, spacing: Spacing.m) {
                title(first + extra)
                HStack(spacing: Spacing.s) {
                    Spacer(minLength: 0)
                    Button("Pular") { skip(approval) }
                        .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                    Button("Responder") { open() }
                        .buttonStyle(SmallPillButtonStyle(kind: .primary))
                }
            }
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

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func answer(_ optionID: String) {
        prompt.store.respond(approvalID: prompt.approvalID, optionID: optionID)
    }

    private func submit(_ question: QuestionPrompt, optionIDs: [String], text: String) {
        prompt.store.answerQuestion(
            id: prompt.approvalID,
            answers: [QuestionAnswerDraft(questionID: question.id, optionIDs: optionIDs, text: text)]
        )
    }

    private func sendText(_ question: QuestionPrompt) {
        guard !trimmed.isEmpty else { return }
        submit(question, optionIDs: [Self.otherID], text: trimmed)
    }

    private func skip(_ approval: Approval) {
        prompt.store.answerQuestion(
            id: prompt.approvalID,
            answers: approval.questions.map { QuestionAnswerDraft(questionID: $0.id, skipped: true) }
        )
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
        .background(AlwaysHover { hovering in
            isHovering = hovering
        })
        .springAnimation(value: isHovering)
        .accessibilityLabel(recommended ? "\(label), recomendado" : label)
    }
}
