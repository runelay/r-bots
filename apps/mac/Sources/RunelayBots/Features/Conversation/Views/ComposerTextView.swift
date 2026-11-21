import AppKit
import SwiftUI

enum ComposerCommand {
    case submit
    case moveUp
    case moveDown
    case tab
    case escape
}

@MainActor
protocol ComposerEditor: AnyObject {
    func insert(_ tokens: [ComposerToken], replacing range: NSRange?)
}

struct ComposerClip: Codable {
    static let type = NSPasteboard.PasteboardType("app.runelay.bots.composer-clip")
    let text: String
    let tokens: [ComposerToken]
}

final class ComposerNSTextView: NSTextView {
    var onFocusChange: ((Bool) -> Void)?
    var copySelection: ((NSRange) -> (plain: String, clip: Data?))?
    var pasteClip: ((Data) -> Bool)?
    var pasteAttachments: ((NSPasteboard) -> Bool)?

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted {
            onFocusChange?(true)
        }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted {
            onFocusChange?(false)
        }
        return accepted
    }

    override func updateDragTypeRegistration() {
        unregisterDraggedTypes()
    }

    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] {
        [ComposerClip.type, .string]
    }

    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        guard let copySelection else { return super.writeSelection(to: pboard, types: types) }
        let range = selectedRange()
        guard range.length > 0 else { return false }
        let content = copySelection(range)
        pboard.declareTypes(content.clip == nil ? [.string] : [ComposerClip.type, .string], owner: nil)
        pboard.setString(content.plain, forType: .string)
        if let clip = content.clip {
            pboard.setData(clip, forType: ComposerClip.type)
        }
        return true
    }

    override func paste(_ sender: Any?) {
        if let data = NSPasteboard.general.data(forType: ComposerClip.type), pasteClip?(data) == true {
            return
        }
        if pasteAttachments?(NSPasteboard.general) == true {
            return
        }
        pasteAsPlainText(sender)
    }

    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), pasteAttachments != nil, isEditable {
            let pasteboard = NSPasteboard.general
            if AttachmentPasteboard.hasImage(pasteboard) || !AttachmentPasteboard.fileURLs(from: pasteboard).isEmpty {
                return true
            }
        }
        return super.validateUserInterfaceItem(item)
    }

    override func pasteAsRichText(_ sender: Any?) {
        paste(sender)
    }
}

final class ComposerScrollView: NSScrollView {
    var onWidthChange: (() -> Void)?
    var onHeightChange: (() -> Void)?
    var onWindowChange: ((NSWindow?) -> Void)?

    override func setFrameSize(_ newSize: NSSize) {
        let old = frame.size
        super.setFrameSize(newSize)
        if old.width != newSize.width {
            onWidthChange?()
        }
        if old.height != newSize.height {
            onHeightChange?()
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChange?(window)
    }
}

struct ComposerTextView: NSViewRepresentable {
    let store: ConversationStore
    let draft: String
    let tokens: [ComposerToken]
    let uploadStates: [AttachmentUploadState]
    @Binding var height: CGFloat
    let focusRequest: Int
    let placeholder: String
    var onFocusChange: (Bool) -> Void
    var onPasteAttachments: (NSPasteboard) -> Bool
    var onCommand: (ComposerCommand) -> Bool

    static let verticalInset = Spacing.s
    static let maxWindowFraction: CGFloat = 0.4

    static var font: NSFont {
        _ = BrandFonts.availableFamilies
        return NSFontManager.shared.font(withFamily: BrandFonts.sansFamily, traits: [], weight: 5, size: 15)
            ?? NSFont.systemFont(ofSize: 15)
    }

