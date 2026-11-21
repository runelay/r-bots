import Foundation

enum ScheduleFormatter {
    private static let locale = Locale(identifier: "pt_BR")

    static func nextDate(for schedule: BotSchedule, now: Date) -> Date? {
        var scheduleCalendar = Calendar(identifier: .gregorian)
        scheduleCalendar.timeZone = schedule.timeZone ?? .current
        return CronSchedule(schedule.cron)?.nextDate(after: now, calendar: scheduleCalendar)
    }

    static func dayLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Hoje" }
        if calendar.isDateInTomorrow(date) { return "Amanhã" }
        let text = date.formatted(Date.FormatStyle().weekday(.wide).day().month(.wide).locale(locale))
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    static func clock(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    }

    static func nextRun(for schedule: BotSchedule, now: Date) -> String {
        var scheduleCalendar = Calendar(identifier: .gregorian)
        scheduleCalendar.timeZone = schedule.timeZone ?? .current
        guard let cron = CronSchedule(schedule.cron),
            let next = cron.nextDate(after: now, calendar: scheduleCalendar)
        else {
            return fallback(for: schedule)
        }

        let interval = next.timeIntervalSince(now)
        if interval < 60 * 60 {
            let minutes = max(1, Int((interval / 60).rounded(.up)))
            return "em \(minutes) min"
        }

        let calendar = Calendar.current
        let time = next.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
        if calendar.isDateInToday(next) {
            return "hoje às \(time)"
        }
        if calendar.isDateInTomorrow(next) {
            return "amanhã às \(time)"
        }
        let weekday = next.formatted(Date.FormatStyle().weekday(.wide).locale(locale))
        return "\(weekday) às \(time)"
    }

    private static func fallback(for schedule: BotSchedule) -> String {
        if let description = schedule.description, !description.isEmpty {
            return description
        }
        return schedule.cron
    }
}
