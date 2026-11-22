import AppKit
import Foundation
import Observation

struct CellPosition: Hashable, Sendable {
    var row: Int
    var col: Int
}

struct CellSelection: Equatable, Sendable {
    var anchor: CellPosition
    var cursor: CellPosition

    var rows: ClosedRange<Int> { min(anchor.row, cursor.row)...max(anchor.row, cursor.row) }
    var cols: ClosedRange<Int> { min(anchor.col, cursor.col)...max(anchor.col, cursor.col) }
    var isSingle: Bool { anchor == cursor }
    var address: String { SheetAddress.range(rows: rows, cols: cols) }

    static let origin = CellSelection(anchor: CellPosition(row: 0, col: 0), cursor: CellPosition(row: 0, col: 0))
}

@MainActor
@Observable
final class SheetEditorStore {
    static let rowHeight: CGFloat = 26
    static let headerHeight: CGFloat = 24
    static let rowHeaderWidth: CGFloat = 46
    static let defaultColumnWidth: CGFloat = 104
    static let chunkRows = 60
    static let chunkCols = 26

    let botID: String
    let sheetID: String

    private(set) var sheet: Sheet?
    private(set) var tabID: String?
    private(set) var selection = CellSelection.origin
    private(set) var editing = false
    private(set) var editSeed: String?
    private(set) var gridRevision = 0
    private(set) var layoutRevision = 0
    private(set) var highlight: [(rows: ClosedRange<Int>, cols: ClosedRange<Int>)] = []
    private(set) var failed: String?
    private(set) var pendingWrites = 0
    private(set) var remoteEditedAt: Date?
    var formulaText = ""

    @ObservationIgnored private(set) var cells: [CellPosition: SheetCell] = [:]
    @ObservationIgnored private(set) var columnOffsets: [CGFloat] = [0]
    @ObservationIgnored private var columnWidths: [Int: CGFloat] = [:]
    @ObservationIgnored private var loadedChunks: Set<CellPosition> = []
    @ObservationIgnored private var loadingChunks: Set<CellPosition> = []
    @ObservationIgnored private var highlightTask: Task<Void, Never>?
    @ObservationIgnored private var pending: Set<CellPosition> = []
    @ObservationIgnored let client: any BlocksClient

    init(botID: String, sheetID: String, client: any BlocksClient) {
        self.botID = botID
        self.sheetID = sheetID
        self.client = client
    }

    var tab: SheetTab? {
        sheet?.tabs.first { $0.id == tabID }
    }

    var rowCount: Int { max((tab?.rowCount ?? 0) + 40, 100) }
    var colCount: Int { max((tab?.colCount ?? 0) + 4, 26) }
    var frozenRows: Int { tab?.frozenRows ?? 0 }

    var statusText: String {
        if let failed { return failed }
        if pendingWrites > 0 { return tr("Salvando…") }
        if let remoteEditedAt, Date().timeIntervalSince(remoteEditedAt) < 60 { return tr("O bot acabou de editar") }
        guard let tab, let sheet else { return tr("Planilha") }
        return sheet.tabs.count > 1 ? tr("Aba %@", tab.name) : tr("Salvo")
    }

    func load() async {
        do {
            let loaded = try await client.sheet(botID: botID, id: sheetID)
            sheet = loaded
            BlockCenter.shared.noteTitleChanged(botID: botID, id: sheetID, title: loaded.title)
            ArtifactCenter.shared.retitle(ArtifactRef(botID: botID, id: sheetID, title: loaded.title, kind: BlockKind.sheet.rawValue, version: loaded.version))
            if tabID == nil || !loaded.tabs.contains(where: { $0.id == tabID }) {
                tabID = loaded.tabs.sorted { $0.index < $1.index }.first?.id
            }
            resetTabState()
            await ensureLoaded(rows: 0...Self.chunkRows - 1, cols: 0...Self.chunkCols - 1)
            syncFormula()
        } catch {
            BlocksLog.failure("sheet load", error)
            failed = tr("Não consegui abrir a planilha.")
        }
    }

    func selectTab(_ id: String) {
        guard id != tabID else { return }
        tabID = id
        selection = .origin
        resetTabState()
        Task { await ensureLoaded(rows: 0...Self.chunkRows - 1, cols: 0...Self.chunkCols - 1) }
        syncFormula()
    }

