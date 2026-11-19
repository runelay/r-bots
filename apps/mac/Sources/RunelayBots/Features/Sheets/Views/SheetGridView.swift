import AppKit
import SwiftUI

final class SheetCellEditor: NSTextField {}

final class SheetGridNSView: NSView, NSTextFieldDelegate {
    weak var store: SheetEditorStore?
    private var editor: SheetCellEditor?
    private var resizing: (col: Int, startX: CGFloat, startWidth: CGFloat)?
    private var dragKind: DragKind = .none

    private enum DragKind {
        case none
        case cells
        case columns
        case rows
    }

    private let rowHeight = SheetEditorStore.rowHeight
    private let headerHeight = SheetEditorStore.headerHeight
    private let rowHeaderWidth = SheetEditorStore.rowHeaderWidth

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }

    func updateSize() {
        guard let store else { return }
        let width = rowHeaderWidth + store.contentWidth
        let height = headerHeight + CGFloat(store.rowCount) * rowHeight
        let parentWidth = enclosingScrollView?.contentSize.width ?? 0
        let parentHeight = enclosingScrollView?.contentSize.height ?? 0
        let size = NSSize(width: max(width, parentWidth), height: max(height, parentHeight))
        if frame.size != size {
            setFrameSize(size)
        }
    }

    func visibleChanged() {
        guard let store else { return }
        let visible = visibleRect
        let firstRow = max(0, Int((visible.minY) / rowHeight) - 2)
        let lastRow = min(store.rowCount - 1, Int(visible.maxY / rowHeight) + 2)
        let firstCol = store.column(at: max(0, visible.minX - rowHeaderWidth))
        let lastCol = min(store.colCount - 1, store.column(at: max(0, visible.maxX - rowHeaderWidth)) + 1)
        if lastRow >= firstRow, lastCol >= firstCol {
            store.visibleChanged(rows: firstRow...lastRow, cols: firstCol...lastCol)
        }
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
        positionEditor()
    }

    private var frozenHeight: CGFloat {
        CGFloat(store?.frozenRows ?? 0) * rowHeight
    }

    private func rowY(_ row: Int, visible: NSRect) -> CGFloat {
        let frozen = store?.frozenRows ?? 0
        if row < frozen {
            return visible.minY + headerHeight + CGFloat(row) * rowHeight
        }
        return headerHeight + CGFloat(row) * rowHeight
    }

    private func colX(_ col: Int) -> CGFloat {
        rowHeaderWidth + (store?.offset(of: col) ?? 0)
    }

    func cellRect(_ position: CellPosition) -> NSRect {
        guard let store else { return .zero }
        return NSRect(x: colX(position.col), y: rowY(position.row, visible: visibleRect), width: store.width(of: position.col), height: rowHeight)
    }

    private func position(at point: NSPoint) -> CellPosition? {
        guard let store else { return nil }
        let visible = visibleRect
        let col = store.column(at: max(0, point.x - rowHeaderWidth))
        let frozenBottom = visible.minY + headerHeight + frozenHeight
        let row: Int
        if point.y < frozenBottom, store.frozenRows > 0 {
            row = max(0, Int((point.y - visible.minY - headerHeight) / rowHeight))
        } else {
            row = Int((point.y - headerHeight) / rowHeight)
        }
        return CellPosition(row: min(max(0, row), store.rowCount - 1), col: col)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let store else { return }
        let visible = visibleRect
        let background = NSColor(Theme.background)
        let headerFill = NSColor(Theme.surface)
        let line = NSColor(Theme.paneDivider)
        let primary = NSColor(Theme.textPrimary)
        let tertiary = NSColor(Theme.textTertiary)
        let danger = NSColor(Theme.danger)
        let accent = NSColor(Theme.brandAccent)
        background.setFill()
        visible.fill()

        let firstCol = store.column(at: max(0, visible.minX - rowHeaderWidth))
        let lastCol = min(store.colCount - 1, store.column(at: max(0, visible.maxX - rowHeaderWidth)))
        let frozen = store.frozenRows
        let bodyTop = visible.minY + headerHeight + frozenHeight
        let firstRow = max(frozen, Int((bodyTop - headerHeight) / rowHeight))
        let lastRow = min(store.rowCount - 1, Int((visible.maxY - headerHeight) / rowHeight))
        let selection = store.selection

        let normalFont = NoteFonts.sans(12.5)
        let boldFont = NoteFonts.sans(12.5, weight: .semibold)
        let headerFont = NoteFonts.sans(11, weight: .medium)
        let paragraphLeft = NSMutableParagraphStyle()
        paragraphLeft.lineBreakMode = .byClipping
        let paragraphRight = NSMutableParagraphStyle()
        paragraphRight.alignment = .right
        paragraphRight.lineBreakMode = .byClipping
        let paragraphCenter = NSMutableParagraphStyle()
        paragraphCenter.alignment = .center
        paragraphCenter.lineBreakMode = .byClipping

        func drawRows(_ rows: [Int], clip: NSRect) {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: clip).addClip()
            for row in rows {
                let y = rowY(row, visible: visible)
                line.setFill()
                NSRect(x: visible.minX, y: y + rowHeight - 0.5, width: visible.width, height: 0.5).fill()
                for col in firstCol...max(firstCol, lastCol) {
                    guard let cell = store.cell(row, col) else { continue }
                    let rect = NSRect(x: colX(col), y: y, width: store.width(of: col), height: rowHeight)
                    let display = cell.input.hasPrefix("=") && store.isPending(row, col) && cell.v == .null ? "…" : CellText.display(cell.v, type: cell.t, format: cell.format)
                    guard !display.isEmpty else { continue }
                    let numeric = CellText.isNumeric(cell.v, type: cell.t)
                    let align = cell.format?.align
                    let style = align == "center" ? paragraphCenter : align == "right" || (align == nil && numeric) ? paragraphRight : align == nil && cell.t == "b" ? paragraphCenter : paragraphLeft
                    let color = cell.t == "e" ? danger : store.isPending(row, col) ? tertiary : primary
                    let font = cell.format?.bold == true || row < frozen ? boldFont : normalFont
                    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
                    let textRect = rect.insetBy(dx: 7, dy: 0)
                    let height = font.ascender - font.descender
                    (display as NSString).draw(in: NSRect(x: textRect.minX, y: rect.midY - height / 2 - 1, width: textRect.width, height: height + 2), withAttributes: attributes)
                }
            }
            var x = colX(firstCol)
            line.setFill()
            for col in firstCol...max(firstCol, lastCol) {
                x = colX(col) + store.width(of: col)
                NSRect(x: x - 0.5, y: clip.minY, width: 0.5, height: clip.height).fill()
            }
            NSGraphicsContext.restoreGraphicsState()
        }

        if lastRow >= firstRow {
            drawRows(Array(firstRow...lastRow), clip: NSRect(x: visible.minX + rowHeaderWidth, y: bodyTop, width: visible.width - rowHeaderWidth, height: visible.maxY - bodyTop))
        }
        if frozen > 0 {
            let frozenRect = NSRect(x: visible.minX + rowHeaderWidth, y: visible.minY + headerHeight, width: visible.width - rowHeaderWidth, height: frozenHeight)
            background.setFill()
            frozenRect.fill()
            drawRows(Array(0..<min(frozen, store.rowCount)), clip: frozenRect)
            NSColor(Theme.textTertiary).withAlphaComponent(0.35).setFill()
            NSRect(x: visible.minX, y: frozenRect.maxY - 1, width: visible.width, height: 1).fill()
        }

        for range in store.highlight {
            accent.withAlphaComponent(0.12).setFill()
            selectionRect(rows: range.rows, cols: range.cols, visible: visible).fill()
        }

        let selected = selectionRect(rows: selection.rows, cols: selection.cols, visible: visible)
        if !selection.isSingle {
            accent.withAlphaComponent(0.08).setFill()
            selected.fill()
        }
        accent.setStroke()
        let border = NSBezierPath(rect: selected.insetBy(dx: 1, dy: 1))
        border.lineWidth = 2
        border.stroke()
        if !selection.isSingle {
            let active = cellRect(selection.anchor)
            let activePath = NSBezierPath(rect: active.insetBy(dx: 1.5, dy: 1.5))
            activePath.lineWidth = 1
            activePath.stroke()
        }

        let header = NSRect(x: visible.minX, y: visible.minY, width: visible.width, height: headerHeight)
        headerFill.setFill()
        header.fill()
        for col in firstCol...max(firstCol, lastCol) {
            let rect = NSRect(x: colX(col), y: visible.minY, width: store.width(of: col), height: headerHeight)
            if selection.cols.contains(col) {
                accent.withAlphaComponent(0.14).setFill()
                rect.fill()
            }
            let color = selection.cols.contains(col) ? primary : tertiary
            let attributes: [NSAttributedString.Key: Any] = [.font: headerFont, .foregroundColor: color, .paragraphStyle: paragraphCenter]
            (SheetAddress.columnName(col) as NSString).draw(in: NSRect(x: rect.minX, y: rect.midY - 7, width: rect.width, height: 15), withAttributes: attributes)
            line.setFill()
            NSRect(x: rect.maxX - 0.5, y: rect.minY, width: 0.5, height: rect.height).fill()
        }

        let rowHeader = NSRect(x: visible.minX, y: visible.minY + headerHeight, width: rowHeaderWidth, height: visible.height - headerHeight)
        headerFill.setFill()
        rowHeader.fill()
        let headerRows = (0..<min(frozen, store.rowCount)).map { $0 } + (lastRow >= firstRow ? Array(firstRow...lastRow) : [])
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: rowHeader).addClip()
        for row in headerRows {
            let y = rowY(row, visible: visible)
            if row >= frozen, y < bodyTop - rowHeight { continue }
            let rect = NSRect(x: visible.minX, y: y, width: rowHeaderWidth, height: rowHeight)
            if selection.rows.contains(row) {
                accent.withAlphaComponent(0.14).setFill()
                rect.fill()
            }
            let color = selection.rows.contains(row) ? primary : tertiary
            let attributes: [NSAttributedString.Key: Any] = [.font: headerFont, .foregroundColor: color, .paragraphStyle: paragraphCenter]
            ("\(row + 1)" as NSString).draw(in: NSRect(x: rect.minX, y: rect.midY - 7, width: rect.width, height: 15), withAttributes: attributes)
        }
        NSGraphicsContext.restoreGraphicsState()
        headerFill.setFill()
        NSRect(x: visible.minX, y: visible.minY, width: rowHeaderWidth, height: headerHeight).fill()
    }

    private func selectionRect(rows: ClosedRange<Int>, cols: ClosedRange<Int>, visible: NSRect) -> NSRect {
        guard let store else { return .zero }
        let top = rowY(rows.lowerBound, visible: visible)
        let bottom = rowY(rows.upperBound, visible: visible) + rowHeight
        let left = colX(cols.lowerBound)
        let right = colX(cols.upperBound) + store.width(of: cols.upperBound)
        return NSRect(x: left, y: top, width: right - left, height: max(rowHeight, bottom - top))
    }

    override func resetCursorRects() {
        guard let store else { return }
        let visible = visibleRect
        addCursorRect(NSRect(x: visible.minX + rowHeaderWidth, y: visible.minY + headerHeight, width: visible.width - rowHeaderWidth, height: visible.height - headerHeight), cursor: .crosshair)
        addCursorRect(NSRect(x: visible.minX + rowHeaderWidth, y: visible.minY, width: visible.width - rowHeaderWidth, height: headerHeight), cursor: .pointingHand)
        addCursorRect(NSRect(x: visible.minX, y: visible.minY + headerHeight, width: rowHeaderWidth, height: visible.height - headerHeight), cursor: .pointingHand)
        let firstCol = store.column(at: max(0, visible.minX - rowHeaderWidth))
        let lastCol = min(store.colCount - 1, store.column(at: max(0, visible.maxX - rowHeaderWidth)))
        for col in firstCol...max(firstCol, lastCol) {
            let x = colX(col) + store.width(of: col)
            addCursorRect(NSRect(x: x - 4, y: visible.minY, width: 8, height: headerHeight), cursor: .resizeLeftRight)
        }
    }

    private func boundaryColumn(at point: NSPoint) -> Int? {
        guard let store, point.y < visibleRect.minY + headerHeight, point.x > visibleRect.minX + rowHeaderWidth else { return nil }
        let col = store.column(at: max(0, point.x - rowHeaderWidth))
        let right = colX(col) + store.width(of: col)
        if abs(point.x - right) <= 4 { return col }
        if col > 0, abs(point.x - colX(col)) <= 4 { return col - 1 }
        return nil
    }

    override func mouseDown(with event: NSEvent) {
        guard let store else { return }
        if editor != nil {
            commitEditor(moveRows: 0, moveCols: 0)
        }
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        let visible = visibleRect
        let extend = event.modifierFlags.contains(.shift)
        if let col = boundaryColumn(at: point) {
            resizing = (col, point.x, store.width(of: col))
            return
        }
        guard let position = position(at: point) else { return }
        if point.y < visible.minY + headerHeight, point.x > visible.minX + rowHeaderWidth {
            dragKind = .columns
            store.selectColumn(position.col, extend: extend)
        } else if point.x < visible.minX + rowHeaderWidth, point.y > visible.minY + headerHeight {
            dragKind = .rows
            store.selectRow(position.row, extend: extend)
        } else if point.x < visible.minX + rowHeaderWidth {
            store.selectAll()
        } else {
            dragKind = .cells
            if event.clickCount == 2 {
                store.select(position)
                store.beginEdit()
            } else {
                store.select(position, extend: extend)
            }
        }
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let store else { return }
        let point = convert(event.locationInWindow, from: nil)
        if let resizing {
            store.resizeColumn(resizing.col, to: resizing.startWidth + point.x - resizing.startX, final: false)
            return
        }
        autoscroll(with: event)
        guard let position = position(at: point) else { return }
        switch dragKind {
        case .cells: store.select(position, extend: true)
        case .columns: store.selectColumn(position.col, extend: true)
        case .rows: store.selectRow(position.row, extend: true)
        case .none: break
        }
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if let resizing, let store {
            let point = convert(event.locationInWindow, from: nil)
            store.resizeColumn(resizing.col, to: resizing.startWidth + point.x - resizing.startX, final: true)
        }
        resizing = nil
        dragKind = .none
    }

    override func keyDown(with event: NSEvent) {
        guard let store else { return }
        let extend = event.modifierFlags.contains(.shift)
        let command = event.modifierFlags.contains(.command)
        switch event.keyCode {
        case 123: store.move(rows: 0, cols: command ? -store.selection.cursor.col : -1, extend: extend)
        case 124: store.move(rows: 0, cols: 1, extend: extend)
        case 125: store.move(rows: 1, cols: 0, extend: extend)
        case 126: store.move(rows: command ? -store.selection.cursor.row : -1, cols: 0, extend: extend)
        case 48: store.move(rows: 0, cols: extend ? -1 : 1, extend: false)
        case 36, 76:
            if extend {
                store.move(rows: -1, cols: 0, extend: false)
            } else {
                store.beginEdit()
            }
        case 120: store.beginEdit()
        case 51, 117: store.clearSelection()
        case 53: store.select(store.selection.anchor)
        default:
            if command || event.modifierFlags.contains(.control) {
                super.keyDown(with: event)
                return
            }
            if let characters = event.characters, let scalar = characters.unicodeScalars.first, !CharacterSet.controlCharacters.contains(scalar), scalar.value < 0xF700 {
                store.beginEdit(seed: characters)
            } else {
                super.keyDown(with: event)
            }
        }
        scrollToCursor()
        needsDisplay = true
    }

    @objc func copy(_ sender: Any?) {
        store?.copySelection()
    }

    @objc func cut(_ sender: Any?) {
        store?.cutSelection()
    }

    @objc func paste(_ sender: Any?) {
        store?.paste()
    }

    override func selectAll(_ sender: Any?) {
        store?.selectAll()
        needsDisplay = true
    }

    func scrollToCursor() {
        guard let store else { return }
        var rect = cellRect(store.selection.cursor)
        rect.origin.y -= headerHeight + frozenHeight
        rect.size.height += headerHeight + frozenHeight
        rect.origin.x -= rowHeaderWidth
        rect.size.width += rowHeaderWidth
        scrollToVisible(rect)
    }

    func syncEditor() {
        guard let store else { return }
        if store.editing, editor == nil {
            let field = SheetCellEditor()
            field.isBordered = false
            field.focusRingType = .none
            field.drawsBackground = true
            field.backgroundColor = NSColor(Theme.background)
            field.textColor = NSColor(Theme.textPrimary)
            field.font = NoteFonts.sans(12.5)
            field.delegate = self
            field.cell?.usesSingleLineMode = true
            field.cell?.wraps = false
            field.cell?.isScrollable = true
            field.stringValue = store.editSeed ?? store.cell(store.selection.anchor.row, store.selection.anchor.col)?.input ?? ""
            addSubview(field)
            editor = field
            positionEditor()
            window?.makeFirstResponder(field)
            if store.editSeed != nil, let text = field.currentEditor() {
                text.selectedRange = NSRange(location: (field.stringValue as NSString).length, length: 0)
            }
        } else if !store.editing, let editor {
            editor.removeFromSuperview()
            self.editor = nil
            window?.makeFirstResponder(self)
        }
    }

    private func positionEditor() {
        guard let editor, let store else { return }
        let rect = cellRect(store.selection.anchor).insetBy(dx: 2, dy: 2)
        editor.frame = NSRect(x: rect.minX + 4, y: rect.midY - 9, width: max(rect.width - 6, 40), height: 18)
    }

    private func commitEditor(moveRows: Int, moveCols: Int) {
        guard let editor, let store else { return }
        let value = editor.stringValue
        editor.removeFromSuperview()
        self.editor = nil
        store.commitEdit(value, moveRows: moveRows, moveCols: moveCols)
        window?.makeFirstResponder(self)
        scrollToCursor()
        needsDisplay = true
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.insertNewline(_:)):
            commitEditor(moveRows: 1, moveCols: 0)
            return true
        case #selector(NSResponder.insertTab(_:)):
            commitEditor(moveRows: 0, moveCols: 1)
            return true
        case #selector(NSResponder.insertBacktab(_:)):
            commitEditor(moveRows: 0, moveCols: -1)
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            editor?.removeFromSuperview()
            editor = nil
            store?.cancelEdit()
            window?.makeFirstResponder(self)
            needsDisplay = true
            return true
        default:
            return false
        }
    }

    func controlTextDidChange(_ notification: Notification) {
        if let editor {
            store?.formulaText = editor.stringValue
        }
    }
}

