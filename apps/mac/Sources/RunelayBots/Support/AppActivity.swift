import AppKit
import Observation

@MainActor
@Observable
final class AppActivity {
    static let shared = AppActivity()

    private(set) var isLive = true
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSApplication.didBecomeActiveNotification,
            NSApplication.didResignActiveNotification,
            NSApplication.didHideNotification,
            NSApplication.didUnhideNotification,
            NSWindow.didChangeOcclusionStateNotification,
            NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification,
            NSWindow.didBecomeKeyNotification,
            NSWindow.willCloseNotification,
        ]
        for name in names {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated {
                    AppActivity.shared.refresh()
                }
            })
        }
        refresh()
    }

    func refresh() {
        let visible = NSApp.windows.contains { window in
            window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible) && window.contentView != nil && window.level == .normal
        }
        let live = NSApp.isActive && !NSApp.isHidden && visible
        if live != isLive {
            isLive = live
        }
    }
}
