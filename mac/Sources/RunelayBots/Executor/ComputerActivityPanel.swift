import AppKit
import SwiftUI

private final class ControlTabPanel: NSPanel {
    override var canBecomeKey: Bool { false }
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
    private let panel: ControlTabPanel
    private let host: FirstMouseHostingView<ControlTabView>
    private let state: ComputerOverlayState
    private let stop: @MainActor () -> Void
    private var active = false
    private var height = ComputerControlTab.plainHeight
    private var notchWidth: CGFloat = 0

    init(state: ComputerOverlayState, stop: @escaping @MainActor () -> Void) {
        self.state = state
        self.stop = stop
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
        host = FirstMouseHostingView(rootView: ControlTabView(state: state, stop: stop, notchWidth: 0, height: Self.plainHeight, active: false))
        panel.contentView = host
    }

    func show() {
        active = true
        reposition()
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.25
            panel.animator().alphaValue = 1
        }
    }

    func hide() {
        let panel = panel
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                panel.orderOut(nil)
                guard let self, panel.alphaValue == 0 else { return }
                self.active = false
                self.host.rootView = ControlTabView(state: self.state, stop: self.stop, notchWidth: self.notchWidth, height: self.height, active: false)
            }
        }
    }

    func reposition() {
        guard let screen = NSScreen.screens.first else { return }
        let frame = screen.frame
        var notchWidth: CGFloat = 0
        var centerX = frame.midX
        var height = Self.plainHeight
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea, screen.safeAreaInsets.top > 0 {
            notchWidth = max(0, right.minX - left.maxX)
            centerX = left.maxX + notchWidth / 2
            height = screen.safeAreaInsets.top
        }
        let width = notchWidth > 0 ? notchWidth + Self.earWidth * 2 + TabShape.flare * 2 : Self.plainWidth
        let pad = Self.glowPad
        self.height = height
        self.notchWidth = notchWidth
        host.rootView = ControlTabView(state: state, stop: stop, notchWidth: notchWidth, height: height, active: active)
        host.frame = NSRect(x: 0, y: 0, width: width + pad * 2, height: height + pad)
        panel.setFrame(NSRect(x: centerX - width / 2 - pad, y: frame.maxY - height - pad, width: width + pad * 2, height: height + pad), display: true)
    }
}

struct ControlTabView: View {
    let state: ComputerOverlayState
    let stop: @MainActor () -> Void
    let notchWidth: CGFloat
    let height: CGFloat
    var active = true
    @State private var isHoveringStop = false

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: Spacing.s - 2) {
                BotCharacter(botID: state.botID, glyph: state.glyph, accent: state.accent, mood: active ? .thinking : .idle, size: 16)
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
            stopButton
                .frame(maxWidth: notchWidth > 0 ? ComputerControlTab.earWidth : nil, alignment: .trailing)
        }
        .padding(.horizontal, TabShape.flare + Spacing.s)
        .frame(height: height)
        .background(tabFill)
        .padding(.horizontal, ComputerControlTab.glowPad)
        .padding(.bottom, ComputerControlTab.glowPad)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .help("\(state.botName) está usando o computador. Mexer no mouse ou no teclado também para o bot.")
    }

    private var tabFill: some View {
        TabShape()
            .fill(Color.black)
            .overlay(
                TabShape().fill(
                    LinearGradient(colors: [.clear, .clear, state.color.opacity(0.28)], startPoint: .top, endPoint: .bottom)
                )
            )
            .shadow(color: state.color.opacity(0.75), radius: 7, y: 2)
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
