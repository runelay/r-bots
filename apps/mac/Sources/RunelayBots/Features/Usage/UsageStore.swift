import AppKit
import Foundation
import Observation
import UserNotifications

struct UsageRingState: Equatable, Sendable, Identifiable {
    let id: String
    let provider: String
    let session: Double?
    let long: Double?
    let tooltip: String
    var badge: String?
    var dimmed = false
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
    var account: String?
    var focusAccount: String?

    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var summaryTask: Task<Void, Never>?
    @ObservationIgnored private var activation: NSObjectProtocol?
    @ObservationIgnored private var lastLimitsAt = Date.distantPast
    @ObservationIgnored private var notified: Set<String> = []
    @ObservationIgnored private var notifiedStore = ""

    func start() {
        guard loop == nil else { return }
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
            throw BotsClient.ClientError.http(status, status == 404 ? tr("O servidor ainda não tem a tela de uso. Atualize o servidor.") : nil)
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
        account = nil
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
            limitsError = tr("Não consegui ler os limites agora.")
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
        if let account { query.append(URLQueryItem(name: "account", value: account)) }
        do {
            let result = try await fetch("/usage/summary", query: query, timeout: 90, as: UsageSummary.self)
            guard !Task.isCancelled else { return }
            summary = result
            summaryError = nil
        } catch {
            guard !Task.isCancelled else { return }
            summaryError = tr("Não consegui somar o uso agora.")
        }
    }

    func accounts(for provider: String) -> [UsageLimitAccount] {
        accounts.filter { $0.provider == provider }
    }

    var rings: [UsageRingState] {
        let ordered = ["claude", "codex"].flatMap { provider in
            accounts(for: provider).enumerated()
                .sorted { lhs, rhs in
                    let left = lhs.element.isDefault == true ? 0 : 1
                    let right = rhs.element.isDefault == true ? 0 : 1
                    return left == right ? lhs.offset < rhs.offset : left < right
                }
                .map(\.element)
        }
        return ordered.map { account in
            let siblings = accounts(for: account.provider).count
            return Self.ring(for: account, badge: siblings > 1 ? Self.initials(account) : nil)
        }
    }

    static func initials(_ account: UsageLimitAccount) -> String {
        let base = UsageFormat.providerName(account.provider)
        var rest = account.label.hasPrefix(base) ? String(account.label.dropFirst(base.count)) : account.label
        rest = rest.trimmingCharacters(in: .whitespaces)
        let words = rest.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        if words.count >= 2 { return String(words.prefix(2).compactMap(\.first)).uppercased() }
        let capitals = rest.filter(\.isUppercase)
        if capitals.count >= 2 { return String(capitals.prefix(2)) }
        return rest.first.map { String($0).uppercased() } ?? ""
    }

    static func ring(for account: UsageLimitAccount, badge: String?) -> UsageRingState {
        var lines = [account.label]
        guard account.ok else {
            lines.append(account.error ?? tr("Sem dados desta conta."))
            return UsageRingState(id: account.id, provider: account.provider, session: nil, long: nil, tooltip: lines.joined(separator: "\n"), badge: badge, dimmed: true)
        }
        let session = account.windows.filter { $0.kind == "session" }.min { $0.remainingPercent < $1.remainingPercent }
        let long = account.windows.filter(\.isLongWindow).min { $0.remainingPercent < $1.remainingPercent }
        if let session {
            lines.append(phrase(tr("Sessão"), session))
        }
        if let long {
            lines.append(phrase(long.kind == "monthly" ? tr("Mensal") : tr("Semanal"), long))
        }
        let exhausted = account.windows.contains { $0.kind != "weekly_model" && $0.remainingPercent < 1 }
        if exhausted, let target = account.failover.first {
            let names = Set(account.failover.map(\.botName)).count
            lines.append(names == 1 ? tr("Acabou: %1$@ está indo para %2$@.", account.failover[0].botName, target.toLabel) : tr("Acabou: %1$lld bots estão indo para %2$@.", names, target.toLabel))
        } else if exhausted {
            lines.append(tr("Acabou, e nenhum bot tem para onde trocar."))
        }
        return UsageRingState(id: account.id, provider: account.provider, session: session?.remainingPercent, long: long?.remainingPercent, tooltip: lines.joined(separator: "\n"), badge: badge)
    }

