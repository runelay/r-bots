import SwiftUI

enum FrameMetrics {
    static let railWidth: CGFloat = 56
    @MainActor static var stripHeight: CGFloat { WindowChrome.shared.stripHeight }
    static let panelInset: CGFloat = 8
    static let sidebarWidth: CGFloat = 300
    static let titleLeading: CGFloat = 84
    static let sidebarContentTrailing: CGFloat = railWidth + sidebarWidth - Spacing.m
}

struct IconRail: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @AppStorage(PreferenceKeys.sidebarCollapsed) private var sidebarCollapsed = false

    private var showsLauncher: Bool {
        model.section != .conversations || model.settingsPresented || sidebarCollapsed
    }

    var body: some View {
        VStack(spacing: 6) {
            RailLogo()
                .padding(.bottom, Spacing.s)
            ForEach(AppSection.railCases) { section in
                RailButton(
                    help: help(for: section),
                    isSelected: model.section == section && !model.settingsPresented
                ) {
                    select(section)
                } icon: {
                    if let mark = section.brandMark {
                        BrandMarkImage(mark: mark, size: 18)
                    } else {
                        Image(systemName: section.systemImage)
                            .font(.system(size: 17, weight: .regular))
                    }
                }
            }
            Spacer(minLength: 0)
            if showsLauncher {
                RailButton(help: "Atalhos", isSelected: model.launcherPresented) {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        model.launcherPresented.toggle()
                    }
                } icon: {
                    GridPlusIcon()
                        .rotationEffect(.degrees(model.launcherPresented && !reduceMotion ? 90 : 0))
                }
                .transition(.opacity.combined(with: .scale(scale: 0.85)))
            }
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
        .animation(Motion.animation(reduceMotion: reduceMotion), value: showsLauncher)
    }

    private func help(for section: AppSection) -> String {
        switch section {
        case .conversations: "Conversas (⌥⌘1)"
        case .git: "Git (⌥⌘2)"
        case .linear: "Linear (⌥⌘3)"
        default: section.title
        }
    }

    private func select(_ section: AppSection) {
        if section == .conversations, model.section == .conversations, !model.settingsPresented {
            sidebarCollapsed.toggle()
            return
        }
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            model.go(to: section)
        }
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
            .help("r/bots")
    }
}

struct RailButton<Icon: View>: View {
    let help: String
    let isSelected: Bool
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon

    @State private var isHovering = false

    init(help: String, isSelected: Bool, action: @escaping () -> Void, @ViewBuilder icon: @escaping () -> Icon) {
        self.help = help
        self.isSelected = isSelected
        self.action = action
        self.icon = icon
    }

    var body: some View {
        Button(action: action) {
            icon()
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

extension RailButton where Icon == RailSymbol {
    init(systemImage: String, help: String, isSelected: Bool, action: @escaping () -> Void) {
        self.init(help: help, isSelected: isSelected, action: action) {
            RailSymbol(systemImage: systemImage)
        }
    }
}

struct RailSymbol: View {
    let systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 17, weight: .regular))
    }
}
