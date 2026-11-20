import AppKit
import SwiftUI

enum ComposerCommand {
    case submit
    case moveUp
    case moveDown
    case tab
    case escape
    case deleteOnEmpty
}

final class ComposerNSTextView: NSTextView {
    var onFocusChange: ((Bool) -> Void)?

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
    @Binding var text: String
    @Binding var height: CGFloat
    let focusRequest: Int
    let placeholder: String
    var onFocusChange: (Bool) -> Void
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
        textView.isRichText = false
        textView.importsGraphics = false
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
        textView.string = text
        textView.delegate = coordinator
        textView.onFocusChange = { [weak coordinator] focused in
            coordinator?.parent.onFocusChange(focused)
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

        coordinator.textView = textView
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
        if textView.string != text, !textView.hasMarkedText() {
            textView.string = text
            let end = NSRange(location: (text as NSString).length, length: 0)
            textView.setSelectedRange(end)
            coordinator.measure()
            textView.scrollRangeToVisible(end)
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
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: ComposerNSTextView?
        weak var scrollView: ComposerScrollView?
        var focusRequest = 0
        private var lastReported: CGFloat = 0
        private var windowHeight: CGFloat = 0
        private var windowObserver: NSObjectProtocol?

        init(parent: ComposerTextView) {
            self.parent = parent
        }

        func focus() {
            guard let textView, let window = textView.window, window.firstResponder !== textView else { return }
            window.makeFirstResponder(textView)
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
            guard let textView else { return }
            parent.text = textView.string
            measure()
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
            case #selector(NSResponder.deleteBackward(_:)):
                guard textView.string.isEmpty else { return false }
                return parent.onCommand(.deleteOnEmpty)
            default:
                return false
            }
        }
    }
}
