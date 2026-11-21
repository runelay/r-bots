import AppKit
import SwiftUI

enum AgendaMetrics {
    static let gutter: CGFloat = 46
    static let minHourHeight: CGFloat = 36
    static let maxHourHeight: CGFloat = 72
    static let allDayRow: CGFloat = 22
    static let allDayLanes = 3
    static let shortEvent: CGFloat = 34
}

enum AgendaFormat {
    static let time = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)

    static func range(_ event: AgendaEvent) -> String {
        "\(event.startDate.formatted(time))–\(event.endDate.formatted(time))"
    }

    static func weekday(_ day: Date) -> String {
        day.formatted(.dateTime.weekday(.abbreviated)).replacingOccurrences(of: ".", with: "").capitalizedFirst
    }

    static func isWeekend(_ day: Date) -> Bool {
        Calendar.agenda.isDateInWeekend(day)
    }
}

struct AgendaView: View {
    @Bindable var store: AgendaStore

    var body: some View {
        VStack(spacing: 0) {
            AgendaLegend(store: store)
                .padding(.horizontal, Spacing.l)
                .padding(.bottom, Spacing.xs)
                .frame(height: 30)
            AgendaSliding(store: store) {
                AgendaDayHeaders(store: store)
            }
            .frame(height: 40)
            AgendaAllDayStrip(store: store)
                .fixedSize(horizontal: false, vertical: true)
            AgendaTimeGrid(store: store)
                .frame(maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

struct AgendaSliding<Content: View>: View {
    let store: AgendaStore
    @ViewBuilder let content: Content

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        let shift: CGFloat = reduceMotion ? 0 : 36 * CGFloat(store.navigationDirection)
        ZStack {
            content
                .id(store.navigation)
                .transition(
                    .asymmetric(
                        insertion: .offset(x: shift).combined(with: .opacity),
                        removal: .offset(x: -shift).combined(with: .opacity)
                    ))
        }
        .clipped()
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.navigation)
    }
}

struct AgendaHeaderControls: View {
    @Bindable var store: AgendaStore

    var body: some View {
        HStack(spacing: Spacing.s) {
            HStack(spacing: 0) {
                AgendaNavButton(systemImage: "chevron.left", help: store.mode == .day ? "Dia anterior" : "Semana anterior") {
                    store.shift(-1)
                }
                AgendaNavButton(title: "Hoje", help: "Voltar para hoje", isActive: store.showsToday) {
                    store.goToToday()
                }
                AgendaNavButton(systemImage: "chevron.right", help: store.mode == .day ? "Próximo dia" : "Próxima semana") {
                    store.shift(1)
                }
            }
            Text(store.rangeTitle)
                .font(TypeScale.rowSubtitle.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .truncationMode(.tail)
                .layoutPriority(1)
                .contentTransition(.numericText())
        }
        .springAnimation(value: store.rangeKey)
    }
}

struct AgendaModeSwitch: View {
    @Bindable var store: AgendaStore
    @Namespace private var namespace

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AgendaStore.Mode.allCases) { mode in
                let active = store.mode == mode
                Button {
                    store.mode = mode
                } label: {
                    Text(mode.title)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(active ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Spacing.s + 2)
                        .frame(height: 24)
                        .background {
                            if active {
                                Capsule()
                                    .fill(Theme.selection)
                                    .matchedGeometryEffect(id: "mode", in: namespace)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle())
                .help(mode == .day ? "Ver o dia" : "Ver a semana")
            }
        }
        .padding(2)
        .glassSurface(Capsule(), interactive: true)
        .springAnimation(value: store.mode)
    }
}

struct AgendaNavButton: View {
    var systemImage: String? = nil
    var title: String? = nil
    let help: String
    var isActive = false
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 26, height: 26)
                } else if let title {
                    Text(title)
                        .font(TypeScale.captionStrong)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Spacing.s)
                        .frame(height: 26)
                }
            }
            .foregroundStyle(hovering || isActive ? Theme.textPrimary : Theme.textSecondary)
            .background(hovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .blockTooltip(help, edge: .leading)
        .accessibilityLabel(help)
    }
}

struct AgendaLegend: View {
    let store: AgendaStore

