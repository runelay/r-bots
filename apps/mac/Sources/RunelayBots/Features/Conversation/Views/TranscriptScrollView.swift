import AppKit
import SwiftUI

struct TranscriptScrollMemory: Equatable {
    var anchorID: String
    var anchorOffset: CGFloat
}

enum TranscriptScrollZone: Equatable {
    case atEnd
    case near
    case away
}

struct TranscriptListRow {
    let id: String
    let content: AnyView
}

@MainActor
final class TranscriptScrollController {
    fileprivate var list: TranscriptListView?
    fileprivate var pendingRestore: TranscriptScrollMemory?

    var isPinned: Bool {
        list?.pinned ?? (pendingRestore == nil)
    }

    var memory: TranscriptScrollMemory? {
        list?.memory
    }

    func restore(_ memory: TranscriptScrollMemory) {
        if let list {
            list.restore(memory)
        } else {
            pendingRestore = memory
        }
    }

    func scrollToEnd(animated: Bool) {
        list?.scrollToEnd(animated: animated)
    }

    func noteToggle(row: String, collapsing: Bool) {
        list?.noteToggle(row: row, collapsing: collapsing)
    }
}

struct TranscriptScrollView: NSViewRepresentable {
    let controller: TranscriptScrollController
    let insets: NSEdgeInsets
    let rows: [TranscriptListRow]
    let animatesAppends: Bool
    let reduceMotion: Bool
    var onZone: (TranscriptScrollZone) -> Void
    var onNearTop: () -> Void
    var onUserScroll: () -> Void

    func makeNSView(context: Context) -> TranscriptListView {
        let view = TranscriptListView()
        controller.list = view
        if let memory = controller.pendingRestore {
            controller.pendingRestore = nil
            view.restore(memory)
        }
        apply(to: view)
        return view
    }

    func updateNSView(_ view: TranscriptListView, context: Context) {
        controller.list = view
        apply(to: view)
    }

    private func apply(to view: TranscriptListView) {
        view.callbacks = .init(zone: onZone, nearTop: onNearTop, userScroll: onUserScroll)
        view.reduceMotion = reduceMotion
        view.update(rows: rows, insets: insets, animatesAppends: animatesAppends)
    }
}

final class TranscriptListView: NSScrollView {
    struct Callbacks {
        var zone: (TranscriptScrollZone) -> Void = { _ in }
        var nearTop: () -> Void = {}
        var userScroll: () -> Void = {}
    }

    var callbacks = Callbacks()
    var reduceMotion = false
    private(set) var pinned = true
    private let document = TranscriptDocument()
    private var rows: [TranscriptListRow] = []
    private var index: [String: Int] = [:]
    private var heights: [String: CGFloat] = [:]
    private var positions: [CGFloat] = []
    private var mounted: [String: TranscriptRowHost] = [:]
    private var pool: [TranscriptRowHost] = []
    private var appearing: Set<String> = []
    private var measuredWidth: CGFloat = 0
    private var estimate: CGFloat = 160
    private var adjusting = false
    private var animating = false
    private var reflowing = false
    private var zone: TranscriptScrollZone = .atEnd
    private var lastClick = Date.distantPast
    private var animateFramesUntil = Date.distantPast
    private var reveal: (id: String, until: Date)?
    private var clickMonitor: Any?
    private var lastClipSize: CGSize = .zero
    private var pendingRestore: TranscriptScrollMemory?
    private var heldAnchor: (id: String, offset: CGFloat)?

    private static let topPadding = Spacing.l + Spacing.s

