import AppKit
import SwiftUI

struct AgendaView: View {
    @Bindable var store: AgendaStore
    @Environment(\.appReduceMotion) private var reduceMotion

    static let hourHeight: CGFloat = 46
    static let gutter: CGFloat = 48

    var body: some View {
        VStack(spacing: Spacing.s) {
            AgendaHeader(store: store)
            ZStack(alignment: .trailing) {
                VStack(spacing: 0) {
                    AgendaDayHeaders(store: store)
                    AgendaAllDayRow(store: store)
                    AgendaTimeGrid(store: store)
                }
                .background(Theme.background, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                if let event = store.selectedEvent {
                    AgendaEventDetail(store: store, event: event)
                        .frame(width: 300)
                        .padding(Spacing.s)
                        .transition(Motion.panel(reduceMotion: reduceMotion))
                }
            }
        }
        .padding(.horizontal, Spacing.l)
        .padding(.bottom, Spacing.l)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.selectedEvent?.id)
    }
}

struct AgendaHeader: View {
    @Bindable var store: AgendaStore

    var body: some View {
        HStack(spacing: Spacing.s) {
            HStack(spacing: Spacing.xxs) {
                SheetToolButton(systemImage: "chevron.left", help: store.mode == .day ? "Dia anterior" : "Semana anterior") {
                    store.shift(-1)
                }
                SheetToolButton(title: "Hoje", help: "Voltar para hoje") {
                    store.goToToday()
                }
                SheetToolButton(systemImage: "chevron.right", help: store.mode == .day ? "Próximo dia" : "Próxima semana") {
                    store.shift(1)
                }
            }
            .padding(Spacing.xxs)
            .background(Theme.surface, in: Capsule())
            Text(store.rangeTitle)
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: Spacing.s)
            ForEach(store.accounts) { account in
                AgendaAccountChip(account: account, visible: !store.hiddenAccounts.contains(account.id)) {
                    store.toggleAccount(account.id)
                }
            }
            HStack(spacing: Spacing.xxs) {
                ForEach(AgendaStore.Mode.allCases) { mode in
                    SheetToolButton(title: mode.title, help: mode == .day ? "Ver o dia" : "Ver a semana", isActive: store.mode == mode) {
                        store.mode = mode
                    }
                }
            }
            .padding(Spacing.xxs)
            .background(Theme.surface, in: Capsule())
        }
    }
}

struct AgendaAccountChip: View {
    let account: AgendaAccount
    let visible: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xs + 2) {
                Circle()
                    .fill(visible ? Theme.accent(account.color) : Color.clear)
                    .overlay {
                        if !visible {
                            Circle().strokeBorder(Theme.accent(account.color), lineWidth: 1.5)
                        }
                    }
                    .frame(width: 9, height: 9)
                Text(account.label)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(visible ? Theme.textPrimary : Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                if account.status == "needs_auth" {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.warning)
                }
            }
            .padding(.horizontal, Spacing.s + 2)
            .frame(height: 28)
            .background(hovering ? Theme.surfaceRaised : Theme.surface, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help(account.status == "needs_auth" ? "\(account.email) precisa ser ligada de novo na runelay" : visible ? "Esconder \(account.email)" : "Mostrar \(account.email)")
    }
}

struct AgendaDayHeaders: View {
    let store: AgendaStore

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: AgendaView.gutter)
            ForEach(store.days, id: \.self) { day in
                let today = Calendar.agenda.isDateInToday(day)
                Button {
                    if store.mode == .week {
                        store.focus(day: day)
                    }
                } label: {
                    HStack(spacing: Spacing.xs) {
                        Text(day.formatted(.dateTime.weekday(.abbreviated)).replacingOccurrences(of: ".", with: "").capitalizedFirst)
                            .font(TypeScale.caption)
                            .foregroundStyle(today ? Theme.brandText : Theme.textSecondary)
                            .lineLimit(1)
                        Text(day.formatted(.dateTime.day()))
                            .font(TypeScale.captionStrong.monospacedDigit())
                            .foregroundStyle(today ? Theme.onAccent : Theme.textPrimary)
                            .lineLimit(1)
                            .frame(minWidth: 22, minHeight: 22)
                            .background(today ? Theme.brandAccent : Color.clear, in: Circle())
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .clickable()
                .disabled(store.mode == .day)
            }
        }
        .background(Theme.surface.opacity(0.5))
    }
}

struct AgendaAllDayRow: View {
    let store: AgendaStore

