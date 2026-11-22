import Foundation

struct CronSchedule: Sendable {
    let minutes: Set<Int>
    let hours: Set<Int>
    let days: Set<Int>
    let months: Set<Int>
    let weekdays: Set<Int>
    let restrictsDays: Bool
    let restrictsWeekdays: Bool

    init?(_ expression: String) {
        let parts = expression.split(whereSeparator: \.isWhitespace).map(String.init)
        guard parts.count == 5,
            let minutes = Self.field(parts[0], range: 0...59),
            let hours = Self.field(parts[1], range: 0...23),
            let days = Self.field(parts[2], range: 1...31),
            let months = Self.field(parts[3], range: 1...12),
            let weekdays = Self.field(parts[4], range: 0...7)
        else { return nil }
        self.minutes = minutes
        self.hours = hours
        self.days = days
        self.months = months
        self.weekdays = Set(weekdays.map { $0 == 7 ? 0 : $0 })
        restrictsDays = parts[2] != "*"
        restrictsWeekdays = parts[4] != "*"
    }

    func nextDate(after date: Date, calendar: Calendar = .current) -> Date? {
        guard var candidate = calendar.dateInterval(of: .minute, for: date)?.end else { return nil }
        let limit = date.addingTimeInterval(60 * 60 * 24 * 9)

        while candidate < limit {
            let components = calendar.dateComponents([.minute, .hour, .day, .month, .weekday], from: candidate)
            let minute = components.minute ?? -1
            let hour = components.hour ?? -1
            let day = components.day ?? -1
            let month = components.month ?? -1
            let weekday = (components.weekday ?? 0) - 1

            let dayMatches: Bool
            if restrictsDays && restrictsWeekdays {
                dayMatches = days.contains(day) || weekdays.contains(weekday)
            } else {
                dayMatches = days.contains(day) && weekdays.contains(weekday)
            }

            if !months.contains(month) || !dayMatches || !hours.contains(hour) {
                guard let nextHour = calendar.dateInterval(of: .hour, for: candidate)?.end else { return nil }
                candidate = nextHour
                continue
            }
            if minutes.contains(minute) {
                return candidate
            }
            candidate = candidate.addingTimeInterval(60)
        }
        return nil
    }

    private static func field(_ text: String, range: ClosedRange<Int>) -> Set<Int>? {
        var result = Set<Int>()
        for item in text.split(separator: ",") {
            let pieces = item.split(separator: "/", omittingEmptySubsequences: false)
            guard pieces.count == 1 || pieces.count == 2 else { return nil }

            var step = 1
            if pieces.count == 2 {
                guard let parsed = Int(pieces[1]), parsed > 0 else { return nil }
                step = parsed
            }

            let base = pieces[0]
            var lower = range.lowerBound
            var upper = range.upperBound
            if base == "*" {
            } else if base.contains("-") {
                let bounds = base.split(separator: "-")
                guard bounds.count == 2, let low = Int(bounds[0]), let high = Int(bounds[1]), low <= high else { return nil }
                lower = low
                upper = high
            } else {
                guard let value = Int(base) else { return nil }
                lower = value
                upper = pieces.count == 2 ? range.upperBound : value
            }

            guard range.contains(lower), range.contains(upper) else { return nil }
            result.formUnion(stride(from: lower, through: upper, by: step))
        }
        return result.isEmpty ? nil : result
    }

    static func describe(_ expression: String) -> String {
        let custom = tr("em horário personalizado")
        let parts = expression.split(whereSeparator: \.isWhitespace).map(String.init)
        guard parts.count == 5 else { return custom }
        let (minute, hour, day, month, weekday) = (parts[0], parts[1], parts[2], parts[3], parts[4])
        func every(_ field: String) -> Int? {
            guard field.hasPrefix("*/") else { return nil }
            return Int(field.dropFirst(2))
        }
        guard month == "*" else { return custom }
        if let step = every(minute), hour == "*", day == "*", weekday == "*" {
            return step == 1 ? tr("a cada minuto") : tr("a cada %lld minutos", step)
        }
        if let value = Int(minute), let step = every(hour), day == "*", weekday == "*" {
            let base = step == 1 ? tr("a cada hora") : tr("a cada %lld horas", step)
            return value == 0 ? base : base + tr(", aos %lld min", value)
        }
        if let value = Int(minute), hour == "*", day == "*", weekday == "*" {
            return value == 0 ? tr("a cada hora") : tr("toda hora, aos %lld min", value)
        }
        guard let value = Int(minute) else { return custom }
        let hours = hour.split(separator: ",").compactMap { Int($0) }
        guard !hours.isEmpty, hours.count == hour.split(separator: ",").count else { return custom }
        let times = Self.join(hours.map { String(format: "%02d:%02d", $0, value) })
        if day == "*", weekday == "*" {
            return tr("todo dia às %@", times)
        }
        if day == "*", weekday == "1-5" {
            return tr("dias úteis às %@", times)
        }
        if day == "*", weekday == "0,6" || weekday == "6,0" {
            return tr("fins de semana às %@", times)
        }
        let names = [tr("domingo"), tr("segunda"), tr("terça"), tr("quarta"), tr("quinta"), tr("sexta"), tr("sábado"), tr("domingo")]
        if day == "*" {
            let days = weekday.split(separator: ",").compactMap { Int($0) }.filter { (0...7).contains($0) }
            if !days.isEmpty, days.count == weekday.split(separator: ",").count {
                let label = Self.join(days.map { names[$0] })
                let masculine = days.count == 1 && (days[0] == 0 || days[0] == 6 || days[0] == 7)
                return masculine ? tr("todo %@ às %@", label, times) : tr("toda %@ às %@", label, times)
            }
        }
        if weekday == "*", let date = Int(day) {
            return tr("todo dia %lld do mês às %@", date, times)
        }
        return custom
    }

    private static func join(_ items: [String]) -> String {
        guard items.count > 1 else { return items.first ?? "" }
        return tr("%@ e %@", items.dropLast().joined(separator: ", "), items.last ?? "")
    }
}
