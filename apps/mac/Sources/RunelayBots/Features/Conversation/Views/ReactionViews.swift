import AppKit
import SwiftUI

struct ReactionBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let reactions: [MessageReaction]
    let me: String?
    let trailing: Bool
    let toggle: (String) -> Void

    var body: some View {
        let groups = ReactionGroup.groups(reactions, me: me)
        HStack(spacing: Spacing.xs) {
            ForEach(groups) { group in
                ReactionPill(group: group, bots: group.botIDs.compactMap { model.bot(id: $0) }) {
                    toggle(group.emoji)
                }
                .transition(reduceMotion ? .opacity : .scale(scale: 0.5, anchor: trailing ? .trailing : .leading).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: groups)
    }
}

struct ReactionPill: View {
    let group: ReactionGroup
    let bots: [Bot]
    let action: () -> Void

    @State private var isHovering = false

    private var tooltip: String {
        var names: [String] = []
        if group.mine {
            names.append("você")
        }
        let others = group.userCount - (group.mine ? 1 : 0)
        if others > 0 {
            names.append(others == 1 ? "outra pessoa" : "\(others) pessoas")
        }
        names.append(contentsOf: bots.map(\.name))
        let who = names.count > 1 ? names.dropLast().joined(separator: ", ") + " e " + (names.last ?? "") : names.first ?? ""
        let hint = group.mine ? "Clique para tirar a sua reação" : "Clique para reagir também"
        return "\(group.emoji) \(who)\n\(hint)"
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xs) {
                Text(group.emoji)
                    .font(.system(size: 13))
                ForEach(bots.prefix(2), id: \.id) { bot in
                    BotCharacter(bot: bot, mood: .idle, size: 12)
                        .frame(width: 12, height: 12)
                }
                if group.count > 1 || bots.isEmpty {
                    Text("\(group.count)")
                        .font(TypeScale.counter)
                        .foregroundStyle(group.mine ? Theme.brandText : Theme.textSecondary)
                        .contentTransition(.numericText())
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 24)
            .background(background, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: group)
        .help(tooltip)
        .accessibilityLabel(tooltip)
    }

    private var background: Color {
        if group.mine {
            return Theme.brandAccent.opacity(isHovering ? 0.22 : 0.15)
        }
        return isHovering ? Theme.surfaceRaised : Theme.surface
    }
}

struct ReactionPickerButton: View {
    let edge: GlassMenuEdge
    @Binding var isOpen: Bool
    var showsMore = true
    let pick: (String) -> Void

    @State private var isHovering = false

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            Image(systemName: "face.smiling")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isHovering || isOpen ? Theme.textPrimary : Theme.textTertiary)
                .frame(width: 26, height: 26)
                .background(isHovering || isOpen ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .glassPopup(isPresented: $isOpen, edge: edge) {
            QuickReactionsPopup(showsMore: showsMore, pick: pick)
        }
        .help("Reagir")
        .accessibilityLabel("Reagir")
    }
}

struct QuickReactionsPopup: View {
    @Environment(\.glassPopupDismiss) private var dismiss
    let showsMore: Bool
    let pick: (String) -> Void

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            ForEach(QuickReactions.emojis, id: \.self) { emoji in
                QuickReactionButton(emoji: emoji) {
                    dismiss()
                    pick(emoji)
                }
            }
            if showsMore {
                MoreReactionsButton {
                    dismiss()
                    EmojiPalette.shared.pick(pick)
                }
            }
        }
        .padding(Spacing.xs)
    }
}

private struct QuickReactionButton: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let emoji: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Text(emoji)
                .font(.system(size: 20))
                .scaleEffect(isHovering && !reduceMotion ? 1.18 : 1)
                .frame(width: 34, height: 34)
                .background(isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .help("Reagir com \(emoji)")
        .accessibilityLabel("Reagir com \(emoji)")
    }
}

private struct MoreReactionsButton: View {
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xs) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
                Text("Mais…")
                    .font(TypeScale.captionStrong)
            }
            .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textSecondary)
            .padding(.horizontal, Spacing.s)
            .frame(height: 34)
            .background(isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .help("Escolher outro emoji")
        .accessibilityLabel("Escolher outro emoji")
    }
}

@MainActor
final class EmojiPalette: NSObject, NSTextViewDelegate, NSWindowDelegate {
    static let shared = EmojiPalette()

    private var panel: NSPanel?
    private var completion: ((String) -> Void)?
    private var closeTask: Task<Void, Never>?

    func pick(_ completion: @escaping (String) -> Void) {
        close()
        self.completion = completion
        let point = NSEvent.mouseLocation
        let panel = EmojiCapturePanel(
            contentRect: NSRect(x: point.x, y: point.y - 2, width: 2, height: 2),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.alphaValue = 0.01
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.delegate = self
        let field = NSTextView(frame: NSRect(x: 0, y: 0, width: 2, height: 2))
        field.drawsBackground = false
        field.isRichText = false
        field.delegate = self
        panel.contentView = field
        self.panel = panel
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        NSApp.orderFrontCharacterPalette(field)
        closeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(90))
            guard !Task.isCancelled else { return }
            self?.close()
        }
    }

    func textDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextView else { return }
        let text = field.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = text.first else { return }
        let emoji = String(first)
        let done = completion
        close()
        if emoji.unicodeScalars.contains(where: { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0xFF) }) {
            done?(emoji)
        }
    }

    func windowDidResignKey(_ notification: Notification) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard let self, let panel = self.panel, !panel.isKeyWindow, let key = NSApp.keyWindow, key !== panel else { return }
            self.close()
        }
    }

    private func close() {
        closeTask?.cancel()
        closeTask = nil
        completion = nil
        panel?.delegate = nil
        panel?.orderOut(nil)
        panel = nil
    }
}

private final class EmojiCapturePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
