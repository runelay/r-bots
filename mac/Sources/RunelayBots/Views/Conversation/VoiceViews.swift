import SwiftUI

struct VoiceWaveform: View {
    let voice: VoiceInput
    var barCount: Int = VoiceInput.levelCount
    var height: CGFloat = 18
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            HStack(spacing: Spacing.s) {
                Circle()
                    .fill(Theme.brandText)
                    .frame(width: 6, height: 6)
                    .opacity(0.35 + 0.65 * Double(voice.levels.last ?? 0))
                Text("Ouvindo…")
                    .font(TypeScale.body)
                    .foregroundStyle(Theme.textTertiary)
            }
            .frame(height: height)
        } else {
            Canvas { context, size in
                let step = barWidth + barGap
                let count = max(1, Int(size.width / step))
                let source = voice.levels
                let visible = source.suffix(count)
                let padding = count - visible.count
                for (offset, level) in visible.enumerated() {
                    let index = offset + padding
                    let eased = sqrt(max(0, min(1, level)))
                    let barHeight = max(barWidth, size.height * eased)
                    let x = size.width - CGFloat(count - index) * step + barGap / 2
                    let rect = CGRect(x: x, y: (size.height - barHeight) / 2, width: barWidth, height: barHeight)
                    let fade = 0.18 + 0.82 * Double(index) / Double(max(1, count - 1))
                    context.opacity = fade * (0.55 + 0.45 * Double(eased))
                    context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(Theme.textPrimary))
                }
            }
            .frame(height: height)
            .frame(maxWidth: .infinity)
        }
    }

    private let barWidth: CGFloat = 2.5
    private let barGap: CGFloat = 2.5
}

struct VoiceElapsed: View {
    let since: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(label(now: context.date))
                .font(TypeScale.counter)
                .monospacedDigit()
                .foregroundStyle(Theme.textTertiary)
                .contentTransition(.numericText())
        }
    }

    private func label(now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(since ?? now)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

struct VoiceStopButton: View {
    let action: () -> Void
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                .fill(Theme.textPrimary)
                .frame(width: 10, height: 10)
                .modifier(SoftPulse(isEnabled: !reduceMotion))
                .frame(width: 34, height: 34)
                .glassSurface(Circle(), interactive: true, fallback: Theme.surfaceRaised)
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .help("Parar de ouvir (solte ⌥Espaço)")
        .accessibilityLabel("Parar de ouvir")
    }
}

struct SoftPulse: ViewModifier {
    let isEnabled: Bool

    func body(content: Content) -> some View {
        if isEnabled {
            content.phaseAnimator([false, true]) { view, expanded in
                view
                    .scaleEffect(expanded ? 0.82 : 1)
                    .opacity(expanded ? 0.7 : 1)
            } animation: { _ in
                .easeInOut(duration: 0.9)
            }
        } else {
            content
        }
    }
}

struct VoiceNoticeLine: View {
    let voice: VoiceInput
    @State private var pickerOpen = false

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: voice.deniedPermission == nil ? "exclamationmark.circle" : "mic.slash")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
            if let permission = voice.deniedPermission {
                Button("Abrir Ajustes") {
                    voice.openSettings(for: permission)
                }
                .buttonStyle(.plain)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.brandText)
                .clickable()
            } else if voice.quietMicrophone != nil {
                Button("Trocar") {
                    pickerOpen = true
                }
                .buttonStyle(.plain)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.brandText)
                .clickable()
                .popover(isPresented: $pickerOpen, arrowEdge: .top) {
                    MicrophonePicker { _ in
                        pickerOpen = false
                        voice.switchMicrophone()
                    }
                    .padding(Spacing.l)
                    .frame(width: 300)
                }
            }
            Button {
                voice.dismissNotice()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: 18, height: 18)
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Fechar aviso")
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 30)
        .glassSurface(Capsule(), fallback: Theme.surface)
    }

    private var message: String {
        voice.deniedPermission?.message ?? voice.failure ?? ""
    }
}
