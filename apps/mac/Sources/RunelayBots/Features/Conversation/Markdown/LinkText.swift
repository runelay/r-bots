import AppKit
import SwiftUI

extension EnvironmentValues {
    @Entry var markdownInk: Color = Theme.textPrimary
}

@MainActor
enum LinkDetection {
    private static var cache: [String: Bool] = [:]
    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    static func hasLink(_ source: String) -> Bool {
        if let cached = cache[source] {
            return cached
        }
        let value = MarkdownCache.attributed(source).runs.contains { $0.link != nil } || firstLink(in: source) != nil
        if cache.count >= 1600 {
            cache.removeAll(keepingCapacity: true)
        }
        cache[source] = value
        return value
    }

    static func firstLink(in text: String) -> (url: URL, range: Range<String.Index>)? {
        guard text.contains("://") || text.contains("www.") else { return nil }
        let nsRange = NSRange(text.startIndex..., in: text)
        guard let match = detector?.firstMatch(in: text, options: [], range: nsRange),
            let url = match.url,
            url.scheme == "http" || url.scheme == "https",
            let range = Range(match.range, in: text)
        else { return nil }
        return (url, range)
    }

    static func links(in text: String) -> [(url: URL, range: NSRange)] {
        guard text.contains("://") || text.contains("www.") else { return [] }
        let nsRange = NSRange(text.startIndex..., in: text)
        return (detector?.matches(in: text, options: [], range: nsRange) ?? []).compactMap { match in
            guard let url = match.url, url.scheme == "http" || url.scheme == "https" else { return nil }
            return (url, match.range)
        }
    }
}

