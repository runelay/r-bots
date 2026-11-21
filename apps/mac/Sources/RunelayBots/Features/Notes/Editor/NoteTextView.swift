import AppKit
import SwiftUI

final class NoteFooterHostingView: NSHostingView<NoteBacklinksFooter> {
    var onResize: (() -> Void)?

    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        DispatchQueue.main.async { [weak self] in
            self?.onResize?()
        }
    }
}

final class NoteTextNSView: NSTextView {
    static let readingWidth: CGFloat = 720
    static let minimumInset: CGFloat = 28
    static let verticalInset: CGFloat = 24

    var onToggleTask: ((NSRange, Bool) -> Void)?
    var onOpenLink: ((String) -> Void)?
    private var arranging = false

    var footer: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let footer {
                addSubview(footer)
            }
            arrangeFooter()
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        let inset = max(Self.minimumInset, floor((newSize.width - Self.readingWidth) / 2))
        if textContainerInset.width != inset {
            textContainerInset = NSSize(width: inset, height: Self.verticalInset)
        }
        super.setFrameSize(newSize)
        if !arranging {
            arrangeFooter()
        }
    }

    func arrangeFooter() {
        guard let footer, let layoutManager, let textContainer else { return }
        arranging = true
        defer { arranging = false }
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        let origin = textContainerOrigin
        let top = origin.y + used.maxY + Spacing.xxl + Spacing.s
        let height = ceil(footer.fittingSize.height)
        footer.frame = NSRect(x: origin.x - Spacing.s, y: top, width: textContainer.size.width + Spacing.s * 2, height: height)
        var needed = top + height + Spacing.xxl
        if let clip = enclosingScrollView?.contentView {
            needed = max(needed, clip.bounds.height)
        }
        if abs(frame.height - needed) > 0.5 {
            super.setFrameSize(NSSize(width: frame.width, height: needed))
        }
    }

    override func didChangeText() {
        super.didChangeText()
        arrangeFooter()
    }

    private var quoteBar: NSColor { NSColor(Theme.textTertiary).withAlphaComponent(0.5) }
    private var codeFill: NSColor { NSColor(Theme.surface) }
    private var highlightFill: NSColor { NSColor(Theme.brandAccent).withAlphaComponent(0.1) }

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0 else { return }
        let glyphs = layoutManager.glyphRange(forBoundingRect: rect, in: textContainer)
        let characters = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let origin = textContainerOrigin
        let width = textContainer.size.width + Spacing.m * 2
        func fill(_ key: NSAttributedString.Key, color: NSColor, bar: Bool) {
            storage.enumerateAttribute(key, in: characters) { value, range, _ in
                guard value != nil else { return }
                let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                layoutManager.enumerateLineFragments(forGlyphRange: glyphRange) { lineRect, _, _, _, _ in
                    color.setFill()
                    if bar {
                        NSRect(x: origin.x + 1, y: lineRect.minY + origin.y, width: 2, height: lineRect.height).fill()
                    } else {
                        NSRect(x: origin.x - Spacing.m, y: lineRect.minY + origin.y, width: width, height: lineRect.height).fill()
                    }
                }
            }
        }
        fill(.noteCode, color: codeFill, bar: false)
        fill(.noteHighlight, color: highlightFill, bar: false)
        fill(.noteQuote, color: quoteBar, bar: true)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0 else { return }
        let glyphs = layoutManager.glyphRange(forBoundingRect: dirtyRect, in: textContainer)
        let characters = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        storage.enumerateAttribute(.noteTask, in: characters) { value, range, _ in
            guard let done = value as? Bool else { return }
            let rect = boxRect(for: range)
            let path = NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5))
            if done {
                NSColor(Theme.brandAccent).setFill()
                NSBezierPath(rect: rect).fill()
                let check = NSBezierPath()
                check.move(to: NSPoint(x: rect.minX + rect.width * 0.24, y: rect.midY))
                check.line(to: NSPoint(x: rect.minX + rect.width * 0.43, y: rect.minY + rect.height * 0.72))
                check.line(to: NSPoint(x: rect.minX + rect.width * 0.78, y: rect.minY + rect.height * 0.3))
                check.lineWidth = 1.8
                check.lineCapStyle = .round
                check.lineJoinStyle = .round
                NSColor(Theme.onAccent).setStroke()
                check.stroke()
            } else {
                NSColor(Theme.textTertiary).setStroke()
                path.lineWidth = 1.2
                path.stroke()
            }
        }
    }

    private func boxRect(for range: NSRange) -> NSRect {
        guard let layoutManager, let textContainer else { return .zero }
        let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
        rect.origin.x += textContainerOrigin.x
        rect.origin.y += textContainerOrigin.y
        let side: CGFloat = 14
        return NSRect(x: rect.minX + 1, y: rect.midY - side / 2, width: side, height: side)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let storage = textStorage, let layoutManager, let textContainer, storage.length > 0 {
            let local = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
            var fraction: CGFloat = 0
            let index = layoutManager.characterIndex(for: local, in: textContainer, fractionOfDistanceBetweenInsertionPoints: &fraction)
            for candidate in [index, max(0, index - 1)] where candidate < storage.length {
                var effective = NSRange(location: 0, length: 0)
                if let done = storage.attribute(.noteTask, at: candidate, effectiveRange: &effective) as? Bool, boxRect(for: effective).insetBy(dx: -4, dy: -4).contains(point) {
                    onToggleTask?(effective, done)
                    return
                }
            }
            if index < storage.length, event.clickCount == 1, !event.modifierFlags.contains(.shift),
                let target = storage.attribute(.noteLink, at: index, effectiveRange: nil) as? String
            {
                let glyph = layoutManager.glyphIndexForCharacter(at: index)
                var glyphRect = layoutManager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer)
                glyphRect.origin.x += textContainerOrigin.x
                glyphRect.origin.y += textContainerOrigin.y
                if glyphRect.insetBy(dx: -2, dy: -2).contains(point) {
                    onOpenLink?(target)
                    return
                }
            }
        }
        super.mouseDown(with: event)
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        guard let storage = textStorage, let layoutManager, let textContainer, storage.length > 0 else { return }
        let glyphs = layoutManager.glyphRange(forBoundingRect: visibleRect, in: textContainer)
        let characters = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        for key in [NSAttributedString.Key.noteLink, .noteTask] {
            storage.enumerateAttribute(key, in: characters) { value, range, _ in
                guard value != nil else { return }
                if key == .noteTask {
                    addCursorRect(boxRect(for: range).insetBy(dx: -4, dy: -4), cursor: .pointingHand)
                    return
                }
                let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                layoutManager.enumerateEnclosingRects(forGlyphRange: glyphRange, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: textContainer) { rect, _ in
                    self.addCursorRect(rect.offsetBy(dx: self.textContainerOrigin.x, dy: self.textContainerOrigin.y), cursor: .pointingHand)
                }
            }
        }
    }
}

