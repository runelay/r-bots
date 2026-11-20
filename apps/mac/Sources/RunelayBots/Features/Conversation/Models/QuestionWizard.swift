import SwiftUI

@MainActor
@Observable
final class QuestionWizard {
    static let otherID = "other"

    private static var registry: [String: QuestionWizard] = [:]

    static func shared(store: ConversationStore, approvalID: String) -> QuestionWizard {
        if let existing = registry[approvalID], existing.store === store {
            return existing
        }
        let wizard = QuestionWizard(store: store, approvalID: approvalID)
        registry[approvalID] = wizard
        return wizard
    }

    let store: ConversationStore
    let approvalID: String
    private(set) var index: Int
    private(set) var forward = true
    private(set) var drafts: [String: QuestionAnswerDraft] = [:]
    var highlight = 0
    private(set) var editingOther: Bool

    init(store: ConversationStore, approvalID: String, index: Int = 0, revealOther: Bool = false) {
        self.store = store
        self.approvalID = approvalID
        self.index = index
        editingOther = revealOther
        if revealOther, let question = store.approvals[approvalID]?.questions[safe: index] {
            drafts[question.id] = QuestionAnswerDraft(questionID: question.id, optionIDs: [Self.otherID])
        }
    }

    var questions: [QuestionPrompt] { store.approvals[approvalID]?.questions ?? [] }

    var question: QuestionPrompt? { questions[safe: index] }

    var isLast: Bool { index >= questions.count - 1 }

    func draft(for question: QuestionPrompt) -> QuestionAnswerDraft {
        drafts[question.id] ?? QuestionAnswerDraft(questionID: question.id)
    }

    func isSelected(_ optionID: String, in question: QuestionPrompt) -> Bool {
        draft(for: question).optionIDs.contains(optionID)
    }

    func otherText(for question: QuestionPrompt) -> Binding<String> {
        Binding(
            get: { self.drafts[question.id]?.text ?? "" },
            set: { value in
                var current = self.draft(for: question)
                current.text = value
                self.drafts[question.id] = current
            }
        )
    }

    func toggle(_ optionID: String, in question: QuestionPrompt) {
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
    }

    func select(row: Int, in question: QuestionPrompt) {
        let rows = question.choices.count + 1
        guard row >= 0, row < rows else { return }
        highlight = row
        toggle(row < question.choices.count ? question.choices[row].id : Self.otherID, in: question)
    }

    func move(to row: Int, in question: QuestionPrompt) {
        highlight = row
        guard !question.multiSelect, row < question.choices.count else { return }
        let optionID = question.choices[row].id
        if !isSelected(optionID, in: question) {
            toggle(optionID, in: question)
        }
    }

    func handle(_ press: KeyPress, question: QuestionPrompt, reduceMotion: Bool) -> KeyPress.Result {
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
            advance(question, reduceMotion: reduceMotion)
            return .handled
        case .escape:
            skip(question, reduceMotion: reduceMotion)
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

    func skip(_ question: QuestionPrompt, reduceMotion: Bool) {
        drafts[question.id] = QuestionAnswerDraft(questionID: question.id, skipped: true)
        next(reduceMotion: reduceMotion)
    }

    func advance(_ question: QuestionPrompt, reduceMotion: Bool) {
        guard !draft(for: question).isEmpty else { return }
        next(reduceMotion: reduceMotion)
    }

    func go(to target: Int, reduceMotion: Bool) {
        guard target != index, questions.indices.contains(target) else { return }
        forward = target > index
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            index = target
            let question = questions[target]
            highlight = question.choices.firstIndex { isSelected($0.id, in: question) } ?? 0
            editingOther = isSelected(Self.otherID, in: question)
        }
    }

    private func next(reduceMotion: Bool) {
        if isLast {
            let answers = questions.map { drafts[$0.id] ?? QuestionAnswerDraft(questionID: $0.id, skipped: true) }
            Self.registry[approvalID] = nil
            store.answerQuestion(id: approvalID, answers: answers)
            return
        }
        go(to: index + 1, reduceMotion: reduceMotion)
    }

    static func letter(_ index: Int) -> String {
        let letters = Array("ABCDEFGHI")
        return index < letters.count ? String(letters[index]) : "\(index + 1)"
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
