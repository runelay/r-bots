import SwiftUI

struct PillTabs<Tab: Hashable & Identifiable>: View {
    let tabs: [Tab]
    @Binding var selection: Tab
    let title: (Tab) -> String

    @Namespace private var namespace
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(tabs) { tab in
                let isSelected = tab == selection
                Button {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        selection = tab
                    }
                } label: {
                    Text(title(tab))
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .padding(.horizontal, Spacing.m + 2)
                        .padding(.vertical, Spacing.s)
                        .background {
                            if isSelected {
                                Capsule()
                                    .fill(Theme.surface)
                                    .matchedGeometryEffect(id: "pill", in: namespace)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .clickable()
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
    }
}
