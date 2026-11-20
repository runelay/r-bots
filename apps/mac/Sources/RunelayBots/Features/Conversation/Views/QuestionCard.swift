import SwiftUI

struct QuestionCard: View {
    let approval: Approval
    var via: Bot? = nil
    let submit: ([QuestionAnswerDraft]) -> Void

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var index = 0
    @State private var forward = true
    @State private var drafts: [String: QuestionAnswerDraft] = [:]
    @State private var highlight = 0
    @State private var editingOther = false
    @FocusState private var cardFocused: Bool
    @FocusState private var otherFocused: Bool

    private static let otherID = "other"

    private var questions: [QuestionPrompt] { approval.questions }

    private var question: QuestionPrompt? {
        questions.indices.contains(index) ? questions[index] : nil
    }

    private var isLast: Bool { index >= questions.count - 1 }

    private func draft(for question: QuestionPrompt) -> QuestionAnswerDraft {
        drafts[question.id] ?? QuestionAnswerDraft(questionID: question.id)
    }

    var body: some View {
        if let question {
            VStack(alignment: .leading, spacing: Spacing.m) {
                header(question)
                ZStack(alignment: .topLeading) {
                    page(question)
                        .id(question.id)
                        .transition(slide)
                }
                .clipped()
                footer(question)
            }
            .padding(Spacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSurface(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .focusable()
            .focusEffectDisabled()
            .focused($cardFocused)
            .onKeyPress(phases: .down) { press in handle(press, question: question) }
            .onAppear { cardFocused = true }
            .springAnimation(value: index)
            .springAnimation(value: drafts)
            .springAnimation(value: highlight)
            .springAnimation(value: editingOther)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Pergunta do bot: \(question.title)")
        }
    }

    private var slide: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
            removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity)
        )
    }

    private func header(_ question: QuestionPrompt) -> some View {
        HStack(spacing: Spacing.s) {
            if let via {
                ViaAgentTag(bot: via)
            }
            Image(systemName: "questionmark.bubble.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.brandAccent)
            Text(question.header ?? (questions.count > 1 ? "Pergunta \(index + 1) de \(questions.count)" : "Pergunta"))
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
            Spacer(minLength: Spacing.s)
            if questions.count > 1 {
                PageDots(count: questions.count, current: index) { target in go(to: target) }
            }
        }
    }

    private func page(_ question: QuestionPrompt) -> some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text(question.title)
                .font(BrandFonts.sans(15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                ForEach(Array(question.choices.enumerated()), id: \.element.id) { offset, choice in
                    QuestionChoiceRow(
                        letter: Self.letter(offset),
                        label: choice.label,
                        detail: choice.detail,
                        recommended: choice.recommended,
                        multiSelect: question.multiSelect,
                        isSelected: draft(for: question).optionIDs.contains(choice.id),
                        isHighlighted: highlight == offset && cardFocused
                    ) {
                        highlight = offset
                        toggle(choice.id, in: question)
                    }
                }
                otherRow(question)
            }
        }
    }

    private func otherRow(_ question: QuestionPrompt) -> some View {
        let offset = question.choices.count
        let selected = draft(for: question).optionIDs.contains(Self.otherID)
        return VStack(alignment: .leading, spacing: Spacing.xs) {
            QuestionChoiceRow(
                letter: Self.letter(offset),
                label: "Outra coisa",
                detail: selected ? nil : "Escreva com suas palavras",
                recommended: false,
                multiSelect: question.multiSelect,
                isSelected: selected,
                isHighlighted: highlight == offset && cardFocused
            ) {
                highlight = offset
                toggle(Self.otherID, in: question)
            }
            if selected {
                TextField("Sua resposta", text: otherText(for: question), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1...4)
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, Spacing.s)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                    .padding(.leading, 24 + Spacing.m)
                    .focused($otherFocused)
                    .onSubmit { advance(question) }
                    .onExitCommand {
                        otherFocused = false
                        cardFocused = true
                    }
                    .onAppear { otherFocused = true }
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
        }
    }

    private func footer(_ question: QuestionPrompt) -> some View {
        HStack(spacing: Spacing.s) {
            Text(question.multiSelect ? "Escolha uma ou mais" : "↑↓ ou 1–\(min(question.choices.count + 1, 9)) para escolher, ⏎ para seguir")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            Spacer(minLength: Spacing.s)
            Button("Pular") { skip(question) }
                .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                .help("Pular esta pergunta (Esc)")
            Button(isLast ? "Enviar" : "Avançar") { advance(question) }
                .buttonStyle(SmallPillButtonStyle(kind: .primary))
                .disabled(draft(for: question).isEmpty)
                .help(isLast ? "Enviar respostas (⏎)" : "Próxima pergunta (⏎)")
        }
    }

    private func otherText(for question: QuestionPrompt) -> Binding<String> {
        Binding(
            get: { drafts[question.id]?.text ?? "" },
            set: { value in
                var current = draft(for: question)
                current.text = value
                drafts[question.id] = current
            }
        )
    }

    private func toggle(_ optionID: String, in question: QuestionPrompt) {
        var current = draft(for: question)
        current.skipped = false
        if current.optionIDs.contains(optionID) {
            current.optionIDs.removeAll { $0 == optionID }
            if optionID == Self.otherID {
                current.text = ""
            }
        } else if question.multiSelect {
            current.optionIDs.append(optionID)
        } else {
            if optionID != Self.otherID {
                current.text = ""
            }
            current.optionIDs = [optionID]
        }
        drafts[question.id] = current
        editingOther = current.optionIDs.contains(Self.otherID)
        if !editingOther {
            otherFocused = false
            cardFocused = true
        }
    }

    private func select(row: Int, in question: QuestionPrompt) {
        let rows = question.choices.count + 1
        guard row >= 0, row < rows else { return }
        highlight = row
        toggle(row < question.choices.count ? question.choices[row].id : Self.otherID, in: question)
    }

    private func handle(_ press: KeyPress, question: QuestionPrompt) -> KeyPress.Result {
        if otherFocused { return .ignored }
        let rows = question.choices.count + 1
        switch press.key {
        case .upArrow:
            move(to: (highlight - 1 + rows) % rows, in: question)
            return .handled
        case .downArrow:
            move(to: (highlight + 1) % rows, in: question)
            return .handled
        case .return:
            if draft(for: question).isEmpty {
                select(row: highlight, in: question)
                if editingOther { return .handled }
            }
            advance(question)
            return .handled
        case .escape:
            skip(question)
            return .handled
        case .space:
            select(row: highlight, in: question)
            return .handled
        default:
            break
        }
        guard press.modifiers.isEmpty || press.modifiers == .shift, let character = press.characters.lowercased().first else {
            return .ignored
        }
        if let digit = character.wholeNumberValue, digit >= 1 {
            select(row: digit - 1, in: question)
            return digit <= rows ? .handled : .ignored
        }
        if let ascii = character.asciiValue, ascii >= 97, ascii < 97 + UInt8(rows) {
            select(row: Int(ascii - 97), in: question)
            return .handled
        }
        return .ignored
    }

    private func move(to row: Int, in question: QuestionPrompt) {
        highlight = row
        guard !question.multiSelect, row < question.choices.count else { return }
        let optionID = question.choices[row].id
        if !draft(for: question).optionIDs.contains(optionID) {
            toggle(optionID, in: question)
        }
    }

    private func skip(_ question: QuestionPrompt) {
        drafts[question.id] = QuestionAnswerDraft(questionID: question.id, skipped: true)
        next()
    }

    private func advance(_ question: QuestionPrompt) {
        guard !draft(for: question).isEmpty else { return }
        next()
    }

    private func next() {
        if isLast {
            submit(questions.map { drafts[$0.id] ?? QuestionAnswerDraft(questionID: $0.id, skipped: true) })
            return
        }
        go(to: index + 1)
    }

    private func go(to target: Int) {
        guard target != index, questions.indices.contains(target) else { return }
        forward = target > index
        otherFocused = false
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            index = target
            let selected = questions[target].choices.firstIndex { drafts[questions[target].id]?.optionIDs.contains($0.id) == true }
            highlight = selected ?? 0
            editingOther = drafts[questions[target].id]?.optionIDs.contains(Self.otherID) == true
        }
        cardFocused = true
    }

    static func letter(_ index: Int) -> String {
        let letters = Array("ABCDEFGHI")
        return index < letters.count ? String(letters[index]) : "\(index + 1)"
    }
}

private struct QuestionChoiceRow: View {
    let letter: String
    let label: String
    let detail: String?
    let recommended: Bool
    let multiSelect: Bool
    let isSelected: Bool
    let isHighlighted: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: Spacing.m) {
                Text(letter)
                    .font(TypeScale.counter)
                    .foregroundStyle(isSelected ? Theme.onAccent : Theme.textSecondary)
                    .frame(width: 24, height: 24)
                    .background(
                        isSelected ? Theme.brandAccent : Theme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Spacing.s) {
                        Text(label)
                            .font(TypeScale.rowTitle)
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
                                .background(Theme.surfaceRaised, in: Capsule())
                        }
                    }
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.top, 2)
                Spacer(minLength: 0)
                if multiSelect, isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Theme.brandAccent)
                        .padding(.top, 5)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(Spacing.s)
            .background(background, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityLabel("\(letter), \(label)\(recommended ? ", recomendado" : "")")
    }

    private var background: Color {
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
