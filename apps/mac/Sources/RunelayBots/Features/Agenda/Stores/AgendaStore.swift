import Foundation
import Observation

struct AllDaySpan: Identifiable, Hashable {
    let event: AgendaEvent
    let first: Int
    let last: Int
    let lane: Int
    let occurrences: Int

    var id: String { "\(event.id)#\(first)" }
}

@MainActor
@Observable
final class AgendaStore {
    enum Mode: String, CaseIterable, Identifiable {
        case day
        case week

        var id: String { rawValue }
        var title: String { self == .day ? "Dia" : "Semana" }
    }

    static let defaultHours = 8..<19
    static let minimumSpan = 8

    let botID: String
    private(set) var accounts: [AgendaAccount] = []
    private(set) var hiddenAccounts: Set<String> = []
    private(set) var events: [AgendaEvent] = []
    private(set) var anchor: Date
    private(set) var loading = false
    private(set) var failed: String?
    private(set) var highlighted: Set<String> = []
    private(set) var remoteEditedAt: Date?
    private(set) var deleting: String?
    private(set) var loaded = false
    private(set) var staggering = false
    private(set) var eventsRevision = 0
    private(set) var navigation = 0
    private(set) var navigationDirection = 1
    private(set) var nowRequest = 0
    var selectedEvent: AgendaEvent?
    var mode: Mode {
        didSet { if mode != oldValue { scheduleReload() } }
    }