    func addTab() {
        guard let sheet else { return }
        let name = tr("Aba %lld", sheet.tabs.count + 1)
        Task {
            if let tab = try? await client.addTab(botID: botID, sheetID: sheetID, name: name) {
                self.sheet?.tabs.append(tab)
                selectTab(tab.id)
            }
        }
    }

    func flush() {}

    func cell(_ row: Int, _ col: Int) -> SheetCell? {
        cells[CellPosition(row: row, col: col)]
    }

    func isPending(_ row: Int, _ col: Int) -> Bool {
        pending.contains(CellPosition(row: row, col: col))
    }

    func width(of col: Int) -> CGFloat {
        columnWidths[col] ?? Self.defaultColumnWidth
    }

    func offset(of col: Int) -> CGFloat {
        if col < columnOffsets.count { return columnOffsets[col] }
        return (columnOffsets.last ?? 0) + CGFloat(col - columnOffsets.count + 1) * Self.defaultColumnWidth
    }

    func column(at x: CGFloat) -> Int {
        var low = 0
        var high = colCount - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if offset(of: mid) <= x { low = mid } else { high = mid - 1 }
        }
        return max(0, low)
    }

    var contentWidth: CGFloat { offset(of: colCount) }

    func visibleChanged(rows: ClosedRange<Int>, cols: ClosedRange<Int>) {
        Task { await ensureLoaded(rows: rows, cols: cols) }
    }

    func select(_ position: CellPosition, extend: Bool = false) {
        let clamped = CellPosition(row: min(max(0, position.row), rowCount - 1), col: min(max(0, position.col), colCount - 1))
        if extend {
            selection.cursor = clamped
        } else {
            selection = CellSelection(anchor: clamped, cursor: clamped)
        }
        editing = false
        editSeed = nil
        syncFormula()
    }

    func selectColumn(_ col: Int, extend: Bool) {
        let anchorCol = extend ? selection.anchor.col : col
        selection = CellSelection(anchor: CellPosition(row: 0, col: anchorCol), cursor: CellPosition(row: rowCount - 1, col: col))
        editing = false
        syncFormula()
    }

    func selectRow(_ row: Int, extend: Bool) {
        let anchorRow = extend ? selection.anchor.row : row
        selection = CellSelection(anchor: CellPosition(row: anchorRow, col: 0), cursor: CellPosition(row: row, col: colCount - 1))
        editing = false
        syncFormula()
    }

    func selectAll() {
        selection = CellSelection(anchor: CellPosition(row: 0, col: 0), cursor: CellPosition(row: rowCount - 1, col: colCount - 1))
        syncFormula()
    }

    func move(rows: Int, cols: Int, extend: Bool) {
        let base = extend ? selection.cursor : selection.anchor
        select(CellPosition(row: base.row + rows, col: base.col + cols), extend: extend)
    }

    func beginEdit(seed: String? = nil) {
        editSeed = seed
        editing = true
    }

    func cancelEdit() {
        editing = false
        editSeed = nil
        syncFormula()
    }

    func commitEdit(_ text: String, moveRows: Int = 0, moveCols: Int = 0) {
        let target = selection.anchor
        editing = false
        editSeed = nil
        write([(target, text)])
        if moveRows != 0 || moveCols != 0 {
            select(CellPosition(row: target.row + moveRows, col: target.col + moveCols))
        } else {
            syncFormula()
        }
    }

    func commitFormulaBar() {
        commitEdit(formulaText, moveRows: 1)
    }

    func clearSelection() {
        var writes: [(CellPosition, String)] = []
        for row in selection.rows {
            for col in selection.cols where cells[CellPosition(row: row, col: col)] != nil {
                writes.append((CellPosition(row: row, col: col), ""))
            }
        }
        write(writes)
    }

    func copySelection() {
        let rows = selection.rows.clamped(to: 0...max(0, (tab?.rowCount ?? 1) - 1))
        let cols = selection.cols.clamped(to: 0...max(0, (tab?.colCount ?? 1) - 1))
        let text = rows.map { row in
            cols.map { col -> String in
                guard let cell = cell(row, col) else { return "" }
                let display = CellText.display(cell.v, type: cell.t, format: cell.format)
                return display.contains("\t") || display.contains("\n") || display.contains("\"") ? "\"\(display.replacingOccurrences(of: "\"", with: "\"\""))\"" : display
            }
            .joined(separator: "\t")
        }
        .joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func cutSelection() {
        copySelection()
        clearSelection()
    }

    func paste() {
        guard let text = NSPasteboard.general.string(forType: .string) else { return }
        let grid = TSV.parse(text)
        guard !grid.isEmpty else { return }
        let origin = CellPosition(row: selection.rows.lowerBound, col: selection.cols.lowerBound)
        var writes: [(CellPosition, String)] = []
        for (rowOffset, line) in grid.enumerated() {
            for (colOffset, value) in line.enumerated() {
                writes.append((CellPosition(row: origin.row + rowOffset, col: origin.col + colOffset), value))
            }
        }
        write(writes)
        let maxCols = grid.map(\.count).max() ?? 1
        selection = CellSelection(anchor: origin, cursor: CellPosition(row: origin.row + grid.count - 1, col: origin.col + maxCols - 1))
        syncFormula()
    }

    func applyFormat(_ type: CellFormatType) {
        guard let tabID else { return }
        let decimals: Int? =
            switch type {
            case .brl, .number: 2
            case .percent: 1
            default: nil
            }
        let range = selectionDataRange
        let base = cell(selection.anchor.row, selection.anchor.col)?.format
        let format = CellFormat(type: type, decimals: decimals, bold: base?.bold, align: base?.align)
        for row in range.rows {
            for col in range.cols {
                let position = CellPosition(row: row, col: col)
                if var cell = cells[position] {
                    cell.format = format
                    cells[position] = cell
                }
            }
        }
        gridRevision += 1
        sendFormat(tabID: tabID, ranges: [SheetAddress.range(rows: range.rows, cols: range.cols)], format: format)
    }

    func toggleBold() {
        guard let tabID else { return }
        let range = selectionDataRange
        let current = cell(selection.anchor.row, selection.anchor.col)?.format
        let bold = !(current?.bold ?? false)
        let format = CellFormat(type: current?.type ?? .general, decimals: current?.decimals, bold: bold, align: current?.align)
        for row in range.rows {
            for col in range.cols {
                let position = CellPosition(row: row, col: col)
                if var cell = cells[position] {
                    cell.format = CellFormat(type: cell.format?.type ?? .general, decimals: cell.format?.decimals, bold: bold, align: cell.format?.align)
                    cells[position] = cell
                }
            }
        }
        gridRevision += 1
        sendFormat(tabID: tabID, ranges: [SheetAddress.range(rows: range.rows, cols: range.cols)], format: format)
    }

    var selectionFormat: CellFormat? {
        cell(selection.anchor.row, selection.anchor.col)?.format
    }

    func toggleFrozenRow() {
        guard let tabID, let index = sheet?.tabs.firstIndex(where: { $0.id == tabID }) else { return }
        let value = frozenRows > 0 ? 0 : 1
        sheet?.tabs[index].frozenRows = value
        gridRevision += 1
        let client = client
        let botID = botID
        let sheetID = sheetID
        Task {
            _ = try? await client.updateTab(botID: botID, sheetID: sheetID, tabID: tabID, patch: SheetTabPatch(frozenRows: value))
        }
    }

    func resizeColumn(_ col: Int, to width: CGFloat, final: Bool) {
        columnWidths[col] = max(36, min(width, 640))
        rebuildOffsets()
        layoutRevision += 1
        guard final, let tabID else { return }
        let name = SheetAddress.columnName(col)
        let value = Double(columnWidths[col] ?? Self.defaultColumnWidth)
        if let index = sheet?.tabs.firstIndex(where: { $0.id == tabID }) {
            sheet?.tabs[index].colWidths[name] = value
        }
        let client = client
        let botID = botID
        let sheetID = sheetID
        Task {
            _ = try? await client.updateTab(botID: botID, sheetID: sheetID, tabID: tabID, patch: SheetTabPatch(colWidths: [name: value]))
        }
    }

    func remoteChanged(version: Int, change: BlockChange?) {
        guard version > (sheet?.version ?? 0) else { return }
        Task {
            guard let latest = try? await client.sheet(botID: botID, id: sheetID) else { return }
            sheet = latest
            remoteEditedAt = Date()
            loadedChunks = []
            for tab in latest.tabs where tab.id == tabID {
                columnWidths = Self.widths(tab)
                rebuildOffsets()
                layoutRevision += 1
            }
            await ensureLoaded(rows: 0...Self.chunkRows - 1, cols: 0...Self.chunkCols - 1)
            if case .ranges(let changedTab, let ranges) = change, changedTab.isEmpty || changedTab == tabID {
                let parsed = ranges.compactMap(SheetAddress.parseRange)
                for range in parsed {
                    await ensureLoaded(rows: range.rows, cols: range.cols)
                }
                flashHighlight(parsed)
            }
            syncFormula()
        }
    }

    private var selectionDataRange: (rows: ClosedRange<Int>, cols: ClosedRange<Int>) {
        let lastRow = max(selection.rows.lowerBound, min(selection.rows.upperBound, max(tab?.rowCount ?? 0, selection.rows.lowerBound + 1) + 200))
        let lastCol = max(selection.cols.lowerBound, min(selection.cols.upperBound, max(tab?.colCount ?? 0, selection.cols.lowerBound + 1) + 26))
        return (selection.rows.lowerBound...lastRow, selection.cols.lowerBound...lastCol)
    }

    private func flashHighlight(_ ranges: [(rows: ClosedRange<Int>, cols: ClosedRange<Int>)]) {
        highlight = ranges
        gridRevision += 1
        highlightTask?.cancel()
        highlightTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.6))
            guard !Task.isCancelled, let self else { return }
            self.highlight = []
            self.gridRevision += 1
        }
    }

    private func sendFormat(tabID: String, ranges: [String], format: CellFormat?) {
        pendingWrites += 1
        let client = client
        let botID = botID
        let sheetID = sheetID
        Task {
            defer { pendingWrites -= 1 }
            do {
                let result = try await client.formatCells(botID: botID, sheetID: sheetID, tabID: tabID, ranges: ranges, format: format)
                merge(result, tabID: tabID)
            } catch {
                failed = error.localizedDescription
            }
        }
    }

    private func write(_ writes: [(CellPosition, String)]) {
        guard let tabID, !writes.isEmpty else { return }
        for (position, input) in writes {
            let address = SheetAddress.cell(row: position.row, col: position.col)
            var cell = cells[position] ?? SheetCell(a: address, r: position.row, c: position.col, input: "", v: .null, t: nil)
            cell.input = input
            if !input.hasPrefix("=") {
                cell.v = input.isEmpty ? .null : .string(input)
                cell.t = input.isEmpty ? nil : "s"
            }
            cells[position] = cell
            pending.insert(position)
        }
        growTab(to: writes.map(\.0))
        gridRevision += 1
        pendingWrites += 1
        failed = nil
        let payload = writes.map { (address: SheetAddress.cell(row: $0.0.row, col: $0.0.col), input: $0.1) }
        let positions = writes.map(\.0)
        let client = client
        let botID = botID
        let sheetID = sheetID
        let base = sheet?.version
        Task {
            defer { pendingWrites -= 1 }
            do {
                let result = try await client.writeCells(botID: botID, sheetID: sheetID, tabID: tabID, cells: payload, baseVersion: base)
                for position in positions { pending.remove(position) }
                merge(result, tabID: tabID)
            } catch BlocksError.stale {
                for position in positions { pending.remove(position) }
                await load()
            } catch {
                for position in positions { pending.remove(position) }
                failed = tr("Não consegui salvar a célula")
                gridRevision += 1
            }
        }
    }

    private func merge(_ result: SheetWriteResult, tabID: String) {
        sheet?.version = result.version
        guard tabID == self.tabID else { return }
        for cell in result.cells {
            let position = CellPosition(row: cell.r, col: cell.c)
            if cell.input.isEmpty, cell.format == nil {
                cells[position] = nil
            } else {
                cells[position] = cell
            }
        }
        gridRevision += 1
        syncFormula()
    }

    private func growTab(to positions: [CellPosition]) {
        guard let tabID, let index = sheet?.tabs.firstIndex(where: { $0.id == tabID }) else { return }
        let maxRow = (positions.map(\.row).max() ?? 0) + 1
        let maxCol = (positions.map(\.col).max() ?? 0) + 1
        if maxRow > sheet?.tabs[index].rowCount ?? 0 { sheet?.tabs[index].rowCount = maxRow }
        if maxCol > sheet?.tabs[index].colCount ?? 0 {
            sheet?.tabs[index].colCount = maxCol
            rebuildOffsets()
            layoutRevision += 1
        }
    }

    private func syncFormula() {
        formulaText = cell(selection.anchor.row, selection.anchor.col)?.input ?? ""
    }

    private func resetTabState() {
        cells = [:]
        loadedChunks = []
        loadingChunks = []
        pending = []
        columnWidths = tab.map(Self.widths) ?? [:]
        rebuildOffsets()
        layoutRevision += 1
        gridRevision += 1
    }

    private static func widths(_ tab: SheetTab) -> [Int: CGFloat] {
        var result: [Int: CGFloat] = [:]
        for (name, width) in tab.colWidths {
            if let position = SheetAddress.parseCell(name + "1") {
                result[position.col] = CGFloat(width)
            }
        }
        return result
    }

    private func rebuildOffsets() {
        var offsets: [CGFloat] = [0]
        offsets.reserveCapacity(colCount + 1)
        var x: CGFloat = 0
        for col in 0..<colCount {
            x += width(of: col)
            offsets.append(x)
        }
        columnOffsets = offsets
    }

    private func ensureLoaded(rows: ClosedRange<Int>, cols: ClosedRange<Int>) async {
        guard let tabID else { return }
        let rowChunks = (rows.lowerBound / Self.chunkRows)...(rows.upperBound / Self.chunkRows)
        let colChunks = (cols.lowerBound / Self.chunkCols)...(cols.upperBound / Self.chunkCols)
        var missing: [CellPosition] = []
        for row in rowChunks {
            for col in colChunks {
                let chunk = CellPosition(row: row, col: col)
                if !loadedChunks.contains(chunk), !loadingChunks.contains(chunk) {
                    missing.append(chunk)
                }
            }
        }
        guard !missing.isEmpty else { return }
        for chunk in missing { loadingChunks.insert(chunk) }
        let tabRows = tab?.rowCount ?? 0
        let tabCols = tab?.colCount ?? 0
        for chunk in missing {
            let startRow = chunk.row * Self.chunkRows
            let startCol = chunk.col * Self.chunkCols
            defer { loadingChunks.remove(chunk) }
            if startRow >= max(tabRows, 1), startCol >= 0, chunk.row > 0 {
                loadedChunks.insert(chunk)
                continue
            }
            if startCol >= max(tabCols, 1), chunk.col > 0 {
                loadedChunks.insert(chunk)
                continue
            }
            let range = SheetAddress.range(rows: startRow...(startRow + Self.chunkRows - 1), cols: startCol...(startCol + Self.chunkCols - 1))
            let result: SheetRangeResult
            do {
                result = try await client.sheetRange(botID: botID, sheetID: sheetID, tabID: tabID, range: range)
            } catch {
                BlocksLog.failure("sheet range \(range)", error)
                failed = tr("Não consegui carregar a planilha.")
                continue
            }
            guard tabID == self.tabID else { continue }
            for cell in result.cells {
                let position = CellPosition(row: cell.r, col: cell.c)
                if !pending.contains(position) {
                    cells[position] = cell
                }
            }
            loadedChunks.insert(chunk)
            gridRevision += 1
        }
        syncFormula()
    }
}

enum TSV {
    static func parse(_ text: String) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var quoted = false
        var index = text.startIndex
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        index = normalized.startIndex
        while index < normalized.endIndex {
            let character = normalized[index]
            if quoted {
                if character == "\"" {
                    let next = normalized.index(after: index)
                    if next < normalized.endIndex, normalized[next] == "\"" {
                        field.append("\"")
                        index = next
                    } else {
                        quoted = false
                    }
                } else {
                    field.append(character)
                }
            } else if character == "\"", field.isEmpty {
                quoted = true
            } else if character == "\t" {
                row.append(field)
                field = ""
            } else if character == "\n" {
                row.append(field)
                rows.append(row)
                row = []
                field = ""
            } else {
                field.append(character)
            }
            index = normalized.index(after: index)
        }
        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        return rows
    }
}
