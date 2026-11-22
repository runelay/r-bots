import Foundation

enum BlockKind: String, Sendable, CaseIterable, Identifiable {
    case note
    case sheet
    case agenda

    var id: String { rawValue }

    static let agendaID = "agenda"
    static let filesKind = "files"

    var label: String {
        switch self {
        case .note: tr("Nota")
        case .sheet: tr("Planilha")
        case .agenda: tr("Agenda")
        }
    }

    var pluralLabel: String {
        switch self {
        case .note: tr("Notas")
        case .sheet: tr("Planilhas")
        case .agenda: tr("Agenda")
        }
    }

    var symbol: String {
        switch self {
        case .note: "doc.text"
        case .sheet: "tablecells"
        case .agenda: "calendar"
        }
    }

    static func isBlockKind(_ kind: String) -> Bool {
        BlockKind(rawValue: kind) != nil || kind == filesKind
    }
}

enum BlockAuthor: String, Codable, Sendable {
    case bot
    case user
}

struct BlockPage<Item: Decodable & Sendable>: Decodable, Sendable {
    var items: [Item]
    var nextCursor: String?
    var total: Int
}

struct NoteSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var folder: String
    var version: Int
    var updatedAt: String
    var updatedBy: BlockAuthor
    var excerpt: String
    var tags: [String]
}

struct NoteLink: Codable, Hashable, Sendable {
    let target: String
    let id: String?
    let title: String
}

struct Note: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var title: String
    var folder: String
    var version: Int
    var updatedAt: String
    var updatedBy: BlockAuthor
    var excerpt: String
    var tags: [String]
    var content: String
    var links: [NoteLink]
    var backlinkCount: Int

    var summary: NoteSummary {
        NoteSummary(id: id, title: title, folder: folder, version: version, updatedAt: updatedAt, updatedBy: updatedBy, excerpt: excerpt, tags: tags)
    }
}

struct NoteBacklink: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let folder: String
    let snippet: String
}

struct NoteFolder: Codable, Identifiable, Hashable, Sendable {
    let name: String
    let path: String
    let notes: Int
    let folders: Int

    var id: String { path }
}

struct NoteTreeLevel: Decodable, Sendable {
    let folder: String
    let folders: [NoteFolder]
    let notes: BlockPage<NoteSummary>
}

struct NoteSearchHit: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let folder: String
    let snippet: String?
    let ranges: [[Int]]?
}

enum NotePatchOp: Sendable {
    case replace(old: String, new: String)
    case append(String)
    case toggleTask(line: Int, done: Bool)

    var json: JSONValue {
        switch self {
        case .replace(let old, let new):
            .object(["op": .string("replace"), "old": .string(old), "new": .string(new)])
        case .append(let text):
            .object(["op": .string("append"), "text": .string(text)])
        case .toggleTask(let line, let done):
            .object(["op": .string("toggle_task"), "line": .number(Double(line)), "done": .bool(done)])
        }
    }
}

enum CellValue: Codable, Hashable, Sendable {
    case number(Double)
    case string(String)
    case bool(Bool)
    case null

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}

enum CellFormatType: String, Codable, Sendable, CaseIterable, Identifiable {
    case general
    case number
    case brl
    case percent
    case date
    case datetime
    case text

    var id: String { rawValue }

    var label: String {
        switch self {
        case .general: tr("Automático")
        case .number: tr("Número")
        case .brl: tr("Real (R$)")
        case .percent: tr("Porcentagem")
        case .date: tr("Data")
        case .datetime: tr("Data e hora")
        case .text: tr("Texto")
        }
    }

    var shortLabel: String {
        switch self {
        case .general: tr("Auto")
        case .number: tr("1.234")
        case .brl: "R$"
        case .percent: "%"
        case .date: tr("Data")
        case .datetime: tr("Data e hora")
        case .text: tr("Texto")
        }
    }
}

struct CellFormat: Codable, Hashable, Sendable {
    var type: CellFormatType
    var decimals: Int?
    var bold: Bool?
    var align: String?

    init(type: CellFormatType, decimals: Int? = nil, bold: Bool? = nil, align: String? = nil) {
        self.type = type
        self.decimals = decimals
        self.bold = bold
        self.align = align
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = (try? container.decodeIfPresent(CellFormatType.self, forKey: .type)) ?? .general
        decimals = try? container.decodeIfPresent(Int.self, forKey: .decimals)
        bold = try? container.decodeIfPresent(Bool.self, forKey: .bold)
        align = try? container.decodeIfPresent(String.self, forKey: .align)
    }
}