    @ObservationIgnored let client: any BlocksClient
    @ObservationIgnored private var highlightTask: Task<Void, Never>?
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    init(botID: String, client: any BlocksClient, anchor: Date = Date(), mode: Mode = .week) {
        self.botID = botID
        self.client = client
        self.anchor = Calendar.agenda.startOfDay(for: anchor)
        self.mode = mode
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

    var rangeKey: String {
        "\(mode.rawValue)#\(anchor.timeIntervalSince1970)"
    }

    var rangeTitle: String {
        guard let first = days.first, let last = days.last else { return "" }
        if mode == .day {
            return first.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)).replacingOccurrences(of: ".", with: "").capitalizedFirst
        }
        let calendar = Calendar.agenda
        let month: (Date) -> String = { $0.formatted(.dateTime.month(.abbreviated)).replacingOccurrences(of: ".", with: "").lowercased() }
        if calendar.isDate(first, equalTo: last, toGranularity: .month) {
            return "\(first.formatted(.dateTime.day()))–\(last.formatted(.dateTime.day())) \(month(last))"
        }
        return "\(first.formatted(.dateTime.day())) \(month(first)) – \(last.formatted(.dateTime.day())) \(month(last))"
    }

    var showsToday: Bool {
        days.contains { Calendar.agenda.isDateInToday($0) }
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
        do {
            let list = try await client.agendaEvents(botID: botID, start: first, end: end, accounts: nil)
            if !loaded {
                staggering = true
                Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(700))
                    self?.staggering = false
                }
            }
            events = list.items.filter { $0.status != "cancelled" }
            eventsRevision += 1
            loaded = true
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
            if selectedEvent?.accountId == id {
                selectedEvent = nil
            }
        }
    }

    func shift(_ direction: Int) {
        let step = mode == .day ? 1 : 7
        navigationDirection = direction >= 0 ? 1 : -1
        navigation += 1
        anchor = Calendar.agenda.date(byAdding: .day, value: step * direction, to: anchor) ?? anchor
        selectedEvent = nil
        scheduleReload()
    }

    func goToToday() {
        let today = Calendar.agenda.startOfDay(for: Date())
        nowRequest += 1
        if !days.contains(where: { Calendar.agenda.isDate($0, inSameDayAs: today) }) {
            navigationDirection = today > anchor ? 1 : -1
            navigation += 1
        }
        anchor = today
        selectedEvent = nil
        scheduleReload()
    }

    func focus(day: Date) {
        anchor = Calendar.agenda.startOfDay(for: day)
        selectedEvent = nil
        mode = .day
    }

    func delete(_ event: AgendaEvent) {
        let snapshot = events
        events.removeAll { $0.id == event.id }
        selectedEvent = nil
        deleting = event.id
        Task {
            defer { deleting = nil }
            do {
                try await client.deleteEvent(botID: botID, id: event.id)
            } catch {
                events = snapshot
                failed = error.localizedDescription
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

    var timedEventsVisible: [AgendaEvent] {
        guard let first = days.first, let last = days.last,
              let end = Calendar.agenda.date(byAdding: .day, value: 1, to: last)
        else { return [] }
        return events.filter { !$0.allDay && !hiddenAccounts.contains($0.accountId) && $0.startDate < end && $0.endDate > first }
    }

    var hourRange: Range<Int> {
        let calendar = Calendar.agenda
        var low = Int.max
        var high = Int.min
        for event in timedEventsVisible {
            let day = calendar.startOfDay(for: max(event.startDate, days.first ?? event.startDate))
            let start = max(event.startDate, day)
            let end = min(event.endDate, calendar.date(byAdding: .day, value: 1, to: day) ?? event.endDate)
            let startHour = Int(floor(start.timeIntervalSince(day) / 3600))
            let endHour = Int(ceil(end.timeIntervalSince(day) / 3600))
            low = min(low, startHour)
            high = max(high, max(endHour, startHour + 1))
        }
        if showsToday {
            let now = Date()
            let hour = calendar.component(.hour, from: now)
            if low != Int.max {
                low = min(low, hour)
                high = max(high, hour + 1)
            }
        }
        guard low != Int.max else { return Self.defaultHours }
        low = max(0, low - 1)
        high = min(24, high + 1)
        while high - low < Self.minimumSpan {
            if low > 0 { low -= 1 }
            if high - low < Self.minimumSpan, high < 24 { high += 1 }
            if low == 0, high == 24 { break }
        }
        return low..<high
    }

    var allDaySpans: [AllDaySpan] {
        let calendar = Calendar.agenda
        let days = days
        guard let first = days.first else { return [] }
        var pieces: [(event: AgendaEvent, first: Int, last: Int)] = []
        for event in events where event.allDay && !hiddenAccounts.contains(event.accountId) {
            let startDay = calendar.startOfDay(for: event.startDate)
            let endDay = calendar.startOfDay(for: event.endDate)
            let lastDay = endDay > startDay ? calendar.date(byAdding: .day, value: -1, to: endDay) ?? startDay : startDay
            let startIndex = calendar.dateComponents([.day], from: first, to: startDay).day ?? 0
            let endIndex = calendar.dateComponents([.day], from: first, to: lastDay).day ?? 0
            guard endIndex >= 0, startIndex < days.count else { continue }
            pieces.append((event, max(0, startIndex), min(days.count - 1, endIndex)))
        }
        pieces.sort { $0.first == $1.first ? $0.last > $1.last : $0.first < $1.first }
        var merged: [(event: AgendaEvent, first: Int, last: Int, count: Int)] = []
        for piece in pieces {
            if let index = merged.lastIndex(where: {
                $0.event.title == piece.event.title && $0.event.accountId == piece.event.accountId && piece.first <= $0.last + 1 && piece.first >= $0.first
            }) {
                merged[index].last = max(merged[index].last, piece.last)
                merged[index].count += 1
            } else {
                merged.append((piece.event, piece.first, piece.last, 1))
            }
        }
        var laneEnds: [Int] = []
        return merged.map { item in
            let lane: Int
            if let free = laneEnds.firstIndex(where: { $0 < item.first }) {
                laneEnds[free] = item.last
                lane = free
            } else {
                laneEnds.append(item.last)
                lane = laneEnds.count - 1
            }
            return AllDaySpan(event: item.event, first: item.first, last: item.last, lane: lane, occurrences: item.count)
        }
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
        calendar.firstWeekday = 2
        return calendar
    }
}

extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
