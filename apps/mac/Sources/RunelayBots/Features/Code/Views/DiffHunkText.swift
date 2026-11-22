import AppKit
import SwiftUI

enum DiffTextLine: Hashable {
    case code(CodeLine)
    case gap(id: String, count: Int)
}

struct TranscriptDiffBlocks: View {
    let blocks: [DiffBlock]
    let language: String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            ForEach(blocks) { block in
                if case .hunk(_, let title, let section, let rows) = block {
                    TranscriptHunkCard(title: title, section: section, rows: rows, language: language)
                }
            }
        }
    }
}

struct TranscriptHunkCard: View {
    let title: String
    let section: String?
    let rows: [CodeRow]
    let language: String
    @State private var openGaps: Set<String> = []

    private var lines: [DiffTextLine] {
        var result: [DiffTextLine] = []
        for row in rows {
            switch row {
            case .line(let line):
                result.append(.code(line))
            case .gap(let id, let hidden):
                if openGaps.contains(id) {
                    result.append(contentsOf: hidden.map(DiffTextLine.code))
                } else {
                    result.append(.gap(id: id, count: hidden.count))
                }
            }
        }
        return result
    }

    var body: some View {
        let lines = lines
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.s) {
                Text(title)
                    .font(BrandFonts.sans(11, weight: .medium))
                    .foregroundStyle(Theme.textTertiary)
                if let section, !section.isEmpty {
                    Text(section)
                        .font(BrandFonts.mono(10.5))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 24)

            DiffHunkText(lines: lines, language: language) { id in
                openGaps.insert(id)
            }
            .frame(height: CGFloat(lines.count) * DiffHunkTextView.lineHeight)
            .padding(.bottom, Spacing.xs)
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }
}

struct DiffHunkText: NSViewRepresentable {
    let lines: [DiffTextLine]
    let language: String
    let openGap: (String) -> Void

    func makeNSView(context: Context) -> DiffHunkScrollView {
        let view = DiffHunkScrollView()
        view.text.openGap = openGap
        view.text.show(lines: lines, language: language)
        return view
    }

    func updateNSView(_ view: DiffHunkScrollView, context: Context) {
        view.text.openGap = openGap
        view.text.show(lines: lines, language: language)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: DiffHunkScrollView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 600, height: CGFloat(lines.count) * DiffHunkTextView.lineHeight)
    }
}

final class DiffHunkScrollView: NSScrollView {
    let text = DiffHunkTextView()

    init() {
        super.init(frame: .zero)
        drawsBackground = false
        hasHorizontalScroller = false
        hasVerticalScroller = false
        horizontalScrollElasticity = .none
        verticalScrollElasticity = .none
        contentView.drawsBackground = false
        documentView = text
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError()
    }

    override func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX), let outer = superview?.enclosingScrollView {
            outer.scrollWheel(with: event)
            return
        }
        super.scrollWheel(with: event)
    }

    override func layout() {
        super.layout()
        text.fit(width: contentView.bounds.width)
    }
}

final class DiffHunkTextView: NSTextView {
    static let lineHeight: CGFloat = 19
    static let gutter: CGFloat = 59
    var openGap: ((String) -> Void)?
    private var lines: [DiffTextLine] = []
    private var signature = 0
    private var contentWidth: CGFloat = 0
    private var visibleWidth: CGFloat = 0

    private static let font =
        NSFontManager.shared.font(withFamily: BrandFonts.monoFamily, traits: [], weight: 5, size: 11.5)
        ?? .monospacedSystemFont(ofSize: 11.5, weight: .regular)
    private static let numberFont =
        NSFontManager.shared.font(withFamily: BrandFonts.monoFamily, traits: [], weight: 5, size: 10.5)
        ?? .monospacedSystemFont(ofSize: 10.5, weight: .regular)
    private static let markFont =
        NSFontManager.shared.font(withFamily: BrandFonts.monoFamily, traits: [], weight: 9, size: 11.5)
        ?? .monospacedSystemFont(ofSize: 11.5, weight: .bold)
    private static let gapFont =
        NSFontManager.shared.font(withFamily: BrandFonts.sansFamily, traits: [], weight: 5, size: 11)
        ?? .systemFont(ofSize: 11)

