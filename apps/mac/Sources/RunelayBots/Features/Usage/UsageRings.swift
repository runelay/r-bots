import SwiftUI

enum UsagePalette {
    static let claude = Color.brand(light: 0xC96442, dark: 0xD97757)
    static let codex = Color.brand(light: 0x3A3A3A, dark: 0xD4D4D4)
    static let codexChart = Color.brand(light: 0x0E8F6F, dark: 0x19C37D)
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

    private let lineWidth: CGFloat = 3
    private let gap: CGFloat = 2

    var body: some View {
        ZStack {
            arc(session, diameter: size, inner: false)
            arc(long, diameter: size - (lineWidth + gap) * 2, inner: true)
            ProviderLogo(provider: provider, size: 14)
        }
        .frame(width: size, height: size)
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

    var body: some View {
        let rings = ["claude", "codex"].compactMap { store.ring(for: $0) }
        if !rings.isEmpty {
            VStack(spacing: Spacing.s) {
                ForEach(rings, id: \.provider) { ring in
                    UsageRailButton(ring: ring, isSelected: model.section == .usage && !model.settingsPresented) {
                        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                            model.closeSettings()
                            model.section = .usage
                        }
                    }
                }
            }
            .transition(.opacity)
        }
    }
}

private struct UsageRailButton: View {
    let ring: UsageRingState
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            UsageRing(provider: ring.provider, session: ring.session, long: ring.long, size: 35)
                .frame(width: 40, height: 40)
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
        .help(ring.tooltip)
        .accessibilityLabel(ring.tooltip)
    }
}
