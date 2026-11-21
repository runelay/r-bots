import SwiftUI

struct ApprovalCardView: View {
    let approval: Approval
    let call: ToolCall?
    let bot: Bot
    let answer: (String) -> Void

    @State private var selection: String?
    @State private var answered = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var phrase: ActionPhrase { ActionPhrase(approval: approval, call: call) }

    private var isSimple: Bool {
        let ids = Set(approval.options.map(\.id))
        return approval.options.isEmpty || (approval.kind == "approval" && ids.isSubset(of: ["approve", "approve_always", "deny"]))
    }

    var body: some View {
        Group {
            if approval.isOpen {
                openCard
                    .transition(.asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.96, anchor: .top)), removal: .opacity))
            } else {
                outcome
                    .transition(.opacity)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: approval.resolution)
        .sensoryFeedback(.impact(weight: .light), trigger: answered)
    }

    private var openCard: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(alignment: .top, spacing: Spacing.m) {
                BotAvatar(bot: bot, mood: .waiting, size: 28)
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(isSimple ? "Posso continuar?" : (approval.title.isEmpty ? "Escolha uma opção" : approval.title))
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.attention)
                    Text(isSimple ? phrase.text : AttributedString(approval.prompt.isEmpty ? approval.title : approval.prompt))
                        .font(BrandFonts.sans(15, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let reason = approval.reason, !reason.isEmpty {
                        Text(reason)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let url = approval.signInURL {
                        Link("Abrir login", destination: url)
                            .font(TypeScale.captionStrong)
                    }
                }
            }
            if isSimple {
                simpleActions
            } else {
                choices
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large + 6, style: .continuous))
    }

    private var simpleActions: some View {
        VStack(spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                Button("Agora não") { send("deny") }
                    .buttonStyle(SoftButtonStyle())
                Button("Permitir") { send("approve") }
                    .buttonStyle(SoftButtonStyle(prominent: true))
            }
            if let always = approval.options.first(where: { $0.id == "approve_always" }) {
                Button(approval.grant == nil ? always.label : "Sempre neste repo") { send("approve_always") }
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(minHeight: 32)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var choices: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            ForEach(Array(approval.options.enumerated()), id: \.element.id) { index, option in
                ChoiceRow(
                    letter: QuestionWizard.letter(index),
                    title: option.label,
                    detail: option.detail,
                    selected: selection == option.id
                ) {
                    selection = option.id
                }
            }
            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                if let skip = approval.options.first(where: { ["deny", "skip", "cancel"].contains($0.id) }) {
                    Button("Pular") { send(skip.id) }
                        .buttonStyle(SoftButtonStyle())
                }
                Button("Concluído") {
                    if let selection { send(selection) }
                }
                .buttonStyle(SoftButtonStyle(prominent: true))
                .disabled(selection == nil)
            }
            .padding(.top, Spacing.xs)
        }
    }

    private var outcome: some View {
        let result = Self.outcome(approval)
        return HStack(spacing: Spacing.s) {
            Image(systemName: result.symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(result.color)
                .frame(width: 18)
            (Text(result.text).foregroundStyle(result.color) + Text(" · ").foregroundStyle(Theme.textTertiary) + Text(phrase.text).foregroundStyle(Theme.textSecondary))
                .font(TypeScale.caption)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, Spacing.xs)
        .frame(minHeight: 28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func send(_ optionID: String) {
        answered += 1
        answer(optionID)
    }

    static func outcome(_ approval: Approval) -> (text: String, color: Color, symbol: String) {
        switch approval.resolution {
        case .open:
            return ("Aguardando", Theme.textTertiary, "clock")
        case .answering(let optionID):
            let summary = approval.summary(for: optionID)
            return (summary.0, Theme.textSecondary, "ellipsis.circle")
        case .settled(let text, let tone):
            switch tone {
            case .approved: return (text.isEmpty ? "Permitido" : text, Theme.success, "checkmark.circle.fill")
            case .denied: return (text.isEmpty ? "Não permitido" : text, Theme.danger, "xmark.circle.fill")
            case .neutral: return (text, Theme.textSecondary, "minus.circle.fill")
            }
        }
    }
}

struct ChoiceRow: View {
    let letter: String
    let title: String
    var detail: String?
    var recommended = false
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Spacing.m) {
                Text(letter)
                    .font(TypeScale.counter)
                    .foregroundStyle(selected ? Theme.onAccent : Theme.textSecondary)
                    .frame(width: 26, height: 26)
                    .background(selected ? Theme.brandAccent : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Spacing.s) {
                        Text(title)
                            .font(BrandFonts.sans(15, weight: .medium))
                            .foregroundStyle(Theme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        if recommended {
                            Text("Sugerido")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.brandText)
                        }
                    }
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(Spacing.s + 2)
            .background(selected ? Theme.selection : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium + 2, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium + 2, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct QuestionCardView: View {
    let store: ConversationStore
    let approval: Approval
    @State private var wizard: QuestionWizard?
    @State private var answered = 0
    @FocusState private var otherFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let wizard = wizard ?? QuestionWizard.shared(store: store, approvalID: approval.id)
        VStack(alignment: .leading, spacing: Spacing.m) {
            if let question = wizard.question {
                header(wizard: wizard, question: question)
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.s) {
                        ForEach(Array(question.choices.enumerated()), id: \.element.id) { index, choice in
                            ChoiceRow(
                                letter: QuestionWizard.letter(index),
                                title: choice.label,
                                detail: choice.detail,
                                recommended: choice.recommended,
                                selected: wizard.isSelected(choice.id, in: question)
                            ) {
                                wizard.toggle(choice.id, in: question)
                                otherFocused = wizard.isSelected(QuestionWizard.otherID, in: question)
                            }
                        }
                        other(wizard: wizard, question: question, index: question.choices.count)
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 320)
                .fixedSize(horizontal: false, vertical: true)
                actions(wizard: wizard, question: question)
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large + 8, style: .continuous))
        .animation(Motion.animation(reduceMotion: reduceMotion), value: wizard.index)
        .sensoryFeedback(.impact(weight: .light), trigger: answered)
        .onAppear {
            if self.wizard == nil {
                self.wizard = QuestionWizard.shared(store: store, approvalID: approval.id)
            }
        }
    }

    private func header(wizard: QuestionWizard, question: QuestionPrompt) -> some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            BotAvatar(bot: store.bot, mood: .waiting, size: 28)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: Spacing.s) {
                    Text(question.header ?? "\(store.bot.name) pergunta")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.attention)
                    if wizard.questions.count > 1 {
                        Text("\(wizard.index + 1) de \(wizard.questions.count)")
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                Text(question.title)
                    .font(BrandFonts.sans(16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .id(question.id)
                if question.multiSelect {
                    Text("Pode marcar mais de uma.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
        }
    }

    @ViewBuilder
    private func other(wizard: QuestionWizard, question: QuestionPrompt, index: Int) -> some View {
        let selected = wizard.isSelected(QuestionWizard.otherID, in: question)
        ChoiceRow(letter: QuestionWizard.letter(index), title: "Outra resposta", selected: selected) {
            wizard.toggle(QuestionWizard.otherID, in: question)
            otherFocused = wizard.isSelected(QuestionWizard.otherID, in: question)
        }
        if selected {
            TextField("Escreva sua resposta", text: wizard.otherText(for: question), axis: .vertical)
                .font(BrandFonts.sans(15))
                .lineLimit(1...4)
                .focused($otherFocused)
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.s + 2)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium + 2, style: .continuous))
                .transition(.opacity)
        }
    }

    private func actions(wizard: QuestionWizard, question: QuestionPrompt) -> some View {
        HStack(spacing: Spacing.s) {
            if wizard.index > 0 {
                Button {
                    wizard.go(to: wizard.index - 1, reduceMotion: reduceMotion)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(SoftButtonStyle())
                .accessibilityLabel("Pergunta anterior")
            }
            Spacer(minLength: 0)
            Button("Pular") {
                answered += 1
                wizard.skip(question, reduceMotion: reduceMotion)
            }
            .buttonStyle(SoftButtonStyle())
            Button(wizard.isLast ? "Enviar" : "Próxima") {
                answered += 1
                otherFocused = false
                wizard.advance(question, reduceMotion: reduceMotion)
            }
            .buttonStyle(SoftButtonStyle(prominent: true))
            .disabled(wizard.draft(for: question).isEmpty)
        }
    }
}

struct QuestionOutcomeLine: View {
    let approval: Approval

    var body: some View {
        let text: String = switch approval.resolution {
        case .open: "Pergunta aberta"
        case .answering(let summary): summary
        case .settled(let summary, _): summary
        }
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Image(systemName: approval.isOpen ? "questionmark.circle" : "checkmark.circle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(approval.isOpen ? Theme.attention : Theme.success)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(approval.questions.first?.title ?? approval.title)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                Text(text)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, Spacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
