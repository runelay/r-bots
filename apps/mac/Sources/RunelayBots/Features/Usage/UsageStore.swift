import AppKit
import Foundation
import Observation
import UserNotifications

struct UsageRingState: Equatable, Sendable {
    let provider: String
    let session: Double?
    let long: Double?
    let tooltip: String
}

@MainActor
@Observable
final class UsageStore {
    static let shared = UsageStore()

    var accounts: [UsageLimitAccount] = []
    var limitsError: String?
    var limitsLoaded = false
    var summary: UsageSummary?
    var summaryError: String?
    var summaryLoading = false
    var tab: UsageTab = .limits
    var range: UsageRange = .month
    var provider: String?
    var environment: String?

    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var summaryTask: Task<Void, Never>?
    @ObservationIgnored private var activation: NSObjectProtocol?
    @ObservationIgnored private var lastLimitsAt = Date.distantPast
    @ObservationIgnored private var notified: Set<String> = []

    private static let notifiedKey = "usage.notified"

    func start() {
        guard loop == nil else { return }
        notified = Set(UserDefaults.standard.stringArray(forKey: Self.notifiedKey) ?? [])
        loop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.refreshLimits()
                try? await Task.sleep(for: .seconds(120))
            }
        }
        activation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in
                let store = UsageStore.shared
                guard Date().timeIntervalSince(store.lastLimitsAt) > 30 else { return }
                await store.refreshLimits()
            }
        }
    }

    private var client: BotsClient { BotsClient(baseURL: ServerConfig.currentURL()) }

    private func fetch<T: Decodable>(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval, as type: T.Type) async throws -> T {
        var request = try client.request(path: path, query: query)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw BotsClient.ClientError.http(status, status == 404 ? "O servidor ainda não tem a tela de uso. Atualize o servidor." : nil)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func forgetServer() {
        summaryTask?.cancel()
        accounts = []
        limitsError = nil
        limitsLoaded = false
        summary = nil
        summaryError = nil
        provider = nil
        environment = nil
        Task { await refreshLimits(force: true) }
    }

    func refreshLimits(force: Bool = false) async {
        lastLimitsAt = Date()
        do {
            let response = try await fetch("/usage/limits", query: force ? [URLQueryItem(name: "refresh", value: "1")] : [], timeout: 60, as: UsageLimitsResponse.self)
            accounts = response.accounts
            limitsError = nil
            limitsLoaded = true
            checkWarnings()
        } catch {
            limitsError = "Não consegui ler os limites agora."
            limitsLoaded = true
        }
    }

    func reloadSummary() {
        summaryTask?.cancel()
        summaryTask = Task { @MainActor [weak self] in
            await self?.loadSummary()
        }
    }

    private func loadSummary() async {
        summaryLoading = true
        defer { summaryLoading = false }
        var query = [URLQueryItem(name: "range", value: range.rawValue)]
        if let provider { query.append(URLQueryItem(name: "provider", value: provider)) }
        if let environment { query.append(URLQueryItem(name: "environment", value: environment)) }
        do {
            let result = try await fetch("/usage/summary", query: query, timeout: 90, as: UsageSummary.self)
            guard !Task.isCancelled else { return }
            summary = result
            summaryError = nil
            if result.environments.mac?.pending == true {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                await loadSummary()
            }
        } catch {
            guard !Task.isCancelled else { return }
            summaryError = "Não consegui somar o uso agora."
        }
    }

    func accounts(for provider: String) -> [UsageLimitAccount] {
        accounts.filter { $0.provider == provider }
    }

    func ring(for provider: String) -> UsageRingState? {
        let list = accounts(for: provider).filter(\.ok)
        guard !list.isEmpty else { return nil }
        let session = Self.lowest(list, where: { $0.kind == "session" })
        let long = Self.lowest(list, where: { $0.isLongWindow })
        var parts = [UsageFormat.providerName(provider)]
        if let session {
            parts.append(Self.phrase("sessão", session))
        }
        if let long {
            parts.append(Self.phrase(long.kind == "monthly" ? "mensal" : "semanal", long))
        }
        return UsageRingState(provider: provider, session: session?.remainingPercent, long: long?.remainingPercent, tooltip: parts.joined(separator: " · "))
    }

    private static func phrase(_ name: String, _ window: UsageLimitWindow) -> String {
        var text = "\(name) \(UsageFormat.percent(window.remainingPercent)) restante"
        if let until = UsageFormat.until(window.resetDate) {
            text += ", volta em \(until)"
        }
        return text
    }

    static func lowest(_ accounts: [UsageLimitAccount], where predicate: (UsageLimitWindow) -> Bool) -> UsageLimitWindow? {
        accounts.flatMap { $0.windows.filter(predicate) }.min { $0.remainingPercent < $1.remainingPercent }
    }

    var providers: [String] {
        ["codex", "claude"].filter { provider in accounts.contains { $0.provider == provider } }
    }

    private func checkWarnings() {
        var changed = false
        for account in accounts where account.ok {
            for window in account.windows where window.remainingPercent < 10 {
                let key = "\(account.id)|\(window.label)|\(window.resetsAt ?? "")"
                guard !notified.contains(key) else { continue }
                notified.insert(key)
                changed = true
                postWarning(account: account, window: window)
            }
        }
        if changed {
            let floor = Date().addingTimeInterval(-8 * 86_400)
            let kept = notified.filter { key in
                guard let stamp = key.split(separator: "|").last, let date = UsageFormat.date(String(stamp)) else { return true }
                return date > floor
            }
            notified = kept
            UserDefaults.standard.set(Array(kept), forKey: Self.notifiedKey)
        }
    }

    static func failoverLine(_ account: UsageLimitAccount) -> String? {
        guard let first = account.failover.first else { return nil }
        let targets = Set(account.failover.map(\.toLabel))
        let names = account.failover.map(\.botName)
        let who = names.count == 1 ? names[0] : names.count == 2 ? "\(names[0]) e \(names[1])" : "\(names[0]) e mais \(names.count - 1)"
        let destination = targets.count == 1 ? first.toLabel : "a conta reserva"
        let verb = names.count == 1 ? "vai" : "vão"
        return "\(who) \(verb) trocar para \(destination)."
    }

    private func postWarning(account: UsageLimitAccount, window: UsageLimitWindow) {
        guard Notifier.shared.isAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(account.label) (\(account.environmentLabel)) quase no limite"
        var body = "\(window.label): \(UsageFormat.percent(window.remainingPercent)) restante"
        if let until = UsageFormat.until(window.resetDate) {
            body += ", volta em \(until)"
        }
        body += "."
        if let line = Self.failoverLine(account) {
            body += " \(line)"
        }
        content.body = body
        content.userInfo = ["usage": "1"]
        let request = UNNotificationRequest(identifier: "usage-\(account.id)-\(window.kind)-\(window.label)", content: content, trigger: nil)
        Task {
            try? await UNUserNotificationCenter.current().add(request)
        }
    }
}
