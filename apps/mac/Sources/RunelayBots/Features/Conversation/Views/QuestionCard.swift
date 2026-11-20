import AppKit
import SwiftUI

struct QuestionCard: View {
    let store: ConversationStore
    let approval: Approval
    var via: Bot? = nil

    var body: some View {
        QuestionWizardView(wizard: QuestionWizard.shared(store: store, approvalID: approval.id), style: .card, via: via)
            .padding(Spacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSurface(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

enum QuestionWizardStyle {
    case card
    case island
}

struct QuestionWizardView: View {
    let wizard: QuestionWizard
    let style: QuestionWizardStyle
    var via: Bot? = nil
    var bodyLimits: [CGFloat]? = nil

    @Environment(\.appReduceMotion) private var reduceMotion
    @FocusState private var cardFocused: Bool
    @FocusState private var otherFocused: Bool

    private var isIsland: Bool { style == .island }

    var body: some View {
        if let question = wizard.question {
            VStack(alignment: .leading, spacing: isIsland ? Spacing.s : Spacing.m) {
                header(question)
                ZStack(alignment: .topLeading) {
                    container(question)
                        .id(question.id)
                        .transition(slide)
                }
                .clipped()
                footer(question)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .focusable()
            .focusEffectDisabled()
            .focused($cardFocused)
            .onKeyPress(phases: .down) { press in
                if otherFocused { return .ignored }
                let result = wizard.handle(press, question: question, reduceMotion: reduceMotion)
                syncFocus()
                return result
            }
            .onAppear { cardFocused = true }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
                if isIsland, !otherFocused { cardFocused = true }
            }
            .springAnimation(value: wizard.index)
            .springAnimation(value: wizard.drafts)
            .springAnimation(value: wizard.highlight)
            .springAnimation(value: wizard.editingOther)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Pergunta do bot: \(question.title)")
        }
    }

    private var slide: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .move(edge: wizard.forward ? .trailing : .leading).combined(with: .opacity),
            removal: .move(edge: wizard.forward ? .leading : .trailing).combined(with: .opacity)
        )
    }

    private func header(_ question: QuestionPrompt) -> some View {
        let questions = wizard.questions
        return HStack(spacing: Spacing.s) {
            if let via {
                ViaAgentTag(bot: via)
            }
            Image(systemName: "questionmark.bubble.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.brandAccent)
            Text(question.header ?? (questions.count > 1 ? "Pergunta \(wizard.index + 1) de \(questions.count)" : "Pergunta"))
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
            Spacer(minLength: Spacing.s)
            if questions.count > 1 {
                PageDots(count: questions.count, current: wizard.index) { target in
                    otherFocused = false
                    wizard.go(to: target, reduceMotion: reduceMotion)
                    cardFocused = true
                }
            }
        }
    }

    @ViewBuilder
    private func container(_ question: QuestionPrompt) -> some View {
        if let limit = bodyLimits?[safe: wizard.index] {
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    page(question)
                }
                .frame(height: limit)
                .onChange(of: wizard.highlight) { _, row in
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        proxy.scrollTo(row)
                    }
                }
            }
        } else {
            page(question)
        }
    }

