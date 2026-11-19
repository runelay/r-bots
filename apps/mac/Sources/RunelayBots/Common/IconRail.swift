import SwiftUI

enum FrameMetrics {
    static let railWidth: CGFloat = 56
    @MainActor static var stripHeight: CGFloat { WindowChrome.shared.stripHeight }
    static let panelInset: CGFloat = 8
    static let sidebarWidth: CGFloat = 300
}

struct IconRail: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 6) {
            RailLogo()
                .padding(.bottom, Spacing.s)
            ForEach(AppSection.railCases) { section in
                RailButton(
                    systemImage: section.systemImage,
                    help: section.title,
                    isSelected: model.section == section && !model.settingsPresented
                ) {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        model.closeSettings()
                        model.section = section
                    }
                    if section == .accounts {
                        Task { await model.loadAccounts() }
                    }
                }
            }
            Spacer(minLength: 0)
            UsageRailIndicator()
                .padding(.bottom, Spacing.xs)
            RailButton(systemImage: "gearshape", help: "Configurações (⌘,)", isSelected: model.settingsPresented) {
                withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                    if model.settingsPresented {
                        model.closeSettings()
                    } else {
                        model.openSettings()
                    }
                }
            }
        }
        .padding(.top, Spacing.m - 4)
        .padding(.bottom, FrameMetrics.panelInset + Spacing.xs)
        .frame(width: FrameMetrics.railWidth)
        .frame(maxHeight: .infinity)
    }
}

struct RailLogo: View {
    @State private var isHovering = false

    var body: some View {
        RunelayAppMark(size: 32, split: isHovering)
            .frame(width: 40, height: 40)
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovering = hovering
            }
            .springAnimation(value: isHovering)
            .help("runelay")
    }
}

struct RailButton: View {
    let systemImage: String
    let help: String
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 40, height: 40)
                .background(
                    isSelected ? Theme.railSelected : (isHovering ? Theme.hover : Theme.maskHidden),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isSelected)
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