    var body: some View {
        let hasAny = store.days.contains { !store.allDayEvents(on: $0).isEmpty }
        if hasAny {
            HStack(alignment: .top, spacing: 0) {
                Text("dia todo")
                    .font(BrandFonts.sans(10))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: AgendaView.gutter, alignment: .center)
                    .padding(.top, Spacing.xs)
                ForEach(store.days, id: \.self) { day in
                    VStack(spacing: Spacing.xxs) {
                        ForEach(store.allDayEvents(on: day)) { event in
                            Button {
                                store.selectedEvent = event
                            } label: {
                                Text(event.title)
                                    .font(BrandFonts.sans(11, weight: .medium))
                                    .foregroundStyle(Theme.textPrimary)
                                    .lineLimit(1)
                                    .padding(.horizontal, Spacing.xs + 2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .frame(height: 20)
                                    .background(Theme.accent(store.color(for: event.accountId)).opacity(0.22))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .clickable()
                        }
                    }
                    .padding(.horizontal, 2)
                    .padding(.vertical, Spacing.xs)
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

struct AgendaTimeGrid: View {
    let store: AgendaStore

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                ZStack(alignment: .topLeading) {
                    VStack(spacing: 0) {
                        ForEach(0..<24, id: \.self) { hour in
                            HStack(alignment: .top, spacing: 0) {
                                Text(hour == 0 ? "" : String(format: "%02d:00", hour))
                                    .font(BrandFonts.sans(10).monospacedDigit())
                                    .foregroundStyle(Theme.textTertiary)
                                    .lineLimit(1)
                                    .fixedSize()
                                    .frame(width: AgendaView.gutter - 8, alignment: .trailing)
                                    .offset(y: -6)
                                Rectangle()
                                    .fill(Theme.paneDivider)
                                    .frame(height: 0.5)
                                    .padding(.leading, 8)
                            }
                            .frame(height: AgendaView.hourHeight, alignment: .top)
                            .id(hour)
                        }
                    }
                    GeometryReader { geometry in
                        let columnWidth = (geometry.size.width - AgendaView.gutter) / CGFloat(max(store.days.count, 1))
                        ForEach(Array(store.days.enumerated()), id: \.element) { index, day in
                            let x = AgendaView.gutter + CGFloat(index) * columnWidth
                            if Calendar.agenda.isDateInToday(day) {
                                Rectangle()
                                    .fill(Theme.brandAccent.opacity(0.035))
                                    .frame(width: columnWidth, height: AgendaView.hourHeight * 24)
                                    .offset(x: x)
                                    .allowsHitTesting(false)
                            }
                            if index > 0 {
                                Rectangle()
                                    .fill(Theme.paneDivider)
                                    .frame(width: 0.5, height: AgendaView.hourHeight * 24)
                                    .offset(x: x)
                                    .allowsHitTesting(false)
                            }
                            ForEach(AgendaLayout.place(store.events(on: day), day: day)) { placed in
                                let width = columnWidth / CGFloat(placed.columns)
                                AgendaEventBlock(
                                    event: placed.event,
                                    color: store.color(for: placed.event.accountId),
                                    highlighted: store.highlighted.contains(placed.event.id),
                                    selected: store.selectedEvent?.id == placed.event.id,
                                    compact: placed.height < 34
                                ) {
                                    store.selectedEvent = placed.event
                                }
                                .frame(width: max(width - 3, 8), height: max(placed.height - 2, 16))
                                .offset(x: x + width * CGFloat(placed.column) + 1, y: placed.top + 1)
                            }
                            if Calendar.agenda.isDateInToday(day) {
                                AgendaNowLine(width: columnWidth)
                                    .offset(x: x)
                                    .allowsHitTesting(false)
                            }
                        }
                    }
                    .frame(height: AgendaView.hourHeight * 24)
                }
                .padding(.top, Spacing.s)
            }
            .scrollEdgesHidden()
            .onAppear {
                let hour = max(0, min(Calendar.agenda.component(.hour, from: Date()) - 2, 16))
                proxy.scrollTo(hour, anchor: .top)
            }
        }
    }
}

struct AgendaNowLine: View {
    let width: CGFloat

    var body: some View {
        TimelineView(.everyMinute) { context in
            let calendar = Calendar.agenda
            let minutes = CGFloat(calendar.component(.hour, from: context.date) * 60 + calendar.component(.minute, from: context.date))
            let y = minutes / 60 * AgendaView.hourHeight
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(Theme.danger)
                    .frame(width: width, height: 1.5)
                Circle()
                    .fill(Theme.danger)
                    .frame(width: 8, height: 8)
                    .offset(x: -4)
            }
            .offset(y: y - 0.75)
        }
        .frame(width: width, alignment: .topLeading)
    }
}

struct AgendaEventBlock: View {
    let event: AgendaEvent
    let color: String
    let highlighted: Bool
    let selected: Bool
    let compact: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 0) {
                Rectangle()
                    .fill(Theme.accent(color))
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(event.title)
                        .font(BrandFonts.sans(11.5, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(compact ? 1 : 2)
                    if !compact {
                        Text(timeText)
                            .font(BrandFonts.sans(10.5).monospacedDigit())
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    }
                }
                .padding(.horizontal, Spacing.xs + 1)
                .padding(.vertical, compact ? 1 : Spacing.xxs + 1)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .background(Theme.accent(color).opacity(selected ? 0.32 : hovering || highlighted ? 0.26 : 0.16))
            .clipShape(Rectangle())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: highlighted)
        .help(event.title)
    }

    private var timeText: String {
        let format = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        return "\(event.startDate.formatted(format))–\(event.endDate.formatted(format))"
    }
}

struct AgendaEventDetail: View {
    let store: AgendaStore
    let event: AgendaEvent

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(alignment: .top, spacing: Spacing.s) {
                Rectangle()
                    .fill(Theme.accent(store.color(for: event.accountId)))
                    .frame(width: 4, height: 22)
                Text(event.title)
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                RoundIconButton(systemImage: "xmark", help: "Fechar", size: 26) {
                    store.selectedEvent = nil
                }
            }
            detailRow("clock", whenText)
            if let account = store.account(event.accountId) {
                detailRow("person.crop.circle", account.label)
            }
            if let location = event.location, !location.isEmpty {
                detailRow("mappin.and.ellipse", location)
            }
            if event.recurring {
                detailRow("repeat", "Repete")
            }
            if !event.attendees.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    ForEach(event.attendees, id: \.email) { attendee in
                        HStack(spacing: Spacing.s) {
                            Image(systemName: icon(for: attendee.response))
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(attendee.response == "accepted" ? Theme.success : attendee.response == "declined" ? Theme.danger : Theme.textTertiary)
                                .frame(width: 16)
                            Text(attendee.isSelf ? "Você" : attendee.displayName)
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            if attendee.organizer {
                                Text("organiza")
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textTertiary)
                                    .lineLimit(1)
                                    .fixedSize()
                            }
                        }
                    }
                }
            }
            if let description = event.description, !description.isEmpty {
                Text(description)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
            HStack(spacing: Spacing.s) {
                if let meet = event.meetUrl, let url = URL(string: meet) {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label("Entrar no Meet", systemImage: "video.fill")
                            .font(TypeScale.rowTitle)
                            .foregroundStyle(Theme.onAccent)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.horizontal, Spacing.l)
                            .frame(height: 34)
                            .background(Theme.brandAccent, in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(PressableButtonStyle())
                }
                Spacer(minLength: 0)
                RoundIconButton(systemImage: "trash", help: "Apagar o evento", size: 32) {
                    store.delete(event)
                }
            }
        }
        .padding(Spacing.l)
        .frame(maxHeight: .infinity, alignment: .top)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.large, style: .continuous), fallback: Theme.surfaceRaised)
        .softElevation(lifted: true)
    }

    private func detailRow(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 16)
            Text(text)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var whenText: String {
        let day = event.startDate.formatted(.dateTime.weekday(.wide).day().month(.wide)).capitalizedFirst
        if event.allDay { return "\(day) · dia todo" }
        let format = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        return "\(day) · \(event.startDate.formatted(format))–\(event.endDate.formatted(format))"
    }

    private func icon(for response: String) -> String {
        switch response {
        case "accepted": "checkmark.circle.fill"
        case "declined": "xmark.circle.fill"
        case "tentative": "questionmark.circle"
        default: "circle"
        }
    }
}

