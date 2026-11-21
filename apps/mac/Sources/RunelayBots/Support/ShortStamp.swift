import Foundation

enum ShortStamp {
    private static let locale = Locale(identifier: "pt_BR")

    static func label(for date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if now.timeIntervalSince(date) < 60 {
            return "agora"
        }
        if calendar.isDateInToday(date) {
            return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
        }
        if calendar.isDateInYesterday(date) {
            return "ontem"
        }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(Date.FormatStyle().weekday(.abbreviated).locale(locale))
        }
        return date.formatted(Date.FormatStyle().day(.twoDigits).month(.twoDigits).locale(locale))
    }

    static func dayLabel(for date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "Hoje"
        }
        if calendar.isDateInYesterday(date) {
            return "Ontem"
        }
        return date.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(locale))
    }
}
