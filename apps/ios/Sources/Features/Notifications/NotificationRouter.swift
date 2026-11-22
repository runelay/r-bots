import Observation
import UIKit
import UserNotifications

@MainActor
@Observable
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationRouter()

    var pendingBotID: String?
    var pendingSessionID: String?

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    // Variantes com completion handler de propósito: a versão async chama o handler fora da main thread
    // e o UIKit derruba o app ao abrir pela notificação.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let botID = response.notification.request.content.userInfo["botID"] as? String
        nonisolated(unsafe) let done = completionHandler
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                NotificationRouter.shared.pendingBotID = botID
            }
            done()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        nonisolated(unsafe) let done = completionHandler
        DispatchQueue.main.async {
            done([])
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated {
            NotificationRouter.shared.install()
        }
        return true
    }
}
