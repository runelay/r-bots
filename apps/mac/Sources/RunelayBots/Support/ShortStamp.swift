import Foundation

enum ShortStamp {
    private static var locale: Locale { LanguageStore.shared.locale }

    static func label(for date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if now.timeIntervalSince(date) < 60 {
            return tr("agora")
        }
        if calendar.isDateInToday(date) {
            return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
        }
        if calendar.isDateInYesterday(date) {
            return tr("ontem")
        }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(Date.FormatStyle().weekday(.abbreviated).locale(locale))
        }
        return date.formatted(Date.FormatStyle().day(.twoDigits).month(.twoDigits).locale(locale))
    }

    static func dayLabel(for date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return tr("Hoje")
        }
        if calendar.isDateInYesterday(date) {
            return tr("Ontem")
        }
        return date.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(locale))
    }
}
