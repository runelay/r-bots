import AppKit
import SwiftUI

struct MarkdownView: View {
    let text: String
    let fontSize: CGFloat
    var lineSpacing: CGFloat = Metrics.bodyLineSpacing

    var body: some View {
        MarkdownBlocksView(blocks: MarkdownCache.blocks(for: text), fontSize: fontSize, lineSpacing: lineSpacing)
    }
}

struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]
    let fontSize: CGFloat
    let lineSpacing: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, fontSize: fontSize, lineSpacing: lineSpacing)
                    .equatable()
            }
        }
    }
}

struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlock
    let fontSize: CGFloat
    let lineSpacing: CGFloat

    nonisolated static func == (lhs: MarkdownBlockView, rhs: MarkdownBlockView) -> Bool {
        lhs.block == rhs.block && lhs.fontSize == rhs.fontSize && lhs.lineSpacing == rhs.lineSpacing
    }

    var body: some View {
        content
            .textSelection(.enabled)
    }

    @ViewBuilder
    private var content: some View {
        switch block {
        case .paragraph(let text):
            inline(text)
        case .heading(let level, let text):
            Text(MarkdownCache.attributed(text))
                .font(BrandFonts.sans(headingSize(level), weight: .semibold))
                .lineSpacing(lineSpacing * 0.6)
                .padding(.top, level == 1 ? Spacing.xs : Spacing.xxs)
        case .list(let items):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                        Text(item.marker)
                            .font(BrandFonts.sans(fontSize).monospacedDigit())
                            .foregroundStyle(Theme.textTertiary)
                            .frame(minWidth: Spacing.m, alignment: .trailing)
                        inline(item.text)
                    }
                    .padding(.leading, CGFloat(item.level) * Spacing.l)
                }
            }
        case .quote(let blocks):
            HStack(alignment: .top, spacing: Spacing.m) {
                Capsule()
                    .fill(Theme.selection)
                    .frame(width: 3)
                MarkdownBlocksView(blocks: blocks, fontSize: fontSize, lineSpacing: lineSpacing)
                    .foregroundStyle(Theme.textSecondary)
                    .environment(\.markdownInk, Theme.textSecondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            MarkdownCodeBlock(language: language, code: text)
        case .rule:
            Rectangle()
                .fill(Theme.paneDivider)
                .frame(height: 1)
                .padding(.vertical, Spacing.xs)
        case .table(let table):
            MarkdownTableView(table: table, fontSize: fontSize)
        }
    }

    @ViewBuilder
    private func inline(_ text: String) -> some View {
        if LinkDetection.hasLink(text) {
            LinkText(source: text, fontSize: fontSize, lineSpacing: lineSpacing)
        } else {
            Text(MarkdownCache.attributed(text))
                .font(BrandFonts.sans(fontSize))
                .lineSpacing(lineSpacing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: fontSize + 2
        case 2: fontSize + 1
        default: fontSize
        }
    }
}

struct MarkdownCodeBlock: View {
    let language: String
    let code: String

    @State private var isHovered = false
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal) {
            Text(code.isEmpty ? " " : code)
                .font(TypeScale.mono)
                .lineSpacing(3)
                .fixedSize(horizontal: true, vertical: true)
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.s + 2)
                .padding(.trailing, Spacing.xxl)
        }
        .scrollIndicators(.automatic)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Button(action: copy) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 24, height: 24)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small - 2, style: .continuous))
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Copiar código")
            .accessibilityLabel("Copiar código")
            .padding(Spacing.xs)
            .opacity(isHovered || copied ? 1 : 0)
            .animation(Motion.reduced, value: isHovered)
        }
        .onHover { isHovered = $0 }
    }

    private func copy() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(code, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.4))
            copied = false
        }
    }
}

struct MarkdownTableView: View {
    let table: MarkdownTable
    let fontSize: CGFloat

    private var numericColumns: [Bool] {
        table.headers.indices.map { column in
            let values = table.rows.map { $0[column] }.filter { !$0.isEmpty }
            return !values.isEmpty && values.allSatisfy(MarkdownParser.isNumeric)
        }
    }

    var body: some View {
        let numeric = numericColumns
        ScrollView(.horizontal) {
            grid(numeric: numeric)
                .fixedSize(horizontal: true, vertical: false)
                .frame(alignment: .leading)
        }
        .scrollIndicators(.automatic)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func grid(numeric: [Bool]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(table.headers.indices, id: \.self) { column in
                    cell(table.headers[column], column: column, numeric: numeric[column], header: true, row: -1)
                }
            }
            ForEach(table.rows.indices, id: \.self) { row in
                GridRow {
                    ForEach(table.headers.indices, id: \.self) { column in
                        cell(table.rows[row][column], column: column, numeric: numeric[column], header: false, row: row)
                    }
                }
            }
        }
        .backgroundPreferenceValue(MarkdownTableRowKey.self) { anchors in
            GeometryReader { proxy in
                ForEach(anchors.keys.sorted(), id: \.self) { row in
                    if let anchor = anchors[row], let fill = rowFill(row) {
                        let rect = proxy[anchor]
                        Rectangle()
                            .fill(fill)
                            .frame(width: proxy.size.width, height: rect.height)
                            .offset(y: rect.minY)
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
    }

    private func rowFill(_ row: Int) -> Color? {
        if row < 0 {
            return Theme.surfaceRaised
        }
        return row % 2 == 1 ? Theme.hover : nil
    }

    private func cell(_ text: String, column: Int, numeric: Bool, header: Bool, row: Int) -> some View {
        let alignment = resolvedAlignment(column: column, numeric: numeric)
        let font = BrandFonts.sans(fontSize - 1, weight: header ? .semibold : .regular).monospacedDigit()
        return MarkdownCappedWidth(maxWidth: 320) {
            Text(MarkdownCache.attributed(text))
                .font(font)
                .multilineTextAlignment(alignment.text)
                .lineSpacing(2)
        }
        .frame(minHeight: ((fontSize - 1) * 1.4).rounded(.up), alignment: alignment.frame)
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.s - 1)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment.frame)
        .anchorPreference(key: MarkdownTableRowKey.self, value: .bounds) { column == 0 ? [row: $0] : [:] }
        .gridColumnAlignment(alignment.horizontal)
    }

    private func resolvedAlignment(column: Int, numeric: Bool) -> (frame: Alignment, text: TextAlignment, horizontal: HorizontalAlignment) {
        let declared = table.alignments[column]
        let value: MarkdownAlignment = declared == .leading && numeric ? .trailing : declared
        switch value {
        case .leading: return (.leading, .leading, .leading)
        case .center: return (.center, .center, .center)
        case .trailing: return (.trailing, .trailing, .trailing)
        }
    }
}

struct MarkdownTableRowKey: PreferenceKey {
    static var defaultValue: [Int: Anchor<CGRect>] { [:] }

    static func reduce(value: inout [Int: Anchor<CGRect>], nextValue: () -> [Int: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

struct MarkdownCappedWidth: Layout {
    let maxWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let ideal = subview.sizeThatFits(.unspecified)
        let width = min(ideal.width, maxWidth, proposal.width ?? .infinity)
        let fitted = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
        return CGSize(width: width, height: fitted.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}