    static var minimumHeight: CGFloat {
        let layout = NSLayoutManager()
        return ceil(layout.defaultLineHeight(for: font)) + verticalInset * 2
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> ComposerScrollView {
        let coordinator = context.coordinator
        let textView = ComposerNSTextView(usingTextLayoutManager: false)
        textView.isRichText = true
        textView.importsGraphics = false
        textView.usesFontPanel = false
        textView.usesRuler = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.smartInsertDeleteEnabled = false
        textView.drawsBackground = false
        textView.font = Self.font
        textView.textColor = NSColor(Theme.textPrimary)
        textView.typingAttributes = [.font: Self.font, .foregroundColor: NSColor(Theme.textPrimary)]
        textView.insertionPointColor = NSColor(Theme.brandAccent)
        textView.textContainerInset = NSSize(width: 0, height: Self.verticalInset)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width]
        textView.setAccessibilityPlaceholderValue(placeholder)
        coordinator.textView = textView
        coordinator.attach(store)
        coordinator.uploadStates = uploadStates
        textView.textStorage?.setAttributedString(coordinator.attributed(text: draft, tokens: tokens))
        textView.typingAttributes = Coordinator.baseAttributes
        textView.delegate = coordinator
        textView.onFocusChange = { [weak coordinator] focused in
            coordinator?.parent.onFocusChange(focused)
        }
        textView.copySelection = { [weak coordinator] range in
            coordinator?.copy(range) ?? ("", nil)
        }
        textView.pasteClip = { [weak coordinator] data in
            coordinator?.paste(data) ?? false
        }
        textView.pasteAttachments = { [weak coordinator] pasteboard in
            coordinator?.parent.onPasteAttachments(pasteboard) ?? false
        }

        let scrollView = ComposerScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.verticalScrollElasticity = .automatic
        scrollView.horizontalScrollElasticity = .none
        scrollView.documentView = textView
        scrollView.onWidthChange = { [weak coordinator] in
            coordinator?.measure()
        }
        scrollView.onHeightChange = { [weak coordinator] in
            coordinator?.keepCaretVisible()
        }
        scrollView.onWindowChange = { [weak coordinator] window in
            coordinator?.observe(window)
        }

        coordinator.scrollView = scrollView
        coordinator.focusRequest = focusRequest
        DispatchQueue.main.async { [weak coordinator] in
            coordinator?.focus()
            coordinator?.measure()
        }
        return scrollView
    }

    func updateNSView(_ scrollView: ComposerScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let textView = coordinator.textView else { return }
        coordinator.attach(store)
        if !textView.hasMarkedText() {
            let current = coordinator.serialize()
            if current.text != draft || current.tokens != tokens {
                coordinator.rebuild(text: draft, tokens: tokens)
            }
        }
        if coordinator.uploadStates != uploadStates {
            coordinator.uploadStates = uploadStates
            coordinator.refreshTokens()
        }
        if textView.accessibilityPlaceholderValue() != placeholder {
            textView.setAccessibilityPlaceholderValue(placeholder)
        }
        if coordinator.focusRequest != focusRequest {
            coordinator.focusRequest = focusRequest
            DispatchQueue.main.async { [weak coordinator] in
                coordinator?.focus()
            }
        }
    }

