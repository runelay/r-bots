import SwiftUI

enum UsagePalette {
    static let claude = Color.brand(light: 0xC96442, dark: 0xD97757)
    static let codex = Color.brand(light: 0x3A3A3A, dark: 0xD4D4D4)
    static let track = Color.dynamic(light: Theme.rgb(0x000000), dark: Theme.rgb(0xFFFFFF), lightAlpha: 0.12, darkAlpha: 0.14)
    static let healthy = Theme.brandAccent
    static let healthyInner = Theme.brandAccent.opacity(0.55)
    static let uncached = Theme.brandAccent
    static let cacheWrite = Theme.stripe3
    static let cacheRead = Theme.success
    static let output = Theme.merged

    static func provider(_ provider: String) -> Color {
        provider == "claude" ? claude : codex
    }

    static func remaining(_ value: Double?) -> Color {
        guard let value else { return Theme.textTertiary }
        if value < 10 { return Theme.danger }
        if value < 25 { return Theme.warning }
        return healthy
    }
}

struct UsageRing: View {
    let provider: String
    let session: Double?
    let long: Double?
    var size: CGFloat = 35
    var badge: String? = nil

    private var lineWidth: CGFloat { size < 32 ? 2.5 : 3 }
    private let gap: CGFloat = 2

    var body: some View {
        ZStack {
            arc(session, diameter: size, inner: false)
            arc(long, diameter: size - (lineWidth + gap) * 2, inner: true)
            ProviderLogo(provider: provider, size: size * 0.4)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if let badge, !badge.isEmpty {
                Text(badge)
                    .font(.system(size: 7.5, weight: .bold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 2.5)
                    .frame(height: 11)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
                    .offset(x: 3, y: 2)
            }
        }
    }

    private func arc(_ value: Double?, diameter: CGFloat, inner: Bool) -> some View {
        ZStack {
            Circle()
                .stroke(UsagePalette.track, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: CGFloat(max(0, min(100, value ?? 0))) / 100)
                .stroke(inner && (value ?? 0) >= 25 ? UsagePalette.healthyInner : UsagePalette.remaining(value), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: diameter - lineWidth, height: diameter - lineWidth)
        .springAnimation(value: value)
    }
}

struct UsageRailIndicator: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var store = UsageStore.shared

    private func ringSize(_ count: Int) -> CGFloat {
        switch count {
        case ...3: 35
        case 4: 31
        default: 27
        }
    }

    var body: some View {
        let rings = store.rings
        if !rings.isEmpty {
            let size = ringSize(rings.count)
            VStack(spacing: rings.count > 3 ? Spacing.xs : Spacing.s) {
                ForEach(rings) { ring in
                    UsageRailButton(ring: ring, size: size, isSelected: model.section == .usage && !model.settingsPresented && store.focusAccount == ring.id) {
                        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                            store.provider = nil
                            store.account = nil
                            store.tab = .limits
                            store.focusAccount = ring.id
                            model.closeSettings()
                            model.section = .usage
                        }
                    }
                }
            }
            .transition(.opacity)
            .springAnimation(value: rings.map(\.id))
        }
    }
}

private struct UsageRailButton: View {
    let ring: UsageRingState
    let size: CGFloat
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            UsageRing(provider: ring.provider, session: ring.session, long: ring.long, size: size, badge: ring.badge)
                .opacity(ring.dimmed ? 0.4 : 1)
                .frame(width: 40, height: size + 5)
                .background(
                    isSelected ? Theme.railSelected : (isHovering ? Theme.hover : Theme.maskHidden),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isSelected)
        .springAnimation(value: size)
        .help(ring.tooltip)
        .accessibilityLabel(ring.tooltip)
    }
}