    var body: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(store.accounts) { account in
                AgendaAccountChip(account: account, visible: !store.hiddenAccounts.contains(account.id)) {
                    store.toggleAccount(account.id)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(height: 26)
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
                    .fill(Theme.accent(account.color))
                    .frame(width: 8, height: 8)
                    .opacity(visible ? 1 : 0.35)
                Text(account.label)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(visible ? Theme.textPrimary : Theme.textTertiary)
                    .strikethrough(!visible, color: Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                if account.status == "needs_auth" {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.warning)
                }
            }
            .padding(.horizontal, Spacing.s + 2)
            .frame(height: 24)
            .background(hovering ? Theme.hover : Color.clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: visible)
        .help(account.status == "needs_auth" ? "\(account.email) precisa ser ligada de novo na runelay" : visible ? "Esconder \(account.email)" : "Mostrar \(account.email)")
    }
}

struct AgendaDayHeaders: View {
    let store: AgendaStore

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: AgendaMetrics.gutter)
            ForEach(store.days, id: \.self) { day in
                AgendaDayHeader(day: day, mode: store.mode) {
                    if store.mode == .week {
                        store.focus(day: day)
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }
        }
        .frame(height: 40)
        .springAnimation(value: store.mode)
    }
}

struct AgendaDayHeader: View {
    let day: Date
    let mode: AgendaStore.Mode
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        let today = Calendar.agenda.isDateInToday(day)
        let weekend = AgendaFormat.isWeekend(day)
        Button(action: action) {
            HStack(spacing: Spacing.xs) {
                Text(AgendaFormat.weekday(day))
                    .font(TypeScale.caption)
                    .foregroundStyle(today ? Theme.brandText : weekend ? Theme.textTertiary : Theme.textSecondary)
                    .lineLimit(1)
                    .fixedSize()
                Text(day.formatted(.dateTime.day()))
                    .font(TypeScale.captionStrong.monospacedDigit())
                    .foregroundStyle(today ? Theme.onAccent : weekend ? Theme.textSecondary : Theme.textPrimary)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(minWidth: 22, minHeight: 22)
                    .background(today ? Theme.brandAccent : hovering && mode == .week ? Theme.hover : Color.clear, in: Circle())
            }
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .disabled(mode == .day)
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help(mode == .week ? "Ver só este dia" : "")
    }
}

struct AgendaAllDayStrip: View {
    let store: AgendaStore

    @State private var expanded = false

    var body: some View {
        let spans = store.allDaySpans
        if !spans.isEmpty {
            let lanes = (spans.map(\.lane).max() ?? 0) + 1
            let shownLanes = expanded ? lanes : min(lanes, AgendaMetrics.allDayLanes)
            let hidden = spans.filter { $0.lane >= shownLanes }.count
            HStack(alignment: .top, spacing: 0) {
                Group {
                    if hidden > 0 || expanded {
                        Button {
                            expanded.toggle()
                        } label: {
                            Text(expanded ? "menos" : "+\(hidden)")
                                .font(TypeScale.caption.monospacedDigit())
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .fixedSize()
                                .frame(width: AgendaMetrics.gutter - 6, height: AgendaMetrics.allDayRow)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .clickable()
                    } else {
                        Color.clear
                    }
                }
                .frame(width: AgendaMetrics.gutter, alignment: .leading)
                GeometryReader { geometry in
                    let column = geometry.size.width / CGFloat(max(store.days.count, 1))
                    ForEach(spans.filter { $0.lane < shownLanes }) { span in
                        let width = column * CGFloat(span.last - span.first + 1)
                        AgendaAllDayPill(store: store, span: span, edge: span.first > store.days.count / 2 ? .trailing : .leading)
                            .frame(width: max(width - 4, 12), height: AgendaMetrics.allDayRow - 3)
                            .offset(x: column * CGFloat(span.first) + 2, y: CGFloat(span.lane) * AgendaMetrics.allDayRow)
                    }
                }
                .frame(height: CGFloat(shownLanes) * AgendaMetrics.allDayRow)
            }
            .padding(.bottom, Spacing.xs)
            .springAnimation(value: expanded)
        }
    }
}

struct AgendaAllDayPill: View {
    let store: AgendaStore
    let span: AllDaySpan
    let edge: GlassMenuEdge

    @State private var hovering = false

