import AppKit
import SwiftUI

private final class ControlTabPanel: NSPanel {
    var acceptsKey = false
    override var canBecomeKey: Bool { acceptsKey }
    override var canBecomeMain: Bool { false }
}

private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class ComputerControlTab {
    static let earWidth: CGFloat = 84
    static let glowPad: CGFloat = 14
    static let plainWidth: CGFloat = 220
    static let plainHeight: CGFloat = 30
    static let cardWidth: CGFloat = 380
    static let cardGap: CGFloat = Spacing.s
    private let panel: ControlTabPanel
    private let host: FirstMouseHostingView<ControlTabView>
    private let state: ComputerOverlayState
    private let stop: @MainActor () -> Void
    private let open: @MainActor (IslandPrompt) -> Void
    private var visible = false
    private var height = ComputerControlTab.plainHeight
    private var notchWidth: CGFloat = 0
    private var tabWidth = ComputerControlTab.plainWidth
    private var cardHeight: CGFloat = 0
    private var collapse: Task<Void, Never>?

    init(state: ComputerOverlayState, stop: @escaping @MainActor () -> Void, open: @escaping @MainActor (IslandPrompt) -> Void) {
        self.state = state
        self.stop = stop
        self.open = open
        panel = ControlTabPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.plainWidth, height: Self.plainHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        host = FirstMouseHostingView(rootView: ControlTabView(state: state, stop: stop, open: open, notchWidth: 0, tabWidth: Self.plainWidth, height: Self.plainHeight))
        panel.contentView = host
    }

    var isVisible: Bool { visible }

    func update() {
        let wanted = state.computerActive || state.promptVisible
        if wanted {
            collapse?.cancel()
            panel.acceptsKey = state.promptVisible
            reposition()
            if !visible {
                visible = true
                if !state.promptVisible {
                    cardHeight = 0
                    applyFrame()
                }
                panel.alphaValue = 0
                panel.orderFrontRegardless()
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.25
                    panel.animator().alphaValue = 1
                }
            } else if !state.promptVisible {
                scheduleShrink()
            }
        } else if visible {
            hide()
        }
    }

    private func scheduleShrink() {
        collapse?.cancel()
        collapse = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(380))
            guard let self, !Task.isCancelled, !self.state.promptVisible else { return }
            self.panel.acceptsKey = false
            if self.panel.isKeyWindow {
                self.panel.resignKey()
            }
            self.cardHeight = 0
            self.applyFrame()
        }
    }

    private func hide() {
        visible = false
        collapse?.cancel()
        panel.acceptsKey = false
        let panel = panel
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.visible else { return }
                panel.orderOut(nil)
                self.cardHeight = 0
            }
        }
    }

    func reposition() {
        guard let screen = NSScreen.screens.first else { return }
        var notchWidth: CGFloat = 0
        var height = Self.plainHeight
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea, screen.safeAreaInsets.top > 0 {
            notchWidth = max(0, right.minX - left.maxX)
            height = screen.safeAreaInsets.top
        }
        self.height = height
        self.notchWidth = notchWidth
        tabWidth = notchWidth > 0 ? notchWidth + Self.earWidth * 2 + TabShape.flare * 2 : Self.plainWidth
        if state.promptVisible, let prompt = state.prompt {
            cardHeight = measure(prompt)
        }
        host.rootView = ControlTabView(state: state, stop: stop, open: open, notchWidth: notchWidth, tabWidth: tabWidth, height: height)
        applyFrame()
    }

    private func measure(_ prompt: IslandPrompt) -> CGFloat {
        let probe = NSHostingView(rootView: IslandPromptCard(prompt: prompt, open: {}).environment(\.appReduceMotion, true))
        return ceil(probe.fittingSize.height)
    }

    private func applyFrame() {
        guard let screen = NSScreen.screens.first else { return }
        let frame = screen.frame
        var centerX = frame.midX
        if let left = screen.auxiliaryTopLeftArea, notchWidth > 0 {
            centerX = left.maxX + notchWidth / 2
        }
        let pad = Self.glowPad
        let expanded = cardHeight > 0
        let width = (expanded ? max(tabWidth, Self.cardWidth) : tabWidth) + pad * 2
        let total = height + pad + (expanded ? Self.cardGap + cardHeight : 0)
        host.frame = NSRect(x: 0, y: 0, width: width, height: total)
        panel.setFrame(NSRect(x: centerX - width / 2, y: frame.maxY - total, width: width, height: total), display: true)
    }
}

struct ControlTabView: View {
    let state: ComputerOverlayState
    let stop: @MainActor () -> Void
    let open: @MainActor (IslandPrompt) -> Void
    let notchWidth: CGFloat
    let tabWidth: CGFloat
    let height: CGFloat
    @State private var isHoveringStop = false

    private var waiting: Bool { state.promptVisible && state.prompt != nil }

    private var mood: CharacterMood {
        if waiting { return .waiting }
        return state.computerActive ? .thinking : .idle
    }

