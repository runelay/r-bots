import SwiftUI

struct BlockCard: View {
    @Environment(AppModel.self) private var model
    let ref: ArtifactRef

    @State private var hovering = false
    @State private var previewFailed = false

    private var center: BlockCenter { .shared }
    private var kind: BlockKind { BlockKind(rawValue: ref.kind) ?? .note }

    var body: some View {
        Group {
            if center.isSuperseded(ref) || center.isDeleted(ref) {
                previousRow
            } else {
                fullCard
            }
        }
        .padding(.leading, 20 + Spacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: "\(ref.id)#\(ref.version)") {
            await loadPreviewIfNeeded()
        }
    }

    private var fullCard: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: Spacing.s) {
                HStack(spacing: Spacing.s) {
                    Image(systemName: kind.symbol)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 18)
                    Text(center.currentTitle(ref))
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.s)
                    Text(subtitle)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .fixedSize()
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .opacity(hovering ? 1 : 0)
                }
                previewBody
            }
            .padding(Spacing.m)
            .frame(width: 440, alignment: .leading)
            .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help("Abrir \(center.currentTitle(ref))")
    }

    private var previousRow: some View {
        Button(action: open) {
            HStack(spacing: Spacing.s) {
                Image(systemName: kind.symbol)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: 18)
                Text(center.isDeleted(ref) ? "Apagada" : "Versão anterior")
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                Text(ref.title)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, Spacing.s)
            .padding(.vertical, Spacing.xs + 2)
            .background(hovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .disabled(center.isDeleted(ref))
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help(center.isDeleted(ref) ? "" : "Abrir a versão atual")
    }

    @ViewBuilder
    private var previewBody: some View {
        switch center.preview(for: ref) {
        case .note(let preview):
            NotePreviewBody(preview: preview, title: ref.title)
        case .sheet(let preview):
            SheetPreviewGrid(preview: preview)
        case .agenda(let preview):
            AgendaPreviewList(preview: preview)
        case nil where previewFailed:
            Text("Não consegui carregar a prévia. Clique para abrir.")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .padding(.vertical, Spacing.xs)
        case nil:
            VStack(alignment: .leading, spacing: Spacing.s) {
                ForEach(0..<3, id: \.self) { index in
                    Rectangle()
                        .fill(Theme.surfaceRaised)
                        .frame(width: index == 2 ? 180 : 320, height: 9)
                }
            }
            .padding(.vertical, Spacing.xs)
        }
    }

    private var subtitle: String {
        if kind == .agenda, case .agenda(let preview) = center.preview(for: ref) {
            return Self.agendaRange(preview)
        }
        return ref.version > 1 ? "\(kind.label) · editada" : kind.label
    }

    static func agendaRange(_ preview: AgendaPreview) -> String {
        guard let start = BlockDates.parse(preview.start), let rawEnd = BlockDates.parse(preview.end) else {
            return preview.view == "week" ? "Semana" : "Dia"
        }
        let end = rawEnd.addingTimeInterval(-1)
        if preview.view == "day" || Calendar.agenda.isDate(start, inSameDayAs: end) {
            return start.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)).replacingOccurrences(of: ".", with: "").capitalizedFirst
        }
        if Calendar.agenda.isDate(start, equalTo: end, toGranularity: .month) {
            return "\(start.formatted(.dateTime.day()))–\(end.formatted(.dateTime.day().month(.abbreviated)))".replacingOccurrences(of: ".", with: "")
        }
        return "\(start.formatted(.dateTime.day().month(.abbreviated))) – \(end.formatted(.dateTime.day().month(.abbreviated)))".replacingOccurrences(of: ".", with: "")
    }

    private func open() {
        let current = ArtifactRef(botID: ref.botID, id: ref.id, title: center.currentTitle(ref), kind: ref.kind, version: ref.version)
        ArtifactCenter.shared.open(current, client: model.client)
    }

    private func loadPreviewIfNeeded() async {
        guard center.preview(for: ref) == nil, !center.isSuperseded(ref) else { return }
        do {
            try await loadPreview()
            previewFailed = false
        } catch is CancellationError {
            return
        } catch {
            BlocksLog.failure("preview \(kind.rawValue)", error)
            previewFailed = true
        }
    }

    private func loadPreview() async throws {
        let client = center.client
        switch kind {
        case .note:
            let note = try await client.note(botID: ref.botID, id: ref.id)
            let excerpt = note.content.split(separator: "\n", omittingEmptySubsequences: false).prefix(14).joined(separator: "\n")
            center.storePreview(.note(NotePreview(folder: note.folder, excerpt: String(excerpt.prefix(600)), words: note.content.split(whereSeparator: \.isWhitespace).count)), for: ref)
        case .sheet:
            let sheet = try await client.sheet(botID: ref.botID, id: ref.id)
            guard let tab = sheet.tabs.sorted(by: { $0.index < $1.index }).first else { return }
            let range = try await client.sheetRange(botID: ref.botID, sheetID: sheet.id, tabID: tab.id, range: "A1:F8")
            let map = Dictionary(range.cells.map { ($0.a, $0) }, uniquingKeysWith: { first, _ in first })
            let rows = (0..<min(8, max(tab.rowCount, 1))).map { row in
                (0..<min(6, max(tab.colCount, 1))).map { col -> SheetPreviewCell in
                    let cell = map[SheetAddress.cell(row: row, col: col)]
                    return SheetPreviewCell(v: cell?.v ?? .null, t: cell?.t, format: cell?.format)
                }
            }
            let widths = (0..<6).map { tab.colWidths[SheetAddress.columnName($0)] ?? 96 }
            center.storePreview(.sheet(SheetPreview(tab: tab.name, tabs: sheet.tabs.count, rows: rows, rowCount: tab.rowCount, colCount: tab.colCount, frozenRows: tab.frozenRows, colWidths: widths)), for: ref)
        case .agenda:
            let start = Calendar.current.startOfDay(for: Date())
            let end = start.addingTimeInterval(86400)
            let accounts = try await client.agendaAccounts(botID: ref.botID)
            let list = try await client.agendaEvents(botID: ref.botID, start: start, end: end, accounts: nil)
            let preview = AgendaPreview(
                view: "day",
                start: BlockDates.string(start),
                end: BlockDates.string(end),
                timezone: list.timezone,
                accounts: accounts.map { AgendaAccountRef(id: $0.id, label: $0.label, color: $0.color) },
                events: list.items.prefix(20).map { AgendaEventPreview(id: $0.id, accountId: $0.accountId, title: $0.title, start: $0.start, end: $0.end, allDay: $0.allDay, meet: $0.meet) }
            )
            center.storePreview(.agenda(preview), for: ref)
        }
    }
}

