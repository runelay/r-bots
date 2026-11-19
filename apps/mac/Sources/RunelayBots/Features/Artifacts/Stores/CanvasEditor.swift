import AppKit
import Foundation
import Observation
import SwiftUI

struct CanvasNode: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var text: String
    var x: Double
    var y: Double
    var w: Double
    var h: Double
    var shape: String
    var color: String?

    var rect: CGRect {
        CGRect(x: x, y: y, width: w, height: h)
    }

    var center: CGPoint {
        CGPoint(x: x + w / 2, y: y + h / 2)
    }
}

struct CanvasEdge: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var from: String
    var to: String
    var label: String?
    var style: String?

    var dashed: Bool { style == "dashed" }
}

struct CanvasGroup: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var label: String
    var nodeIds: [String]
}

struct CanvasDoc: Codable, Equatable, Sendable {
    var schema = 1
    var layout: String
    var nodes: [CanvasNode]
    var edges: [CanvasEdge]
    var groups: [CanvasGroup]?
    var version: Int?

    static let empty = CanvasDoc(layout: "diagram", nodes: [], edges: [])

    func node(_ id: String) -> CanvasNode? {
        nodes.first { $0.id == id }
    }

    var bounds: CGRect {
        nodes.reduce(CGRect.null) { $0.union($1.rect) }
    }
}

enum CanvasShapeKind: String, CaseIterable {
    case box, round, diamond, ellipse, note

    var label: String {
        switch self {
        case .box: "Caixa"
        case .round: "Etapa"
        case .diamond: "Decisão"
        case .ellipse: "Início ou fim"
        case .note: "Nota"
        }
    }

    var symbol: String {
        switch self {
        case .box: "square"
        case .round: "capsule"
        case .diamond: "diamond"
        case .ellipse: "oval"
        case .note: "note.text"
        }
    }
}

enum CanvasPalette {
    static let colors = ["blue", "green", "yellow", "red", "violet", "orange", "teal", "pink", "indigo", "grey"]

    private static let hexes: [String: (light: Int, dark: Int)] = [
        "neutral": (0x1E1E1E, 0xE9ECEF),
        "blue": (0x1971C2, 0x4DABF7),
        "green": (0x2F9E44, 0x69DB7C),
        "yellow": (0xE67700, 0xFFD43B),
        "amber": (0xF08C00, 0xFFC078),
        "red": (0xE03131, 0xFF8787),
        "violet": (0x6741D9, 0xB197FC),
        "orange": (0xE8590C, 0xFFA94D),
        "teal": (0x0C8599, 0x38D9A9),
        "pink": (0xC2255C, 0xF783AC),
        "indigo": (0x3B5BDB, 0x748FFC),
        "grey": (0x868E96, 0xADB5BD),
    ]

    static func name(_ color: String?, shape: String) -> String {
        if let color, hexes[color] != nil {
            return color
        }
        switch shape {
        case "ellipse": return "green"
        case "diamond": return "yellow"
        case "note": return "neutral"
        default: return "blue"
        }
    }

    static func label(_ name: String) -> String {
        name == "neutral" ? "Neutro" : Theme.accentName(name)
    }

    static func stroke(_ name: String) -> Color {
        let hex = hexes[name] ?? hexes["neutral"]!
        return Color.dynamic(light: Theme.rgb(hex.light), dark: Theme.rgb(hex.dark))
    }

    static func fill(_ name: String) -> Color {
        name == "neutral" ? Color.clear : stroke(name).opacity(0.16)
    }

    static func hachured(_ name: String) -> Bool {
        name != "neutral"
    }
}

enum CanvasSaveState: Equatable {
    case idle
    case pending
    case saving
    case saved
    case failed
}

@MainActor
@Observable
final class CanvasEditor {
    let ref: ArtifactRef

