import SwiftUI

struct RoutinesScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                PageHeaderView(
                    title: "Rotinas",
                    description: "O que o time roda sozinho, na ordem em que vai rodar."
                ) {
                    EmptyView()
                }
                TimelineView(.everyMinute) { context in
                    content(now: context.date)
                }
            }
            .frame(maxWidth: ScreenLayout.width, alignment: .leading)
            .padding(.horizontal, Spacing.xxl)
            .padding(.top, Spacing.xl + 4)
            .padding(.bottom, Spacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgesHidden()
        .background(Theme.background)
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        let days = RoutineDay.build(bots: model.loadedBots, now: now)
        if days.isEmpty {
            EmptyStateView(
                systemImage: "clock.arrow.circlepath",
                title: "Nenhuma rotina ainda",
                description: "Peça a um bot para rodar algo todo dia, ou crie a rotina no perfil dele."
            )
        } else {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                ForEach(days) { day in
                    ScreenSection(title: day.title, caption: day.items.count == 1 ? "1 rotina" : "\(day.items.count) rotinas") {
                        ForEach(day.items) { item in
                            RoutineTimelineRow(item: item, now: now)
                        }
                    }
                }
            }
        }
    }
}

struct RoutineItem: Identifiable {
    let bot: Bot
    let schedule: BotSchedule
    let next: Date?

    var id: String { "\(bot.id)|\(schedule.id)" }
}

struct RoutineDay: Identifiable {
    let id: String
    let title: String
    let items: [RoutineItem]

    static func build(bots: [Bot], now: Date) -> [RoutineDay] {
        let items = bots
            .flatMap { bot in bot.schedules.map { RoutineItem(bot: bot, schedule: $0, next: ScheduleFormatter.nextDate(for: $0, now: now)) } }
            .sorted { ($0.next ?? .distantFuture) < ($1.next ?? .distantFuture) }
        var days: [RoutineDay] = []
        for item in items {
            let key = item.next.map { Calendar.current.startOfDay(for: $0).timeIntervalSince1970.description } ?? "unknown"
            let title = item.next.map(ScheduleFormatter.dayLabel) ?? "Sem horário"
            if let index = days.firstIndex(where: { $0.id == key }) {
                days[index] = RoutineDay(id: key, title: days[index].title, items: days[index].items + [item])
            } else {
                days.append(RoutineDay(id: key, title: title, items: [item]))
            }
        }
        return days
    }
}

private struct RoutineTimelineRow: View {
    @Environment(AppModel.self) private var model
    let item: RoutineItem
    let now: Date

    @State private var isHovering = false

    var body: some View {
        let running = model.isRunning(item.schedule, of: item.bot)
        HStack(alignment: .center, spacing: Spacing.l) {
            timeColumn(running: running)
            BotCharacter(bot: item.bot, mood: model.mood(for: item.bot.id), size: 28)
                .frame(width: 36, height: 36)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                    Text(title)
                        .font(BrandFonts.sans(13, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text(item.bot.name)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
                if let description = item.schedule.description, !description.isEmpty {
                    Text(description)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .help(description)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            runButton(running: running)
                .opacity(isHovering || running ? 1 : 0)
                .allowsHitTesting(isHovering || running)
        }
        .padding(.horizontal, Spacing.m)
        .frame(minHeight: 64)
        .background(isHovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            model.openProfile(item.bot)
            model.profileTab = .routines
        }
        .clickable()
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: running)
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Rodar agora") {
            model.runNow(item.schedule, of: item.bot)
        }
    }

    private var title: String {
        let name = item.schedule.name
        return name.prefix(1).uppercased() + name.dropFirst()
    }

    @ViewBuilder
    private func timeColumn(running: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            if let next = item.next {
                Text(ScheduleFormatter.clock(next))
                    .font(BrandFonts.sans(15, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Theme.textPrimary)
                Text(running ? "rodando" : relative(next))
                    .font(TypeScale.caption.monospacedDigit())
                    .foregroundStyle(running || isSoon(next) ? Theme.brandText : Theme.textTertiary)
                    .contentTransition(.opacity)
            } else {
                Text("—")
                    .font(BrandFonts.sans(15, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(width: 64, alignment: .leading)
    }

    private func isSoon(_ date: Date) -> Bool {
        date.timeIntervalSince(now) < 60 * 60
    }

    private func relative(_ date: Date) -> String {
        let minutes = max(1, Int((date.timeIntervalSince(now) / 60).rounded(.up)))
        if minutes < 60 { return "em \(minutes) min" }
        let hours = minutes / 60
        if hours < 24 { return "em \(hours) h" }
        return "em \(hours / 24) d"
    }

    private func runButton(running: Bool) -> some View {
        Button {
            model.runNow(item.schedule, of: item.bot)
        } label: {
            HStack(spacing: Spacing.xs) {
                Image(systemName: running ? "circle.dotted" : "play.fill")
                    .font(.system(size: 9, weight: .bold))
                    .symbolEffect(.pulse, options: .repeating, isActive: running)
                Text(running ? "Rodando…" : "Rodar agora")
                    .font(TypeScale.captionStrong)
                    .contentTransition(.opacity)
            }
            .foregroundStyle(running ? Theme.brandText : Theme.textPrimary)
            .padding(.horizontal, Spacing.m)
            .frame(height: 28)
            .background(Theme.surfaceRaised, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(running || item.bot.isPending)
        .help("Rodar \(item.schedule.name) agora")
    }
}

struct ScreenTitle: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(title)
                .font(TypeScale.pageTitle)
                .tracking(Metrics.pageTitleTracking)
                .foregroundStyle(Theme.textPrimary)
            Text(subtitle)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
        }
    }
}

struct RoleTag: View {
    let text: String

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        }
    }
}
