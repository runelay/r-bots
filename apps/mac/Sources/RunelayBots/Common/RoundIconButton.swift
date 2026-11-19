import SwiftUI

struct RoundIconButton: View {
    let systemImage: String
    let help: String
    var size: CGFloat = 32
    var isActive = false
    let action: () -> Void

    @State private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.42, weight: .medium))
                .foregroundStyle(isActive ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: size, height: size)
                .glassSurface(
                    Circle(),
                    interactive: true,
                    tint: isActive ? Theme.selection : nil,
                    fallback: isHovering || isActive ? Theme.surfaceRaised : Theme.surface
                )
                .contentShape(Circle())
                .opacity(isEnabled ? 1 : 0.35)
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
    }
}
