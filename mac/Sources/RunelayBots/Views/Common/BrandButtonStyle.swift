import SwiftUI

struct BrandButtonStyle: ButtonStyle {
    enum Kind {
        case primary
        case secondary
    }

    let kind: Kind
    @Environment(\.appReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(TypeScale.rowTitle)
            .foregroundStyle(kind == .primary ? Theme.onAccent : Theme.textPrimary)
            .padding(.horizontal, Spacing.l + 2)
            .frame(minHeight: 36)
            .glassSurface(
                Capsule(),
                interactive: true,
                tint: kind == .primary ? Theme.brandAccent : nil,
                fallback: kind == .primary ? Theme.brandAccent : Theme.surfaceRaised
            )
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .contentShape(Capsule())
            .clickable()
            .animation(Motion.animation(reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == BrandButtonStyle {
    static var brandPrimary: BrandButtonStyle { BrandButtonStyle(kind: .primary) }
    static var brandSecondary: BrandButtonStyle { BrandButtonStyle(kind: .secondary) }
}