struct SheetGridView: NSViewRepresentable {
    let store: SheetEditorStore

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let grid = SheetGridNSView()
        grid.store = store
        let scrollView = NSScrollView()
        scrollView.drawsBackground = true
        scrollView.backgroundColor = NSColor(Theme.background)
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.documentView = grid
        scrollView.contentView.postsBoundsChangedNotifications = true
        scrollView.postsFrameChangedNotifications = true
        context.coordinator.grid = grid
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.changed), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.changed), name: NSView.frameDidChangeNotification, object: scrollView)
        grid.updateSize()
        DispatchQueue.main.async {
            grid.updateSize()
            grid.window?.makeFirstResponder(grid)
            grid.visibleChanged()
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let grid = context.coordinator.grid else { return }
        let coordinator = context.coordinator
        if coordinator.layoutRevision != store.layoutRevision {
            coordinator.layoutRevision = store.layoutRevision
            grid.updateSize()
            grid.window?.invalidateCursorRects(for: grid)
        }
        if coordinator.gridRevision != store.gridRevision || coordinator.selection != store.selection {
            coordinator.gridRevision = store.gridRevision
            coordinator.selection = store.selection
            grid.needsDisplay = true
        }
        if coordinator.editing != store.editing {
            coordinator.editing = store.editing
            grid.syncEditor()
        }
    }

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) {
        NotificationCenter.default.removeObserver(coordinator)
    }

    @MainActor
    final class Coordinator: NSObject {
        weak var grid: SheetGridNSView?
        var gridRevision = -1
        var layoutRevision = -1
        var selection = CellSelection.origin
        var editing = false

        @objc func changed() {
            grid?.updateSize()
            grid?.visibleChanged()
        }
    }
}
