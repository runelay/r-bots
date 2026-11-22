import AppKit
import Foundation

actor FixtureBlocksClient: BlocksClient {
    static let shared = FixtureBlocksClient()

    nonisolated var isFixture: Bool { true }

    private var notesByID: [String: Note] = [:]
    private var sheetsByID: [String: Sheet] = [:]
    private var cellsBySheetTab: [String: [String: SheetCell]] = [:]
    private var events: [AgendaEvent] = []
    private var exports: [String: (ExportJob, Data)] = [:]
    private var seeded = false

    private let accounts: [AgendaAccount] = [
        AgendaAccount(
            id: "acc_pessoal", label: "Pessoal", email: "pessoal@exemplo.com", color: "blue", primary: true, status: "ready",
            calendars: [AgendaCalendar(id: "primary", name: "Pessoal", color: "blue", selected: true)]),
        AgendaAccount(
            id: "acc_trabalho", label: "Trabalho", email: "trabalho@exemplo.com", color: "violet", primary: false, status: "ready",
            calendars: [AgendaCalendar(id: "primary", name: "Trabalho", color: "violet", selected: true)]),
    ]

    private func seed() {
        guard !seeded else { return }
        seeded = true
        let now = BlockDates.string(Date())
        let seeds: [(String, String, String, String)] = [
            (
                "note_plano", "Plano Q1", "Projetos",
                """
                # Plano Q1

                Metas do trimestre, revisadas toda segunda com o [[Diário de bordo]].

                ## Metas
                - [x] Revisar o orçamento com a [[Reunião com a Ana]]
                - [ ] Fechar as metas de receita
                - [ ] Lançar a nova página de preços

                ## Números
                | Métrica | Meta | Hoje |
                | --- | ---: | ---: |
                | Receita | R$ 120 mil | R$ 84 mil |
                | Clientes | 40 | 31 |

                > Foco em menos coisas, feitas até o fim.

                ```
                prioridade = impacto / esforço
                ```
                """
            ),
            (
                "note_ana", "Reunião com a Ana", "Reuniões",
                """
                # Reunião com a Ana

                **Quando:** terça, 10h
                **Pauta:** orçamento do [[Plano Q1]] e contratação.

                - Ana aprova o teto de *R$ 30 mil* para mídia
                - Contratar uma pessoa de design até março
                - [ ] Mandar a proposta revisada
                """
            ),
            (
                "note_diario", "Diário de bordo", "",
                """
                # Diário de bordo

                ## 18/11
                - Revisei o [[Plano Q1]] e marquei o orçamento como feito.
                - Ideia: juntar as metas numa [[Planilha de metas]].

                ## 17/11
                - Conversa boa com o time sobre prioridades.
                """
            ),
            (
                "note_leituras", "Leituras", "Pessoal",
                """
                # Leituras

                - [x] Shape Up
                - [ ] The Mom Test
                - [ ] Working Backwards
                """
            ),
        ]
        for (id, title, folder, content) in seeds {
            notesByID[id] = makeNote(id: id, title: title, folder: folder, content: content, version: 1, updatedAt: now, author: .bot)
        }

        let tabMain = SheetTab(id: "tab_resumo", name: "Resumo", index: 0, rowCount: 14, colCount: 6, frozenRows: 1, frozenCols: 0, colWidths: ["A": 160, "E": 110])
        let tabData = SheetTab(id: "tab_lancamentos", name: "Lançamentos", index: 1, rowCount: 1, colCount: 4, frozenRows: 1, frozenCols: 0, colWidths: [:])
        sheetsByID["sheet_orcamento"] = Sheet(id: "sheet_orcamento", title: "Orçamento Q1", version: 1, updatedAt: now, updatedBy: .bot, tabs: [tabMain, tabData])
        var inputs: [String: String] = [
            "A1": "Categoria", "B1": "Janeiro", "C1": "Fevereiro", "D1": "Março", "E1": "Total", "F1": "Peso",
            "A2": "Mídia", "B2": "8000", "C2": "9500", "D2": "12000",
            "A3": "Ferramentas", "B3": "1200", "C3": "1200", "D3": "1350",
            "A4": "Pessoas", "B4": "42000", "C4": "42000", "D4": "48000",
            "A5": "Eventos", "B5": "0", "C5": "3500", "D5": "0",
            "A6": "Outros", "B6": "650", "C6": "820", "D6": "500",
            "A8": "Total", "B8": "=SOMA(B2:B6)", "C8": "=SOMA(C2:C6)", "D8": "=SOMA(D2:D6)", "E8": "=SOMA(E2:E6)",
        ]
        for row in 2...6 {
            inputs["E\(row)"] = "=SOMA(B\(row):D\(row))"
            inputs["F\(row)"] = "=E\(row)/E8"
        }
        var cells: [String: SheetCell] = [:]
        for (address, input) in inputs {
            guard let position = SheetAddress.parseCell(address) else { continue }
            var format: CellFormat?
            if position.row > 0, (1...4).contains(position.col) { format = CellFormat(type: .brl, decimals: 2) }
            if position.row > 0, position.col == 5 { format = CellFormat(type: .percent, decimals: 1) }
            if position.row == 0 || address == "A8" { format = CellFormat(type: format?.type ?? .general, decimals: format?.decimals, bold: true) }
            cells[address] = SheetCell(a: address, r: position.row, c: position.col, input: input, v: .null, t: nil, format: format)
        }
        cellsBySheetTab["sheet_orcamento#tab_resumo"] = recalculated(cells)
        let headers = ["Data", "Descrição", "Categoria", "Valor"]
        var data: [String: SheetCell] = [:]
        for (index, header) in headers.enumerated() {
            let address = SheetAddress.cell(row: 0, col: index)
            data[address] = SheetCell(a: address, r: 0, c: index, input: header, v: .string(header), t: "s", format: CellFormat(type: .general, bold: true))
        }
        cellsBySheetTab["sheet_orcamento#tab_lancamentos"] = data

        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        func at(_ dayOffset: Int, _ hour: Int, _ minute: Int = 0) -> Date {
            calendar.date(byAdding: .minute, value: dayOffset * 1440 + hour * 60 + minute, to: today) ?? today
        }
        let seedsEvents: [(String, String, Int, Int, Int, Int, Bool, String?)] = [
            ("evt_1", "Daily do time", 0, 9, 0, 30, true, "acc_trabalho"),
            ("evt_2", "Reunião com a Ana", 0, 10, 0, 60, true, "acc_trabalho"),
            ("evt_3", "Almoço com a família", 0, 12, 30, 90, false, "acc_pessoal"),
            ("evt_4", "Revisão do Plano Q1", 1, 14, 0, 60, true, "acc_trabalho"),
            ("evt_5", "Academia", 1, 7, 0, 60, false, "acc_pessoal"),
            ("evt_6", "1:1 com o Pedro", 2, 11, 0, 45, true, "acc_trabalho"),
            ("evt_7", "Dentista", 3, 16, 0, 60, false, "acc_pessoal"),
            ("evt_8", "Planejamento de mídia", -1, 15, 0, 90, true, "acc_trabalho"),
            ("evt_9", "Entrega da proposta", 2, 15, 0, 30, false, "acc_trabalho"),
            ("evt_10", "Treino de corrida", -2, 6, 30, 60, false, "acc_pessoal"),
        ]
        events = seedsEvents.map { id, title, day, hour, minute, duration, meet, account in
            let start = at(day, hour, minute)
            return AgendaEvent(
                id: id,
                accountId: account ?? "acc_pessoal",
                calendarId: "primary",
                title: title,
                start: BlockDates.string(start),
                end: BlockDates.string(start.addingTimeInterval(Double(duration) * 60)),
                allDay: false,
                meet: meet,
                meetUrl: meet ? "https://meet.google.com/abc-defg-hij" : nil,
                location: meet ? nil : (title == "Dentista" ? "Rua Augusta, 1200" : nil),
                description: title == "Reunião com a Ana" ? "Orçamento do Plano Q1 e contratação de design." : nil,
                attendees: meet
                    ? [
                        AgendaAttendee(email: "ana@exemplo.com", name: "Ana Souza", response: "accepted", isSelf: false, organizer: true),
                        AgendaAttendee(email: "trabalho@exemplo.com", name: nil, response: "accepted", isSelf: true, organizer: false),
                        AgendaAttendee(email: "pedro@exemplo.com", name: "Pedro Lima", response: "tentative", isSelf: false, organizer: false),
                    ] : [],
                status: "confirmed",
                recurring: title == "Daily do time",
                updatedAt: now
            )
        }
        let allDayStart = at(4, 0)
        refreshLinks()
        events.append(
            AgendaEvent(
                id: "evt_allday", accountId: "acc_pessoal", calendarId: "primary", title: "Aniversário da Bia", start: BlockDates.dayString(allDayStart), end: BlockDates.dayString(at(5, 0)),
                allDay: true, meet: false, meetUrl: nil, location: nil, description: nil, attendees: [], status: "confirmed", recurring: false, updatedAt: now))
    }

    func notes(botID: String, folder: String?, query: String?, cursor: String?, limit: Int) async throws -> BlockPage<NoteSummary> {
        seed()
        var items = notesByID.values.map(\.summary)
        if let folder { items = items.filter { $0.folder == folder } }
        if let query, !query.isEmpty { items = items.filter { $0.title.localizedCaseInsensitiveContains(query) } }
        items.sort { $0.updatedAt == $1.updatedAt ? $0.title < $1.title : $0.updatedAt > $1.updatedAt }
        return paged(items, cursor: cursor, limit: limit)
    }

    func noteTree(botID: String, folder: String) async throws -> NoteTreeLevel {
        seed()
        let all = Array(notesByID.values)
        let prefix = folder.isEmpty ? "" : folder + "/"
        var childFolders: [String: (Int, Set<String>)] = [:]
        for note in all where note.folder != folder && (folder.isEmpty || note.folder.hasPrefix(prefix)) && !note.folder.isEmpty {
            let rest = String(note.folder.dropFirst(prefix.count))
            let parts = rest.split(separator: "/").map(String.init)
            guard let first = parts.first else { continue }
            var entry = childFolders[first] ?? (0, [])
            if parts.count == 1 { entry.0 += 1 } else { entry.1.insert(parts[1]) }
            childFolders[first] = entry
        }
        let folders = childFolders.keys.sorted().map { name in
            NoteFolder(name: name, path: prefix + name, notes: childFolders[name]?.0 ?? 0, folders: childFolders[name]?.1.count ?? 0)
        }
        let notes = all.filter { $0.folder == folder }.map(\.summary).sorted { $0.title < $1.title }
        return NoteTreeLevel(folder: folder, folders: folders, notes: BlockPage(items: notes, nextCursor: nil, total: notes.count))
    }

    func searchNotes(botID: String, query: String, titlesOnly: Bool, cursor: String?, limit: Int) async throws -> BlockPage<NoteSearchHit> {
        seed()
        let needle = query.trimmingCharacters(in: .whitespaces)
        var hits: [NoteSearchHit] = []
        for note in notesByID.values.sorted(by: { $0.title < $1.title }) {
            if needle.isEmpty || note.title.localizedCaseInsensitiveContains(needle) {
                hits.append(NoteSearchHit(id: note.id, title: note.title, folder: note.folder, snippet: titlesOnly ? nil : note.excerpt, ranges: nil))
            } else if !titlesOnly, let line = note.content.split(separator: "\n").first(where: { $0.localizedCaseInsensitiveContains(needle) }) {
                let snippet = String(line).trimmingCharacters(in: .whitespaces)
                let range = (snippet as NSString).range(of: needle, options: [.caseInsensitive, .diacriticInsensitive])
                hits.append(
                    NoteSearchHit(
                        id: note.id, title: note.title, folder: note.folder, snippet: snippet, ranges: range.location == NSNotFound ? nil : [[range.location, range.location + range.length]]))
            }
        }
        return paged(hits, cursor: cursor, limit: limit)
    }

    func note(botID: String, id: String) async throws -> Note {
        seed()
        guard let note = notesByID[id] else { throw BlocksError.message(tr("Nota não encontrada.")) }
        return note
    }

    func resolveNote(botID: String, title: String) async throws -> Note? {
        seed()
        return notesByID.values.first { $0.title.caseInsensitiveCompare(title) == .orderedSame }
    }

    func backlinks(botID: String, id: String, cursor: String?) async throws -> BlockPage<NoteBacklink> {
        seed()
        guard let target = notesByID[id] else { return BlockPage(items: [], nextCursor: nil, total: 0) }
        let items = notesByID.values.compactMap { note -> NoteBacklink? in
            guard note.id != id, let line = note.content.split(separator: "\n").first(where: { $0.contains("[[\(target.title)") }) else { return nil }
            return NoteBacklink(id: note.id, title: note.title, folder: note.folder, snippet: String(line).trimmingCharacters(in: .whitespaces))
        }
        .sorted { $0.title < $1.title }
        return paged(items, cursor: cursor, limit: 50)
    }

    func createNote(botID: String, title: String, folder: String, content: String) async throws -> Note {
        seed()
        if notesByID.values.contains(where: { $0.title == title && $0.folder == folder }) {
            throw BlocksError.message(tr("Já existe uma nota com esse título nessa pasta."))
        }
        let id = "note_\(UUID().uuidString.prefix(8))"
        let note = makeNote(id: id, title: title, folder: folder, content: content.isEmpty ? "# \(title)\n\n" : content, version: 1, updatedAt: BlockDates.string(Date()), author: .user)
        notesByID[id] = note
        refreshLinks()
        return notesByID[id] ?? note
    }

    func writeNote(botID: String, id: String, content: String, title: String?, baseVersion: Int?) async throws -> Note {
        seed()
        guard let current = notesByID[id] else { throw BlocksError.message(tr("Nota não encontrada.")) }
        if let baseVersion, baseVersion < current.version, current.updatedBy == .bot { throw BlocksError.stale(current.version) }
        let version = current.updatedBy == .user ? current.version : current.version + 1
        let note = makeNote(id: id, title: title ?? current.title, folder: current.folder, content: content, version: version, updatedAt: BlockDates.string(Date()), author: .user)
        notesByID[id] = note
        refreshLinks()
        return notesByID[id] ?? note
    }

    func patchNote(botID: String, id: String, ops: [NotePatchOp], baseVersion: Int?) async throws -> Note {
        seed()
        guard var content = notesByID[id]?.content else { throw BlocksError.message(tr("Nota não encontrada.")) }
        for op in ops {
            switch op {
            case .replace(let old, let new):
                guard let range = content.range(of: old) else { throw BlocksError.message(tr("Trecho não encontrado.")) }
                content.replaceSubrange(range, with: new)
            case .append(let text):
                content += text
            case .toggleTask(let line, let done):
                var lines = content.components(separatedBy: "\n")
                guard lines.indices.contains(line) else { continue }
                lines[line] = done ? lines[line].replacingOccurrences(of: "[ ]", with: "[x]") : lines[line].replacingOccurrences(of: "[x]", with: "[ ]")
                content = lines.joined(separator: "\n")
            }
        }
        return try await writeNote(botID: botID, id: id, content: content, title: nil, baseVersion: nil)
    }

    func sheets(botID: String, query: String?, cursor: String?, limit: Int) async throws -> BlockPage<SheetSummary> {
        seed()
        var items = sheetsByID.values.map {
            SheetSummary(id: $0.id, title: $0.title, version: $0.version, updatedAt: $0.updatedAt, updatedBy: $0.updatedBy, tabs: $0.tabs.map { SheetTabRef(id: $0.id, name: $0.name) })
        }
        if let query, !query.isEmpty { items = items.filter { $0.title.localizedCaseInsensitiveContains(query) } }
        return paged(items.sorted { $0.updatedAt > $1.updatedAt }, cursor: cursor, limit: limit)
    }

    func createSheet(botID: String, title: String) async throws -> Sheet {
        seed()
        let id = "sheet_\(UUID().uuidString.prefix(8))"
        let sheet = Sheet(
            id: id, title: title, version: 1, updatedAt: BlockDates.string(Date()), updatedBy: .user,
            tabs: [SheetTab(id: "tab_1", name: "Planilha 1", index: 0, rowCount: 0, colCount: 0, frozenRows: 0, frozenCols: 0, colWidths: [:])])
        sheetsByID[id] = sheet
        return sheet
    }

    func sheet(botID: String, id: String) async throws -> Sheet {
        seed()
        guard let sheet = sheetsByID[id] else { throw BlocksError.message(tr("Planilha não encontrada.")) }
        return sheet
    }

    func sheetRange(botID: String, sheetID: String, tabID: String, range: String) async throws -> SheetRangeResult {
        seed()
        guard let bounds = SheetAddress.parseRange(range) else { throw BlocksError.message(tr("Intervalo inválido.")) }
        let cells = (cellsBySheetTab["\(sheetID)#\(tabID)"] ?? [:]).values.filter { bounds.rows.contains($0.r) && bounds.cols.contains($0.c) }
        return SheetRangeResult(tabId: tabID, range: range, version: sheetsByID[sheetID]?.version ?? 1, cells: Array(cells))
    }

    func writeCells(botID: String, sheetID: String, tabID: String, cells: [(address: String, input: String)], baseVersion: Int?) async throws -> SheetWriteResult {
        seed()
        let key = "\(sheetID)#\(tabID)"
        var map = cellsBySheetTab[key] ?? [:]
        for cell in cells {
            guard let position = SheetAddress.parseCell(cell.address) else { continue }
            if cell.input.isEmpty, map[cell.address]?.format == nil {
                map[cell.address] = nil
            } else {
                map[cell.address] = SheetCell(a: cell.address, r: position.row, c: position.col, input: cell.input, v: .null, t: nil, format: map[cell.address]?.format)
            }
        }
        map = recalculated(map)
        cellsBySheetTab[key] = map
        bumpSheet(sheetID, tabID: tabID, cells: map)
        return SheetWriteResult(version: sheetsByID[sheetID]?.version ?? 1, cells: Array(map.values))
    }

    func formatCells(botID: String, sheetID: String, tabID: String, ranges: [String], format: CellFormat?) async throws -> SheetWriteResult {
        seed()
        let key = "\(sheetID)#\(tabID)"
        var map = cellsBySheetTab[key] ?? [:]
        var touched: [SheetCell] = []
        for range in ranges {
            guard let bounds = SheetAddress.parseRange(range) else { continue }
            for row in bounds.rows {
                for col in bounds.cols {
                    let address = SheetAddress.cell(row: row, col: col)
                    var cell = map[address] ?? SheetCell(a: address, r: row, c: col, input: "", v: .null, t: nil)
                    cell.format = format
                    map[address] = cell
                    touched.append(cell)
                }
            }
        }
        cellsBySheetTab[key] = map
        bumpSheet(sheetID, tabID: tabID, cells: map)
        return SheetWriteResult(version: sheetsByID[sheetID]?.version ?? 1, cells: touched)
    }

    func updateTab(botID: String, sheetID: String, tabID: String, patch: SheetTabPatch) async throws -> SheetTab {
        seed()
        guard var sheet = sheetsByID[sheetID], let index = sheet.tabs.firstIndex(where: { $0.id == tabID }) else { throw BlocksError.message(tr("Aba não encontrada.")) }
        if let name = patch.name { sheet.tabs[index].name = name }
        if let rows = patch.frozenRows { sheet.tabs[index].frozenRows = rows }
        if let cols = patch.frozenCols { sheet.tabs[index].frozenCols = cols }
        if let widths = patch.colWidths { sheet.tabs[index].colWidths.merge(widths) { $1 } }
        sheetsByID[sheetID] = sheet
        return sheet.tabs[index]
    }

    func addTab(botID: String, sheetID: String, name: String) async throws -> SheetTab {
        seed()
        guard var sheet = sheetsByID[sheetID] else { throw BlocksError.message(tr("Planilha não encontrada.")) }
        let tab = SheetTab(id: "tab_\(UUID().uuidString.prefix(6))", name: name, index: sheet.tabs.count, rowCount: 0, colCount: 0, frozenRows: 0, frozenCols: 0, colWidths: [:])
        sheet.tabs.append(tab)
        sheetsByID[sheetID] = sheet
        return tab
    }

    func agendaAccounts(botID: String) async throws -> [AgendaAccount] {
        seed()
        return accounts
    }

    func agendaEvents(botID: String, start: Date, end: Date, accounts: [String]?) async throws -> AgendaList {
        seed()
        let items = events.filter { event in
            (accounts == nil || accounts?.contains(event.accountId) == true) && event.endDate > start && event.startDate < end
        }
        .sorted { $0.startDate < $1.startDate }
        return AgendaList(timezone: TimeZone.current.identifier, items: items)
    }

    func createEvent(botID: String, draft: AgendaEventDraft) async throws -> AgendaEvent {
        seed()
        let event = AgendaEvent(
            id: "evt_\(UUID().uuidString.prefix(6))", accountId: draft.accountId, calendarId: "primary", title: draft.title, start: BlockDates.string(draft.start), end: BlockDates.string(draft.end),
            allDay: draft.allDay, meet: draft.meet, meetUrl: draft.meet ? "https://meet.google.com/new" : nil, location: draft.location, description: draft.description, attendees: [],
            status: "confirmed", recurring: false, updatedAt: BlockDates.string(Date()))
        events.append(event)
        return event
    }

    func deleteEvent(botID: String, id: String) async throws {
        seed()
        events.removeAll { $0.id == id }
    }

    func createExport(botID: String, kind: BlockKind, id: String, format: ExportFormat, tabID: String?) async throws -> ExportJob {
        seed()
        let data: Data
        let title: String
        switch (kind, format) {
        case (.note, .md):
            guard let note = notesByID[id] else { throw BlocksError.message(tr("Nota não encontrada.")) }
            data = Data(note.content.utf8)
            title = note.title
        case (.note, .docx), (.note, .pdf):
            guard let note = notesByID[id] else { throw BlocksError.message(tr("Nota não encontrada.")) }
            data = try await MainActor.run { try Self.richDocument(note.content, pdf: format == .pdf) }
            title = note.title
        case (.sheet, .csv):
            guard let sheet = sheetsByID[id] else { throw BlocksError.message(tr("Planilha não encontrada.")) }
            let tab = tabID ?? sheet.tabs.first?.id ?? ""
            data = Data(csv(cellsBySheetTab["\(id)#\(tab)"] ?? [:]).utf8)
            title = sheet.title
        default:
            throw BlocksError.message(tr("Esse formato chega junto com o servidor dos blocos."))
        }
        let job = ExportJob(
            id: "exp_\(UUID().uuidString.prefix(8))", kind: kind.rawValue, sourceId: id, format: format, status: "ready", fileName: "\(title).\(format.rawValue)", size: data.count, url: "fixture",
            error: nil, createdAt: BlockDates.string(Date()))
        exports[job.id] = (job, data)
        return job
    }

    func exportJob(botID: String, id: String) async throws -> ExportJob {
        guard let job = exports[id]?.0 else { throw BlocksError.message(tr("Exportação não encontrada.")) }
        return job
    }

    func download(botID: String, job: ExportJob) async throws -> DownloadedFile {
        guard let data = exports[job.id]?.1 else { throw BlocksError.message(tr("Exportação não encontrada.")) }
        return DownloadedFile(data: data, fileName: job.fileName)
    }

    @MainActor
    private static func richDocument(_ markdown: String, pdf: Bool) throws -> Data {
        let attributed = NSMutableAttributedString(attributedString: NoteStyler.exportAttributed(markdown))
        let range = NSRange(location: 0, length: attributed.length)
        if pdf {
            let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 700))
            view.textStorage?.setAttributedString(attributed)
            view.textContainerInset = NSSize(width: 40, height: 40)
            view.sizeToFit()
            return view.dataWithPDF(inside: view.bounds)
        }
        return try attributed.data(from: range, documentAttributes: [.documentType: NSAttributedString.DocumentType.officeOpenXML])
    }

    private func csv(_ cells: [String: SheetCell]) -> String {
        let maxRow = cells.values.map(\.r).max() ?? -1
        let maxCol = cells.values.map(\.c).max() ?? -1
        guard maxRow >= 0, maxCol >= 0 else { return "" }
        return (0...maxRow).map { row in
            (0...maxCol).map { col in
                let cell = cells[SheetAddress.cell(row: row, col: col)]
                let text =
                    cell.map { value -> String in
                        if case .number(let number) = value.v { return String(number) }
                        return CellText.display(value.v, type: value.t, format: value.format)
                    } ?? ""
                return text.contains(",") || text.contains("\"") || text.contains("\n") ? "\"\(text.replacingOccurrences(of: "\"", with: "\"\""))\"" : text
            }
            .joined(separator: ",")
        }
        .joined(separator: "\n")
    }

    private func bumpSheet(_ id: String, tabID: String, cells: [String: SheetCell]) {
        guard var sheet = sheetsByID[id] else { return }
        sheet.version += 1
        sheet.updatedAt = BlockDates.string(Date())
        sheet.updatedBy = .user
        if let index = sheet.tabs.firstIndex(where: { $0.id == tabID }) {
            sheet.tabs[index].rowCount = (cells.values.map(\.r).max() ?? -1) + 1
            sheet.tabs[index].colCount = (cells.values.map(\.c).max() ?? -1) + 1
        }
        sheetsByID[id] = sheet
    }

    private func paged<T>(_ items: [T], cursor: String?, limit: Int) -> BlockPage<T> {
        let start = cursor.flatMap(Int.init) ?? 0
        let slice = Array(items.dropFirst(start).prefix(limit))
        let next = start + slice.count < items.count ? String(start + slice.count) : nil
        return BlockPage(items: slice, nextCursor: next, total: items.count)
    }

    private func makeNote(id: String, title: String, folder: String, content: String, version: Int, updatedAt: String, author: BlockAuthor) -> Note {
        let plain =
            content
            .replacingOccurrences(of: "#", with: "")
            .replacingOccurrences(of: "[[", with: "")
            .replacingOccurrences(of: "]]", with: "")
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .dropFirst()
            .joined(separator: " ")
        return Note(
            id: id,
            title: title,
            folder: folder,
            version: version,
            updatedAt: updatedAt,
            updatedBy: author,
            excerpt: String(plain.prefix(160)),
            tags: [],
            content: content,
            links: [],
            backlinkCount: 0
        )
    }

    private func refreshLinks() {
        let titles = Dictionary(notesByID.values.map { ($0.title.lowercased(), $0.id) }, uniquingKeysWith: { first, _ in first })
        var counts: [String: Int] = [:]
        for (id, note) in notesByID {
            let targets = NoteLinkParser.targets(in: note.content)
            notesByID[id]?.links = targets.map { NoteLink(target: $0, id: titles[$0.lowercased()], title: $0) }
            for target in Set(targets.compactMap { titles[$0.lowercased()] }) where target != id {
                counts[target, default: 0] += 1
            }
        }
        for id in notesByID.keys {
            notesByID[id]?.backlinkCount = counts[id] ?? 0
        }
    }

    private func recalculated(_ cells: [String: SheetCell]) -> [String: SheetCell] {
        var map = cells
        for (address, cell) in map where !cell.input.hasPrefix("=") {
            let parsed = FixtureFormula.literal(cell.input)
            map[address]?.v = parsed.0
            map[address]?.t = parsed.1
        }
        for _ in 0..<4 {
            for (address, cell) in map where cell.input.hasPrefix("=") {
                let value = FixtureFormula.evaluate(String(cell.input.dropFirst())) { reference in
                    map[reference]?.v.number ?? 0
                }
                if let value {
                    map[address]?.v = .number(value)
                    map[address]?.t = "n"
                    map[address]?.error = nil
                } else {
                    map[address]?.v = .string("#VALUE!")
                    map[address]?.t = "e"
                    map[address]?.error = tr("Fórmula que o modo de demonstração não sabe calcular.")
                }
            }
        }
        return map
    }
}

