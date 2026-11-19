import Foundation
import Observation

@MainActor
@Observable
final class AgendaStore {
    enum Mode: String, CaseIterable, Identifiable {
        case day
        case week

        var id: String { rawValue }
        var title: String { self == .day ? "Dia" : "Semana" }
    }

    let botID: String
    private(set) var accounts: [AgendaAccount] = []
    private(set) var hiddenAccounts: Set<String> = []
    private(set) var events: [AgendaEvent] = []
    private(set) var anchor = Calendar.agenda.startOfDay(for: Date())
    private(set) var loading = false
    private(set) var failed: String?
    private(set) var highlighted: Set<String> = []
    private(set) var remoteEditedAt: Date?
    var selectedEvent: AgendaEvent?
    var mode: Mode = .week {
        didSet { if mode != oldValue { Task { await reload() } } }
    }

    @ObservationIgnored let client: any BlocksClient
    @ObservationIgnored private var highlightTask: Task<Void, Never>?
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    init(botID: String, client: any BlocksClient) {
        self.botID = botID
        self.client = client
    }

    var days: [Date] {
        let calendar = Calendar.agenda
        switch mode {
        case .day:
            return [anchor]
        case .week:
            let start = calendar.dateInterval(of: .weekOfYear, for: anchor)?.start ?? anchor
            return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
        }
    }

    var rangeTitle: String {
        guard let first = days.first, let last = days.last else { return "" }
        if mode == .day {
            return first.formatted(.dateTime.weekday(.wide).day().month(.wide)).capitalizedFirst
        }
        let sameMonth = Calendar.agenda.isDate(first, equalTo: last, toGranularity: .month)
        if sameMonth {
            return "\(first.formatted(.dateTime.day()))–\(last.formatted(.dateTime.day().month(.wide).year()))"
        }
        return "\(first.formatted(.dateTime.day().month(.abbreviated))) – \(last.formatted(.dateTime.day().month(.abbreviated).year()))"
    }

    var statusText: String {
        if let failed { return failed }
        if loading { return "Atualizando…" }
        if let remoteEditedAt, Date().timeIntervalSince(remoteEditedAt) < 60 { return "O bot acabou de mexer na agenda" }
        let ready = accounts.filter { $0.status == "ready" }.count
        return ready == 1 ? "1 conta ligada" : "\(ready) contas ligadas"
    }

    var visibleAccounts: [AgendaAccount] {
        accounts.filter { !hiddenAccounts.contains($0.id) }
    }

    func color(for accountID: String) -> String {
        accounts.first { $0.id == accountID }?.color ?? "blue"
    }

    func account(_ id: String) -> AgendaAccount? {
        accounts.first { $0.id == id }
    }

    func load() async {
        if accounts.isEmpty {
            do {
                accounts = try await client.agendaAccounts(botID: botID)
            } catch {
                failed = error.localizedDescription
            }
        }
        await reload()
    }

    func reload() async {
        guard let first = days.first, let last = days.last,
              let end = Calendar.agenda.date(byAdding: .day, value: 1, to: last)
        else { return }
        loading = true
        defer { loading = false }
        let visible = accounts.isEmpty ? nil : visibleAccounts.map(\.id)
        do {
            let list = try await client.agendaEvents(botID: botID, start: first, end: end, accounts: visible)
            events = list.items.filter { $0.status != "cancelled" }
            failed = nil
            if let selected = selectedEvent {
                selectedEvent = events.first { $0.id == selected.id }
            }
        } catch {
            failed = error.localizedDescription
        }
    }

    func toggleAccount(_ id: String) {
        if hiddenAccounts.contains(id) {
            hiddenAccounts.remove(id)
        } else if visibleAccounts.count > 1 {
            hiddenAccounts.insert(id)
        }
        scheduleReload()
    }

    func shift(_ direction: Int) {
        let step = mode == .day ? 1 : 7
        anchor = Calendar.agenda.date(byAdding: .day, value: step * direction, to: anchor) ?? anchor
        scheduleReload()
    }

    func goToToday() {
        anchor = Calendar.agenda.startOfDay(for: Date())
        scheduleReload()
    }

    func focus(day: Date) {
        anchor = Calendar.agenda.startOfDay(for: day)
        mode = .day
    }

    func delete(_ event: AgendaEvent) {
        events.removeAll { $0.id == event.id }
        selectedEvent = nil
        Task {
            do {
                try await client.deleteEvent(botID: botID, id: event.id)
            } catch {
                failed = error.localizedDescription
                await reload()
            }
        }
    }

    func remoteChanged(change: BlockChange?) {
        Task {
            await reload()
            remoteEditedAt = Date()
            guard case .events(let ids) = change, !ids.isEmpty else { return }
            if let first = events.first(where: { ids.contains($0.id) }), !days.contains(where: { Calendar.agenda.isDate($0, inSameDayAs: first.startDate) }) {
                anchor = Calendar.agenda.startOfDay(for: first.startDate)
                await reload()
            }
            highlighted = Set(ids)
            highlightTask?.cancel()
            highlightTask = Task {
                try? await Task.sleep(for: .seconds(2.6))
                guard !Task.isCancelled else { return }
                self.highlighted = []
            }
        }
    }

    func events(on day: Date) -> [AgendaEvent] {
        let calendar = Calendar.agenda
        guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { return [] }
        return events.filter { !$0.allDay && !hiddenAccounts.contains($0.accountId) && $0.startDate < next && $0.endDate > day }
    }

    func allDayEvents(on day: Date) -> [AgendaEvent] {
        let calendar = Calendar.agenda
        guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { return [] }
        return events.filter { $0.allDay && !hiddenAccounts.contains($0.accountId) && $0.startDate < next && $0.endDate > day }
    }

    private func scheduleReload() {
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            await self?.reload()
        }
    }
}

extension Calendar {
    static var agenda: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "pt_BR")
        calendar.timeZone = .current
        calendar.firstWeekday = 1
        return calendar
    }
}

extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