    static func dismantleNSView(_ nsView: ComposerScrollView, coordinator: Coordinator) {
        coordinator.observe(nil)
        coordinator.attach(nil)
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate, ComposerEditor {
        var parent: ComposerTextView
        weak var textView: ComposerNSTextView?
        weak var scrollView: ComposerScrollView?
        weak var store: ConversationStore?
        var focusRequest = 0
        var uploadStates: [AttachmentUploadState] = []
        private var lastReported: CGFloat = 0
        private var windowHeight: CGFloat = 0
        private var windowObserver: NSObjectProtocol?

        init(parent: ComposerTextView) {
            self.parent = parent
        }

        static var baseAttributes: [NSAttributedString.Key: Any] {
            [.font: ComposerTextView.font, .foregroundColor: NSColor(Theme.textPrimary)]
        }

        func focus() {
            guard let textView, let window = textView.window, window.firstResponder !== textView else { return }
            window.makeFirstResponder(textView)
        }

        func attach(_ next: ConversationStore?) {
            guard store !== next else { return }
            if let store, store.composerEditor === self {
                store.composerEditor = nil
            }
            store = next
            next?.composerEditor = self
        }

        func tokenString(_ token: ComposerToken) -> NSAttributedString? {
            guard let store else { return nil }
            let file: ComposerAttachment?
            let tip: String
            switch token {
            case .file(let id):
                guard let found = store.attachment(id) else { return nil }
                file = found
                tip = "\(found.name) · \(found.sizeLabel)"
            case .skill(let skill):
                file = nil
                tip = skill.description.isEmpty ? skill.name : "\(skill.name): \(skill.description)"
            }
            let cell = ComposerTokenCell(token: token, file: file, font: ComposerTextView.font) { [weak store] attachment in
                store?.retryUpload(attachment)
            }
            let result = NSMutableAttributedString(attachment: ComposerTokenAttachment(token: token, cell: cell))
            let range = NSRange(location: 0, length: result.length)
            result.addAttributes(Self.baseAttributes, range: range)
            result.addAttribute(.toolTip, value: tip, range: range)
            return result
        }

        func attributed(text: String, tokens: [ComposerToken]) -> NSAttributedString {
            let result = NSMutableAttributedString()
            var pending = ""
            var queue = tokens.makeIterator()
            func flush() {
                guard !pending.isEmpty else { return }
                result.append(NSAttributedString(string: pending, attributes: Self.baseAttributes))
                pending = ""
            }
            for scalar in text.unicodeScalars {
                guard scalar == ComposerToken.glyph else {
                    pending.unicodeScalars.append(scalar)
                    continue
                }
                flush()
                if let token = queue.next(), let piece = tokenString(token) {
                    result.append(piece)
                }
            }
            flush()
            return result
        }

        func serialize(_ range: NSRange? = nil) -> (text: String, tokens: [ComposerToken]) {
            guard let storage = textView?.textStorage else { return ("", []) }
            let target = range ?? NSRange(location: 0, length: storage.length)
            let source = storage.string as NSString
            var text = ""
            var tokens: [ComposerToken] = []
            storage.enumerateAttribute(.attachment, in: target) { value, run, _ in
                if let attachment = value as? ComposerTokenAttachment {
                    for _ in 0..<run.length {
                        text += ComposerToken.glyphString
                        tokens.append(attachment.token)
                    }
                } else {
                    text += ComposerToken.stripped(source.substring(with: run))
                }
            }
            return (text, tokens)
        }

        func rebuild(text: String, tokens: [ComposerToken]) {
            guard let textView, let storage = textView.textStorage else { return }
            storage.setAttributedString(attributed(text: text, tokens: tokens))
            textView.typingAttributes = Self.baseAttributes
            let end = NSRange(location: storage.length, length: 0)
            textView.setSelectedRange(end)
            measure()
            textView.scrollRangeToVisible(end)
            let settled = serialize()
            if settled.text != text || settled.tokens != tokens {
                DispatchQueue.main.async { [weak self] in
                    self?.store?.updateDraft(settled.text, tokens: settled.tokens)
                }
            }
        }

        func refreshTokens() {
            guard let textView, let layoutManager = textView.layoutManager, let storage = textView.textStorage else { return }
            let range = NSRange(location: 0, length: storage.length)
            layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
            layoutManager.invalidateDisplay(forCharacterRange: range)
            measure()
        }

        func insert(_ tokens: [ComposerToken], replacing range: NSRange?) {
            guard let textView, let storage = textView.textStorage else { return }
            let length = storage.length
            let requested = range ?? textView.selectedRange()
            let location = min(max(0, requested.location), length)
            let target = NSRange(location: location, length: min(max(0, requested.length), length - location))
            let piece = NSMutableAttributedString()
            for token in tokens {
                if let string = tokenString(token) {
                    piece.append(string)
                }
            }
            if piece.length > 0 {
                let source = storage.string as NSString
                if target.location > 0, !Self.isWhitespace(source.character(at: target.location - 1)) {
                    piece.insert(NSAttributedString(string: " ", attributes: Self.baseAttributes), at: 0)
                }
                let end = target.location + target.length
                if end >= length || !Self.isWhitespace(source.character(at: end)) {
                    piece.append(NSAttributedString(string: " ", attributes: Self.baseAttributes))
                }
            }
            replace(target, with: piece)
            focus()
        }

        func copy(_ range: NSRange) -> (plain: String, clip: Data?) {
            let part = serialize(range)
            let plain = store?.markedText(part.text, tokens: part.tokens) ?? ComposerToken.stripped(part.text)
            guard !part.tokens.isEmpty else { return (plain, nil) }
            return (plain, try? JSONEncoder().encode(ComposerClip(text: part.text, tokens: part.tokens)))
        }

        func paste(_ data: Data) -> Bool {
            guard let textView, let clip = try? JSONDecoder().decode(ComposerClip.self, from: data) else { return false }
            replace(textView.selectedRange(), with: attributed(text: clip.text, tokens: clip.tokens))
            return true
        }

        private func replace(_ range: NSRange, with piece: NSAttributedString) {
            guard let textView, let storage = textView.textStorage else { return }
            textView.breakUndoCoalescing()
            guard textView.shouldChangeText(in: range, replacementString: piece.string) else { return }
            storage.replaceCharacters(in: range, with: piece)
            textView.didChangeText()
            textView.breakUndoCoalescing()
            let caret = NSRange(location: range.location + piece.length, length: 0)
            textView.setSelectedRange(caret)
            textView.typingAttributes = Self.baseAttributes
            textView.scrollRangeToVisible(caret)
        }

        private static func isWhitespace(_ unit: unichar) -> Bool {
            guard let scalar = Unicode.Scalar(unit) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }

        func observe(_ window: NSWindow?) {
            if let windowObserver {
                NotificationCenter.default.removeObserver(windowObserver)
            }
            windowObserver = nil
            guard let window else { return }
            windowHeight = window.contentLayoutRect.height
            windowObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let window = self.textView?.window else { return }
                    let height = window.contentLayoutRect.height
                    guard height != self.windowHeight else { return }
                    self.windowHeight = height
                    self.measure()
                }
            }
            measure()
        }