struct NoteTextView: NSViewRepresentable {
    let store: NoteEditorStore

    func makeCoordinator() -> Coordinator {
        Coordinator(store: store)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = NoteTextNSView(usingTextLayoutManager: false)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.smartInsertDeleteEnabled = false
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: NoteTextNSView.minimumInset, height: NoteTextNSView.verticalInset)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        textView.insertionPointColor = NSColor(Theme.brandAccent)
        textView.linkTextAttributes = [.foregroundColor: NSColor(Theme.brandText), .cursor: NSCursor.pointingHand]
        textView.selectedTextAttributes = [.backgroundColor: NSColor(Theme.brandAccent).withAlphaComponent(0.2)]
        textView.delegate = context.coordinator
        textView.textStorage?.delegate = context.coordinator
        textView.typingAttributes = context.coordinator.styler.baseAttributes
        textView.onToggleTask = { [weak coordinator = context.coordinator] range, done in
            coordinator?.toggleTask(range: range, done: done)
        }
        textView.onOpenLink = { [weak store] title in
            store?.openLink(title)
        }

        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.documentView = textView
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.scrolled), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)

        let footer = NoteFooterHostingView(rootView: NoteBacklinksFooter(store: store))
        footer.sizingOptions = [.intrinsicContentSize]
        footer.onResize = { [weak textView] in
            textView?.arrangeFooter()
        }
        textView.footer = footer

        context.coordinator.textView = textView
        context.coordinator.load(store.text)
        store.insertLink = { [weak coordinator = context.coordinator] title in
            coordinator?.insertLink(title)
        }
        DispatchQueue.main.async {
            textView.window?.makeFirstResponder(textView)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.revision != store.textRevision {
            coordinator.revision = store.textRevision
            coordinator.replace(with: store.text)
        }
        if coordinator.highlightToken != store.highlightToken {
            coordinator.highlightToken = store.highlightToken
            coordinator.flashHighlight(store.highlight)
        }
    }

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) {
        NotificationCenter.default.removeObserver(coordinator)
        coordinator.highlightTask?.cancel()
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate, @preconcurrency NSTextStorageDelegate {
        let store: NoteEditorStore
        let styler = NoteStyler()
        weak var textView: NoteTextNSView?
        var revision = 0
        var highlightToken = 0
        var highlightTask: Task<Void, Never>?
        private var fences: [NSRange] = []
        private var editedRange: NSRange?
        private var caretLine: NSRange?
        private var applying = false

        init(store: NoteEditorStore) {
            self.store = store
            revision = store.textRevision
        }

        func load(_ text: String) {
            guard let textView, let storage = textView.textStorage else { return }
            applying = true
            storage.setAttributedString(NSAttributedString(string: text, attributes: styler.baseAttributes))
            applying = false
            restyleAll()
        }

        func replace(with text: String) {
            guard let textView, let storage = textView.textStorage, storage.string != text else { return }
            let selection = textView.selectedRange()
            applying = true
            storage.beginEditing()
            storage.replaceCharacters(in: NSRange(location: 0, length: storage.length), with: text)
            storage.endEditing()
            applying = false
            let location = min(selection.location, storage.length)
            textView.setSelectedRange(NSRange(location: location, length: min(selection.length, storage.length - location)))
            restyleAll()
        }

        func restyleAll() {
            guard let textView, let storage = textView.textStorage else { return }
            fences = NoteStyler.fenceRanges(in: storage.string as NSString)
            caretLine = currentLine()
            styler.style(storage, in: NSRange(location: 0, length: storage.length), caretLine: caretLine, fences: fences)
            textView.typingAttributes = styler.baseAttributes
            textView.window?.invalidateCursorRects(for: textView)
            textView.needsDisplay = true
            textView.arrangeFooter()
        }

        func flashHighlight(_ lines: [ClosedRange<Int>]) {
            guard let textView, let storage = textView.textStorage, !lines.isEmpty else { return }
            let text = storage.string as NSString
            var ranges: [NSRange] = []
            var lineIndex = 0
            var location = 0
            while location < text.length {
                let line = text.lineRange(for: NSRange(location: location, length: 0))
                if lines.contains(where: { $0.contains(lineIndex) }) {
                    ranges.append(line)
                }
                lineIndex += 1
                location = NSMaxRange(line)
            }
            for range in ranges {
                storage.addAttribute(.noteHighlight, value: true, range: range)
            }
            if let first = ranges.first {
                textView.scrollRangeToVisible(first)
            }
            textView.needsDisplay = true
            highlightTask?.cancel()
            highlightTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2.6))
                guard !Task.isCancelled, let self, let textView = self.textView, let storage = textView.textStorage else { return }
                storage.removeAttribute(.noteHighlight, range: NSRange(location: 0, length: storage.length))
                textView.needsDisplay = true
            }
        }

        func toggleTask(range: NSRange, done: Bool) {
            guard let textView, let storage = textView.textStorage, NSMaxRange(range) <= storage.length else { return }
            let replacement = done ? "[ ]" : "[x]"
            guard textView.shouldChangeText(in: range, replacementString: replacement) else { return }
            storage.replaceCharacters(in: range, with: replacement)
            textView.didChangeText()
            let text = storage.string as NSString
            var line = 0
            text.enumerateSubstrings(in: NSRange(location: 0, length: range.location), options: [.byLines, .substringNotRequired]) { _, _, _, _ in
                line += 1
            }
            store.toggledTask(line: line, done: !done)
        }

        func insertLink(_ title: String) {
            guard let textView, let storage = textView.textStorage else { return }
            let text = storage.string as NSString
            let caret = textView.selectedRange().location
            let lineStart = text.lineRange(for: NSRange(location: caret, length: 0)).location
            let before = text.substring(with: NSRange(location: lineStart, length: caret - lineStart)) as NSString
            let open = before.range(of: "[[", options: .backwards)
            guard open.location != NSNotFound else { return }
            let start = lineStart + open.location + 2
            let hasClose = caret + 2 <= text.length && text.substring(with: NSRange(location: caret, length: 2)) == "]]"
            let range = NSRange(location: start, length: caret - start)
            let replacement = hasClose ? title : title + "]]"
            guard textView.shouldChangeText(in: range, replacementString: replacement) else { return }
            storage.replaceCharacters(in: range, with: replacement)
            textView.didChangeText()
            textView.setSelectedRange(NSRange(location: start + (title as NSString).length + 2, length: 0))
        }

        @objc func scrolled() {
            guard let textView else { return }
            textView.window?.invalidateCursorRects(for: textView)
            updateLinkContext()
        }

        func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorageEditActions, range editedRange: NSRange, changeInLength delta: Int) {
            guard editedMask.contains(.editedCharacters), !applying else { return }
            if let existing = self.editedRange {
                let shifted = NSRange(location: existing.location, length: max(0, existing.length + delta))
                self.editedRange = NSUnionRange(shifted, editedRange)
            } else {
                self.editedRange = editedRange
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let textView, let storage = textView.textStorage else { return }
            let range = editedRange ?? NSRange(location: 0, length: storage.length)
            editedRange = nil
            let text = storage.string as NSString
            let newFences = NoteStyler.fenceRanges(in: text)
            let touchedFence = text.substring(with: text.paragraphRange(for: NSRange(location: min(range.location, text.length), length: 0))).contains("```")
            if newFences.count != fences.count || touchedFence {
                fences = newFences
                caretLine = currentLine()
                styler.style(storage, in: NSRange(location: 0, length: storage.length), caretLine: caretLine, fences: fences)
            } else {
                fences = newFences
                caretLine = currentLine()
                let clamped = NSRange(location: min(range.location, text.length), length: min(range.length, text.length - min(range.location, text.length)))
                styler.style(storage, in: clamped, caretLine: caretLine, fences: fences)
            }
            textView.typingAttributes = styler.baseAttributes
            textView.window?.invalidateCursorRects(for: textView)
            store.userEdited(storage.string)
            updateLinkContext()
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView, let storage = textView.textStorage, !applying else { return }
            let line = currentLine()
            if line != caretLine {
                let previous = caretLine
                caretLine = line
                for range in [previous, line].compactMap({ $0 }) where NSMaxRange(range) <= storage.length {
                    styler.style(storage, in: range, caretLine: line, fences: fences)
                }
                textView.window?.invalidateCursorRects(for: textView)
            }
            textView.typingAttributes = styler.baseAttributes
            updateLinkContext()
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if store.linkContext != nil, !store.suggestions.isEmpty {
                switch commandSelector {
                case #selector(NSResponder.moveDown(_:)):
                    store.moveSuggestion(1)
                    return true
                case #selector(NSResponder.moveUp(_:)):
                    store.moveSuggestion(-1)
                    return true
                case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertTab(_:)):
                    store.acceptSuggestion()
                    return true
                case #selector(NSResponder.cancelOperation(_:)):
                    store.updateLinkContext(nil)
                    return true
                default:
                    break
                }
            }
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                return continueList(in: textView)
            }
            return false
        }

        private func continueList(in textView: NSTextView) -> Bool {
            guard let storage = textView.textStorage else { return false }
            let text = storage.string as NSString
            let caret = textView.selectedRange().location
            let line = text.lineRange(for: NSRange(location: caret, length: 0))
            let content = text.substring(with: NSRange(location: line.location, length: caret - line.location))
            let indent = String(content.prefix { $0 == " " || $0 == "\t" })
            let body = content.dropFirst(indent.count)
            var marker: String?
            var markerLength = 0
            if body.hasPrefix("- [ ] ") || body.hasPrefix("- [x] ") {
                marker = "- [ ] "
                markerLength = 6
            } else if body.hasPrefix("- ") || body.hasPrefix("* ") || body.hasPrefix("> ") {
                marker = String(body.prefix(2))
                markerLength = 2
            } else {
                let digits = body.prefix { $0.isNumber }
                if !digits.isEmpty, body.dropFirst(digits.count).hasPrefix(". "), let number = Int(digits) {
                    marker = "\(number + 1). "
                    markerLength = digits.count + 2
                }
            }
            guard let marker else { return false }
            let rest = body.dropFirst(markerLength)
            if rest.trimmingCharacters(in: .whitespaces).isEmpty {
                let range = NSRange(location: line.location, length: caret - line.location)
                if textView.shouldChangeText(in: range, replacementString: "") {
                    storage.replaceCharacters(in: range, with: "")
                    textView.didChangeText()
                }
                return true
            }
            textView.insertText("\n" + indent + marker, replacementRange: textView.selectedRange())
            return true
        }

        private func currentLine() -> NSRange? {
            guard let textView, let storage = textView.textStorage else { return nil }
            let text = storage.string as NSString
            let selection = textView.selectedRange()
            guard selection.location <= text.length else { return nil }
            return text.lineRange(for: NSRange(location: selection.location, length: 0))
        }

        private func updateLinkContext() {
            guard let textView, let storage = textView.textStorage else { return }
            let text = storage.string as NSString
            let selection = textView.selectedRange()
            guard selection.length == 0, selection.location <= text.length else {
                store.updateLinkContext(nil)
                return
            }
            let lineStart = text.lineRange(for: NSRange(location: selection.location, length: 0)).location
            let before = text.substring(with: NSRange(location: lineStart, length: selection.location - lineStart)) as NSString
            let open = before.range(of: "[[", options: .backwards)
            guard open.location != NSNotFound else {
                store.updateLinkContext(nil)
                return
            }
            let query = before.substring(from: open.location + 2)
            guard !query.contains("]]"), !query.contains("|"), query.count <= 60 else {
                store.updateLinkContext(nil)
                return
            }
            let caretRect = textView.firstRect(forCharacterRange: NSRange(location: selection.location, length: 0), actualRange: nil)
            guard let window = textView.window, let scrollView = textView.enclosingScrollView else { return }
            let inWindow = window.convertFromScreen(caretRect)
            let local = scrollView.convert(inWindow, from: nil)
            let flipped = CGRect(x: local.minX, y: scrollView.bounds.height - local.maxY, width: max(local.width, 1), height: local.height)
            store.updateLinkContext(LinkContext(query: query, anchor: flipped))
        }
    }
}
