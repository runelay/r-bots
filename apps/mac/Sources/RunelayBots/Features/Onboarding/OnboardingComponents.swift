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

struct SetupProgressBar: View {
    let completed: Int
    let total: Int

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Spacing.m) {
            GeometryReader { geometry in
                Capsule()
                    .fill(Theme.textPrimary.opacity(0.08))
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(Theme.textPrimary)
                            .frame(width: geometry.size.width * CGFloat(completed) / CGFloat(max(total, 1)))
                    }
            }
            .frame(height: 4)
            .animation(reduceMotion ? Motion.reduced : .easeOut(duration: 0.8), value: completed)
            Text("\(completed) de \(total)")
                .font(TypeScale.caption.monospacedDigit())
                .foregroundStyle(Theme.textSecondary)
                .contentTransition(.numericText())
                .lineLimit(1)
                .fixedSize()
        }
    }
}

struct TimelineNode: View {
    let index: Int
    let done: Bool
    let active: Bool
    let reachable: Bool

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(done ? Theme.textPrimary : (active ? Theme.background : Theme.surface))
            if active && !done {
                Circle()
                    .strokeBorder(Theme.textPrimary, lineWidth: 1)
                Circle()
                    .stroke(Theme.textPrimary.opacity(0.08), lineWidth: 4)
                    .padding(-3)
            }
            Group {
                if done {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Theme.background)
                } else {
                    Text("\(index)")
                        .font(BrandFonts.sans(11, weight: .semibold).monospacedDigit())
                        .foregroundStyle(active ? Theme.textPrimary : Theme.textSecondary)
                }
            }
            .id(done)
            .transition(reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity))
        }
        .frame(width: 28, height: 28)
        .opacity(reachable ? 1 : 0.6)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: done)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: active)
    }
}

struct TimelineConnector: View {
    let filled: Bool

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        Rectangle()
            .fill(Theme.textPrimary.opacity(0.1))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Theme.textPrimary)
                    .scaleEffect(x: 1, y: filled ? 1 : 0, anchor: .top)
            }
            .frame(width: 1)
            .animation(reduceMotion ? Motion.reduced : .easeOut(duration: 0.7), value: filled)
    }
}

struct TimelineStepView<Body: View, Actions: View>: View {
    let step: SetupStepID
    let index: Int
    let done: Bool
    let open: Bool
    let reachable: Bool
    let last: Bool
    var summary: String?
    let onToggle: () -> Void
    let onSkip: () -> Void
    @ViewBuilder let content: Body
    @ViewBuilder let actions: Actions

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var hovering = false
    @State private var appeared = false

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.l) {
            VStack(spacing: 0) {
                TimelineNode(index: index, done: done, active: open, reachable: reachable)
                if !last {
                    TimelineConnector(filled: done)
                        .padding(.top, Spacing.xs)
                        .padding(.bottom, -Spacing.xs)
                }
            }
            .frame(width: 28)

            VStack(alignment: .leading, spacing: 0) {
                Button(action: onToggle) {
                    HStack(spacing: Spacing.s) {
                        Text(step.title)
                            .font(BrandFonts.sans(14, weight: .semibold))
                            .foregroundStyle(done && !open ? Theme.textSecondary : Theme.textPrimary)
                            .lineLimit(1)
                        if reachable {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Theme.textSecondary)
                                .rotationEffect(.degrees(open ? 180 : 0))
                                .opacity(open || hovering ? 1 : 0)
                        }
                        Spacer(minLength: Spacing.s)
                        if done && !open {
                            Text(summary ?? step.doneSummary)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .transition(.opacity)
                        }
                    }
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!reachable)
                .onHover { hovering = $0 && reachable }
                .modifier(PointerIf(enabled: reachable))

                if open {
                    VStack(alignment: .leading, spacing: Spacing.l) {
                        if !step.description.isEmpty {
                            Text(step.description)
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(Theme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        content
                        HStack(spacing: Spacing.s) {
                            actions
                            if !done {
                                Button(step.skipLabel, action: onSkip)
                                    .buttonStyle(OnboardingGhostButtonStyle())
                            }
                        }
                    }
                    .padding(.top, Spacing.s)
                    .transition(.onboarding(reduceMotion: reduceMotion))
                }
            }
            .padding(.bottom, last ? Spacing.s : Spacing.xxl + Spacing.s)
        }
        .opacity(appeared ? (reachable ? 1 : 0.55) : 0)
        .offset(y: appeared || reduceMotion ? 0 : 10)
        .blur(radius: appeared || reduceMotion ? 0 : 4)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: open)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: done)
        .onAppear {
            withAnimation((reduceMotion ? Motion.reduced : .easeOut(duration: 0.5)).delay(Double(index) * 0.08)) {
                appeared = true
            }
        }
    }
}

private struct PointerIf: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.clickable()
        } else {
            content
        }
    }
}