@MainActor
enum LinkTextBuilder {
    static func sansFont(_ size: CGFloat, weight: NSFont.Weight = .regular, italic: Bool = false) -> NSFont {
        var font: NSFont
        if BrandFonts.availableFamilies.contains(BrandFonts.sansFamily) {
            let descriptor = NSFontDescriptor(fontAttributes: [
                .family: BrandFonts.sansFamily,
                .traits: [NSFontDescriptor.TraitKey.weight: weight],
            ])
            font = NSFont(descriptor: descriptor, size: size) ?? .systemFont(ofSize: size, weight: weight)
        } else {
            font = .systemFont(ofSize: size, weight: weight)
        }
        if italic {
            let italicDescriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.italic))
            font = NSFont(descriptor: italicDescriptor, size: size) ?? font
        }
        return font
    }

    static func monoFont(_ size: CGFloat) -> NSFont {
        if BrandFonts.availableFamilies.contains(BrandFonts.monoFamily) {
            let descriptor = NSFontDescriptor(fontAttributes: [.family: BrandFonts.monoFamily])
            if let font = NSFont(descriptor: descriptor, size: size) {
                return font
            }
        }
        return .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    static func build(source: String, fontSize: CGFloat, lineSpacing: CGFloat, ink: NSColor) -> NSAttributedString {
        let attributed = MarkdownCache.attributed(source)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        let result = NSMutableAttributedString()
        var codeRanges: [NSRange] = []
        for run in attributed.runs {
            let text = String(attributed[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            let isCode = intent.contains(.code)
            let font: NSFont
            if isCode {
                font = monoFont(fontSize - 1)
            } else {
                font = sansFont(
                    fontSize,
                    weight: intent.contains(.stronglyEmphasized) ? .bold : .regular,
                    italic: intent.contains(.emphasized)
                )
            }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: ink,
                .paragraphStyle: paragraph,
            ]
            if intent.contains(.strikethrough) {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link {
                attributes[.link] = link
            }
            let start = result.length
            result.append(NSAttributedString(string: text, attributes: attributes))
            if isCode || run.link != nil {
                codeRanges.append(NSRange(location: start, length: result.length - start))
            }
        }
        for link in LinkDetection.links(in: result.string) where !codeRanges.contains(where: { NSIntersectionRange($0, link.range).length > 0 }) {
            result.addAttribute(.link, value: link.url, range: link.range)
        }
        return result
    }
}

struct LinkText: NSViewRepresentable {
    let source: String
    let fontSize: CGFloat
    let lineSpacing: CGFloat
    @Environment(\.markdownInk) private var ink
    @Environment(\.markdownOnAccent) private var onAccent

    func makeNSView(context: Context) -> LinkTextView {
        let view = LinkTextView()
        view.useLinkColor(onAccent ? NSColor(Theme.onAccent) : nil)
        view.apply(source: source, fontSize: fontSize, lineSpacing: lineSpacing, ink: NSColor(ink))
        return view
    }

    func updateNSView(_ view: LinkTextView, context: Context) {
        view.useLinkColor(onAccent ? NSColor(Theme.onAccent) : nil)
        view.apply(source: source, fontSize: fontSize, lineSpacing: lineSpacing, ink: NSColor(ink))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: LinkTextView, context: Context) -> CGSize? {
        nsView.fittingSize(width: proposal.width)
    }
}

final class LinkTextView: NSTextView {
    private var appliedKey: String?
    private var hoveredRange: NSRange?
    private var trackingArea: NSTrackingArea?

    convenience init() {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        self.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        backgroundColor = .clear
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        allowsUndo = false
        isAutomaticLinkDetectionEnabled = false
        linkTextAttributes = [
            .foregroundColor: NSColor(Theme.brandText),
            .cursor: NSCursor.pointingHand,
        ]
        setContentHuggingPriority(.defaultHigh, for: .vertical)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    func useLinkColor(_ color: NSColor?) {
        var attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: color ?? NSColor(Theme.brandText),
            .cursor: NSCursor.pointingHand,
        ]
        if color != nil {
            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        linkTextAttributes = attributes
    }

    func apply(source: String, fontSize: CGFloat, lineSpacing: CGFloat, ink: NSColor) {
        let key = "\(fontSize)|\(lineSpacing)|\(ink.hash)|\(source)"
        guard key != appliedKey, let storage = textStorage else { return }
        appliedKey = key
        hoveredRange = nil
        storage.setAttributedString(LinkTextBuilder.build(source: source, fontSize: fontSize, lineSpacing: lineSpacing, ink: ink))
        invalidateIntrinsicContentSize()
    }

    func fittingSize(width: CGFloat?) -> CGSize {
        guard let layout = layoutManager, let container = textContainer else { return .zero }
        let target = width.map { $0.isFinite ? max($0, 1) : CGFloat.greatestFiniteMagnitude } ?? CGFloat.greatestFiniteMagnitude
        let live = container.size
        if live.width != target {
            container.size = NSSize(width: target, height: CGFloat.greatestFiniteMagnitude)
        }
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        if container.size != live {
            container.size = live
        }
        let measured = ceil(used.width) + 1
        let resolved = target == CGFloat.greatestFiniteMagnitude ? measured : min(measured, target)
        return CGSize(width: resolved, height: ceil(used.height))
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }

    override func updateTrackingAreas() {
        if let trackingArea {
            removeTrackingArea(trackingArea)
        }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect, .cursorUpdate], owner: self)
        addTrackingArea(area)
        trackingArea = area
        super.updateTrackingAreas()
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        updateHover(at: convert(event.locationInWindow, from: nil))
    }

    override func cursorUpdate(with event: NSEvent) {
        if linkRange(at: convert(event.locationInWindow, from: nil)) != nil {
            NSCursor.pointingHand.set()
        } else {
            super.cursorUpdate(with: event)
        }
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        setHovered(nil)
    }

    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }

    override func clicked(onLink link: Any, at charIndex: Int) {
        guard let url = Self.url(from: link) else { return }
        WebPageStore.shared.openLink(url)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        guard let range = linkRange(at: convert(event.locationInWindow, from: nil)),
            let link = textStorage?.attribute(.link, at: range.location, effectiveRange: nil),
            let url = Self.url(from: link)
        else { return menu }
        var items: [NSMenuItem] = []
        if WebPageStore.isWebURL(url) {
            items.append(LinkMenuItem(tr("Abrir aqui no app")) { WebPageStore.shared.openHere(url) })
        }
        items.append(LinkMenuItem(tr("Abrir no navegador")) { NSWorkspace.shared.open(url) })
        items.append(
            LinkMenuItem(tr("Copiar link")) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url.absoluteString, forType: .string)
            })
        items.append(.separator())
        for (index, item) in items.enumerated() {
            menu.insertItem(item, at: index)
        }
        return menu
    }

    private static func url(from link: Any) -> URL? {
        if let url = link as? URL {
            return url
        }
        if let string = link as? String {
            return URL(string: string)
        }
        return nil
    }

    private func updateHover(at point: NSPoint) {
        let range = linkRange(at: point)
        setHovered(range)
        if range != nil {
            NSCursor.pointingHand.set()
        }
    }

    private func linkRange(at point: NSPoint) -> NSRange? {
        guard let layout = layoutManager, let container = textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let glyph = layout.glyphIndex(for: point, in: container)
        let glyphRect = layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard glyphRect.insetBy(dx: -1, dy: -2).contains(point) else { return nil }
        let index = layout.characterIndexForGlyph(at: glyph)
        guard index < storage.length else { return nil }
        var range = NSRange(location: 0, length: 0)
        guard storage.attribute(.link, at: index, effectiveRange: &range) != nil else { return nil }
        return range
    }

    private func setHovered(_ range: NSRange?) {
        guard range != hoveredRange, let layout = layoutManager else { return }
        if let old = hoveredRange, NSMaxRange(old) <= (textStorage?.length ?? 0) {
            layout.removeTemporaryAttribute(.underlineStyle, forCharacterRange: old)
        }
        if let range {
            layout.addTemporaryAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, forCharacterRange: range)
        }
        hoveredRange = range
    }
}