    var body: some View {
        let color = Theme.accent(store.color(for: span.event.accountId))
        Button {
            store.selectedEvent = span.event
        } label: {
            HStack(spacing: Spacing.xs) {
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                Text(span.event.title)
                    .font(BrandFonts.sans(11, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(color.opacity(hovering || isSelected ? 0.24 : 0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help(span.event.title)
        .agendaPopover(store: store, event: span.event, edge: edge)
    }

    private var isSelected: Bool {
        store.selectedEvent?.id == span.event.id
    }
}

struct AgendaTimeGrid: View {
    let store: AgendaStore

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { outer in
            let range = store.hourRange
            let fitted = (outer.size.height - Spacing.l) / CGFloat(max(range.count, 1))
            let hourHeight = min(max(fitted, AgendaMetrics.minHourHeight), AgendaMetrics.maxHourHeight)
            let fits = fitted >= AgendaMetrics.minHourHeight
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    ZStack(alignment: .topLeading) {
                        AgendaHourLines(hourHeight: hourHeight)
                        AgendaHourMarkers(hourHeight: hourHeight)
                        AgendaSliding(store: store) {
                            ZStack(alignment: .topLeading) {
                                if !store.loaded {
                                    AgendaShimmer(store: store, hourHeight: hourHeight)
                                        .transition(.opacity)
                                }
                                AgendaColumns(store: store, hourHeight: hourHeight)
                            }
                            .animation(Motion.crossFade, value: store.loaded)
                        }
                        .padding(.leading, AgendaMetrics.gutter)
                    }
                    .frame(height: hourHeight * 24)
                    .padding(.top, Spacing.m)
                    .padding(.bottom, Spacing.s)
                }
                .scrollEdgesHidden()
                .onAppear {
                    scroll(proxy, range: range, fits: fits, toNow: false, animated: false)
                }
                .onChange(of: store.rangeKey) {
                    scroll(proxy, range: store.hourRange, fits: fits, toNow: false, animated: true)
                }
                .onChange(of: store.nowRequest) {
                    scroll(proxy, range: store.hourRange, fits: fits, toNow: true, animated: true)
                }
                .onChange(of: store.eventsRevision) { old, _ in
                    if old == 0 {
                        scroll(proxy, range: store.hourRange, fits: fits, toNow: false, animated: false)
                    }
                }
            }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy, range: Range<Int>, fits: Bool, toNow: Bool, animated: Bool) {
        var target = range.lowerBound
        if toNow || !fits, store.showsToday {
            let now = Calendar.agenda.component(.hour, from: Date())
            target = toNow ? max(0, now - 1) : max(range.lowerBound, min(now - 1, 23))
        }
        if animated {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) { proxy.scrollTo(target, anchor: .top) }
        } else {
            proxy.scrollTo(target, anchor: .top)
        }
    }
}

struct AgendaHourMarkers: View {
    let hourHeight: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(0..<24, id: \.self) { hour in
                Color.clear
                    .frame(width: 1, height: 1)
                    .position(x: 0.5, y: max(0.5, CGFloat(hour) * hourHeight - 12))
                    .id(hour)
            }
        }
        .frame(width: 1, height: hourHeight * 24)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct AgendaShimmer: View {
    let store: AgendaStore
    let hourHeight: CGFloat

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    var body: some View {
        GeometryReader { geometry in
            let count = max(store.days.count, 1)
            let column = geometry.size.width / CGFloat(count)
            let start = CGFloat(store.hourRange.lowerBound) * hourHeight
            ZStack(alignment: .topLeading) {
                ForEach(0..<count, id: \.self) { index in
                    ForEach(0..<3, id: \.self) { slot in
                        let seed = (index * 7 + slot * 3) % 5
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(Theme.surface)
                            .frame(width: max(column - 6, 8), height: hourHeight * (0.6 + CGFloat(seed) * 0.2))
                            .offset(x: CGFloat(index) * column + 3, y: start + hourHeight * (CGFloat(slot) * 2.4 + CGFloat(seed) * 0.4 + 0.5))
                    }
                }
            }
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: Theme.maskVisible.opacity(0.45), location: 0),
                        .init(color: Theme.maskVisible, location: 0.5),
                        .init(color: Theme.maskVisible.opacity(0.45), location: 1),
                    ],
                    startPoint: UnitPoint(x: phase, y: 0),
                    endPoint: UnitPoint(x: phase + 1, y: 0)
                )
            }
        }
        .allowsHitTesting(false)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
    }
}

