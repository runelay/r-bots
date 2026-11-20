import SwiftUI

struct SheetEditorView: View {
    @Bindable var store: SheetEditorStore

    var body: some View {
        VStack(spacing: Spacing.s) {
            SheetToolbar(store: store)
            SheetFormulaBar(store: store)
            Group {
                if store.sheet == nil {
                    VStack(alignment: .leading, spacing: Spacing.m) {
                        SkeletonRow(width: 300)
                        SkeletonRow(width: 220)
                    }
                    .padding(Spacing.l)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else {
                    SheetGridView(store: store)
                }
            }
            .clipped()
            SheetTabsBar(store: store)
        }
        .padding(.horizontal, Spacing.l)
        .padding(.bottom, Spacing.m)
    }
}

struct SheetToolbar: View {
    let store: SheetEditorStore

    private let formats: [CellFormatType] = [.general, .number, .brl, .percent, .date]

    var body: some View {
        HStack(spacing: Spacing.xs) {
            HStack(spacing: Spacing.xxs) {
                ForEach(formats) { format in
                    let active = (store.selectionFormat?.type ?? .general) == format
                    SheetToolButton(title: format.shortLabel, help: format.label, isActive: active) {
                        store.applyFormat(format)
                    }
                }
            }
            .padding(Spacing.xxs)
            .background(Theme.surface, in: Capsule())
            SheetToolButton(systemImage: "bold", help: "Negrito", isActive: store.selectionFormat?.bold == true) {
                store.toggleBold()
            }
            SheetToolButton(systemImage: "pin", help: store.frozenRows > 0 ? "Soltar a primeira linha" : "Fixar a primeira linha", isActive: store.frozenRows > 0) {
                store.toggleFrozenRow()
            }
            Spacer(minLength: 0)
        }
    }
}

struct SheetToolButton: View {
    var title: String? = nil
    var systemImage: String? = nil
    let help: String
    var isActive = false
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 30)
                } else if let title {
                    Text(title)
                        .font(TypeScale.captionStrong)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Spacing.s + 2)
                }
            }
            .foregroundStyle(isActive ? Theme.textPrimary : Theme.textSecondary)
            .frame(height: 26)
            .background(isActive ? Theme.selection : hovering ? Theme.hover : Color.clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help(help)
    }
}

struct SheetFormulaBar: View {
    @Bindable var store: SheetEditorStore
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Spacing.s) {
            Text(store.selection.address)
                .font(TypeScale.captionStrong.monospacedDigit())
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: 64, alignment: .leading)
            Image(systemName: "function")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
            TextField("Valor ou fórmula, como =SOMA(B2:B9)", text: $store.formulaText)
                .textFieldStyle(.plain)
                .font(BrandFonts.mono(12.5))
                .focused($focused)
                .onSubmit {
                    store.commitFormulaBar()
                    focused = false
                }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 32)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }
}

struct SheetTabsBar: View {
    let store: SheetEditorStore

    var body: some View {
        HStack(spacing: Spacing.xs) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.xs) {
                    ForEach((store.sheet?.tabs ?? []).sorted { $0.index < $1.index }) { tab in
                        SheetTabButton(title: tab.name, isActive: tab.id == store.tabID) {
                            store.selectTab(tab.id)
                        }
                    }
                }
            }
            .scrollEdgesHidden()
            SheetToolButton(systemImage: "plus", help: "Nova aba") {
                store.addTab()
            }
        }
        .frame(height: 30)
    }
}

struct SheetTabButton: View {
    let title: String
    let isActive: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(TypeScale.captionStrong)
                .foregroundStyle(isActive ? Theme.textPrimary : Theme.textSecondary)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, Spacing.m)
                .frame(height: 26)
                .background(isActive ? Theme.surfaceRaised : hovering ? Theme.hover : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }
}