    init() {
        super.init(frame: .zero)
        drawsBackground = false
        backgroundColor = .clear
        hasVerticalScroller = true
        hasHorizontalScroller = false
        autohidesScrollers = true
        scrollerStyle = .overlay
        automaticallyAdjustsContentInsets = false
        verticalScrollElasticity = .allowed
        horizontalScrollElasticity = .none
        contentView.drawsBackground = false
        contentView.postsBoundsChangedNotifications = true
        document.onLayout = { [weak self] in
            self?.reflow()
        }
        documentView = document
        NotificationCenter.default.addObserver(self, selector: #selector(boundsChanged), name: NSView.boundsDidChangeNotification, object: contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(liveScrollStarted), name: NSScrollView.willStartLiveScrollNotification, object: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError()
    }

    @objc private func liveScrollStarted() {
        pendingRestore = nil
    }

    override func scrollWheel(with event: NSEvent) {
        pendingRestore = nil
        super.scrollWheel(with: event)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let clickMonitor {
            NSEvent.removeMonitor(clickMonitor)
            self.clickMonitor = nil
        }
        guard window != nil else { return }
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] event in
            if let self, event.window === self.window, self.bounds.contains(self.convert(event.locationInWindow, from: nil)) {
                self.lastClick = Date()
            }
            return event
        }
    }

    var memory: TranscriptScrollMemory? {
        guard !pinned, let anchor = captureAnchor() else { return nil }
        return TranscriptScrollMemory(anchorID: anchor.id, anchorOffset: anchor.offset)
    }

    var mountedRowFrames: [String: CGRect] {
        mounted.mapValues(\.view.frame)
    }

    func restore(_ memory: TranscriptScrollMemory) {
        pinned = false
        pendingRestore = memory
        document.needsLayout = true
    }

    func update(rows newRows: [TranscriptListRow], insets: NSEdgeInsets, animatesAppends: Bool) {
        if contentInsets.top != insets.top || contentInsets.bottom != insets.bottom {
            if !pinned, heldAnchor == nil {
                heldAnchor = captureAnchor()
            }
            adjust { contentInsets = insets }
        }
        if !pinned, heldAnchor == nil, rows.map(\.id) != newRows.map(\.id) {
            heldAnchor = captureAnchor()
        }
        let known = index
        rows = newRows
        index = Dictionary(newRows.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        if animatesAppends, !known.isEmpty, !reduceMotion,
           let firstKnown = newRows.firstIndex(where: { known[$0.id] != nil && !$0.id.hasPrefix("transcript-") }) {
            for row in newRows[firstKnown...] where known[row.id] == nil {
                appearing.insert(row.id)
            }
        }
        for (id, host) in mounted {
            if let position = index[id] {
                host.set(content: content(for: newRows[position]))
            }
        }
        positions = []
        positionsKey = nil
        document.needsLayout = true
    }

    private func content(for row: TranscriptListRow) -> AnyView {
        guard appearing.contains(row.id) else { return row.content }
        return AnyView(row.content.modifier(TranscriptAppear()))
    }

    override func layout() {
        super.layout()
        reflow()
    }

    private var viewportHeight: CGFloat {
        contentView.bounds.height
    }

    var maxOffset: CGFloat {
        max(-contentInsets.top, document.frame.height + contentInsets.bottom - viewportHeight)
    }

    var distanceFromBottom: CGFloat {
        max(0, maxOffset - contentView.bounds.origin.y)
    }

    private func height(of id: String) -> CGFloat {
        heights[id] ?? estimate
    }

    private var positionsKey: CGFloat?
    private var positionsHeight: CGFloat = 0

    private func computePositions() -> CGFloat {
        if positionsKey == estimate, positions.count == rows.count {
            return positionsHeight
        }
        var y = Self.topPadding
        positions = rows.map { row in
            defer { y += height(of: row.id) }
            return y
        }
        positionsKey = estimate
        positionsHeight = y
        return y
    }

    private func captureAnchor() -> (id: String, offset: CGFloat)? {
        if let heldAnchor { return heldAnchor }
        guard !rows.isEmpty else { return nil }
        if positions.count != rows.count {
            _ = computePositions()
        }
        let top = contentView.bounds.origin.y + contentInsets.top
        var low = 0
        var high = rows.count - 1
        while low < high {
            let mid = (low + high) / 2
            if positions[mid] + height(of: rows[mid].id) <= top {
                low = mid + 1
            } else {
                high = mid
            }
        }
        return (rows[low].id, positions[low] - top)
    }

    private func reflow() {
        guard !reflowing else { return }
        reflowing = true
        defer { reflowing = false }
        let width = contentView.bounds.width
        guard width > 0 else { return }
        if abs(width - measuredWidth) > 0.5 {
            if !pinned, heldAnchor == nil {
                heldAnchor = captureAnchor()
            }
            measuredWidth = width
            positionsKey = nil
            for host in mounted.values {
                host.needsMeasure = true
            }
        }
        var anchor: (id: String, offset: CGFloat)?
        if let restore = pendingRestore, index[restore.anchorID] != nil, viewportHeight > 1 {
            anchor = (restore.anchorID, restore.anchorOffset)
        } else if !pinned {
            anchor = heldAnchor ?? captureAnchor()
        }
        heldAnchor = nil
        if let held = anchor, index[held.id] == nil {
            anchor = nil
        }
        for _ in 0..<10 {
            var contentHeight = computePositions()
            let minHeight = max(0, viewportHeight - contentInsets.top - contentInsets.bottom)
            let lift = max(0, minHeight - contentHeight)
            if lift > 0 {
                positions = positions.map { $0 + lift }
                contentHeight += lift
                positionsKey = nil
            }
            let docHeight = max(contentHeight, minHeight)
            if document.frame.size != CGSize(width: width, height: docHeight) {
                document.setFrameSize(CGSize(width: width, height: docHeight))
            }
            if !animating {
                adjust {
                    if pinned {
                        moveTo(maxOffset)
                    } else if let anchor, let position = index[anchor.id].map({ positions[$0] }) {
                        moveTo(position - anchor.offset - contentInsets.top)
                    }
                }
            }
            if !mountVisible(width: width) {
                break
            }
        }
        placeMounted(width: width)
        applyReveal()
        report()
    }

    func noteToggle(row: String, collapsing: Bool) {
        if !reduceMotion {
            animateFramesUntil = Date().addingTimeInterval(0.6)
        }
        if !collapsing, pinned {
            heldAnchor = nil
            pinned = false
        }
        reveal = collapsing ? (row, Date().addingTimeInterval(0.8)) : nil
    }

    private func applyReveal() {
        guard let reveal, reveal.until > Date(), !pinned, let position = index[reveal.id], positions.count == rows.count else {
            if let reveal, reveal.until <= Date() { self.reveal = nil }
            return
        }
        let top = positions[position]
        let bottom = top + height(of: reveal.id)
        let bandTop = contentView.bounds.origin.y + contentInsets.top
        let bandHeight = viewportHeight - contentInsets.top - contentInsets.bottom
        let keep = min(bottom - top, bandHeight * 0.5, 160)
        if bottom < bandTop + keep {
            adjust { moveTo(bottom - keep - contentInsets.top) }
        }
    }

    private func firstRow(below y: CGFloat) -> Int {
        var low = 0
        var high = rows.count - 1
        while low < high {
            let mid = (low + high) / 2
            if positions[mid] + height(of: rows[mid].id) < y {
                low = mid + 1
            } else {
                high = mid
            }
        }
        return low
    }

    private func rowIndices(from top: CGFloat, to bottom: CGFloat) -> Range<Int> {
        let start = firstRow(below: top)
        var end = start
        while end < rows.count, positions[end] <= bottom {
            end += 1
        }
        return start..<end
    }

    private func mountVisible(width: CGFloat) -> Bool {
        guard !rows.isEmpty, positions.count == rows.count else {
            for host in mounted.values { recycle(host) }
            mounted = [:]
            return false
        }
        let origin = contentView.bounds.origin.y
        let screen = viewportHeight
        let required = rowIndices(from: origin - screen * 0.25, to: origin + screen * 1.25)
        let keep = rowIndices(from: origin - screen * 4, to: origin + screen * 5)
        let keepIDs = Set(keep.map { rows[$0].id })
        for (id, host) in mounted where !keepIDs.contains(id) {
            recycle(host)
            mounted[id] = nil
        }
        var changed = false
        for position in required {
            let id = rows[position].id
            let host = mounted[id] ?? mount(id)
            if host.needsMeasure || heights[id] == nil {
                host.needsMeasure = false
                let measured = host.measure(width: width)
                if abs(measured - (heights[id] ?? -1)) > 0.5 {
                    heights[id] = measured
                    changed = true
                }
            }
        }
        if changed {
            let values = heights.values
            estimate = max(60, values.reduce(0, +) / CGFloat(max(1, values.count)))
            positionsKey = nil
        }
        schedulePrefetch()
        return changed
    }

    @discardableResult
    private func mount(_ id: String) -> TranscriptRowHost {
        let host = pool.popLast() ?? TranscriptRowHost()
        host.id = id
        host.needsMeasure = true
        host.onHeight = { [weak self] id, height in
            self?.rowResized(id: id, height: height)
        }
        if let row = index[id].map({ rows[$0] }) {
            host.set(content: content(for: row))
        }
        document.addSubview(host.view)
        mounted[id] = host
        if let position = index[id], positions.count == rows.count {
            host.view.frame = CGRect(x: 0, y: positions[position], width: contentView.bounds.width, height: height(of: id))
        }
        return host
    }

    private var prefetchScheduled = false

    private func nextPrefetch() -> String? {
        guard !rows.isEmpty, positions.count == rows.count else { return nil }
        let origin = contentView.bounds.origin.y
        let screen = viewportHeight
        let zone = rowIndices(from: origin - screen * 2.5, to: origin + screen * 3.5)
        let center = origin + screen / 2
        return zone.lazy
            .map { self.rows[$0].id }
            .filter { self.mounted[$0] == nil }
            .min { abs(self.positions[self.index[$0] ?? 0] - center) < abs(self.positions[self.index[$1] ?? 0] - center) }
    }

    private func schedulePrefetch() {
        guard !prefetchScheduled, window != nil, nextPrefetch() != nil else { return }
        prefetchScheduled = true
        perform(#selector(prefetchTick), with: nil, afterDelay: 0, inModes: [.default, .eventTracking])
    }

    @objc private func prefetchTick() {
        prefetchScheduled = false
        guard let id = nextPrefetch() else { return }
        mount(id)
        schedulePrefetch()
    }

    private func placeMounted(width: CGFloat) {
        guard positions.count == rows.count else { return }
        var changes: [(NSView, CGRect)] = []
        for (id, host) in mounted {
            guard let position = index[id] else { continue }
            let frame = CGRect(x: 0, y: positions[position], width: width, height: height(of: id))
            if host.view.frame != frame {
                changes.append((host.view, frame))
            }
        }
        guard !changes.isEmpty else { return }
        guard animateFramesUntil > Date(), !reduceMotion else {
            for (view, frame) in changes { view.frame = frame }
            return
        }
        for (view, _) in changes { view.clipsToBounds = true }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.35
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
            for (view, frame) in changes { view.animator().frame = frame }
        } completionHandler: {
            MainActor.assumeIsolated {
                for (view, _) in changes { view.clipsToBounds = false }
            }
        }
    }

    private func recycle(_ host: TranscriptRowHost) {
        host.view.removeFromSuperview()
        host.onHeight = nil
        host.id = nil
        host.set(content: AnyView(EmptyView()))
        if pool.count < 12 {
            pool.append(host)
        }
    }

    private func rowResized(id: String, height: CGFloat) {
        guard mounted[id] != nil, abs((heights[id] ?? -1) - height) > 0.5 else { return }
        if pinned, Date().timeIntervalSince(lastClick) < 0.6, height > (heights[id] ?? 0) {
            pinned = false
        }
        if !pinned, heldAnchor == nil {
            heldAnchor = captureAnchor()
        }
        heights[id] = height
        mounted[id]?.needsMeasure = false
        positions = []
        positionsKey = nil
        document.needsLayout = true
    }

    func scrollToEnd(animated: Bool) {
        pinned = true
        pendingRestore = nil
        heldAnchor = nil
        reflow()
        guard animated, !reduceMotion else { return }
        let runway = min(viewportHeight * 0.6, max(0, maxOffset + contentInsets.top))
        guard runway > 1 else { return }
        let target = maxOffset
        animating = true
        adjust { moveTo(target - runway) }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.32
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
            contentView.animator().setBoundsOrigin(CGPoint(x: 0, y: target))
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.animating = false
                self.reflow()
            }
        }
    }

    private func adjust(_ body: () -> Void) {
        let was = adjusting
        adjusting = true
        body()
        adjusting = was
    }

    private func moveTo(_ y: CGFloat) {
        let clamped = min(max(y, -contentInsets.top), maxOffset)
        guard abs(contentView.bounds.origin.y - clamped) > 0.25 else { return }
        contentView.setBoundsOrigin(CGPoint(x: 0, y: clamped))
        reflectScrolledClipView(contentView)
    }

    @objc private func boundsChanged() {
        let size = contentView.bounds.size
        let resized = size != lastClipSize
        lastClipSize = size
        if adjusting || reflowing { return }
        if animating || resized || pendingRestore != nil {
            reflow()
            return
        }
        pendingRestore = nil
        heldAnchor = nil
        pinned = distanceFromBottom <= 24
        reflow()
        let nearTop = contentView.bounds.origin.y + contentInsets.top < viewportHeight
        let callbacks = callbacks
        DispatchQueue.main.async {
            callbacks.userScroll()
            if nearTop {
                callbacks.nearTop()
            }
        }
    }

    private func report() {
        let distance = distanceFromBottom
        let next: TranscriptScrollZone = pinned || distance <= 24 ? .atEnd : distance > 200 ? .away : .near
        guard next != zone else { return }
        zone = next
        let callback = callbacks.zone
        DispatchQueue.main.async {
            callback(next)
        }
    }
}

final class TranscriptDocument: NSView {
    var onLayout: (() -> Void)?

    override var isFlipped: Bool {
        true
    }

    override func layout() {
        super.layout()
        onLayout?()
    }
}

@MainActor
final class TranscriptRowHost {
    private let controller = NSHostingController(rootView: AnyView(EmptyView()))
    var id: String?
    var needsMeasure = true
    var onHeight: ((String, CGFloat) -> Void)?

    var view: NSView {
        controller.view
    }

    init() {
        controller.sizingOptions = []
        controller.view.translatesAutoresizingMaskIntoConstraints = true
    }

    func set(content: AnyView) {
        controller.rootView = AnyView(
            content
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { [weak self] height in
                    guard let self, let id = self.id else { return }
                    self.onHeight?(id, ceil(height))
                }
                .frame(maxWidth: .infinity, alignment: .top)
        )
    }

    func measure(width: CGFloat) -> CGFloat {
        let size = controller.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        return ceil(max(size.height, 1))
    }
}

private struct TranscriptAppear: ViewModifier {
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 12)
            .onAppear {
                withAnimation(Motion.spring) {
                    shown = true
                }
            }
    }
}