struct SheetCell: Codable, Hashable, Sendable {
    let a: String
    let r: Int
    let c: Int
    var input: String
    var v: CellValue
    var t: String?
    var format: CellFormat?
    var error: String?
}

struct SheetTab: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var index: Int
    var rowCount: Int
    var colCount: Int
    var frozenRows: Int
    var frozenCols: Int
    var colWidths: [String: Double]
}

struct SheetTabRef: Codable, Hashable, Sendable {
    let id: String
    let name: String
}

struct SheetSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var version: Int
    var updatedAt: String
    var updatedBy: BlockAuthor
    var tabs: [SheetTabRef]
}

struct Sheet: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var title: String
    var version: Int
    var updatedAt: String
    var updatedBy: BlockAuthor
    var tabs: [SheetTab]
}

struct SheetRangeResult: Codable, Sendable {
    let tabId: String
    let range: String
    let version: Int
    let cells: [SheetCell]
}

struct SheetWriteResult: Codable, Sendable {
    let version: Int
    let cells: [SheetCell]
}

struct SheetTabPatch: Sendable {
    var name: String?
    var frozenRows: Int?
    var frozenCols: Int?
    var colWidths: [String: Double]?
}

struct AgendaCalendar: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let color: String
    let selected: Bool
}

struct AgendaAccount: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let email: String
    let color: String
    let primary: Bool
    let status: String
    let calendars: [AgendaCalendar]
}

struct AgendaAttendee: Codable, Hashable, Sendable {
    let email: String
    let name: String?
    let response: String
    let isSelf: Bool
    let organizer: Bool

    var displayName: String { name ?? email }

    enum CodingKeys: String, CodingKey {
        case email
        case name
        case response
        case isSelf = "self"
        case organizer
    }
}

struct AgendaEvent: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var accountId: String
    var calendarId: String
    var title: String
    var start: String
    var end: String
    var allDay: Bool
    var meet: Bool
    var meetUrl: String?
    var location: String?
    var description: String?
    var attendees: [AgendaAttendee]
    var status: String
    var recurring: Bool
    var updatedAt: String
    var calendarUrl: String? = nil

    var startDate: Date { BlockDates.parse(start) ?? .distantPast }
    var endDate: Date { BlockDates.parse(end) ?? startDate }
}

struct AgendaList: Codable, Sendable {
    let timezone: String
    let items: [AgendaEvent]
}

struct AgendaEventDraft: Sendable {
    var accountId: String
    var title: String
    var start: Date
    var end: Date
    var allDay = false
    var location: String?
    var description: String?
    var meet = false
}

enum ExportFormat: String, Codable, Sendable, CaseIterable, Identifiable {
    case docx
    case pdf
    case md
    case xlsx
    case csv

    var id: String { rawValue }

    var label: String {
        switch self {
        case .docx: "Word (.docx)"
        case .pdf: "PDF"
        case .md: "Markdown (.md)"
        case .xlsx: "Excel (.xlsx)"
        case .csv: tr("CSV da aba")
        }
    }

    static func formats(for kind: BlockKind) -> [ExportFormat] {
        kind == .note ? [.docx, .pdf, .md] : [.xlsx, .csv, .pdf]
    }
}

struct ExportJob: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let sourceId: String
    let format: ExportFormat
    var status: String
    let fileName: String
    var size: Int?
    var url: String?
    var error: String?
    let createdAt: String
}

struct NotePreview: Codable, Hashable, Sendable {
    let folder: String
    let excerpt: String
    let words: Int
}

struct SheetPreviewCell: Codable, Hashable, Sendable {
    let v: CellValue
    let t: String?
    let format: CellFormat?
}

struct SheetPreview: Codable, Hashable, Sendable {
    let tab: String
    let tabs: Int
    let rows: [[SheetPreviewCell]]
    let rowCount: Int
    let colCount: Int
    let frozenRows: Int
    let colWidths: [Double]
}

struct AgendaAccountRef: Codable, Hashable, Sendable {
    let id: String
    let label: String
    let color: String
}

struct AgendaEventPreview: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let accountId: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let meet: Bool

    var startDate: Date { BlockDates.parse(start) ?? .distantPast }
    var endDate: Date { BlockDates.parse(end) ?? startDate }
}

struct AgendaPreview: Codable, Hashable, Sendable {
    let view: String
    let start: String
    let end: String
    let timezone: String
    let accounts: [AgendaAccountRef]
    let events: [AgendaEventPreview]
}