enum FixtureFormula {
    static func literal(_ input: String) -> (CellValue, String?) {
        let trimmed = input.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return (.null, nil) }
        let normalized = trimmed.replacingOccurrences(of: "R$", with: "").replacingOccurrences(of: " ", with: "")
        if normalized.hasSuffix("%"), let number = number(String(normalized.dropLast())) {
            return (.number(number / 100), "n")
        }
        if let number = number(normalized) {
            return (.number(number), "n")
        }
        return (.string(trimmed), "s")
    }

    static func number(_ text: String) -> Double? {
        if let value = Double(text) { return value }
        let swapped = text.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: ".")
        return Double(swapped)
    }

    static func evaluate(_ expression: String, lookup: @escaping (String) -> Double) -> Double? {
        var parser = Parser(text: Array(expression.uppercased().replacingOccurrences(of: " ", with: "")), lookup: lookup)
        guard let value = parser.expression(), parser.index == parser.text.count, value.isFinite else { return nil }
        return value
    }

    private struct Parser {
        let text: [Character]
        let lookup: (String) -> Double
        var index = 0

        mutating func expression() -> Double? {
            guard var value = term() else { return nil }
            while index < text.count, text[index] == "+" || text[index] == "-" {
                let op = text[index]
                index += 1
                guard let rhs = term() else { return nil }
                value = op == "+" ? value + rhs : value - rhs
            }
            return value
        }

        mutating func term() -> Double? {
            guard var value = factor() else { return nil }
            while index < text.count, text[index] == "*" || text[index] == "/" {
                let op = text[index]
                index += 1
                guard let rhs = factor() else { return nil }
                value = op == "*" ? value * rhs : value / rhs
            }
            return value
        }

        mutating func factor() -> Double? {
            guard index < text.count else { return nil }
            if text[index] == "(" {
                index += 1
                let value = expression()
                guard index < text.count, text[index] == ")" else { return nil }
                index += 1
                return value
            }
            if text[index] == "-" {
                index += 1
                return factor().map { -$0 }
            }
            var token = ""
            while index < text.count, text[index].isLetter || text[index].isNumber || text[index] == "." || text[index] == "," || text[index] == ":" {
                token.append(text[index])
                index += 1
            }
            if index < text.count, text[index] == "(" {
                index += 1
                var args = ""
                while index < text.count, text[index] != ")" {
                    args.append(text[index])
                    index += 1
                }
                guard index < text.count else { return nil }
                index += 1
                guard let bounds = SheetAddress.parseRange(args) else { return nil }
                var values: [Double] = []
                for row in bounds.rows {
                    for col in bounds.cols {
                        values.append(lookup(SheetAddress.cell(row: row, col: col)))
                    }
                }
                switch token {
                case "SUM", "SOMA": return values.reduce(0, +)
                case "AVERAGE", "MEDIA", "MÉDIA": return values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
                case "MAX", "MÁXIMO": return values.max() ?? 0
                case "MIN", "MÍNIMO": return values.min() ?? 0
                default: return nil
                }
            }
            if let number = FixtureFormula.number(token) { return number }
            if SheetAddress.parseCell(token) != nil { return lookup(token) }
            return nil
        }
    }
}

enum NoteLinkParser {
    static func targets(in content: String) -> [String] {
        var result: [String] = []
        var rest = content[...]
        while let open = rest.range(of: "[["), let close = rest[open.upperBound...].range(of: "]]") {
            let inside = rest[open.upperBound..<close.lowerBound]
            let target = inside.split(separator: "|").first.map { $0.split(separator: "#").first.map(String.init) ?? "" } ?? ""
            if !target.isEmpty, !target.contains("\n") {
                result.append(target.trimmingCharacters(in: .whitespaces))
            }
            rest = rest[close.upperBound...]
        }
        return result
    }
}