@MainActor
final class LinkMenuItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(_ title: String, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError()
    }

    @objc private func run() {
        handler()
    }
}

struct SystemLink: Equatable {
    let label: String
    let url: URL

    @MainActor
    static func parse(_ text: String) -> SystemLink? {
        guard let match = LinkDetection.firstLink(in: text) else { return nil }
        var remainder = text
        remainder.removeSubrange(match.range)
        remainder = remainder.trimmingCharacters(in: CharacterSet(charactersIn: " :·-—").union(.whitespacesAndNewlines))
        let number = pullNumber(match.url)
        var label = remainder
        if let number {
            if let prRange = label.range(of: "PR") {
                label.replaceSubrange(prRange, with: "PR #\(number)")
            } else if label.isEmpty {
                label = "PR #\(number)"
            } else {
                label += " · PR #\(number)"
            }
        }
        if label.isEmpty {
            label = match.url.host() ?? match.url.absoluteString
        }
        return SystemLink(label: label, url: match.url)
    }

    private static func pullNumber(_ url: URL) -> String? {
        let parts = url.pathComponents
        guard let index = parts.firstIndex(where: { $0 == "pull" || $0 == "pulls" || $0 == "merge_requests" }),
            index + 1 < parts.count,
            parts[index + 1].allSatisfy(\.isNumber)
        else { return nil }
        return parts[index + 1]
    }
}

struct SystemLinkLine: View {
    let link: SystemLink
    let symbol: String
    @State private var isHovering = false

    var body: some View {
        Button {
            WebPageStore.shared.openLink(link.url)
        } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .semibold))
                Text(link.label)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("·")
                    .foregroundStyle(Theme.textTertiary)
                Text("Abrir ↗")
                    .foregroundStyle(Theme.brandText)
                    .underline(isHovering)
            }
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .help(link.url.absoluteString)
        .contextMenu {
            Button("Abrir aqui no app") { WebPageStore.shared.openHere(link.url) }
            Button("Abrir no navegador") { NSWorkspace.shared.open(link.url) }
            Button("Copiar link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link.url.absoluteString, forType: .string)
            }
        }
        .accessibilityLabel("\(link.label). Abrir")
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xs)
    }
}