enum BlockPreview: Hashable, Sendable {
    case note(NotePreview)
    case sheet(SheetPreview)
    case agenda(AgendaPreview)

    static func parse(_ value: JSONValue?) -> BlockPreview? {
        guard let value, let kind = value["kind"]?.stringValue else { return nil }
        switch kind {
        case "note": return BlockJSON.decode(NotePreview.self, from: value).map(BlockPreview.note)
        case "sheet": return BlockJSON.decode(SheetPreview.self, from: value).map(BlockPreview.sheet)
        case "agenda": return BlockJSON.decode(AgendaPreview.self, from: value).map(BlockPreview.agenda)
        default: return nil
        }
    }
}

enum BlockChange: Hashable, Sendable {
    case lines([ClosedRange<Int>])
    case ranges(tabID: String, [String])
    case events([String])

    static func parse(_ value: JSONValue?) -> BlockChange? {
        guard let value else { return nil }
        if let lines = value["lines"]?.arrayValue {
            let ranges = lines.compactMap { pair -> ClosedRange<Int>? in
                guard let start = pair.arrayValue?.first?.intValue, let end = pair.arrayValue?.last?.intValue, end >= start else { return nil }
                return start...end
            }
            return .lines(ranges)
        }
        if let ranges = value["ranges"]?.arrayValue {
            return .ranges(tabID: value["tabId"]?.stringValue ?? "", ranges.compactMap(\.stringValue))
        }
        if let ids = value["eventIds"]?.arrayValue {
            return .events(ids.compactMap(\.stringValue))
        }
        return nil
    }
}

struct BlockEvent: Sendable {
    let botID: String
    let kind: BlockKind
    let id: String
    let title: String
    let version: Int
    let author: BlockAuthor
    let action: String
    let preview: BlockPreview?
    let change: BlockChange?

    init?(type: String, data: JSONValue, fallbackBotID: String) {
        guard type.hasPrefix("block."), let kindText = data["kind"]?.stringValue, let kind = BlockKind(rawValue: kindText) else { return nil }
        botID = data["botId"]?.stringValue ?? fallbackBotID
        self.kind = kind
        id = data["id"]?.stringValue ?? (kind == .agenda ? BlockKind.agendaID : "")
        guard !id.isEmpty else { return nil }
        title = data["title"]?.stringValue ?? kind.label
        version = data["version"]?.intValue ?? 1
        author = BlockAuthor(rawValue: data["author"]?.stringValue ?? "bot") ?? .bot
        action = data["action"]?.stringValue ?? (type == "block.deleted" ? "deleted" : type == "block.created" ? "created" : "edited")
        preview = BlockPreview.parse(data["preview"])
        change = BlockChange.parse(data["changed"])
    }

    var ref: ArtifactRef {
        ArtifactRef(botID: botID, id: id, title: title, kind: kind.rawValue, version: version)
    }
}

enum BlockJSON {
    static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? {
        do {
            let data = try JSONEncoder().encode(value)
            return try JSONDecoder().decode(type, from: data)
        } catch {
            BlocksLog.failure("decode \(T.self)", error)
            return nil
        }
    }
}

enum BlockDates {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    nonisolated(unsafe) private static let day: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        formatter.timeZone = .current
        return formatter
    }()

    static func parse(_ text: String) -> Date? {
        fractional.date(from: text) ?? plain.date(from: text) ?? day.date(from: text)
    }

    static func string(_ date: Date) -> String {
        plain.string(from: date)
    }

    static func dayString(_ date: Date) -> String {
        day.string(from: date)
    }

    static func relative(_ text: String) -> String {
        guard let date = parse(text) else { return "" }
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return tr("agora") }
        if seconds < 3600 { return tr("há %lld min", Int(seconds / 60)) }
        if Calendar.current.isDateInToday(date) { return tr("hoje, %@", date.formatted(.dateTime.hour().minute().locale(LanguageStore.shared.locale))) }
        if Calendar.current.isDateInYesterday(date) { return tr("ontem") }
        return date.formatted(.dateTime.day().month(.abbreviated).locale(LanguageStore.shared.locale))
    }
}

enum SheetAddress {
    static func columnName(_ index: Int) -> String {
        var name = ""
        var rest = index + 1
        while rest > 0 {
            let digit = (rest - 1) % 26
            name = String(UnicodeScalar(65 + digit).map(Character.init) ?? "A") + name
            rest = (rest - 1) / 26
        }
        return name
    }