    private(set) var doc = CanvasDoc.empty
    private(set) var loaded = false
    private(set) var version = 0
    var selection: Set<String> = []
    var selectedEdges: Set<String> = []
    var editingNode: String?
    var editingEdge: String?
    var draft = ""
    var scale: CGFloat = 1
    var offset: CGSize = .zero
    var viewSize: CGSize = .zero
    var hoveredNode: String?
    var linking: (from: String, point: CGPoint)?
    var marquee: CGRect?
    var pointer: CGPoint?
    private(set) var saveState: CanvasSaveState = .idle
    private(set) var canUndo = false
    private(set) var canRedo = false
    private(set) var arranging = false
    private(set) var draggingNodes = false
    private(set) var panning = false

    @ObservationIgnored private let client: BotsClient
    @ObservationIgnored private var undoStack: [CanvasDoc] = []
    @ObservationIgnored private var redoStack: [CanvasDoc] = []
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var dragOrigins: [String: CGPoint]?
    @ObservationIgnored private var panOrigin: CGSize?
    @ObservationIgnored private var marqueeBase: Set<String> = []
    @ObservationIgnored private var zoomBase: CGFloat?
    @ObservationIgnored private var fitted = false
    @ObservationIgnored private var dirty = false
    @ObservationIgnored var reduceMotion = false
    @ObservationIgnored private var monitors: [Any] = []

    init(ref: ArtifactRef, client: BotsClient) {
        self.ref = ref
        self.client = client
    }

    private var animation: Animation {
        Motion.animation(reduceMotion: reduceMotion)
    }

    private var basePath: String {
        "/bots/\(ref.botID)/artifacts/\(ref.id)"
    }

    func load(version requested: Int? = nil) async {
        let path = requested.map { "\(basePath)/v/\($0).json" } ?? "\(basePath)/doc"
        guard let doc = await Self.fetch(client: client, path: path) else { return }
        apply(remote: doc, animated: loaded)
    }

    func reloadIfClean(version newer: Int) {
        guard newer > version, !dirty, saveTask == nil else { return }
        Task { await load() }
    }

    private func apply(remote: CanvasDoc, animated: Bool) {
        let ids = Set(remote.nodes.map(\.id))
        var remote = remote
        for index in remote.nodes.indices {
            let node = remote.nodes[index]
            let size = Self.size(for: node.text, shape: node.shape)
            if abs(size.width - node.w) > 1 || abs(size.height - node.h) > 1 {
                remote.nodes[index].w = size.width
                remote.nodes[index].h = size.height
                remote.nodes[index].x = (node.center.x - size.width / 2).rounded()
                remote.nodes[index].y = (node.center.y - size.height / 2).rounded()
            }
        }
        let change = {
            self.doc = remote
            self.selection = self.selection.intersection(ids)
            self.selectedEdges = self.selectedEdges.intersection(Set(remote.edges.map(\.id)))
        }
        if animated {
            withAnimation(animation, change)
        } else {
            change()
        }
        version = remote.version ?? version
        loaded = true
        if !fitted, viewSize != .zero {
            fit(animated: false)
        }
    }

    static func fetch(client: BotsClient, path: String) async -> CanvasDoc? {
        guard let request = try? client.request(path: path),
              let result = try? await URLSession.shared.data(for: request),
              (result.1 as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? JSONDecoder().decode(CanvasDoc.self, from: result.0)
    }

    func setViewSize(_ size: CGSize) {
        viewSize = size
        if loaded, !fitted, size != .zero {
            fit(animated: false)
        }
    }

    func toScreen(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x * scale + offset.width, y: point.y * scale + offset.height)
    }

    func toWorld(_ point: CGPoint) -> CGPoint {
        CGPoint(x: (point.x - offset.width) / scale, y: (point.y - offset.height) / scale)
    }

    func screenRect(_ node: CanvasNode) -> CGRect {
        CGRect(x: node.x * scale + offset.width, y: node.y * scale + offset.height, width: node.w * scale, height: node.h * scale)
    }

    func nodeAt(screen point: CGPoint) -> CanvasNode? {
        doc.nodes.last { screenRect($0).insetBy(dx: -6, dy: -6).contains(point) }
    }

