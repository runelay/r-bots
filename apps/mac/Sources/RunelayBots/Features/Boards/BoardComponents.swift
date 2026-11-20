import AppKit
import SwiftUI

struct RemoteAvatar: View {
    let url: String?
    let name: String
    var size: CGFloat = 20

    private var initials: String {
        let parts = name.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "-" || $0 == "_" || $0 == "@" })
        let letters = parts.prefix(2).compactMap(\.first).map(String.init).joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }

    var body: some View {
        ZStack {
            Circle().fill(Theme.surfaceRaised)
            if let url, let parsed = URL(string: url) {
                AsyncImage(url: parsed, transaction: Transaction(animation: Motion.crossFade)) { phase in
                    if let image = phase.image {
                        image.resizable().interpolation(.high).scaledToFill()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .help(name)
        .accessibilityLabel(name)
    }

    private var fallback: some View {
        Text(initials)
            .font(BrandFonts.sans(size * 0.4, weight: .semibold))
            .foregroundStyle(Theme.textSecondary)
            .minimumScaleFactor(0.5)
    }
}

struct BoardChip: View {
    let text: String
    var systemImage: String? = nil
    var tint: Color = Theme.textSecondary
    var filled = false

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 9.5, weight: .semibold))
            }
            Text(text)
                .font(BrandFonts.sans(11, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(filled ? tint.opacity(0.14) : Theme.surface, in: Capsule())
        .fixedSize()
    }
}

struct BoardDot: View {
    let color: Color
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
    }
}

struct BoardIconButton: View {
    let systemImage: String
    let help: String
    var spinning = false
    let action: () -> Void

    @State private var hovering = false
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(hovering ? Theme.textPrimary : Theme.textSecondary)
                .rotationEffect(.degrees(spinning && !reduceMotion ? 360 : 0))
                .animation(spinning && !reduceMotion ? .linear(duration: 0.9).repeatForever(autoreverses: false) : .default, value: spinning)
                .frame(width: 30, height: 30)
                .background(hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct BoardActionButton: View {
    let title: String
    var systemImage: String? = nil
    var prominent = false
    var tint: Color = Theme.brandAccent
    var isBusy = false
    let action: () -> Void

    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isBusy {
                    ProgressView().controlSize(.mini)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 11.5, weight: .semibold))
                }
                Text(title)
                    .font(TypeScale.captionStrong)
                    .lineLimit(1)
            }
            .foregroundStyle(prominent ? Theme.onAccent : Theme.textPrimary)
            .padding(.horizontal, Spacing.m)
            .frame(height: 30)
            .background(background, in: Capsule())
            .contentShape(Capsule())
            .opacity(isEnabled ? 1 : 0.45)
            .fixedSize()
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }

    private var background: Color {
        if prominent { return hovering && isEnabled ? tint.opacity(0.88) : tint }
        return hovering && isEnabled ? Theme.selection : Theme.surface
    }
}

struct BoardSegment<Item: Hashable & Identifiable>: View {
    let items: [Item]
    let selection: Item
    let title: (Item) -> String
    let count: (Item) -> Int?
    let onSelect: (Item) -> Void

    @Namespace private var namespace
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items) { item in
                let isSelected = item == selection
                Button {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        onSelect(item)
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(title(item))
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        if let value = count(item), value > 0 {
                            Text(value > 99 ? "99+" : "\(value)")
                                .font(TypeScale.counter)
                                .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textTertiary)
                                .contentTransition(.numericText())
                        }
                    }
                    .padding(.horizontal, Spacing.m)
                    .frame(height: 28)
                    .background {
                        if isSelected {
                            Capsule()
                                .fill(Theme.background)
                                .softElevation()
                                .matchedGeometryEffect(id: "segment", in: namespace)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .clickable()
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Theme.surface, in: Capsule())
    }
}

struct BoardNoticeView: View {
    let notice: BoardNotice
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: notice.isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(notice.isError ? Theme.danger : Theme.success)
            Text(notice.text)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: 18, height: 18)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .clickable()
        }
        .padding(.leading, Spacing.m)
        .padding(.trailing, Spacing.s)
        .frame(height: 36)
        .glassSurface(Capsule(), fallback: Theme.surfaceRaised)
        .softElevation(lifted: true)
        .frame(maxWidth: 420)
    }
}

struct BoardInlineNotice: View {
    let systemImage: String
    let title: String
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: Spacing.m) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 52, height: 52)
                .background(Theme.surface, in: Circle())
            VStack(spacing: Spacing.xs) {
                Text(title)
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                Text(message)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 340)
            }
            if let actionTitle, let action {
                BoardActionButton(title: actionTitle, action: action)
            }
        }
        .padding(Spacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ShimmerBlock: View {
    var width: CGFloat? = nil
    var height: CGFloat = 10
    var radius: CGFloat = 4

    @State private var lit = false
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Theme.surfaceRaised)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
            .opacity(lit ? 0.55 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    lit = true
                }
            }
            .accessibilityHidden(true)
    }
}

struct BoardSearchField: View {
    @Binding var text: String
    let prompt: String
    var isEnabled = true

    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .focused($focused)
                .disabled(!isEnabled)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textTertiary)
                }
                .buttonStyle(.plain)
                .clickable()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 30)
        .background(focused ? Theme.hover : Theme.hover.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .opacity(isEnabled ? 1 : 0.5)
        .springAnimation(value: focused)
    }
}

enum BoardLinks {
    @MainActor
    static func open(_ text: String?) {
        guard let text, let url = URL(string: text) else { return }
        NSWorkspace.shared.open(url)
    }
}

struct BoardBackShortcuts: View {
    var escapes = true

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion

    private var blocked: Bool {
        model.launcherPresented || model.activeSheet != nil || model.settingsPresented
    }

    var body: some View {
        ZStack {
            if escapes {
                Button("Voltar às conversas", action: back)
                    .keyboardShortcut(.cancelAction)
                    .disabled(blocked)
            }
            Button("Voltar às conversas", action: back)
                .keyboardShortcut("[", modifiers: .command)
                .disabled(blocked)
        }
        .opacity(0)
        .accessibilityHidden(true)
    }

    private func back() {
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            model.go(to: .conversations)
        }
    }
}