struct NotePreviewBody: View {
    let preview: NotePreview
    let title: String

    private var text: String {
        var lines = preview.excerpt.components(separatedBy: "\n")
        if let first = lines.first, first.trimmingCharacters(in: .whitespaces).hasPrefix("# ") {
            lines.removeFirst()
        }
        while lines.first?.trimmingCharacters(in: .whitespaces).isEmpty == true {
            lines.removeFirst()
        }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        MarkdownView(text: text, fontSize: 13, lineSpacing: 3)
            .frame(maxWidth: .infinity, maxHeight: 156, alignment: .topLeading)
            .clipped()
            .mask {
                LinearGradient(stops: [.init(color: Theme.maskVisible, location: 0.7), .init(color: Theme.maskHidden, location: 1)], startPoint: .top, endPoint: .bottom)
            }
            .allowsHitTesting(false)
    }
}

struct SheetPreviewGrid: View {
    let preview: SheetPreview

    private let rowHeight: CGFloat = 22
    private let headerWidth: CGFloat = 26

    var body: some View {
        let columns = max(preview.rows.first?.count ?? 0, 1)
        let rows = preview.rows.count
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Canvas { context, size in
                let available = size.width - headerWidth
                let raw = (0..<columns).map { CGFloat(preview.colWidths.indices.contains($0) ? preview.colWidths[$0] : 96) }
                let total = raw.reduce(0, +)
                let widths = raw.map { $0 / max(total, 1) * available }
                context.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: rowHeight)), with: .color(Theme.surfaceRaised))
                context.fill(Path(CGRect(x: 0, y: 0, width: headerWidth, height: size.height)), with: .color(Theme.surfaceRaised))
                var x = headerWidth
                for col in 0..<columns {
                    context.draw(
                        Text(SheetAddress.columnName(col)).font(BrandFonts.sans(10, weight: .medium)).foregroundStyle(Theme.textTertiary),
                        at: CGPoint(x: x + widths[col] / 2, y: rowHeight / 2)
                    )
                    x += widths[col]
                    context.fill(Path(CGRect(x: x - 0.5, y: 0, width: 0.5, height: size.height)), with: .color(Theme.paneDivider))
                }
                for row in 0..<rows {
                    let y = CGFloat(row + 1) * rowHeight
                    context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 0.5)), with: .color(Theme.paneDivider))
                    context.draw(
                        Text("\(row + 1)").font(BrandFonts.sans(10, weight: .medium)).foregroundStyle(Theme.textTertiary),
                        at: CGPoint(x: headerWidth / 2, y: y + rowHeight / 2)
                    )
                    var cellX = headerWidth
                    for col in 0..<columns {
                        let cell = preview.rows[row].indices.contains(col) ? preview.rows[row][col] : nil
                        if let cell {
                            let display = CellText.display(cell.v, type: cell.t, format: cell.format)
                            let numeric = CellText.isNumeric(cell.v, type: cell.t)
                            let bold = cell.format?.bold == true || row < preview.frozenRows
                            let text = Text(display)
                                .font(BrandFonts.sans(11, weight: bold ? .semibold : .regular).monospacedDigit())
                                .foregroundStyle(cell.t == "e" ? Theme.danger : Theme.textPrimary)
                            let resolved = context.resolve(text)
                            var inner = context
                            inner.clip(to: Path(CGRect(x: cellX + 1, y: y, width: widths[col] - 2, height: rowHeight)))
                            inner.draw(
                                resolved,
                                at: CGPoint(x: numeric ? cellX + widths[col] - 5 : cellX + 5, y: y + rowHeight / 2),
                                anchor: numeric ? .trailing : .leading
                            )
                        }
                        cellX += widths[col]
                    }
                }
            }
            .frame(height: CGFloat(rows + 1) * rowHeight)
            .frame(maxWidth: .infinity)
            .background(Theme.background)
            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            Text(footer)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
        }
        .allowsHitTesting(false)
    }

    private var footer: String {
        var parts = [preview.tab]
        parts.append("\(preview.rowCount) \(preview.rowCount == 1 ? "linha" : "linhas")")
        if preview.tabs > 1 {
            parts.append("\(preview.tabs) abas")
        }
        return parts.joined(separator: " · ")
    }
}