    func ring(for provider: String) -> UsageRingState? {
        let list = accounts(for: provider).filter(\.ok)
        guard !list.isEmpty else { return nil }
        let session = Self.lowest(list, where: { $0.kind == "session" })
        let long = Self.lowest(list, where: { $0.isLongWindow })
        var parts = [UsageFormat.providerName(provider)]
        if let session {
            parts.append(Self.phrase(tr("sessão"), session))
        }
        if let long {
            parts.append(Self.phrase(long.kind == "monthly" ? tr("mensal") : tr("semanal"), long))
        }
        return UsageRingState(id: provider, provider: provider, session: session?.remainingPercent, long: long?.remainingPercent, tooltip: parts.joined(separator: " · "))
    }

    private static func phrase(_ name: String, _ window: UsageLimitWindow) -> String {
        var text = tr("%1$@ %2$@ restante", name, UsageFormat.percent(window.remainingPercent))
        if let until = UsageFormat.until(window.resetDate) {
            text += tr(", volta em %@", until)
        }
        return text
    }

    static func lowest(_ accounts: [UsageLimitAccount], where predicate: (UsageLimitWindow) -> Bool) -> UsageLimitWindow? {
        accounts.flatMap { $0.windows.filter(predicate) }.min { $0.remainingPercent < $1.remainingPercent }
    }

    var providers: [String] {
        ["codex", "claude"].filter { provider in accounts.contains { $0.provider == provider } }
    }

    static func warningKey(account: UsageLimitAccount, window: UsageLimitWindow, now: Date = Date()) -> String {
        let cycle: Int
        if let reset = window.resetDate {
            cycle = Int((reset.timeIntervalSince1970 / 3600).rounded()) * 3600
        } else {
            cycle = Int(now.timeIntervalSince1970 / 86_400) * 86_400
        }
        return "\(account.id)|\(window.kind)|\(window.label)|\(cycle)"
    }

    private func loadNotified() {
        let store = "usage.notified.\(ServerConfig.currentURL().absoluteString)"
        guard store != notifiedStore else { return }
        notifiedStore = store
        notified = Set(UserDefaults.standard.stringArray(forKey: store) ?? [])
    }

    private func checkWarnings() {
        loadNotified()
        var changed = false
        for account in accounts where account.ok {
            for window in account.windows where window.remainingPercent < 10 {
                let key = Self.warningKey(account: account, window: window)
                guard !notified.contains(key) else { continue }
                notified.insert(key)
                changed = true
                postWarning(account: account, window: window, key: key)
            }
        }
        guard changed else { return }
        let floor = Date().addingTimeInterval(-8 * 86_400).timeIntervalSince1970
        notified = notified.filter { key in
            guard let stamp = key.split(separator: "|").last, let cycle = TimeInterval(stamp) else { return false }
            return cycle > floor
        }
        UserDefaults.standard.set(Array(notified), forKey: notifiedStore)
    }

    static func failoverLine(_ account: UsageLimitAccount) -> String? {
        guard let first = account.failover.first else { return nil }
        let targets = Set(account.failover.map(\.toLabel))
        let names = account.failover.map(\.botName)
        let who = names.count == 1 ? names[0] : names.count == 2 ? tr("%1$@ e %2$@", names[0], names[1]) : tr("%1$@ e mais %2$lld", names[0], names.count - 1)
        let destination = targets.count == 1 ? first.toLabel : tr("a conta reserva")
        return names.count == 1 ? tr("%1$@ vai trocar para %2$@.", who, destination) : tr("%1$@ vão trocar para %2$@.", who, destination)
    }

    private func postWarning(account: UsageLimitAccount, window: UsageLimitWindow, key: String) {
        guard Notifier.shared.isAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = tr("%@ quase no limite", account.label)
        var body = tr("%1$@: %2$@ restante", window.label, UsageFormat.percent(window.remainingPercent))
        if let until = UsageFormat.until(window.resetDate) {
            body += tr(", volta em %@", until)
        }
        body += "."
        if let line = Self.failoverLine(account) {
            body += " \(line)"
        }
        content.body = body
        content.userInfo = ["usage": "1"]
        let request = UNNotificationRequest(identifier: "usage-\(key)", content: content, trigger: nil)
        Task {
            try? await UNUserNotificationCenter.current().add(request)
        }
    }
}
