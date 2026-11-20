import AppKit
import SwiftUI

private final class ControlTabPanel: NSPanel {
    var acceptsKey = false
    private(set) var previousApp: NSRunningApplication?
    override var canBecomeKey: Bool { acceptsKey }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, acceptsKey, !isKeyWindow {
            let front = NSWorkspace.shared.frontmostApplication
            previousApp = front?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : front
            makeKey()
        }
        super.sendEvent(event)
    }

    func giveBackFocus() {
        let previous = previousApp
        previousApp = nil
        guard isKeyWindow else { return }
        resignKey()
        if let previous, !previous.isTerminated {
            previous.activate()
        }
    }
}

private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class ComputerControlTab {
    static let earWidth: CGFloat = 84
    static let shadowPad: CGFloat = 24
    static let plainWidth: CGFloat = 220
    static let plainHeight: CGFloat = 30
    static let cardWidth: CGFloat = 392
    static let cardPadding: CGFloat = Spacing.l
    static let shrinkDelay: Duration = .milliseconds(520)
    static let heightShare: CGFloat = 0.6
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
    private var bodyLimits: [CGFloat]?
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
        panel.appearance = NSAppearance(named: .darkAqua)
        host = FirstMouseHostingView(rootView: ControlTabView(state: state, stop: stop, open: open, notchWidth: 0, tabWidth: Self.plainWidth, expandedWidth: Self.cardWidth, height: Self.plainHeight))
        host.appearance = NSAppearance(named: .darkAqua)
        panel.contentView = host
    }

    var isVisible: Bool { visible }

    private var expandedWidth: CGFloat { max(tabWidth, Self.cardWidth) }

    static func contentWidth(expandedWidth: CGFloat) -> CGFloat {
        expandedWidth - TabShape.flare * 2 - cardPadding * 2
    }

    func update() {
        let wanted = state.computerActive || state.promptVisible
        if wanted {
            collapse?.cancel()
            panel.acceptsKey = state.promptVisible && state.prompt?.isOpen == true
            if !panel.acceptsKey {
                panel.giveBackFocus()
            }
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
            try? await Task.sleep(for: Self.shrinkDelay)
            guard let self, !Task.isCancelled, !self.state.promptVisible else { return }
            self.panel.acceptsKey = false
            self.panel.giveBackFocus()
            self.cardHeight = 0
            self.bodyLimits = nil
            self.applyFrame()
        }
    }

    private func hide() {
        visible = false
        collapse?.cancel()
        panel.acceptsKey = false
        panel.giveBackFocus()
        let panel = panel
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.visible else { return }
                panel.orderOut(nil)
                self.cardHeight = 0
                self.bodyLimits = nil
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
            let screenHeight = screen.visibleFrame.height + (screen.frame.maxY - screen.visibleFrame.maxY)
            let layout = measure(prompt, cap: max(160, screenHeight * Self.heightShare - height))
            cardHeight = layout.height
            bodyLimits = layout.limits
        }
        host.rootView = ControlTabView(state: state, stop: stop, open: open, notchWidth: notchWidth, tabWidth: tabWidth, expandedWidth: expandedWidth, height: height, bodyLimits: bodyLimits)
        applyFrame()
    }

    private func measure(_ prompt: IslandPrompt, cap: CGFloat) -> (height: CGFloat, limits: [CGFloat]?) {
        let steps = max(1, prompt.approval.map { $0.isQuestion ? $0.questions.count : 1 } ?? 1)
        let natural = (0..<steps).map { probe(prompt, step: $0, limits: nil) }
        let tallest = natural.max() ?? 0
        guard tallest > cap else { return (tallest, nil) }
        let chrome = (0..<steps).map { probe(prompt, step: $0, limits: Array(repeating: 0, count: steps)) }
        let limits = (0..<steps).map { max(48, min(natural[$0], cap) - chrome[$0]) }
        let height = (0..<steps).map { chrome[$0] + limits[$0] }.max() ?? cap
        return (height, limits)
    }

    private func probe(_ prompt: IslandPrompt, step: Int, limits: [CGFloat]?) -> CGFloat {
        let width = Self.contentWidth(expandedWidth: expandedWidth)
        let wizard = prompt.approval?.isQuestion == true
            ? QuestionWizard(store: prompt.store, approvalID: prompt.approvalID, index: step, revealOther: true)
            : nil
        let card = IslandPromptCard(prompt: prompt, width: width, avatar: nil, bodyLimits: limits, wizard: wizard, open: {})
        let view = NSHostingView(rootView: card.environment(\.appReduceMotion, true).environment(\.colorScheme, .dark))
        view.appearance = NSAppearance(named: .darkAqua)
        return ceil(view.fittingSize.height) + Self.cardPadding * 2
    }

    private func applyFrame() {
        guard let screen = NSScreen.screens.first else { return }
        let frame = screen.frame
        var centerX = frame.midX
        if let left = screen.auxiliaryTopLeftArea, notchWidth > 0 {
            centerX = left.maxX + notchWidth / 2
        }
        let pad = Self.shadowPad
        let expanded = cardHeight > 0
        let width = (expanded ? expandedWidth : tabWidth) + pad * 2
        let total = height + (expanded ? cardHeight : 0) + pad
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
    let expandedWidth: CGFloat
    let height: CGFloat
    var bodyLimits: [CGFloat]? = nil
    @Namespace private var island
    @State private var isHoveringStop = false

    private var expanded: Bool { state.promptVisible && state.prompt != nil }

    private var morph: Animation {
        state.reduceMotion ? Motion.reduced : .spring(response: 0.42, dampingFraction: 0.8)
    }

    private var mood: CharacterMood {
        if expanded { return .waiting }
        return state.computerActive ? .thinking : .idle
    }

    private var radius: CGFloat {
        expanded ? IslandShape.expandedRadius : min(IslandShape.collapsedRadius, height / 2)
    }

    var body: some View {
        VStack(spacing: 0) {
            topRow
            if expanded, let prompt = state.prompt {
                IslandPromptCard(
                    prompt: prompt,
                    width: ComputerControlTab.contentWidth(expandedWidth: expandedWidth),
                    avatar: island,
                    bodyLimits: bodyLimits
                ) { open(prompt) }
                .id(prompt.id)
                .padding(.horizontal, TabShape.flare + ComputerControlTab.cardPadding)
                .padding(.vertical, ComputerControlTab.cardPadding)
                .transition(state.reduceMotion ? .opacity : .asymmetric(
                    insertion: .opacity.combined(with: .scale(scale: 0.94, anchor: .top)).animation(morph.delay(0.06)),
                    removal: .opacity.animation(.easeOut(duration: 0.12))
                ))
            }
        }
        .frame(width: expanded ? expandedWidth : tabWidth, alignment: .top)
        .background(IslandShape(bottomRadius: radius).fill(Color.black))
        .clipShape(IslandShape(bottomRadius: radius))
        .shadow(color: Color.black.opacity(expanded ? 0.32 : 0), radius: 18, y: 8)
        .keyframeAnimator(initialValue: 1.0, trigger: state.attention) { content, scale in
            content.scaleEffect(scale, anchor: .top)
        } keyframes: { _ in
            KeyframeTrack {
                SpringKeyframe(state.reduceMotion ? 1 : 1.04, duration: 0.18, spring: .snappy)
                SpringKeyframe(1, duration: 0.45, spring: .bouncy)
            }
        }
        .animation(morph, value: expanded)
        .animation(morph, value: state.prompt?.id)
        .environment(\.appReduceMotion, state.reduceMotion)
        .environment(\.colorScheme, .dark)
        .padding(.horizontal, ComputerControlTab.shadowPad)
        .padding(.bottom, ComputerControlTab.shadowPad)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .help(expanded ? "" : state.computerActive ? "\(state.botName) está usando o computador. Mexer no mouse ou no teclado também para o bot." : "\(state.botName) está esperando sua resposta.")
    }

    private var topRow: some View {
        HStack(spacing: 0) {
            leadingEar
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
    }

    @ViewBuilder
    private var leadingEar: some View {
        if expanded {
            Color.clear.frame(width: 16, height: 16)
        } else {
            HStack(spacing: Spacing.s - 2) {
                avatar
                ViewThatFits(in: .horizontal) {
                    Text(state.botName)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                        .fixedSize()
                    Color.clear.frame(width: 0, height: 0)
                }
            }
            .transition(.opacity)
        }
    }

    private var avatar: some View {
        BotCharacter(botID: state.botID, glyph: state.glyph, accent: state.accent, mood: mood, size: 16)
            .frame(width: 16, height: 16)
            .matchedGeometryEffect(id: "avatar", in: island)
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

struct IslandShape: Shape {
    static let collapsedRadius: CGFloat = 12
    static let expandedRadius: CGFloat = 32

    var bottomRadius: CGFloat

    var animatableData: CGFloat {
        get { bottomRadius }
        set { bottomRadius = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let flare = TabShape.flare
        let width = rect.width
        let height = rect.height
        let reach = max(0, min(bottomRadius * 1.28, (width - flare * 2) / 2, height - flare))
        let radius = reach / 1.28
        let pull = radius * 0.36
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addQuadCurve(to: CGPoint(x: flare, y: flare), control: CGPoint(x: flare, y: 0))
        path.addLine(to: CGPoint(x: flare, y: height - reach))
        path.addCurve(
            to: CGPoint(x: flare + reach, y: height),
            control1: CGPoint(x: flare, y: height - pull),
            control2: CGPoint(x: flare + pull, y: height)
        )
        path.addLine(to: CGPoint(x: width - flare - reach, y: height))
        path.addCurve(
            to: CGPoint(x: width - flare, y: height - reach),
            control1: CGPoint(x: width - flare - pull, y: height),
            control2: CGPoint(x: width - flare, y: height - pull)
        )
        path.addLine(to: CGPoint(x: width - flare, y: flare))
        path.addQuadCurve(to: CGPoint(x: width, y: 0), control: CGPoint(x: width - flare, y: 0))
        path.closeSubpath()
        return path
    }
}

enum TabShape {
    static let flare: CGFloat = 8
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