struct AgendaHourLines: View {
    let hourHeight: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 0) {
                    Text(hour == 0 ? "" : String(format: "%02d:00", hour))
                        .font(BrandFonts.sans(10).monospacedDigit())
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .fixedSize()
                        .frame(width: AgendaMetrics.gutter - 8, alignment: .trailing)
                        .offset(y: -6)
                    Rectangle()
                        .fill(Theme.paneDivider)
                        .frame(height: 0.5)
                        .padding(.leading, 8)
                }
                .frame(height: hourHeight, alignment: .top)
            }
        }
    }
}

struct AgendaColumns: View {
    let store: AgendaStore
    let hourHeight: CGFloat

    var body: some View {
        GeometryReader { geometry in
            let count = max(store.days.count, 1)
            let column = geometry.size.width / CGFloat(count)
            let height = hourHeight * 24
            ForEach(Array(store.days.enumerated()), id: \.element) { index, day in
                let x = CGFloat(index) * column
                let today = Calendar.agenda.isDateInToday(day)
                Rectangle()
                    .fill(today ? Theme.brandAccent.opacity(0.04) : AgendaFormat.isWeekend(day) ? Theme.surface.opacity(0.45) : Color.clear)
                    .frame(width: column, height: height)
                    .offset(x: x)
                    .allowsHitTesting(false)
                if index > 0 {
                    Rectangle()
                        .fill(Theme.paneDivider)
                        .frame(width: 0.5, height: height)
                        .offset(x: x)
                        .allowsHitTesting(false)
                }
                ForEach(Array(AgendaLayout.place(store.events(on: day), day: day, hourHeight: hourHeight).enumerated()), id: \.element.id) { order, placed in
                    let unit = column / CGFloat(placed.columns)
                    let width = max(unit * CGFloat(placed.span) - 2, 10)
                    AgendaEventBlock(
                        store: store,
                        event: placed.event,
                        width: width,
                        height: placed.height,
                        edge: index >= count / 2 && count > 1 ? .trailing : .leading,
                        delay: store.staggering ? min(Double(index * 3 + order) * 0.025, 0.3) : nil
                    )
                    .frame(width: width, height: max(placed.height - 1.5, 14))
                    .offset(x: x + unit * CGFloat(placed.column) + 1, y: placed.top + 0.75)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                }
                if today {
                    AgendaNowLine(width: column, hourHeight: hourHeight, leading: index == 0)
                        .offset(x: x)
                        .allowsHitTesting(false)
                }
            }
        }
        .springAnimation(value: store.mode)
        .springAnimation(value: store.hiddenAccounts)
        .springAnimation(value: store.eventsRevision)
    }
}

struct AgendaNowLine: View {
    let width: CGFloat
    let hourHeight: CGFloat
    let leading: Bool

    var body: some View {
        TimelineView(.everyMinute) { context in
            let calendar = Calendar.agenda
            let minutes = CGFloat(calendar.component(.hour, from: context.date) * 60 + calendar.component(.minute, from: context.date))
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(Theme.brandAccent)
                    .frame(width: width, height: 1.5)
                Circle()
                    .fill(Theme.brandAccent)
                    .frame(width: 7, height: 7)
                    .offset(x: -3.5)
            }
            .offset(y: minutes / 60 * hourHeight - 0.75)
            .animation(.easeInOut(duration: 0.6), value: minutes)
        }
        .frame(width: width, alignment: .topLeading)
    }
}

struct AgendaEventBlock: View {
    let store: AgendaStore
    let event: AgendaEvent
    let width: CGFloat
    let height: CGFloat
    let edge: GlassMenuEdge
    var delay: Double?

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var hovering = false
    @State private var appeared = false

    private var short: Bool { height < AgendaMetrics.shortEvent }
    private var narrow: Bool { width < 96 }
    private var timeFits: Bool { width >= 78 }
    private var selected: Bool { store.selectedEvent?.id == event.id }
    private var highlighted: Bool { store.highlighted.contains(event.id) }
    private var past: Bool { event.endDate < Date() }