    private func mutate(_ change: (inout CanvasDoc) -> Void, animated: Bool = false) {
        undoStack.append(doc)
        if undoStack.count > 200 {
            undoStack.removeFirst()
        }
        redoStack.removeAll()
        var next = doc
        change(&next)
        if animated {
            withAnimation(animation) { doc = next }
        } else {
            doc = next
        }
        refreshHistory()
        scheduleSave()
    }

    private func refreshHistory() {
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(doc)
        withAnimation(animation) { doc = previous }
        pruneSelection()
        refreshHistory()
        scheduleSave()
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(doc)
        withAnimation(animation) { doc = next }
        pruneSelection()
        refreshHistory()
        scheduleSave()
    }

    private func pruneSelection() {
        selection = selection.intersection(Set(doc.nodes.map(\.id)))
        selectedEdges = selectedEdges.intersection(Set(doc.edges.map(\.id)))
    }

    private func scheduleSave() {
        dirty = true
        saveState = .pending
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            await self?.save()
        }
    }

    func flush() {
        guard dirty else { return }
        saveTask?.cancel()
        saveTask = nil
        Task { await save() }
    }

    private func save() async {
        saveTask = nil
        guard dirty, var request = try? client.request(path: "\(basePath)/doc") else { return }
        dirty = false
        saveState = .saving
        var body = doc
        body.version = nil
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Payload: Encodable {
            let doc: CanvasDoc
            let baseVersion: Int
        }
        request.httpBody = try? JSONEncoder().encode(Payload(doc: body, baseVersion: version))
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200 {
                struct Saved: Decodable { let version: Int }
                if let saved = try? JSONDecoder().decode(Saved.self, from: data) {
                    version = saved.version
                }
                saveState = dirty ? .pending : .saved
                ArtifactCenter.shared.noteSaved(ref, version: version)
            } else if status == 409 {
                saveState = .idle
                undoStack.removeAll()
                redoStack.removeAll()
                refreshHistory()
                await load()
            } else {
                retrySave()
            }
        } catch {
            retrySave()
        }
    }

    private func retrySave() {
        dirty = true
        saveState = .failed
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await self?.save()
        }
    }

    func startMonitors() {
        guard monitors.isEmpty else { return }
        if let keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard let self, ArtifactCenter.shared.canvas === self else { return event }
            return self.handleKey(event) ? nil : event
        }) {
            monitors.append(keys)
        }
        if let wheel = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel, handler: { [weak self] event in
            guard let self, ArtifactCenter.shared.canvas === self, let pointer = self.pointer else { return event }
            let precise = event.hasPreciseScrollingDeltas
            if event.modifierFlags.contains(.command) {
                self.zoom(to: self.scale * exp(-event.scrollingDeltaY * (precise ? 0.01 : 0.08)), around: pointer)
            } else {
                let factor: CGFloat = precise ? 1 : 12
                self.scroll(dx: event.scrollingDeltaX * factor, dy: event.scrollingDeltaY * factor)
            }
            return nil
        }) {
            monitors.append(wheel)
        }
    }

    func stopMonitors() {
        for monitor in monitors {
            NSEvent.removeMonitor(monitor)
        }
        monitors.removeAll()
        pointer = nil
    }

    func select(_ id: String, extend: Bool) {
        commitEditing()
        selectedEdges.removeAll()
        if extend {
            if selection.contains(id) {
                selection.remove(id)
            } else {
                selection.insert(id)
            }
        } else {
            selection = [id]
        }
    }

    func selectEdge(_ id: String, extend: Bool) {
        commitEditing()
        if !extend {
            selection.removeAll()
            selectedEdges = [id]
        } else if selectedEdges.contains(id) {
            selectedEdges.remove(id)
        } else {
            selectedEdges.insert(id)
        }
    }

    func clearSelection() {
        commitEditing()
        selection.removeAll()
        selectedEdges.removeAll()
    }

    func selectAll() {
        selection = Set(doc.nodes.map(\.id))
    }

    func beginEditing(_ id: String) {
        guard let node = doc.node(id) else { return }
        commitEditing()
        selection = [id]
        selectedEdges.removeAll()
        draft = node.text
        editingNode = id
    }

    func beginEditingEdge(_ id: String) {
        guard let edge = doc.edges.first(where: { $0.id == id }) else { return }
        commitEditing()
        selectedEdges = [id]
        selection.removeAll()
        draft = edge.label ?? ""
        editingEdge = id
    }

    func commitEditing() {
        if let id = editingNode {
            editingNode = nil
            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            if let node = doc.node(id), node.text != text {
                mutate { doc in
                    guard let index = doc.nodes.firstIndex(where: { $0.id == id }) else { return }
                    doc.nodes[index].text = text
                    let size = Self.size(for: text, shape: doc.nodes[index].shape)
                    let center = doc.nodes[index].center
                    doc.nodes[index].w = size.width
                    doc.nodes[index].h = size.height
                    doc.nodes[index].x = center.x - doc.nodes[index].w / 2
                    doc.nodes[index].y = center.y - doc.nodes[index].h / 2
                }
            }
        }
        if let id = editingEdge {
            editingEdge = nil
            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            if let edge = doc.edges.first(where: { $0.id == id }), (edge.label ?? "") != text {
                mutate { doc in
                    guard let index = doc.edges.firstIndex(where: { $0.id == id }) else { return }
                    doc.edges[index].label = text.isEmpty ? nil : text
                }
            }
        }
    }

    func cancelEditing() {
        editingNode = nil
        editingEdge = nil
    }

    nonisolated static let textFontSize: CGFloat = 16
    nonisolated static let labelFontSize: CGFloat = 13
    nonisolated static let lineHeight: CGFloat = 24

    static func textSize(_ text: String) -> CGSize {
        let font = BrandFonts.handNSFont(textFontSize)
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        func width(_ value: String) -> CGFloat {
            ceil((value as NSString).size(withAttributes: attributes).width)
        }
        var lines: [String] = []
        for paragraph in text.components(separatedBy: "\n") {
            let words = paragraph.split(whereSeparator: \.isWhitespace).map(String.init)
            var line = ""
            for word in words {
                let candidate = line.isEmpty ? word : line + " " + word
                if !line.isEmpty, width(candidate) > 200 {
                    lines.append(line)
                    line = word
                } else {
                    line = candidate
                }
            }
            lines.append(line)
        }
        let widest = max(32, lines.map(width).max() ?? 0) + 4
        return CGSize(width: widest, height: CGFloat(max(1, lines.count)) * lineHeight)
    }

    static func size(for text: String, shape: String) -> CGSize {
        let content = textSize(text)
        var w: CGFloat
        var h: CGFloat
        switch shape {
        case "diamond":
            w = max(150, content.width * 1.5 + 48)
            h = max(100, content.height * 1.6 + 40)
        case "ellipse":
            w = max(130, content.width * 1.25 + 44)
            h = max(60, content.height * 1.25 + 24)
        default:
            w = max(120, content.width + 36)
            h = max(56, content.height + 28)
        }
        return CGSize(width: w.rounded(), height: h.rounded())
    }

    func obstacles(except ids: Set<String>) -> [CGRect] {
        doc.nodes.filter { !ids.contains($0.id) }.map { screenRect($0) }
    }

    func route(for edge: CanvasEdge) -> CanvasGeometry.Route {
        guard let from = doc.node(edge.from), let to = doc.node(edge.to) else { return .direct }
        return CanvasGeometry.route(
            from: screenRect(from),
            to: screenRect(to),
            obstacles: obstacles(except: [edge.from, edge.to]),
            lean: CanvasGeometry.lean(edge.label),
            scale: scale
        )
    }

    func labelPoint(for edge: CanvasEdge, route: CanvasGeometry.Route) -> CGPoint {
        guard let from = doc.node(edge.from), let to = doc.node(edge.to) else { return .zero }
        let curve = CanvasGeometry.curve(from: screenRect(from), to: screenRect(to), route: route)
        return CanvasGeometry.labelPoint(curve, text: editingEdge == edge.id ? draft : (edge.label ?? ""), scale: scale, obstacles: obstacles(except: []))
    }

    private func newID(_ prefix: String) -> String {
        prefix + String(UUID().uuidString.prefix(8)).lowercased()
    }

    private func freeSpot(for size: CGSize, near center: CGPoint, direction: CGVector, in doc: CanvasDoc) -> CGPoint {
        func blocked(_ point: CGPoint) -> Bool {
            let rect = CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height).insetBy(dx: -16, dy: -16)
            return doc.nodes.contains { $0.rect.intersects(rect) }
        }
        var point = center
        var step = 1
        while blocked(point), step < 40 {
            let offset = CGFloat((step + 1) / 2) * 72 * (step.isMultiple(of: 2) ? -1 : 1)
            point = CGPoint(x: center.x - direction.dy * offset, y: center.y + direction.dx * offset)
            step += 1
        }
        return point
    }

    @discardableResult
    func addNode(atScreen point: CGPoint, connectFrom source: String? = nil, edit: Bool = true) -> String {
        let id = newID("n")
        let world = toWorld(point)
        let shape = "box"
        let size = Self.size(for: "", shape: shape)
        mutate { doc in
            doc.nodes.append(CanvasNode(id: id, text: "", x: world.x - size.width / 2, y: world.y - size.height / 2, w: size.width, h: size.height, shape: shape))
            if let source {
                doc.edges.append(CanvasEdge(id: self.newID("e"), from: source, to: id))
            }
        }
        if edit {
            beginEditing(id)
            draft = ""
        }
        return id
    }

    private func direction(from parent: CanvasNode) -> CGVector {
        guard doc.layout == "mindmap" else { return CGVector(dx: 0, dy: 1) }
        let incoming = Set(doc.edges.map(\.to))
        guard let root = doc.nodes.first(where: { !incoming.contains($0.id) }), root.id != parent.id else {
            let count = doc.edges.filter { $0.from == parent.id }.count
            let angle = -Double.pi / 2 + Double(count) * 1.1
            return CGVector(dx: cos(angle), dy: sin(angle))
        }
        let dx = parent.center.x - root.center.x
        let dy = parent.center.y - root.center.y
        let length = max(1, hypot(dx, dy))
        return CGVector(dx: dx / length, dy: dy / length)
    }

    func addChild() {
        commitEditing()
        guard selection.count == 1, let parentID = selection.first, let parent = doc.node(parentID) else { return }
        let direction = direction(from: parent)
        let size = Self.size(for: "", shape: "box")
        let distance = doc.layout == "mindmap" ? 240.0 : parent.h / 2 + 88 + size.height / 2
        let target = CGPoint(x: parent.center.x + direction.dx * distance * (doc.layout == "mindmap" ? 1.25 : 1), y: parent.center.y + direction.dy * distance)
        let spot = freeSpot(for: size, near: target, direction: direction, in: doc)
        let id = newID("n")
        mutate { doc in
            doc.nodes.append(CanvasNode(id: id, text: "", x: spot.x - size.width / 2, y: spot.y - size.height / 2, w: size.width, h: size.height, shape: "box"))
            doc.edges.append(CanvasEdge(id: self.newID("e"), from: parentID, to: id))
        }
        beginEditing(id)
        draft = ""
    }

    func addSibling() {
        commitEditing()
        guard selection.count == 1, let currentID = selection.first, let current = doc.node(currentID) else { return }
        guard let link = doc.edges.first(where: { $0.to == currentID }), let parent = doc.node(link.from) else {
            let size = Self.size(for: "", shape: current.shape)
            let target = CGPoint(x: current.center.x + current.w / 2 + 48 + size.width / 2, y: current.center.y)
            let spot = freeSpot(for: size, near: target, direction: CGVector(dx: 1, dy: 0), in: doc)
            let id = newID("n")
            mutate { doc in
                doc.nodes.append(CanvasNode(id: id, text: "", x: spot.x - size.width / 2, y: spot.y - size.height / 2, w: size.width, h: size.height, shape: current.shape))
            }
            beginEditing(id)
            draft = ""
            return
        }
        let direction = direction(from: parent)
        let size = Self.size(for: "", shape: "box")
        let along = CGVector(dx: -direction.dy, dy: direction.dx)
        let gap = doc.layout == "mindmap" ? 72.0 : current.w / 2 + 48 + size.width / 2
        let target = CGPoint(x: current.center.x + along.dx * gap, y: current.center.y + along.dy * gap)
        let spot = freeSpot(for: size, near: target, direction: direction, in: doc)
        let id = newID("n")
        mutate { doc in
            doc.nodes.append(CanvasNode(id: id, text: "", x: spot.x - size.width / 2, y: spot.y - size.height / 2, w: size.width, h: size.height, shape: "box"))
            doc.edges.append(CanvasEdge(id: self.newID("e"), from: parent.id, to: id))
        }
        beginEditing(id)
        draft = ""
    }

    func connect(_ from: String, to: String) {
        guard from != to, !doc.edges.contains(where: { $0.from == from && $0.to == to }) else { return }
        mutate { doc in
            doc.edges.append(CanvasEdge(id: self.newID("e"), from: from, to: to))
        }
    }

    func finishLinking(at point: CGPoint) {
        guard let link = linking else { return }
        linking = nil
        if let target = nodeAt(screen: point) {
            connect(link.from, to: target.id)
            return
        }
        guard let source = doc.node(link.from) else { return }
        let rect = screenRect(source)
        guard hypot(point.x - rect.midX, point.y - rect.midY) > max(rect.width, rect.height) / 2 + 24 else { return }
        addNode(atScreen: point, connectFrom: link.from)
    }

    func deleteSelection() {
        guard !selection.isEmpty || !selectedEdges.isEmpty else { return }
        let nodes = selection
        let edges = selectedEdges
        mutate({ doc in
            doc.nodes.removeAll { nodes.contains($0.id) }
            doc.edges.removeAll { edges.contains($0.id) || nodes.contains($0.from) || nodes.contains($0.to) }
            if let groups = doc.groups {
                let kept = groups.map { CanvasGroup(id: $0.id, label: $0.label, nodeIds: $0.nodeIds.filter { !nodes.contains($0) }) }.filter { !$0.nodeIds.isEmpty }
                doc.groups = kept.isEmpty ? nil : kept
            }
        }, animated: true)
        selection.removeAll()
        selectedEdges.removeAll()
    }

    func duplicateSelection() {
        commitEditing()
        guard !selection.isEmpty else { return }
        var mapping: [String: String] = [:]
        for id in selection {
            mapping[id] = newID("n")
        }
        let source = doc
        mutate({ doc in
            for node in source.nodes where mapping[node.id] != nil {
                var copy = node
                copy.id = mapping[node.id]!
                copy.x += 32
                copy.y += 32
                doc.nodes.append(copy)
            }
            for edge in source.edges {
                if let from = mapping[edge.from], let to = mapping[edge.to] {
                    doc.edges.append(CanvasEdge(id: self.newID("e"), from: from, to: to, label: edge.label, style: edge.style))
                }
            }
        }, animated: true)
        selection = Set(mapping.values)
    }

    func setShape(_ shape: CanvasShapeKind) {
        let ids = selection
        guard !ids.isEmpty else { return }
        mutate({ doc in
            for index in doc.nodes.indices where ids.contains(doc.nodes[index].id) {
                let center = doc.nodes[index].center
                let size = Self.size(for: doc.nodes[index].text, shape: shape.rawValue)
                doc.nodes[index].shape = shape.rawValue
                doc.nodes[index].w = size.width
                doc.nodes[index].h = size.height
                doc.nodes[index].x = center.x - size.width / 2
                doc.nodes[index].y = center.y - size.height / 2
            }
        }, animated: true)
    }

    func setColor(_ color: String?) {
        let ids = selection
        guard !ids.isEmpty else { return }
        mutate({ doc in
            for index in doc.nodes.indices where ids.contains(doc.nodes[index].id) {
                doc.nodes[index].color = color
            }
        }, animated: true)
    }

    var targetEdges: Set<String> {
        if !selectedEdges.isEmpty {
            return selectedEdges
        }
        return Set(doc.edges.filter { selection.contains($0.from) && selection.contains($0.to) }.map(\.id))
    }

    func setEdgeStyle(dashed: Bool) {
        let ids = targetEdges
        guard !ids.isEmpty else { return }
        mutate({ doc in
            for index in doc.edges.indices where ids.contains(doc.edges[index].id) {
                doc.edges[index].style = dashed ? "dashed" : nil
            }
        }, animated: true)
    }

    var selectionShape: String? {
        let shapes = Set(doc.nodes.filter { selection.contains($0.id) }.map(\.shape))
        return shapes.count == 1 ? shapes.first : nil
    }

    var edgesDashed: Bool? {
        let ids = targetEdges
        guard !ids.isEmpty else { return nil }
        let styles = Set(doc.edges.filter { ids.contains($0.id) }.map(\.dashed))
        return styles.count == 1 ? styles.first : nil
    }

    func arrange() async {
        guard !doc.nodes.isEmpty, var request = try? client.request(path: "\(basePath)/layout") else { return }
        commitEditing()
        arranging = true
        defer { arranging = false }
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Payload: Encodable { let doc: CanvasDoc }
        var body = doc
        body.version = nil
        request.httpBody = try? JSONEncoder().encode(Payload(doc: body))
        guard let result = try? await URLSession.shared.data(for: request),
              (result.1 as? HTTPURLResponse)?.statusCode == 200,
              let arranged = try? JSONDecoder().decode(CanvasDoc.self, from: result.0)
        else { return }
        let positions = Dictionary(uniqueKeysWithValues: arranged.nodes.map { ($0.id, $0) })
        mutate({ doc in
            for index in doc.nodes.indices {
                if let placed = positions[doc.nodes[index].id] {
                    doc.nodes[index].x = placed.x
                    doc.nodes[index].y = placed.y
                }
            }
        }, animated: true)
        fit(animated: true)
    }

    func beginDrag(_ id: String) {
        guard dragOrigins == nil else { return }
        commitEditing()
        if !selection.contains(id) {
            selection = [id]
            selectedEdges.removeAll()
        }
        undoStack.append(doc)
        redoStack.removeAll()
        refreshHistory()
        dragOrigins = Dictionary(uniqueKeysWithValues: doc.nodes.filter { selection.contains($0.id) }.map { ($0.id, CGPoint(x: $0.x, y: $0.y)) })
        draggingNodes = true
    }

    func drag(by translation: CGSize) {
        guard let origins = dragOrigins else { return }
        for index in doc.nodes.indices {
            if let origin = origins[doc.nodes[index].id] {
                doc.nodes[index].x = (origin.x + translation.width / scale).rounded()
                doc.nodes[index].y = (origin.y + translation.height / scale).rounded()
            }
        }
    }

    func endDrag() {
        guard dragOrigins != nil else { return }
        dragOrigins = nil
        draggingNodes = false
        scheduleSave()
    }

    func pan(by translation: CGSize) {
        if panOrigin == nil {
            panOrigin = offset
            panning = true
        }
        guard let origin = panOrigin else { return }
        offset = CGSize(width: origin.width + translation.width, height: origin.height + translation.height)
    }

    func endPan() {
        panOrigin = nil
        panning = false
    }

    func scroll(dx: CGFloat, dy: CGFloat) {
        offset = CGSize(width: offset.width + dx, height: offset.height + dy)
    }

    func updateMarquee(from start: CGPoint, to end: CGPoint) {
        if marquee == nil {
            commitEditing()
            marqueeBase = selection
            selectedEdges.removeAll()
        }
        let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
        marquee = rect
        selection = marqueeBase.union(doc.nodes.filter { screenRect($0).intersects(rect) }.map(\.id))
    }

    func endMarquee() {
        marquee = nil
        marqueeBase = []
    }

    func zoom(to value: CGFloat, around anchor: CGPoint, animated: Bool = false) {
        let clamped = min(4, max(0.15, value))
        let world = toWorld(anchor)
        let change = {
            self.scale = clamped
            self.offset = CGSize(width: anchor.x - world.x * clamped, height: anchor.y - world.y * clamped)
        }
        if animated {
            withAnimation(animation, change)
        } else {
            change()
        }
    }

    func magnify(_ factor: CGFloat, around anchor: CGPoint) {
        if zoomBase == nil {
            zoomBase = scale
        }
        zoom(to: (zoomBase ?? scale) * factor, around: anchor)
    }

    func endMagnify() {
        zoomBase = nil
    }

    func zoomStep(_ direction: CGFloat) {
        let center = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        zoom(to: scale * (direction > 0 ? 1.25 : 0.8), around: center, animated: true)
    }

    func fit(animated: Bool) {
        guard viewSize.width > 0, viewSize.height > 0 else { return }
        fitted = true
        let bounds = doc.bounds
        guard !bounds.isNull, bounds.width > 0 else {
            offset = CGSize(width: viewSize.width / 2, height: viewSize.height / 2)
            return
        }
        let padding: CGFloat = 72
        let value = min(1.4, max(0.15, min((viewSize.width - padding * 2) / bounds.width, (viewSize.height - padding * 2 - 64) / bounds.height)))
        let change = {
            self.scale = value
            self.offset = CGSize(
                width: self.viewSize.width / 2 - bounds.midX * value,
                height: (self.viewSize.height - 64) / 2 - bounds.midY * value
            )
        }
        if animated {
            withAnimation(animation, change)
        } else {
            change()
        }
    }

    var mermaid: String {
        var lines = [doc.layout == "mindmap" ? "flowchart LR" : "flowchart TD"]
        func escape(_ text: String) -> String {
            text.replacingOccurrences(of: "\"", with: "#quot;").replacingOccurrences(of: "\n", with: "<br>")
        }
        func safe(_ id: String) -> String {
            let cleaned = id.map { $0.isLetter || $0.isNumber || $0 == "_" ? String($0) : "_" }.joined()
            return cleaned.first?.isLetter == true ? cleaned : "n_" + cleaned
        }
        for node in doc.nodes {
            let text = "\"\(escape(node.text.isEmpty ? " " : node.text))\""
            let body: String = switch node.shape {
            case "round": "(\(text))"
            case "diamond": "{\(text)}"
            case "ellipse": "([\(text)])"
            case "note": ">\(text)]"
            default: "[\(text)]"
            }
            lines.append("    \(safe(node.id))\(body)")
        }
        for edge in doc.edges {
            let arrow = edge.dashed ? "-.->" : "-->"
            let label = edge.label.map { "|\"\(escape($0))\"|" } ?? ""
            lines.append("    \(safe(edge.from)) \(arrow)\(label) \(safe(edge.to))")
        }
        for group in doc.groups ?? [] {
            lines.append("    subgraph \(safe(group.id))[\"\(escape(group.label))\"]")
            for id in group.nodeIds {
                lines.append("        \(safe(id))")
            }
            lines.append("    end")
        }
        return lines.joined(separator: "\n")
    }

    func handleKey(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let command = flags.contains(.command)
        let shift = flags.contains(.shift)
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if editingNode != nil || editingEdge != nil {
            switch event.keyCode {
            case 48:
                if editingNode != nil {
                    addChild()
                    return true
                }
                commitEditing()
                return true
            case 53:
                cancelEditing()
                return true
            default:
                return false
            }
        }
        if command {
            switch key {
            case "z":
                shift ? redo() : undo()
                return true
            case "d":
                duplicateSelection()
                return true
            case "a":
                selectAll()
                return true
            case "=", "+":
                zoomStep(1)
                return true
            case "-":
                zoomStep(-1)
                return true
            case "0":
                fit(animated: true)
                return true
            default:
                return false
            }
        }
        switch event.keyCode {
        case 51, 117:
            deleteSelection()
            return true
        case 48:
            if selection.count == 1 {
                addChild()
                return true
            }
            return false
        case 36, 76:
            if selection.count == 1 {
                addSibling()
                return true
            }
            return false
        case 53:
            if !selection.isEmpty || !selectedEdges.isEmpty {
                clearSelection()
                return true
            }
            return false
        default:
            return false
        }
    }
}