        func measure() {
            guard let textView, let layoutManager = textView.layoutManager, let container = textView.textContainer else { return }
            layoutManager.ensureLayout(for: container)
            let used = ceil(layoutManager.usedRect(for: container).height) + ComposerTextView.verticalInset * 2
            let minimum = ComposerTextView.minimumHeight
            let cap = max(minimum, floor(windowHeight * ComposerTextView.maxWindowFraction))
            let target = min(max(used, minimum), cap)
            guard target != lastReported else { return }
            lastReported = target
            DispatchQueue.main.async { [weak self] in
                guard let self, self.parent.height != target else { return }
                self.parent.height = target
            }
        }

        func keepCaretVisible() {
            guard let textView, textView.window?.firstResponder === textView else { return }
            textView.scrollRangeToVisible(textView.selectedRange())
        }

        func textDidChange(_ notification: Notification) {
            let current = serialize()
            store?.updateDraft(current.text, tokens: current.tokens)
            measure()
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView, !textView.hasMarkedText() else { return }
            textView.typingAttributes = Self.baseAttributes
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if textView.hasMarkedText() {
                return false
            }
            switch commandSelector {
            case #selector(NSResponder.insertNewline(_:)):
                let modifiers = NSApp.currentEvent?.modifierFlags ?? []
                if modifiers.contains(.shift) || modifiers.contains(.option) {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                    return true
                }
                _ = parent.onCommand(.submit)
                return true
            case #selector(NSResponder.moveUp(_:)):
                return parent.onCommand(.moveUp)
            case #selector(NSResponder.moveDown(_:)):
                return parent.onCommand(.moveDown)
            case #selector(NSResponder.insertTab(_:)):
                if parent.onCommand(.tab) {
                    return true
                }
                textView.window?.selectNextKeyView(nil)
                return true
            case #selector(NSResponder.cancelOperation(_:)), #selector(NSResponder.complete(_:)):
                if parent.onCommand(.escape) {
                    return true
                }
                textView.nextResponder?.tryToPerform(#selector(NSResponder.cancelOperation(_:)), with: nil)
                return true
            default:
                return false
            }
        }
    }
}