    init() {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 1_000_000, height: 1_000_000))
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        isHorizontallyResizable = false
        isVerticallyResizable = false
        textContainerInset = .zero
        isAutomaticLinkDetectionEnabled = false
        usesFindBar = false
        allowsUndo = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError()
    }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
    }

    override var textContainerOrigin: NSPoint {
        NSPoint(x: Self.gutter, y: 0)
    }

    func show(lines next: [DiffTextLine], language: String) {
        var hasher = Hasher()
        hasher.combine(next)
        hasher.combine(language)
        let value = hasher.finalize()
        guard value != signature else { return }
        signature = value
        lines = next
        let text = NSMutableAttributedString()
        var widest: CGFloat = 0
        for (index, line) in next.enumerated() {
            let part = DiffLineText.attributed(line, language: language, font: Self.font, gapFont: Self.gapFont)
            text.append(part.text)
            widest = max(widest, part.width)
            if index < next.count - 1 {
                text.append(NSAttributedString(string: "\n", attributes: [.font: Self.font, .paragraphStyle: DiffLineText.paragraph]))
            }
        }
        textStorage?.setAttributedString(text)
        contentWidth = ceil(widest) + Self.gutter + Spacing.l
        fit(width: visibleWidth)
        needsDisplay = true
    }

    func fit(width: CGFloat) {
        visibleWidth = width
        let size = CGSize(width: max(contentWidth, width, 600), height: CGFloat(lines.count) * Self.lineHeight)
        if frame.size != size {
            setFrameSize(size)
        }
    }

    override func drawBackground(in rect: NSRect) {
        let first = max(0, Int(rect.minY / Self.lineHeight))
        let last = min(lines.count - 1, Int(rect.maxY / Self.lineHeight))
        guard first <= last else { return }
        let added = NSColor(CodePalette.addedText)
        let removed = NSColor(CodePalette.removedText)
        let addedBand = NSColor(CodePalette.addedBackground)
        let removedBand = NSColor(CodePalette.removedBackground)
        let number: [NSAttributedString.Key: Any] = [.font: Self.numberFont, .foregroundColor: NSColor(Theme.textTertiary).withAlphaComponent(0.75)]
        for index in first...last {
            let y = CGFloat(index) * Self.lineHeight
            guard case .code(let line) = lines[index] else { continue }
            let band = CGRect(x: 0, y: y, width: bounds.width, height: Self.lineHeight)
            switch line.kind {
            case .added:
                addedBand.setFill()
                band.fill()
                added.setFill()
                CGRect(x: 0, y: y, width: 3, height: Self.lineHeight).fill()
            case .removed:
                removedBand.setFill()
                band.fill()
                removed.setFill()
                CGRect(x: 0, y: y, width: 3, height: Self.lineHeight).fill()
            case .context:
                break
            }
            let label = (line.kind == .removed ? line.oldNumber : line.newNumber).map(String.init) ?? ""
            if !label.isEmpty {
                let string = NSAttributedString(string: label, attributes: number)
                let size = string.size()
                string.draw(at: CGPoint(x: 3 + 34 - size.width, y: y + (Self.lineHeight - size.height) / 2))
            }
            if line.kind != .context {
                let mark = NSAttributedString(
                    string: line.kind == .added ? "+" : "−",
                    attributes: [
                        .font: Self.markFont,
                        .foregroundColor: line.kind == .added ? added : removed,
                    ])
                mark.draw(at: CGPoint(x: 3 + 34 + Spacing.s, y: y + (Self.lineHeight - mark.size().height) / 2))
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = Int(point.y / Self.lineHeight)
        if index >= 0, index < lines.count, case .gap(let id, _) = lines[index] {
            openGap?(id)
            return
        }
        super.mouseDown(with: event)
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        for (index, line) in lines.enumerated() {
            if case .gap = line {
                addCursorRect(CGRect(x: 0, y: CGFloat(index) * Self.lineHeight, width: bounds.width, height: Self.lineHeight), cursor: .pointingHand)
            }
        }
    }
}

@MainActor
enum DiffLineText {
    static let paragraph: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = DiffHunkTextView.lineHeight
        style.maximumLineHeight = DiffHunkTextView.lineHeight
        style.lineBreakMode = .byClipping
        return style
    }()

    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 6000
        return cache
    }()

    final class Entry {
        let text: NSAttributedString
        let width: CGFloat

        init(text: NSAttributedString, width: CGFloat) {
            self.text = text
            self.width = width
        }
    }

    static func attributed(_ line: DiffTextLine, language: String, font: NSFont, gapFont: NSFont) -> Entry {
        let offset = (DiffHunkTextView.lineHeight - (font.ascender - font.descender)) / 2 - 1
        switch line {
        case .gap(_, let count):
            let text = count == 1 ? tr("⋯ 1 linha oculta") : tr("⋯ %lld linhas ocultas", count)
            let value = NSAttributedString(
                string: text,
                attributes: [
                    .font: gapFont,
                    .foregroundColor: NSColor(Theme.textTertiary),
                    .paragraphStyle: paragraph,
                    .baselineOffset: offset,
                ])
            return Entry(text: value, width: value.size().width)
        case .code(let code):
            let key = "\(language)|\(code.kind)|\(code.emphasis.map { "\($0.lowerBound)-\($0.upperBound)" }.joined(separator: ","))|\(code.text)" as NSString
            if let hit = cache.object(forKey: key) {
                return hit
            }
            let result = NSMutableAttributedString()
            for (text, token) in CodeSyntax.tokens(code.text, language: language) {
                result.append(
                    NSAttributedString(
                        string: text,
                        attributes: [
                            .font: font,
                            .foregroundColor: NSColor(CodePalette.color(token)),
                            .paragraphStyle: paragraph,
                            .baselineOffset: offset,
                        ]))
            }
            if result.length == 0 {
                result.append(NSAttributedString(string: " ", attributes: [.font: font, .paragraphStyle: paragraph]))
            }
            if !code.emphasis.isEmpty {
                let emphasis = NSColor(code.kind == .added ? CodePalette.addedEmphasis : CodePalette.removedEmphasis)
                let string = result.string as NSString
                let characters = Array(code.text)
                for range in code.emphasis where range.lowerBound < characters.count {
                    let upper = min(range.upperBound, characters.count)
                    let prefix = String(characters[0..<range.lowerBound])
                    let middle = String(characters[range.lowerBound..<upper])
                    let start = (prefix as NSString).length
                    let length = (middle as NSString).length
                    if start + length <= string.length {
                        result.addAttribute(.backgroundColor, value: emphasis, range: NSRange(location: start, length: length))
                    }
                }
            }
            let entry = Entry(text: result, width: result.size().width)
            cache.setObject(entry, forKey: key)
            return entry
        }
    }
}
