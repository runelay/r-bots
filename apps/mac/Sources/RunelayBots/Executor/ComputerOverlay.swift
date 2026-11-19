import AppKit
import SwiftUI

@MainActor
@Observable
final class ComputerOverlayState {
    var auraVisible = false
    var botID = ""
    var botName = ""
    var accent = "electric"
    var glyph: String?
    var cursorVisible = false
    var cursor = CGPoint.zero
    var pulse = 0
    var reduceMotion = false

    var color: Color { Theme.accent(accent) }

    var labelColor: Color {
        switch accent.lowercased() {
        case "white", "yellow", "amber", "sky", "light": Color.black.opacity(0.85)
        default: Color.white
        }
    }
}

@MainActor
final class ComputerOverlay {
    let state = ComputerOverlayState()
    private var screenPanels: [NSPanel] = []
    private let tab: ComputerControlTab
    private var cursorHide: Task<Void, Never>?
    private var screenObserver: NSObjectProtocol?
    private let glide = Animation.spring(response: 0.42, dampingFraction: 0.82)

    init(stop: @escaping @MainActor () -> Void) {
        tab = ComputerControlTab(state: state, stop: stop)
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                ComputerExecutor.shared.overlayScreensChanged()
            }
        }
    }

    static var prefersReducedMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            || UserDefaults.standard.string(forKey: PreferenceKeys.motion) == MotionPreference.reduced.rawValue
    }

    func begin(botID: String, botName: String, bot: Bot?) {
        state.botID = botID
        state.botName = bot?.name ?? botName
        state.accent = bot?.accent ?? "electric"
        state.glyph = bot?.glyph
        state.reduceMotion = Self.prefersReducedMotion
        buildPanels()
        for panel in screenPanels {
            panel.orderFrontRegardless()
        }
        withAnimation(.easeOut(duration: 0.35)) {
            state.auraVisible = true
        }
        tab.show()
    }

    func end() {
        cursorHide?.cancel()
        withAnimation(.easeOut(duration: 0.4)) {
            state.auraVisible = false
            state.cursorVisible = false
        }
        tab.hide()
        let panels = screenPanels
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(450))
            guard !self.state.auraVisible else { return }
            for panel in panels {
                panel.orderOut(nil)
            }
        }
    }

    func screensChanged() {
        guard state.auraVisible else { return }
        buildPanels()
        for panel in screenPanels {
            panel.orderFrontRegardless()
        }
        tab.reposition()
    }

    func moveCursor(to point: CGPoint) async {
        cursorHide?.cancel()
        state.reduceMotion = Self.prefersReducedMotion
        if !state.cursorVisible {
            state.cursor = Self.mouseLocation()
            withAnimation(.easeOut(duration: 0.18)) {
                state.cursorVisible = true
            }
            if !state.reduceMotion {
                try? await Task.sleep(for: .milliseconds(30))
            }
        }
        if state.reduceMotion {
            state.cursor = point
            return
        }
        let distance = hypot(point.x - state.cursor.x, point.y - state.cursor.y)
        withAnimation(glide) {
            state.cursor = point
        }
        guard distance > 2 else { return }
        try? await Task.sleep(for: .milliseconds(Int(min(520, 260 + distance * 0.25))))
    }

    func follow(to point: CGPoint, duration: Double) {
        if state.reduceMotion {
            state.cursor = point
        } else {
            withAnimation(.easeInOut(duration: duration)) {
                state.cursor = point
            }
        }
    }

    func pulse() {
        state.pulse += 1
    }

    func scheduleCursorHide() {
        cursorHide?.cancel()
        cursorHide = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.6)) {
                self.state.cursorVisible = false
            }
        }
    }

    private func buildPanels() {
        let screens = NSScreen.screens
        guard screens.count != screenPanels.count || zip(screens, screenPanels).contains(where: { $0.frame != $1.frame }) else { return }
        for panel in screenPanels {
            panel.orderOut(nil)
        }
        screenPanels = screens.map(makePanel)
    }

    private func makePanel(for screen: NSScreen) -> NSPanel {
        let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        let mainHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let origin = CGPoint(x: screen.frame.minX, y: mainHeight - screen.frame.maxY)
        let host = NSHostingView(rootView: ScreenOverlayView(state: state, origin: origin, cornerRadius: Self.cornerRadius(of: screen)))
        host.frame = CGRect(origin: .zero, size: screen.frame.size)
        panel.contentView = host
        panel.setFrame(screen.frame, display: false)
        return panel
    }

    static func cornerRadius(of screen: NSScreen) -> CGFloat {
        let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        guard CGDisplayIsBuiltin(id) != 0 else { return 0 }
        return screen.safeAreaInsets.top > 0 ? 16 : 8
    }

    static func mouseLocation() -> CGPoint {
        let location = NSEvent.mouseLocation
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        return CGPoint(x: location.x, y: mainHeight - location.y)
    }
}

