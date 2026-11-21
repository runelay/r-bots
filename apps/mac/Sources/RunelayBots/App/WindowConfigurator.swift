import AppKit
import SwiftUI

@MainActor
@Observable
final class WindowChrome {
    static let shared = WindowChrome()
    var stripHeight: CGFloat = 40
    @ObservationIgnored weak var mainWindow: NSWindow?
}

final class WindowConfiguringView: NSView {
    private var observers: [NSObjectProtocol] = []

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let window else { return }
        WindowChrome.shared.mainWindow = window
        window.titlebarSeparatorStyle = .none
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
        window.toolbar = nil
        let names: [Notification.Name] = [
            NSWindow.didResizeNotification,
            NSWindow.didEndLiveResizeNotification,
            NSWindow.didExitFullScreenNotification,
            NSWindow.didBecomeKeyNotification,
        ]
        observers = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak window] _ in
                guard let window else { return }
                MainActor.assumeIsolated {
                    Self.placeTrafficLights(in: window)
                }
            }
        }
        DispatchQueue.main.async { [weak window] in
            guard let window else { return }
            Self.placeTrafficLights(in: window)
        }
    }

    @MainActor
    private static func placeTrafficLights(in window: NSWindow) {
        let types: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        let buttons = types.compactMap { window.standardWindowButton($0) }
        guard let first = buttons.first, let container = first.superview?.superview else { return }
        let stripHeight = WindowChrome.shared.stripHeight
        var frame = container.frame
        frame.size.height = stripHeight
        frame.origin.y = window.frame.height - stripHeight
        container.frame = frame
        let leading: CGFloat = 18
        let spacing: CGFloat = 20
        for (index, button) in buttons.enumerated() {
            button.setFrameOrigin(
                NSPoint(
                    x: leading + CGFloat(index) * spacing,
                    y: ((stripHeight - button.frame.height) / 2).rounded()
                ))
        }
    }
}

struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> WindowConfiguringView {
        WindowConfiguringView()
    }

    func updateNSView(_ nsView: WindowConfiguringView, context: Context) {}
}