    var body: some View {
        let color = Theme.accent(store.color(for: event.accountId))
        Button {
            store.selectedEvent = selected ? nil : event
        } label: {
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(color)
                    .frame(width: 3)
                    .padding(.vertical, 2)
                    .padding(.leading, 2)
                content
                    .padding(.horizontal, 5)
                    .padding(.vertical, short ? 0 : 3)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: short ? .leading : .topLeading)
            }
            .background(color.opacity(selected ? 0.34 : hovering || highlighted ? 0.26 : 0.16), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .opacity(past && !selected && !hovering ? 0.62 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .shadow(color: hovering ? Theme.elevationShadowLifted : .clear, radius: 6, y: 2)
            .scaleEffect(hovering && !reduceMotion ? 1.015 : 1)
        }
        .buttonStyle(.plain)
        .clickable()
        .opacity(delay == nil || appeared ? 1 : 0)
        .scaleEffect(delay == nil || appeared || reduceMotion ? 1 : 0.96)
        .onAppear {
            guard let delay, !appeared else { return }
            withAnimation(Motion.animation(reduceMotion: reduceMotion).delay(reduceMotion ? 0 : delay)) {
                appeared = true
            }
        }
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: highlighted)
        .springAnimation(value: selected)
        .help("\(event.title) · \(AgendaFormat.range(event))")
        .agendaPopover(store: store, event: event, edge: edge)
    }

    @ViewBuilder
    private var content: some View {
        if short {
            HStack(spacing: Spacing.xs) {
                Text(event.title)
                    .font(BrandFonts.sans(11, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if timeFits {
                    Text(event.startDate.formatted(AgendaFormat.time))
                        .font(BrandFonts.sans(10).monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                        .layoutPriority(1)
                }
                Spacer(minLength: 0)
            }
        } else if narrow {
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title)
                    .font(BrandFonts.sans(11, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(height >= 40 ? 2 : 1)
                    .truncationMode(.tail)
                if height >= 54 {
                    Text(event.startDate.formatted(AgendaFormat.time))
                        .font(BrandFonts.sans(10).monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title)
                    .font(BrandFonts.sans(11.5, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(height >= 58 ? 2 : 1)
                    .truncationMode(.tail)
                HStack(spacing: Spacing.xs) {
                    Text(AgendaFormat.range(event))
                        .font(BrandFonts.sans(10.5).monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                    if event.meetUrl != nil {
                        Image(systemName: "video.fill")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                if height > 64, let location = event.location, !location.isEmpty {
                    Text(location)
                        .font(BrandFonts.sans(10.5))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
            }
        }
    }
}

extension View {
    func agendaPopover(store: AgendaStore, event: AgendaEvent, edge: GlassMenuEdge) -> some View {
        glassPopup(
            isPresented: Binding(
                get: { store.selectedEvent?.id == event.id },
                set: { shown in
                    if !shown, store.selectedEvent?.id == event.id {
                        store.selectedEvent = nil
                    }
                }
            ),
            edge: edge
        ) {
            AgendaEventPopover(store: store, event: store.selectedEvent ?? event)
        }
    }
}

struct AgendaEventPopover: View {
    let store: AgendaStore
    let event: AgendaEvent

    @Environment(\.glassPopupDismiss) private var dismiss
    @State private var confirmingDelete = false

    private static let attendeeLimit = 6

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                Circle()
                    .fill(Theme.accent(store.color(for: event.accountId)))
                    .frame(width: 9, height: 9)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                Text(event.title)
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: Spacing.s) {
                row("clock", whenText)
                if let account = store.account(event.accountId) {
                    row("person.crop.circle", account.email.isEmpty ? account.label : "\(account.label) · \(account.email)")
                }
                if event.recurring {
                    row("repeat", "Evento que se repete")
                }
                if let location = event.location, !location.isEmpty, location != event.meetUrl {
                    row("mappin.and.ellipse", location)
                }
            }
            if !event.attendees.isEmpty {
                attendees
            }
            if let description = cleanDescription {
                Text(description)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(6)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            actions
        }
        .padding(Spacing.l)
        .frame(width: 320, alignment: .leading)
    }

    private var attendees: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(event.attendees.count == 1 ? "1 participante" : "\(event.attendees.count) participantes")
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
                .fixedSize()
            ForEach(event.attendees.prefix(Self.attendeeLimit), id: \.email) { attendee in
                HStack(spacing: Spacing.s) {
                    Image(systemName: icon(for: attendee.response))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(attendee.response == "accepted" ? Theme.success : attendee.response == "declined" ? Theme.danger : Theme.textTertiary)
                        .frame(width: 14)
                    Text(attendee.isSelf ? "Você" : attendee.displayName)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if attendee.organizer {
                        Text("organiza")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
            if event.attendees.count > Self.attendeeLimit {
                Text("e mais \(event.attendees.count - Self.attendeeLimit)")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.leading, 14 + Spacing.s)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: Spacing.s) {
            if let meet = event.meetUrl, let url = URL(string: meet) {
                Button {
                    NSWorkspace.shared.open(url)
                    dismiss()
                } label: {
                    Label(meet.contains("meet.google.com") ? "Entrar no Meet" : "Entrar na chamada", systemImage: "video.fill")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.onAccent)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Spacing.m)
                        .frame(height: 30)
                        .background(Theme.brandAccent, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle())
            }
            if let link = event.calendarUrl, let url = URL(string: link) {
                Button {
                    NSWorkspace.shared.open(url)
                    dismiss()
                } label: {
                    Text("Abrir no Google")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Spacing.m)
                        .frame(height: 30)
                        .background(Theme.hover, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle())
            }
            Spacer(minLength: 0)
            if confirmingDelete {
                Button {
                    store.delete(event)
                    dismiss()
                } label: {
                    Text("Apagar evento")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.danger)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Spacing.m)
                        .frame(height: 30)
                        .background(Theme.danger.opacity(0.12), in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle())
                .transition(.opacity)
            } else {
                RoundIconButton(systemImage: "trash", help: "Apagar o evento", size: 30) {
                    confirmingDelete = true
                }
            }
        }
        .springAnimation(value: confirmingDelete)
    }

    private func row(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 14)
            Text(text)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private var whenText: String {
        let calendar = Calendar.agenda
        let day = event.startDate.formatted(.dateTime.weekday(.wide).day().month(.wide)).capitalizedFirst
        if event.allDay {
            let last = calendar.date(byAdding: .day, value: -1, to: event.endDate) ?? event.startDate
            if last > event.startDate, !calendar.isDate(last, inSameDayAs: event.startDate) {
                return "\(day) até \(last.formatted(.dateTime.day().month(.wide))) · dia todo"
            }
            return "\(day) · dia todo"
        }
        let minutes = Int(event.endDate.timeIntervalSince(event.startDate) / 60)
        let length = minutes < 60 ? "\(minutes) min" : minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60)"
        return "\(day) · \(AgendaFormat.range(event)) (\(length))"
    }

    private var cleanDescription: String? {
        guard let raw = event.description, !raw.isEmpty else { return nil }
        let stripped =
            raw
            .replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return stripped.isEmpty ? nil : stripped
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
    let span: Int
    let columns: Int

    var id: String { event.id }
}

@MainActor
enum AgendaLayout {
    static func place(_ events: [AgendaEvent], day: Date, hourHeight: CGFloat) -> [PlacedEvent] {
        let calendar = Calendar.agenda
        guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { return [] }
        let minimum = TimeInterval(AgendaMetrics.shortEvent * 0.6 / hourHeight * 3600)
        let sorted = events.sorted { $0.startDate == $1.startDate ? $0.endDate > $1.endDate : $0.startDate < $1.startDate }
        var result: [PlacedEvent] = []
        var cluster: [(event: AgendaEvent, column: Int, start: Date, end: Date)] = []
        var clusterEnd = Date.distantPast
        var columnEnds: [Date] = []

        func flush() {
            let count = max(columnEnds.count, 1)
            for item in cluster {
                var span = 1
                while item.column + span < count {
                    let blocked = cluster.contains { other in
                        other.column == item.column + span && other.start < item.end && other.end > item.start
                    }
                    if blocked { break }
                    span += 1
                }
                let top = CGFloat(item.start.timeIntervalSince(day) / 3600) * hourHeight
                let height = CGFloat(item.end.timeIntervalSince(item.start) / 3600) * hourHeight
                result.append(PlacedEvent(event: item.event, top: top, height: height, column: item.column, span: span, columns: count))
            }
            cluster = []
            columnEnds = []
        }

        for event in sorted {
            let start = max(event.startDate, day)
            let end = min(max(event.endDate, start.addingTimeInterval(minimum)), next)
            if start >= clusterEnd, !cluster.isEmpty {
                flush()
            }
            if let free = columnEnds.firstIndex(where: { $0 <= start }) {
                columnEnds[free] = end
                cluster.append((event, free, start, end))
            } else {
                columnEnds.append(end)
                cluster.append((event, columnEnds.count - 1, start, end))
            }
            clusterEnd = max(clusterEnd, end)
        }
        flush()
        return result
    }
}