struct AgendaPreviewList: View {
    let preview: AgendaPreview

    private static let dayLimit = 5

    private var colors: [String: String] {
        Dictionary(preview.accounts.map { ($0.id, $0.color) }, uniquingKeysWith: { first, _ in first })
    }

    private var timed: [AgendaEventPreview] {
        preview.events.filter { !$0.allDay }.sorted { $0.startDate < $1.startDate }
    }

    private var allDay: [(event: AgendaEventPreview, days: Int, first: Date, last: Date)] {
        let calendar = Calendar.agenda
        var groups: [(event: AgendaEventPreview, days: Int, first: Date, last: Date)] = []
        for event in preview.events.filter(\.allDay).sorted(by: { $0.startDate < $1.startDate }) {
            let last = calendar.date(byAdding: .day, value: -1, to: event.endDate) ?? event.startDate
            if let index = groups.firstIndex(where: { $0.event.title == event.title && $0.event.accountId == event.accountId }) {
                groups[index].days += 1
                groups[index].last = max(groups[index].last, last)
            } else {
                groups.append((event, 1, event.startDate, max(last, event.startDate)))
            }
        }
        return groups
    }

    private var days: [(day: Date, events: [AgendaEventPreview])] {
        let calendar = Calendar.agenda
        let grouped = Dictionary(grouping: timed) { calendar.startOfDay(for: $0.startDate) }
        return grouped.keys.sorted().map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs + 2) {
            if preview.events.isEmpty {
                Text("Nada marcado")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
            }
            if !allDay.isEmpty {
                HStack(spacing: Spacing.xs) {
                    ForEach(allDay.prefix(3), id: \.event.id) { group in
                        HStack(spacing: Spacing.xs) {
                            Circle()
                                .fill(Theme.accent(colors[group.event.accountId] ?? "blue"))
                                .frame(width: 6, height: 6)
                            Text(group.event.title)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            if group.days > 1 || group.last > group.first {
                                Text(spanText(group.first, group.last))
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textTertiary)
                                    .lineLimit(1)
                                    .fixedSize()
                            }
                        }
                        .padding(.horizontal, Spacing.s)
                        .frame(height: 22)
                        .background(Theme.accent(colors[group.event.accountId] ?? "blue").opacity(0.12), in: Capsule())
                    }
                    Spacer(minLength: 0)
                }
            }
            if preview.view == "week" {
                ForEach(days.prefix(Self.dayLimit), id: \.day) { item in
                    weekRow(item.day, item.events)
                }
                if days.count > Self.dayLimit {
                    Text("e mais \(days.count - Self.dayLimit) \(days.count - Self.dayLimit == 1 ? "dia" : "dias")")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
            } else {
                ForEach(timed.prefix(6)) { event in
                    dayRow(event)
                }
                if timed.count > 6 {
                    Text("e mais \(timed.count - 6)")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func weekRow(_ day: Date, _ events: [AgendaEventPreview]) -> some View {
        let today = Calendar.agenda.isDateInToday(day)
        return HStack(spacing: Spacing.s) {
            Text("\(AgendaFormat.weekday(day)) \(day.formatted(.dateTime.day()))")
                .font(TypeScale.captionStrong.monospacedDigit())
                .foregroundStyle(today ? Theme.brandText : Theme.textSecondary)
                .lineLimit(1)
                .fixedSize()
                .frame(width: 52, alignment: .leading)
            HStack(spacing: 3) {
                ForEach(events.prefix(8)) { event in
                    Capsule()
                        .fill(Theme.accent(colors[event.accountId] ?? "blue"))
                        .frame(width: 4, height: 14)
                }
            }
            .fixedSize()
            Text(events.prefix(2).map { "\($0.startDate.formatted(AgendaFormat.time)) \($0.title)" }.joined(separator: "  ·  "))
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            Text("\(events.count)")
                .font(TypeScale.caption.monospacedDigit())
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
                .fixedSize()
        }
    }

    private func dayRow(_ event: AgendaEventPreview) -> some View {
        HStack(spacing: Spacing.s) {
            Capsule()
                .fill(Theme.accent(colors[event.accountId] ?? "blue"))
                .frame(width: 4, height: 16)
            Text(event.startDate.formatted(AgendaFormat.time))
                .font(TypeScale.caption.monospacedDigit())
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .fixedSize()
                .frame(width: 40, alignment: .leading)
            Text(event.title)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if event.meet {
                Image(systemName: "video")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
    }

    private func spanText(_ first: Date, _ last: Date) -> String {
        if Calendar.agenda.isDate(first, inSameDayAs: last) { return AgendaFormat.weekday(first).lowercased() }
        return "\(AgendaFormat.weekday(first).lowercased())–\(AgendaFormat.weekday(last).lowercased())"
    }
}
