import Foundation

struct UsageLimitWindow: Decodable, Sendable, Hashable {
    let kind: String
    let label: String
    let usedPercent: Double
    let remainingPercent: Double
    let resetsAt: String?
    let windowMinutes: Double?
    let pacePercent: Double?

    var resetDate: Date? { UsageFormat.date(resetsAt) }

    var isLongWindow: Bool { kind == "weekly" || kind == "monthly" }
}

struct UsageFailover: Decodable, Sendable, Hashable {
    let botId: String
    let botName: String
    let to: String
    let toLabel: String
}

struct UsageLimitAccount: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let provider: String
    let label: String
    let plan: String?
    let isDefault: Bool?
    let ok: Bool
    let error: String?
    let windows: [UsageLimitWindow]
    let failover: [UsageFailover]
}

struct UsageLimitsResponse: Decodable, Sendable {
    let checkedAt: String
    let accounts: [UsageLimitAccount]
}

struct UsageTotals: Decodable, Sendable {
    let processed: Double
    let input: Double
    let cacheRead: Double
    let cacheWrite: Double
    let output: Double
    let reasoning: Double
    let requests: Double
    let sessions: Double
    let costUsd: Double
    let savingsUsd: Double
    let unpricedTokens: Double
}

struct UsageCostByType: Decodable, Sendable {
    let input: Double
    let cacheRead: Double
    let cacheWrite: Double
    let output: Double
}

struct UsageSeriesPoint: Decodable, Sendable, Hashable {
    let bucket: String
    let provider: String
    let tokens: Double
    let costUsd: Double
}

struct UsageSpeed: Decodable, Sendable, Hashable {
    let speed: String
    let tokens: Double
    let costUsd: Double
}

struct UsageDetailRow: Decodable, Sendable, Hashable {
    let day: String
    let provider: String
    let model: String
    let account: String?
    let input: Double
    let cacheRead: Double
    let cacheWrite: Double
    let output: Double
    let processed: Double
    let requests: Double
    let costUsd: Double?
}

struct UsageAccountTotals: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let provider: String
    let label: String
    let processed: Double
    let requests: Double
    let sessions: Double
    let costUsd: Double
}

struct UsageSummary: Decodable, Sendable {
    let range: String
    let granularity: String
    let totals: UsageTotals
    let costByType: UsageCostByType
    let series: [UsageSeriesPoint]
    let speeds: [UsageSpeed]
    let detail: [UsageDetailRow]
    let accounts: [UsageAccountTotals]?
}

enum UsageRange: String, CaseIterable, Identifiable, Sendable {
    case day = "24h"
    case week = "7d"
    case month = "30d"
    case quarter = "90d"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .day: "24 h"
        case .week: "7 dias"
        case .month: "30 dias"
        case .quarter: "90 dias"
        }
    }
}

enum UsageTab: String, CaseIterable, Identifiable, Sendable {
    case limits
    case tokens
    case cost

    var id: String { rawValue }

    var title: String {
        switch self {
        case .limits: "Limites"
        case .tokens: "Tokens"
        case .cost: "Custo"
        }
    }
}

enum UsageFormat {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        if let date = fractional.date(from: text) { return date }
        if let date = plain.date(from: text) { return date }
        let trimmed = text.replacingOccurrences(of: #"\.(\d{3})\d+"#, with: ".$1", options: .regularExpression)
        return fractional.date(from: trimmed)
    }

    static func day(_ text: String) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return date(text) }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        components.timeZone = TimeZone(identifier: "America/Sao_Paulo")
        return Calendar(identifier: .gregorian).date(from: components)
    }

    static func until(_ date: Date?, now: Date = Date()) -> String? {
        guard let date else { return nil }
        let seconds = max(0, Int(date.timeIntervalSince(now)))
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3600
        let minutes = (seconds % 3600) / 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(max(minutes, 1))m"
    }

    static func percent(_ value: Double) -> String {
        "\(Int(value.rounded()))%"
    }

    static func tokens(_ value: Double) -> String {
        let absolute = abs(value)
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "pt_BR")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 1
        formatter.minimumFractionDigits = 0
        if absolute >= 1_000_000_000 {
            return (formatter.string(from: NSNumber(value: value / 1_000_000_000)) ?? "") + " bi"
        }
        if absolute >= 1_000_000 {
            return (formatter.string(from: NSNumber(value: value / 1_000_000)) ?? "") + " mi"
        }
        if absolute >= 1000 {
            return (formatter.string(from: NSNumber(value: value / 1000)) ?? "") + " mil"
        }
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "\(Int(value))"
    }

    static func usd(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "pt_BR")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return "US$ " + (formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value))
    }

    static func dayLabel(_ text: String) -> String {
        guard let date = day(text) else { return text }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pt_BR")
        formatter.timeZone = TimeZone(identifier: "America/Sao_Paulo")
        formatter.dateFormat = "d MMM"
        return formatter.string(from: date)
    }

    static func providerName(_ provider: String) -> String {
        provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider.capitalized
    }

    static func modelName(_ model: String) -> String {
        if model.hasPrefix("gpt-") {
            return "GPT-" + model.dropFirst(4)
        }
        var name = model.replacingOccurrences(of: "claude-", with: "")
        name = name.replacingOccurrences(of: #"-(\d+)-(\d+)$"#, with: " $1.$2", options: .regularExpression)
        name = name.replacingOccurrences(of: #"-(\d+)$"#, with: " $1", options: .regularExpression)
        guard let first = name.first else { return model }
        return first.uppercased() + name.dropFirst()
    }
}