struct PlacedEvent: Identifiable {
    let event: AgendaEvent
    let top: CGFloat
    let height: CGFloat
    let column: Int
    let columns: Int

    var id: String { event.id }
}

@MainActor
enum AgendaLayout {
    static func place(_ events: [AgendaEvent], day: Date) -> [PlacedEvent] {
        let calendar = Calendar.agenda
        guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { return [] }
        let sorted = events.sorted { $0.startDate == $1.startDate ? $0.endDate > $1.endDate : $0.startDate < $1.startDate }
        var result: [PlacedEvent] = []
        var cluster: [(AgendaEvent, Int)] = []
        var clusterEnd = Date.distantPast
        var columnEnds: [Date] = []

        func flush() {
            let count = max(columnEnds.count, 1)
            for (event, column) in cluster {
                let start = max(event.startDate, day)
                let end = min(max(event.endDate, start.addingTimeInterval(900)), next)
                let top = CGFloat(start.timeIntervalSince(day) / 3600) * AgendaView.hourHeight
                let height = CGFloat(end.timeIntervalSince(start) / 3600) * AgendaView.hourHeight
                result.append(PlacedEvent(event: event, top: top, height: height, column: column, columns: count))
            }
            cluster = []
            columnEnds = []
        }

        for event in sorted {
            if event.startDate >= clusterEnd, !cluster.isEmpty {
                flush()
            }
            let effectiveEnd = max(event.endDate, event.startDate.addingTimeInterval(900))
            if let free = columnEnds.firstIndex(where: { $0 <= event.startDate }) {
                columnEnds[free] = effectiveEnd
                cluster.append((event, free))
            } else {
                columnEnds.append(effectiveEnd)
                cluster.append((event, columnEnds.count - 1))
            }
            clusterEnd = max(clusterEnd, effectiveEnd)
        }
        flush()
        return result
    }
}