    var body: some View {
        VStack(spacing: ComputerControlTab.cardGap) {
            tab
            if waiting, let prompt = state.prompt {
                IslandPromptCard(prompt: prompt) { open(prompt) }
                    .id(prompt.id)
                    .transition(state.reduceMotion ? .opacity : .asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.85, anchor: .top)).combined(with: .offset(y: -12)),
                        removal: .opacity.combined(with: .scale(scale: 0.92, anchor: .top))
                    ))
            }
        }
        .environment(\.appReduceMotion, state.reduceMotion)
        .animation(Motion.animation(reduceMotion: state.reduceMotion), value: state.promptVisible)
        .animation(Motion.animation(reduceMotion: state.reduceMotion), value: state.prompt?.id)
        .padding(.horizontal, ComputerControlTab.glowPad)
        .padding(.bottom, ComputerControlTab.glowPad)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var tab: some View {
        HStack(spacing: 0) {
            HStack(spacing: Spacing.s - 2) {
                BotCharacter(botID: state.botID, glyph: state.glyph, accent: state.accent, mood: mood, size: 16)
                    .frame(width: 16, height: 16)
                Text(state.botName)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: notchWidth > 0 ? ComputerControlTab.earWidth : .infinity, alignment: .leading)
            if notchWidth > 0 {
                Color.clear.frame(width: notchWidth)
            }
            if state.computerActive {
                stopButton
                    .frame(maxWidth: notchWidth > 0 ? ComputerControlTab.earWidth : nil, alignment: .trailing)
            } else if notchWidth > 0 {
                Color.clear.frame(width: ComputerControlTab.earWidth)
            }
        }
        .padding(.horizontal, TabShape.flare + Spacing.s)
        .frame(width: tabWidth, height: height)
        .background(tabFill)
        .keyframeAnimator(initialValue: 1.0, trigger: state.attention) { content, scale in
            content.scaleEffect(scale, anchor: .top)
        } keyframes: { _ in
            KeyframeTrack {
                SpringKeyframe(state.reduceMotion ? 1 : 1.07, duration: 0.18, spring: .snappy)
                SpringKeyframe(1, duration: 0.45, spring: .bouncy)
            }
        }
        .help(state.computerActive ? "\(state.botName) está usando o computador. Mexer no mouse ou no teclado também para o bot." : "\(state.botName) está esperando sua resposta.")
    }

    private var glowColor: Color { waiting ? Theme.attention : state.color }

    @ViewBuilder
    private var tabFill: some View {
        if waiting, !state.reduceMotion {
            fill
                .phaseAnimator([0.45, 1.0]) { content, phase in
                    content.shadow(color: glowColor.opacity(0.6 * phase), radius: 6 + 6 * phase, y: 2)
                } animation: { _ in
                    .easeInOut(duration: 1.4)
                }
        } else {
            fill
                .shadow(color: glowColor.opacity(0.75), radius: 7, y: 2)
        }
    }

    private var fill: some View {
        TabShape()
            .fill(Color.black)
            .overlay(
                TabShape().fill(
                    LinearGradient(colors: [.clear, .clear, glowColor.opacity(0.28)], startPoint: .top, endPoint: .bottom)
                )
            )
    }

    private var stopButton: some View {
        Button(action: stop) {
            HStack(spacing: Spacing.xs) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Color.white)
                    .frame(width: 7, height: 7)
                if isHoveringStop {
                    Text("Parar")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Color.white)
                        .fixedSize()
                        .transition(.opacity.combined(with: .move(edge: .leading)))
                }
            }
            .padding(.horizontal, isHoveringStop ? Spacing.s : 0)
            .frame(minWidth: 20, minHeight: 20)
            .background(isHoveringStop ? Theme.danger : Color.white.opacity(0.2), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .background(AlwaysHover { hovering in
            isHoveringStop = hovering
        })
        .animation(state.reduceMotion ? nil : Motion.spring, value: isHoveringStop)
        .accessibilityLabel("Parar o bot")
    }
}

struct TabShape: Shape {
    static let flare: CGFloat = 8
    static let bottomRadius: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        let flare = Self.flare
        let radius = min(Self.bottomRadius, rect.height / 2)
        let width = rect.width
        let height = rect.height
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addQuadCurve(to: CGPoint(x: flare, y: flare), control: CGPoint(x: flare, y: 0))
        path.addLine(to: CGPoint(x: flare, y: height - radius))
        path.addQuadCurve(to: CGPoint(x: flare + radius, y: height), control: CGPoint(x: flare, y: height))
        path.addLine(to: CGPoint(x: width - flare - radius, y: height))
        path.addQuadCurve(to: CGPoint(x: width - flare, y: height - radius), control: CGPoint(x: width - flare, y: height))
        path.addLine(to: CGPoint(x: width - flare, y: flare))
        path.addQuadCurve(to: CGPoint(x: width, y: 0), control: CGPoint(x: width - flare, y: 0))
        path.closeSubpath()
        return path
    }
}

struct AlwaysHover: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> HoverTrackingView {
        let view = HoverTrackingView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: HoverTrackingView, context: Context) {
        view.onChange = onChange
    }

    final class HoverTrackingView: NSView {
        var onChange: ((Bool) -> Void)?

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            for area in trackingAreas {
                removeTrackingArea(area)
            }
            addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        }

        override func mouseEntered(with event: NSEvent) {
            onChange?(true)
        }

        override func mouseExited(with event: NSEvent) {
            onChange?(false)
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            nil
        }
    }
}