struct ScreenOverlayView: View {
    let state: ComputerOverlayState
    let origin: CGPoint
    let cornerRadius: CGFloat

    var body: some View {
        GeometryReader { proxy in
            let local = CGPoint(x: state.cursor.x - origin.x, y: state.cursor.y - origin.y)
            let inside = local.x >= -40 && local.y >= -40 && local.x <= proxy.size.width + 40 && local.y <= proxy.size.height + 40
            ZStack(alignment: .topLeading) {
                if state.auraVisible {
                    ScreenAura(color: state.color, cornerRadius: cornerRadius, reduceMotion: state.reduceMotion)
                        .transition(.opacity)
                }
                if inside {
                    BotCursor(state: state)
                        .position(x: local.x + BotCursor.size.width / 2, y: local.y + BotCursor.size.height / 2)
                        .opacity(state.cursorVisible ? 1 : 0)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

struct ScreenAura: View {
    let color: Color
    let cornerRadius: CGFloat
    let reduceMotion: Bool

    var body: some View {
        if reduceMotion {
            glow(0.85)
        } else {
            glow(1)
                .phaseAnimator([0.5, 1.0]) { content, phase in
                    content.opacity(phase)
                } animation: { _ in
                    .easeInOut(duration: 2.8)
                }
        }
    }

    private func glow(_ intensity: Double) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let gradient = AngularGradient(
            colors: [color, color.opacity(0.55), color.opacity(0.9), color.opacity(0.6), color],
            center: .center
        )
        return ZStack {
            shape.strokeBorder(gradient, lineWidth: 10)
                .blur(radius: 9)
            shape.strokeBorder(gradient, lineWidth: 3)
                .blur(radius: 3)
                .opacity(0.7)
        }
        .opacity(intensity)
    }
}

struct BotCursor: View {
    static let size = CGSize(width: 22, height: 26)
    let state: ComputerOverlayState

    var body: some View {
        ZStack(alignment: .topLeading) {
            PulseRing(color: state.color, trigger: state.pulse, reduceMotion: state.reduceMotion)
                .offset(x: -14, y: -14)
            CursorArrow()
                .fill(state.color)
                .overlay(CursorArrow().stroke(Color.white, lineWidth: 1.5))
                .frame(width: Self.size.width, height: Self.size.height)
                .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
            Text(state.botName)
                .font(TypeScale.captionStrong)
                .foregroundStyle(state.labelColor)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, Spacing.s)
                .frame(height: 20)
                .background(state.color, in: Capsule())
                .offset(x: 18, y: 22)
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
    }
}

struct PulseRing: View {
    let color: Color
    let trigger: Int
    let reduceMotion: Bool

    var body: some View {
        Circle()
            .fill(color.opacity(0.35))
            .frame(width: 28, height: 28)
            .keyframeAnimator(initialValue: PulseFrame(), trigger: trigger) { content, frame in
                content
                    .scaleEffect(frame.scale)
                    .opacity(frame.opacity)
            } keyframes: { _ in
                KeyframeTrack(\.scale) {
                    LinearKeyframe(reduceMotion ? 1 : 0.4, duration: 0.01)
                    SpringKeyframe(reduceMotion ? 1 : 1.9, duration: 0.45, spring: .snappy)
                }
                KeyframeTrack(\.opacity) {
                    LinearKeyframe(0.9, duration: 0.01)
                    LinearKeyframe(0, duration: 0.45)
                }
            }
    }
}

struct PulseFrame {
    var scale: CGFloat = 1
    var opacity: Double = 0
}

struct CursorArrow: Shape {
    func path(in rect: CGRect) -> Path {
        let width = rect.width
        let height = rect.height
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 0, y: height * 0.86))
        path.addLine(to: CGPoint(x: width * 0.27, y: height * 0.64))
        path.addLine(to: CGPoint(x: width * 0.45, y: height))
        path.addLine(to: CGPoint(x: width * 0.6, y: height * 0.94))
        path.addLine(to: CGPoint(x: width * 0.43, y: height * 0.6))
        path.addLine(to: CGPoint(x: width * 0.78, y: height * 0.6))
        path.closeSubpath()
        return path
    }
}
