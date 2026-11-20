import SwiftUI

struct OnboardingFade: ViewModifier {
    let active: Bool
    let offset: CGFloat

    func body(content: Content) -> some View {
        content
            .opacity(active ? 0 : 1)
            .blur(radius: active ? 4 : 0)
            .offset(y: active ? offset : 0)
    }
}

extension AnyTransition {
    static func onboarding(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .modifier(active: OnboardingFade(active: true, offset: 8), identity: OnboardingFade(active: false, offset: 0)),
            removal: .modifier(active: OnboardingFade(active: true, offset: -4), identity: OnboardingFade(active: false, offset: 0))
        )
    }
}

struct OnboardingGhostButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(TypeScale.rowSubtitle.weight(.medium))
            .foregroundStyle(hovering ? Theme.textPrimary : Theme.textSecondary)
            .padding(.horizontal, Spacing.m)
            .frame(minHeight: 32)
            .background(hovering ? Theme.hover : Color.clear, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
            .contentShape(Capsule())
            .clickable()
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}

struct OnboardingHeader: View {
    let title: String
    let description: String

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Spacing.l) {
            RunelayAppMark(size: 56)
                .softElevation(lifted: true)
            ZStack {
                VStack(spacing: Spacing.xs) {
                    Text(title)
                        .font(BrandFonts.sans(20, weight: .semibold))
                        .tracking(-0.4)
                        .foregroundStyle(Theme.textPrimary)
                        .multilineTextAlignment(.center)
                    Text(description)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .id(title)
                .transition(.onboarding(reduceMotion: reduceMotion))
            }
            .animation(Motion.animation(reduceMotion: reduceMotion), value: title)
        }
        .frame(maxWidth: .infinity)
    }
}

struct OnboardingField<Content: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs + 2) {
            Text(label)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
            content
                .textFieldStyle(.plain)
                .font(TypeScale.body)
                .padding(.horizontal, Spacing.m)
                .frame(height: 44)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            if let hint {
                Text(hint)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct OnboardingPrimaryButton: View {
    let title: String
    var systemImage: String?
    var busy = false
    var busyTitle: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xs + 2) {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.onAccent)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 13, weight: .semibold))
                }
                Text(busy ? (busyTitle ?? title) : title)
                    .lineLimit(1)
                    .fixedSize()
            }
            .frame(maxWidth: .infinity)
            .frame(height: 40)
        }
        .buttonStyle(.brandPrimary)
    }
}
