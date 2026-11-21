import SwiftUI
import UIKit

extension EnvironmentValues {
    @Entry var markdownOnAccent = false
}

struct MarkdownView: View {
    let text: String
    var fontSize: CGFloat = 16

    var body: some View {
        MarkdownBlocksView(blocks: MarkdownCache.blocks(for: text), fontSize: fontSize)
    }
}

struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]
    let fontSize: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s + 2) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, fontSize: fontSize)
                    .equatable()
            }
        }
    }
}

struct MarkdownBlockView: View, Equatable {
    @Environment(\.markdownOnAccent) private var onAccent
    let block: MarkdownBlock
    let fontSize: CGFloat

    nonisolated static func == (lhs: MarkdownBlockView, rhs: MarkdownBlockView) -> Bool {
        lhs.block == rhs.block && lhs.fontSize == rhs.fontSize
    }

    private var lineSpacing: CGFloat { fontSize * 0.28 }

    var body: some View {
        switch block {
        case .paragraph(let text):
            inline(text)
        case .heading(let level, let text):
            Text(MarkdownCache.attributed(text))
                .font(BrandFonts.sans(level == 1 ? fontSize + 3 : (level == 2 ? fontSize + 1 : fontSize), weight: .semibold))
                .tracking(-0.2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Spacing.xs)
        case .list(let items):
            VStack(alignment: .leading, spacing: Spacing.xs + 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                        Text(item.marker)
                            .font(BrandFonts.sans(fontSize).monospacedDigit())
                            .foregroundStyle(onAccent ? Theme.onAccent.opacity(0.7) : Theme.textTertiary)
                            .frame(minWidth: Spacing.m, alignment: .trailing)
                        inline(item.text)
                    }
                    .padding(.leading, CGFloat(item.level) * Spacing.l)
                }
            }
        case .quote(let blocks):
            HStack(alignment: .top, spacing: Spacing.m) {
                Capsule()
                    .fill(onAccent ? Theme.onAccent.opacity(0.4) : Theme.selection)
                    .frame(width: 3)
                MarkdownBlocksView(blocks: blocks, fontSize: fontSize)
                    .foregroundStyle(onAccent ? Theme.onAccent.opacity(0.85) : Theme.textSecondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(_, let text):
            MarkdownCodeBlock(code: text)
        case .rule:
            Rectangle()
                .fill(onAccent ? Theme.onAccent.opacity(0.3) : Theme.paneDivider)
                .frame(height: 1)
                .padding(.vertical, Spacing.xs)
        case .table(let table):
            MarkdownTableView(table: table, fontSize: fontSize)
        }
    }

    private func inline(_ text: String) -> some View {
        Text(MarkdownCache.attributed(text))
            .font(BrandFonts.sans(fontSize))
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct MarkdownCodeBlock: View {
    @Environment(\.markdownOnAccent) private var onAccent
    let code: String
    @State private var copied = 0

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code.isEmpty ? " " : code)
                .font(BrandFonts.mono(13))
                .lineSpacing(3)
                .fixedSize(horizontal: true, vertical: true)
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.s + 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(onAccent ? Theme.onAccent.opacity(0.14) : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
        .contextMenu {
            Button("Copiar código", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = code
                copied += 1
            }
        }
        .sensoryFeedback(.success, trigger: copied)
    }
}

struct MarkdownTableView: View {
    let table: MarkdownTable
    let fontSize: CGFloat

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: Spacing.l, verticalSpacing: Spacing.s) {
                GridRow {
                    ForEach(Array(table.headers.enumerated()), id: \.offset) { _, header in
                        Text(MarkdownCache.attributed(header))
                            .font(BrandFonts.sans(fontSize - 2, weight: .semibold))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(MarkdownCache.attributed(cell))
                                .font(BrandFonts.sans(fontSize - 2))
                                .monospacedDigit()
                                .frame(maxWidth: 260, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(.vertical, Spacing.xs)
        }
    }
}
