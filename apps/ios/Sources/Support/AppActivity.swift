import Observation
import UIKit

@MainActor
@Observable
final class AppActivity {
    static let shared = AppActivity()

    private(set) var isLive = true
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            UIApplication.didBecomeActiveNotification,
            UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
        ]
        for name in names {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { _ in
                    MainActor.assumeIsolated {
                        AppActivity.shared.refresh()
                    }
                })
        }
        refresh()
    }

    func refresh() {
        let live = UIApplication.shared.applicationState != .background
        if live != isLive {
            isLive = live
        }
    }
}
