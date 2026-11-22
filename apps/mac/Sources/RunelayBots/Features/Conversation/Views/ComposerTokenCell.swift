import AppKit
import SwiftUI

final class ComposerTokenAttachment: NSTextAttachment {
    let token: ComposerToken

    init(token: ComposerToken, cell: ComposerTokenCell) {
        self.token = token
        super.init(data: nil, ofType: nil)
        attachmentCell = cell
    }

    required init?(coder: NSCoder) {
        nil
    }
}

final class ComposerTokenCell: NSTextAttachmentCell {
    static let maxNameWidth: CGFloat = 240
    static let iconGap: CGFloat = 4
    static let detailGap: CGFloat = 5

    private let token: ComposerToken
    private weak var file: ComposerAttachment?
    private let labelFont: NSFont
    private let detailFont: NSFont
    private let retry: @MainActor (ComposerAttachment) -> Void

    init(token: ComposerToken, file: ComposerAttachment?, font: NSFont, retry: @escaping @MainActor (ComposerAttachment) -> Void) {
        self.token = token
        self.file = file
        labelFont = font
        detailFont = NSFontManager.shared.convert(font, toSize: (labelFont.pointSize * 0.78).rounded())
        self.retry = retry
        super.init(textCell: "")
    }

    required init(coder: NSCoder) {
        token = .file(UUID())
        file = nil
        labelFont = NSFont.systemFont(ofSize: 15)
        detailFont = NSFont.systemFont(ofSize: 12)
        retry = { _ in }
        super.init(coder: coder)
    }

    private var label: String {
        switch token {
        case .file:
            file?.ref?.name ?? file?.name ?? "arquivo"
        case .skill(let skill):
            skill.slug
        }
    }

    private var detail: String? {
        guard case .file = token, let file else { return nil }
        return file.isFailed ? tr("não foi, clique para tentar de novo") : file.sizeLabel
    }

    private var tint: NSColor {
        switch token {
        case .file:
            if file?.isFailed == true {
                return NSColor(Theme.danger)
            }
            return NSColor(FileTokenKind(name: label).color)
        case .skill:
            return NSColor(SkillTokenStyle.color)
        }
    }

    private var systemImage: String {
        switch token {
        case .file:
            FileTokenKind(name: label).systemImage
        case .skill:
            SkillTokenStyle.systemImage
        }
    }

    private var fraction: CGFloat {
        file?.isUploading == true ? 0.5 : 1
    }

    private var icon: NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: (labelFont.pointSize * 0.8).rounded(), weight: .medium)
            .applying(NSImage.SymbolConfiguration(paletteColors: [tint]))
        return NSImage(systemSymbolName: systemImage, accessibilityDescription: nil)?.withSymbolConfiguration(configuration)
    }

    private var nameWidth: CGFloat {
        min(ceil((label as NSString).size(withAttributes: [.font: labelFont]).width), Self.maxNameWidth)
    }

    private var detailWidth: CGFloat {
        guard let detail else { return 0 }
        return ceil((detail as NSString).size(withAttributes: [.font: detailFont]).width)
    }

    override func cellSize() -> NSSize {
        let iconWidth = ceil(icon?.size.width ?? 0)
        var width = iconWidth + Self.iconGap + nameWidth
        if detail != nil {
            width += Self.detailGap + detailWidth
        }
        return NSSize(width: width + 1, height: ceil(labelFont.ascender - labelFont.descender))
    }

    override func cellBaselineOffset() -> NSPoint {
        NSPoint(x: 0, y: floor(labelFont.descender))
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let baseline = cellFrame.maxY + floor(labelFont.descender)
        var x = cellFrame.minX
        if let icon {
            let size = icon.size
            let center = baseline - labelFont.capHeight / 2
            icon.draw(
                in: NSRect(x: x, y: center - size.height / 2, width: size.width, height: size.height),
                from: .zero,
                operation: .sourceOver,
                fraction: fraction,
                respectFlipped: true,
                hints: nil
            )
            x += ceil(size.width) + Self.iconGap
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingMiddle
        let name: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: tint.withAlphaComponent(fraction),
            .paragraphStyle: paragraph,
        ]
        (label as NSString).draw(
            with: NSRect(x: x, y: baseline - labelFont.ascender, width: nameWidth, height: labelFont.ascender - labelFont.descender),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: name
        )
        x += nameWidth + Self.detailGap
        guard let detail else { return }
        let color = file?.isFailed == true ? NSColor(Theme.danger) : NSColor(Theme.textTertiary)
        (detail as NSString).draw(
            with: NSRect(x: x, y: baseline - detailFont.ascender, width: detailWidth, height: detailFont.ascender - detailFont.descender),
            options: [.usesLineFragmentOrigin],
            attributes: [.font: detailFont, .foregroundColor: color.withAlphaComponent(fraction)]
        )
    }

    override func wantsToTrackMouse() -> Bool {
        file?.isFailed == true
    }

    override func trackMouse(with theEvent: NSEvent, in cellFrame: NSRect, of controlView: NSView?, untilMouseUp flag: Bool) -> Bool {
        guard let file, file.isFailed else { return false }
        retry(file)
        return true
    }
}