    private func page(_ question: QuestionPrompt) -> some View {
        VStack(alignment: .leading, spacing: isIsland ? Spacing.s : Spacing.m) {
            Text(question.title)
                .font(isIsland ? TypeScale.rowTitle : BrandFonts.sans(15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: isIsland ? Spacing.xs : Spacing.xxs) {
                ForEach(Array(question.choices.enumerated()), id: \.element.id) { offset, choice in
                    QuestionChoiceRow(
                        style: style,
                        letter: QuestionWizard.letter(offset),
                        label: choice.label,
                        detail: choice.detail,
                        recommended: choice.recommended,
                        multiSelect: question.multiSelect,
                        isSelected: wizard.isSelected(choice.id, in: question),
                        isHighlighted: wizard.highlight == offset && cardFocused
                    ) {
                        wizard.highlight = offset
                        wizard.toggle(choice.id, in: question)
                        syncFocus()
                    }
                    .id(offset)
                }
                otherRow(question)
            }
        }
    }

    private func otherRow(_ question: QuestionPrompt) -> some View {
        let offset = question.choices.count
        let selected = wizard.isSelected(QuestionWizard.otherID, in: question)
        return VStack(alignment: .leading, spacing: Spacing.xs) {
            QuestionChoiceRow(
                style: style,
                letter: QuestionWizard.letter(offset),
                label: "Outra coisa",
                detail: selected ? nil : "Escreva com suas palavras",
                recommended: false,
                multiSelect: question.multiSelect,
                isSelected: selected,
                isHighlighted: wizard.highlight == offset && cardFocused
            ) {
                wizard.highlight = offset
                wizard.toggle(QuestionWizard.otherID, in: question)
                syncFocus()
            }
            if selected {
                TextField("Sua resposta", text: wizard.otherText(for: question), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1...4)
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, Spacing.s)
                    .background(isIsland ? Theme.selection : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                    .padding(.leading, isIsland ? 0 : 24 + Spacing.m)
                    .focused($otherFocused)
                    .onSubmit { wizard.advance(question, reduceMotion: reduceMotion) }
                    .onExitCommand {
                        otherFocused = false
                        cardFocused = true
                    }
                    .onAppear { otherFocused = true }
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .id(offset)
    }

    private func footer(_ question: QuestionPrompt) -> some View {
        let keys = min(question.choices.count + 1, 9)
        return HStack(spacing: Spacing.s) {
            ViewThatFits(in: .horizontal) {
                hint(question.multiSelect ? "Escolha uma ou mais" : "↑↓ ou 1–\(keys) para escolher, ⏎ para seguir")
                hint(question.multiSelect ? "Uma ou mais" : "1–\(keys) escolhe · ⏎ segue")
                Color.clear.frame(width: 0, height: 0)
            }
            Spacer(minLength: Spacing.s)
            Button("Pular") { wizard.skip(question, reduceMotion: reduceMotion) }
                .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                .help("Pular esta pergunta (Esc)")
            Button(wizard.isLast ? "Enviar" : "Avançar") { wizard.advance(question, reduceMotion: reduceMotion) }
                .buttonStyle(SmallPillButtonStyle(kind: .primary))
                .disabled(wizard.draft(for: question).isEmpty)
                .help(wizard.isLast ? "Enviar respostas (⏎)" : "Próxima pergunta (⏎)")
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(TypeScale.caption)
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(1)
            .fixedSize()
    }

    private func syncFocus() {
        if !wizard.editingOther {
            otherFocused = false
            cardFocused = true
        }
    }
}

private struct QuestionChoiceRow: View {
    let style: QuestionWizardStyle
    let letter: String
    let label: String
    let detail: String?
    let recommended: Bool
    let multiSelect: Bool
    let isSelected: Bool
    let isHighlighted: Bool
    let select: () -> Void

    @State private var isHovering = false

    private var isIsland: Bool { style == .island }

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: isIsland ? Spacing.s : Spacing.m) {
                Text(letter)
                    .font(TypeScale.counter)
                    .foregroundStyle(isSelected ? Theme.onAccent : Theme.textSecondary)
                    .frame(width: isIsland ? 20 : 24, height: isIsland ? 20 : 24)
                    .background(
                        isSelected ? Theme.brandAccent : (isIsland ? Theme.selection : Theme.surfaceRaised),
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Spacing.s) {
                        Text(label)
                            .font(isIsland ? TypeScale.rowSubtitle : TypeScale.rowTitle)
                            .foregroundStyle(isSelected ? Theme.brandText : Theme.textPrimary)
                            .lineLimit(2)
                        if recommended {
                            Text("Recomendado")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(isIsland ? Theme.selection : Theme.surfaceRaised, in: Capsule())
                        }
                    }
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(isIsland ? 2 : nil)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.top, isIsland ? 1 : 2)
                Spacer(minLength: 0)
                if multiSelect, isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Theme.brandAccent)
                        .padding(.top, isIsland ? 3 : 5)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(Spacing.s)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .background(AlwaysHover { hovering in
            isHovering = hovering
        })
        .springAnimation(value: isHovering)
        .springAnimation(value: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityLabel("\(letter), \(label)\(recommended ? ", recomendado" : "")")
    }

    private var background: Color {
        if isIsland {
            if isSelected { return Theme.brandAccent.opacity(0.22) }
            if isHovering || isHighlighted { return Theme.selection }
            return Theme.hover
        }
        if isSelected { return Theme.brandAccent.opacity(0.12) }
        if isHovering || isHighlighted { return Theme.hover }
        return Color.clear
    }
}

private struct PageDots: View {
    let count: Int
    let current: Int
    let go: (Int) -> Void

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<count, id: \.self) { item in
                Button { go(item) } label: {
                    Capsule()
                        .fill(item == current ? Theme.brandAccent : Theme.textTertiary.opacity(0.45))
                        .frame(width: item == current ? 16 : 6, height: 6)
                        .contentShape(Rectangle().inset(by: -4))
                }
                .buttonStyle(.plain)
                .clickable()
                .accessibilityLabel("Pergunta \(item + 1)")
            }
        }
        .springAnimation(value: current)
    }
}

struct QuestionLine: View {
    let approval: Approval

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
            Text(text)
                .font(TypeScale.captionStrong)
                .foregroundStyle(approval.isOpen ? Theme.textPrimary : Theme.textSecondary)
                .lineLimit(2)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.vertical, Spacing.xxs)
        .springAnimation(value: approval.resolution)
        .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -4)))
    }

    private var text: String {
        switch approval.resolution {
        case .open:
            let first = approval.questions.first?.title ?? approval.prompt
            return approval.questions.count > 1 ? "\(first) (+\(approval.questions.count - 1)) · responda abaixo" : "\(first) · responda abaixo"
        case .answering(let summary):
            return summary
        case .settled(let summary, _):
            return summary
        }
    }

    private var symbol: String {
        switch approval.resolution {
        case .open: "questionmark.bubble"
        case .answering: "ellipsis.bubble"
        case .settled(_, let tone): tone == .approved ? "checkmark.bubble" : "minus.circle"
        }
    }

    private var color: Color {
        switch approval.resolution {
        case .open, .answering: Theme.brandAccent
        case .settled(_, let tone): tone == .approved ? Theme.success : Theme.textSecondary
        }
    }
}