    static func cell(row: Int, col: Int) -> String {
        "\(columnName(col))\(row + 1)"
    }

    static func range(rows: ClosedRange<Int>, cols: ClosedRange<Int>) -> String {
        let start = cell(row: rows.lowerBound, col: cols.lowerBound)
        let end = cell(row: rows.upperBound, col: cols.upperBound)
        return start == end ? start : "\(start):\(end)"
    }

    static func parseCell(_ text: String) -> (row: Int, col: Int)? {
        var col = 0
        var digits = ""
        var sawLetter = false
        for character in text.uppercased() {
            if let ascii = character.asciiValue, ascii >= 65, ascii <= 90, digits.isEmpty {
                col = col * 26 + Int(ascii - 64)
                sawLetter = true
            } else if character.isNumber {
                digits.append(character)
            } else if character == "$" {
                continue
            } else {
                return nil
            }
        }
        guard sawLetter, let row = Int(digits), row > 0 else { return nil }
        return (row - 1, col - 1)
    }

    static func parseRange(_ text: String) -> (rows: ClosedRange<Int>, cols: ClosedRange<Int>)? {
        let parts = text.split(separator: ":").map(String.init)
        guard let first = parts.first.flatMap(parseCell) else { return nil }
        let last = parts.count > 1 ? parseCell(parts[1]) ?? first : first
        return (min(first.row, last.row)...max(first.row, last.row), min(first.col, last.col)...max(first.col, last.col))
    }
}

enum CellText {
    nonisolated(unsafe) private static var formatters: (locale: String, number: NumberFormatter, currency: NumberFormatter)?

    private static func localized() -> (number: NumberFormatter, currency: NumberFormatter) {
        let locale = LanguageStore.shared.locale
        if let formatters, formatters.locale == locale.identifier { return (formatters.number, formatters.currency) }
        let number = NumberFormatter()
        number.locale = locale
        number.numberStyle = .decimal
        let currency = NumberFormatter()
        currency.locale = locale
        currency.numberStyle = .currency
        currency.currencyCode = "BRL"
        formatters = (locale.identifier, number, currency)
        return (number, currency)
    }

    static func display(_ value: CellValue, type: String?, format: CellFormat?) -> String {
        switch value {
        case .null:
            return ""
        case .bool(let flag):
            return flag ? tr("VERDADEIRO") : tr("FALSO")
        case .string(let text):
            if type == "d" || format?.type == .date || format?.type == .datetime, let date = BlockDates.parse(text) {
                return dateText(date, withTime: format?.type == .datetime)
            }
            return text
        case .number(let number):
            return numberText(number, format: format)
        }
    }

    static func numberText(_ number: Double, format: CellFormat?) -> String {
        let decimals = format?.decimals
        let (numberFormatter, currencyFormatter) = localized()
        switch format?.type ?? .general {
        case .brl:
            currencyFormatter.minimumFractionDigits = decimals ?? 2
            currencyFormatter.maximumFractionDigits = decimals ?? 2
            return currencyFormatter.string(from: NSNumber(value: number)) ?? "\(number)"
        case .percent:
            numberFormatter.minimumFractionDigits = decimals ?? 0
            numberFormatter.maximumFractionDigits = decimals ?? 1
            return (numberFormatter.string(from: NSNumber(value: number * 100)) ?? "\(number * 100)") + "%"
        case .number:
            numberFormatter.minimumFractionDigits = decimals ?? 2
            numberFormatter.maximumFractionDigits = decimals ?? 2
            return numberFormatter.string(from: NSNumber(value: number)) ?? "\(number)"
        case .date, .datetime:
            let date = Date(timeIntervalSince1970: (number - 25569) * 86400)
            return dateText(date, withTime: format?.type == .datetime)
        case .general, .text:
            numberFormatter.minimumFractionDigits = 0
            numberFormatter.maximumFractionDigits = decimals ?? 10
            return numberFormatter.string(from: NSNumber(value: number)) ?? "\(number)"
        }
    }

    static func dateText(_ date: Date, withTime: Bool) -> String {
        withTime
            ? date.formatted(.dateTime.day(.twoDigits).month(.twoDigits).year().hour().minute().locale(LanguageStore.shared.locale))
            : date.formatted(.dateTime.day(.twoDigits).month(.twoDigits).year().locale(LanguageStore.shared.locale))
    }

    static func isNumeric(_ value: CellValue, type: String?) -> Bool {
        if case .number = value { return type != "s" }
        return false
    }
}
