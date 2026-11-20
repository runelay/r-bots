import AppKit
import LocalAuthentication
import Observation

@MainActor
@Observable
final class VaultLock {
    static let shared = VaultLock()

    static let unlockWindow: Duration = .seconds(300)
    static let revealWindow: Duration = .seconds(20)
    static let pasteboardWindow: Duration = .seconds(60)

    private(set) var isUnlocked = false
    private(set) var isAuthenticating = false
    private(set) var failure: String?

    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    @ObservationIgnored private var suppressed = 0
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        for name in [NSApplication.didResignActiveNotification, NSApplication.didHideNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated {
                    VaultLock.shared.lockUnlessAuthenticating()
                }
            })
        }
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification] {
            observers.append(workspace.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated {
                    VaultLock.shared.lock()
                }
            })
        }
        observers.append(DistributedNotificationCenter.default().addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                VaultLock.shared.lock()
            }
        })
    }

    func unlock() async {
        guard !isUnlocked, !isAuthenticating else { return }
        failure = nil
        isAuthenticating = true
        suppressed += 1
        defer {
            isAuthenticating = false
            suppressed -= 1
        }
        let context = LAContext()
        context.localizedCancelTitle = "Cancelar"
        do {
            if try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Desbloquear o cofre") {
                isUnlocked = true
                scheduleExpiry()
            }
        } catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel {
            failure = nil
        } catch {
            failure = "Não deu para confirmar que é você. Tente de novo."
        }
    }

    func lock() {
        expiryTask?.cancel()
        expiryTask = nil
        isUnlocked = false
    }

    func authenticated<T>(_ work: () async throws -> T) async rethrows -> T {
        suppressed += 1
        defer { suppressed -= 1 }
        return try await work()
    }

    func copy(_ value: String) -> Bool {
        guard isUnlocked else { return false }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(value, forType: .string)
        let stamp = pasteboard.changeCount
        Task { @MainActor in
            try? await Task.sleep(for: VaultLock.pasteboardWindow)
            if NSPasteboard.general.changeCount == stamp {
                NSPasteboard.general.clearContents()
            }
        }
        return true
    }

    private func lockUnlessAuthenticating() {
        guard suppressed == 0 else { return }
        lock()
    }

    private func scheduleExpiry() {
        expiryTask?.cancel()
        expiryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: VaultLock.unlockWindow)
            guard !Task.isCancelled else { return }
            self?.lock()
        }
    }
}
