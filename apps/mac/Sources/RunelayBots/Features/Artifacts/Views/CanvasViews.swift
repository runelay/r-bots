import AppKit
import SwiftUI

enum CanvasGeometry {
    static let space = "canvas-surface"

    struct Curve {
        let start: CGPoint
        let control1: CGPoint
        let control2: CGPoint
        let end: CGPoint

        var midpoint: CGPoint {
            point(at: 0.5)
        }

        func point(at t: CGFloat) -> CGPoint {
            let u = 1 - t
            let a = u * u * u
            let b = 3 * u * u * t
            let c = 3 * u * t * t
            let d = t * t * t
            return CGPoint(
                x: a * start.x + b * control1.x + c * control2.x + d * end.x,
                y: a * start.y + b * control1.y + c * control2.y + d * end.y
            )
        }
    }

    struct Route: Equatable {
        enum Kind: Equatable {
            case direct, right, left, below, above
        }

        var kind: Kind
        var extra: CGFloat

        static let direct = Route(kind: .direct, extra: 0)
    }

    static func horizontal(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(b.midX - a.midX) * max(a.height, 1) > abs(b.midY - a.midY) * max(a.width, 1) * 0.9
    }

    static func curve(from a: CGRect, to b: CGRect, route: Route = .direct) -> Curve {
        switch route.kind {
        case .right:
            let x = max(a.maxX, b.maxX) + route.extra
            return Curve(start: CGPoint(x: a.maxX, y: a.midY), control1: CGPoint(x: x, y: a.midY), control2: CGPoint(x: x, y: b.midY), end: CGPoint(x: b.maxX, y: b.midY))
        case .left:
            let x = min(a.minX, b.minX) - route.extra
            return Curve(start: CGPoint(x: a.minX, y: a.midY), control1: CGPoint(x: x, y: a.midY), control2: CGPoint(x: x, y: b.midY), end: CGPoint(x: b.minX, y: b.midY))
        case .below:
            let y = max(a.maxY, b.maxY) + route.extra
            return Curve(start: CGPoint(x: a.midX, y: a.maxY), control1: CGPoint(x: a.midX, y: y), control2: CGPoint(x: b.midX, y: y), end: CGPoint(x: b.midX, y: b.maxY))
        case .above:
            let y = min(a.minY, b.minY) - route.extra
            return Curve(start: CGPoint(x: a.midX, y: a.minY), control1: CGPoint(x: a.midX, y: y), control2: CGPoint(x: b.midX, y: y), end: CGPoint(x: b.midX, y: b.minY))
        case .direct:
            break
        }
        if horizontal(a, b) {
            let sign: CGFloat = b.midX >= a.midX ? 1 : -1
            let start = CGPoint(x: sign > 0 ? a.maxX : a.minX, y: a.midY)
            let end = CGPoint(x: sign > 0 ? b.minX : b.maxX, y: b.midY)
            let reach = max(abs(end.x - start.x) / 2, 24)
            return Curve(start: start, control1: CGPoint(x: start.x + sign * reach, y: start.y), control2: CGPoint(x: end.x - sign * reach, y: end.y), end: end)
        }
        let sign: CGFloat = b.midY >= a.midY ? 1 : -1
        let start = CGPoint(x: a.midX, y: sign > 0 ? a.maxY : a.minY)
        let end = CGPoint(x: b.midX, y: sign > 0 ? b.minY : b.maxY)
        let reach = max(abs(end.y - start.y) / 2, 24)
        return Curve(start: start, control1: CGPoint(x: start.x, y: start.y + sign * reach), control2: CGPoint(x: end.x, y: end.y - sign * reach), end: end)
    }

    static func lean(_ label: String?) -> Int {
        let text = (label ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        guard !text.isEmpty else { return 0 }
        let first = text.split(whereSeparator: { !$0.isLetter }).first.map(String.init) ?? text
        if ["sim", "yes", "ok", "s", "aprovado", "aprova", "verdadeiro", "true"].contains(first) {
            return -1
        }
        if ["não", "nao", "no", "n", "recusado", "recusa", "falso", "false"].contains(first) {
            return 1
        }
        return 0
    }

    private static func hits(_ curve: Curve, obstacles: [CGRect], margin: CGFloat) -> Int {
        var count = 0
        for index in 1..<24 {
            let point = curve.point(at: CGFloat(index) / 24)
            if obstacles.contains(where: { $0.insetBy(dx: -margin, dy: -margin).contains(point) }) {
                count += 1
            }
        }
        return count
    }

    private static func extra(_ kind: Route.Kind, a: CGRect, b: CGRect, obstacles: [CGRect], scale: CGFloat) -> CGFloat {
        let base = 36 * scale
        let margin = 16 * scale
        switch kind {
        case .right, .left:
            let low = min(a.midY, b.midY)
            let high = max(a.midY, b.midY)
            let band = obstacles.filter { $0.maxY > low && $0.minY < high }
            if kind == .right {
                let edge = max(a.maxX, b.maxX)
                let reach = (band.map(\.maxX).max() ?? edge) + margin - edge
                return max(base, reach / 0.75)
            }
            let edge = min(a.minX, b.minX)
            let reach = edge - ((band.map(\.minX).min() ?? edge) - margin)
            return max(base, reach / 0.75)
        case .below, .above:
            let low = min(a.midX, b.midX)
            let high = max(a.midX, b.midX)
            let band = obstacles.filter { $0.maxX > low && $0.minX < high }
            if kind == .below {
                let edge = max(a.maxY, b.maxY)
                let reach = (band.map(\.maxY).max() ?? edge) + margin - edge
                return max(base, reach / 0.75)
            }
            let edge = min(a.minY, b.minY)
            let reach = edge - ((band.map(\.minY).min() ?? edge) - margin)
            return max(base, reach / 0.75)
        case .direct:
            return 0
        }
    }

    static func route(from a: CGRect, to b: CGRect, obstacles: [CGRect], lean: Int, scale: CGFloat) -> Route {
        let kinds: [Route.Kind]
        if horizontal(a, b) {
            kinds = [.direct, .below, .above]
        } else if lean > 0 {
            kinds = [.right, .direct, .left]
        } else if lean < 0 {
            kinds = [.direct, .left, .right]
        } else {
            kinds = [.direct, .right, .left]
        }
        var best = Route.direct
        var fewest = Int.max
        for kind in kinds {
            let route = Route(kind: kind, extra: extra(kind, a: a, b: b, obstacles: obstacles, scale: scale))
            let count = hits(curve(from: a, to: b, route: route), obstacles: obstacles, margin: 6 * scale)
            if count == 0 {
                return route
            }
            if count < fewest {
                fewest = count
                best = route
            }
        }
        return best
    }

    static func labelSize(_ text: String, scale: CGFloat) -> CGSize {
        let font = BrandFonts.handNSFont(CanvasEditor.labelFontSize)
        let width = (text as NSString).size(withAttributes: [.font: font]).width
        return CGSize(width: (width + 18) * scale, height: 22 * scale)
    }

    static func labelPoint(_ curve: Curve, text: String, scale: CGFloat, obstacles: [CGRect]) -> CGPoint {
        guard !text.isEmpty else { return curve.midpoint }
        let size = labelSize(text, scale: scale)
        for t in [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8] as [CGFloat] {
            let point = curve.point(at: t)
            let rect = CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height)
            if !obstacles.contains(where: { $0.insetBy(dx: -3 * scale, dy: -3 * scale).intersects(rect) }) {
                return point
            }
        }
        return curve.midpoint
    }

    static func shape(_ name: String, scale: CGFloat) -> AnyShape {
        switch name {
        case "round": AnyShape(RoundedRectangle(cornerRadius: 22 * scale, style: .continuous))
        case "diamond": AnyShape(CanvasDiamond(radius: 6 * scale))
        case "ellipse": AnyShape(Ellipse())
        case "note": AnyShape(RoundedRectangle(cornerRadius: 3 * scale, style: .continuous))
        default: AnyShape(RoundedRectangle(cornerRadius: 10 * scale, style: .continuous))
        }
    }

    static func textInset(_ shape: String, size: CGSize) -> CGSize {
        switch shape {
        case "diamond": CGSize(width: size.width * 0.17, height: size.height * 0.2)
        case "ellipse": CGSize(width: size.width * 0.1, height: size.height * 0.1)
        default: CGSize(width: 16, height: 10)
        }
    }

    static func amplitude(_ scale: CGFloat) -> CGFloat {
        min(2.4, max(0.5, 1.1 * scale))
    }
}

struct CanvasDiamond: Shape {
    var radius: CGFloat = 8

    func path(in rect: CGRect) -> Path {
        let top = CGPoint(x: rect.midX, y: rect.minY)
        let right = CGPoint(x: rect.maxX, y: rect.midY)
        let bottom = CGPoint(x: rect.midX, y: rect.maxY)
        let left = CGPoint(x: rect.minX, y: rect.midY)
        var path = Path()
        path.move(to: CGPoint(x: (left.x + top.x) / 2, y: (left.y + top.y) / 2))
        path.addArc(tangent1End: top, tangent2End: right, radius: radius)
        path.addArc(tangent1End: right, tangent2End: bottom, radius: radius)
        path.addArc(tangent1End: bottom, tangent2End: left, radius: radius)
        path.addArc(tangent1End: left, tangent2End: top, radius: radius)
        path.closeSubpath()
        return path
    }
}

struct CanvasRoughOutline: Shape {
    var kind: String
    var seed: UInt64
    var scale: CGFloat

    func path(in rect: CGRect) -> Path {
        CanvasRough.outline(CanvasGeometry.shape(kind, scale: scale).path(in: rect), seed: seed, amplitude: CanvasGeometry.amplitude(scale))
    }
}

struct CanvasHachure: Shape {
    var seed: UInt64
    var scale: CGFloat

    func path(in rect: CGRect) -> Path {
        CanvasRough.hachure(in: rect, spacing: max(5, 9 * scale), seed: seed, amplitude: CanvasGeometry.amplitude(scale))
    }
}

struct CanvasEdgeCurve: Shape {
    var from: CGRect
    var to: CGRect
    var route: CanvasGeometry.Route = .direct
    var seed: UInt64 = 0
    var rough: CGFloat = 0

    var animatableData: AnimatablePair<CGRect.AnimatableData, CGRect.AnimatableData> {
        get { AnimatablePair(from.animatableData, to.animatableData) }
        set {
            from.animatableData = newValue.first
            to.animatableData = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        let curve = CanvasGeometry.curve(from: from, to: to, route: route)
        return rough > 0 ? CanvasRough.line(curve, seed: seed, amplitude: rough) : CanvasGeometry.path(curve)
    }
}

struct CanvasArrowHead: Shape {
    var from: CGRect
    var to: CGRect
    var route: CanvasGeometry.Route = .direct
    var size: CGFloat
    var seed: UInt64 = 0
    var rough: CGFloat = 0

    var animatableData: AnimatablePair<CGRect.AnimatableData, CGRect.AnimatableData> {
        get { AnimatablePair(from.animatableData, to.animatableData) }
        set {
            from.animatableData = newValue.first
            to.animatableData = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        CanvasRough.arrowHead(CanvasGeometry.curve(from: from, to: to, route: route), size: size, seed: seed, amplitude: rough)
    }
}

extension CanvasGeometry {
    static func path(_ curve: Curve) -> Path {
        var path = Path()
        path.move(to: curve.start)
        path.addCurve(to: curve.end, control1: curve.control1, control2: curve.control2)
        return path
    }
}

struct CanvasEditorView: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let editor: CanvasEditor

    @State private var marqueeDrag: Bool?

    var body: some View {
        ZStack(alignment: .topLeading) {
            surface
            groups
            ForEach(editor.doc.edges) { edge in
                if let from = editor.doc.node(edge.from), let to = editor.doc.node(edge.to) {
                    CanvasEdgeView(editor: editor, edge: edge, from: editor.screenRect(from), to: editor.screenRect(to))
                }
            }
            linkPreview
            ForEach(editor.doc.nodes) { node in
                CanvasNodeView(editor: editor, node: node)
            }
            ForEach(editor.doc.edges) { edge in
                if editor.doc.node(edge.from) != nil, editor.doc.node(edge.to) != nil {
                    CanvasEdgeLabel(editor: editor, edge: edge)
                }
            }
            if let marquee = editor.marquee {
                Rectangle()
                    .fill(Theme.brandAccent.opacity(0.1))
                    .frame(width: marquee.width, height: marquee.height)
                    .offset(x: marquee.minX, y: marquee.minY)
                    .allowsHitTesting(false)
            }
            if editor.loaded && editor.doc.nodes.isEmpty {
                Text("Duplo clique para criar uma caixa")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .coordinateSpace(.named(CanvasGeometry.space))
        .clipped()
        .simultaneousGesture(
            MagnifyGesture()
                .onChanged { value in
                    editor.magnify(value.magnification, around: value.startLocation)
                }
                .onEnded { _ in
                    editor.endMagnify()
                }
        )
        .onContinuousHover(coordinateSpace: .named(CanvasGeometry.space)) { phase in
            switch phase {
            case .active(let point):
                editor.pointer = point
            case .ended:
                editor.pointer = nil
            }
        }
        .onGeometryChange(for: CGSize.self) { proxy in
            proxy.size
        } action: { size in
            editor.setViewSize(size)
        }
        .overlay(alignment: .bottom) {
            CanvasToolbar(editor: editor)
                .padding(.bottom, Spacing.l)
        }
        .overlay(alignment: .topTrailing) {
            CanvasSaveBadge(state: editor.saveState)
                .padding(Spacing.m)
        }
        .onAppear {
            editor.reduceMotion = reduceMotion
            editor.startMonitors()
        }
        .onDisappear {
            editor.stopMonitors()
            editor.flush()
        }
    }

    private var surface: some View {
        CanvasDotGrid(scale: editor.scale, offset: editor.offset)
            .background(Theme.background)
            .contentShape(Rectangle())
            .pointerStyle(editor.panning ? .grabActive : nil)
            .gesture(
                DragGesture(minimumDistance: 3, coordinateSpace: .named(CanvasGeometry.space))
                    .onChanged { value in
                        if marqueeDrag == nil {
                            marqueeDrag = NSEvent.modifierFlags.contains(.shift)
                        }
                        if marqueeDrag == true {
                            editor.updateMarquee(from: value.startLocation, to: value.location)
                        } else {
                            editor.pan(by: value.translation)
                        }
                    }
                    .onEnded { _ in
                        if marqueeDrag == true {
                            editor.endMarquee()
                        } else {
                            editor.endPan()
                        }
                        marqueeDrag = nil
                    }
            )
            .onTapGesture(count: 2, coordinateSpace: .named(CanvasGeometry.space)) { point in
                editor.addNode(atScreen: point)
            }
            .onTapGesture {
                editor.clearSelection()
            }
    }

    private var groups: some View {
        ForEach(editor.doc.groups ?? []) { group in
            let rects = group.nodeIds.compactMap { editor.doc.node($0) }.map { editor.screenRect($0) }
            if let first = rects.first {
                let box = rects.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: -20 * editor.scale, dy: -20 * editor.scale)
                let frame = CGRect(x: box.minX, y: box.minY - 22 * editor.scale, width: box.width, height: box.height + 22 * editor.scale)
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 18 * editor.scale, style: .continuous)
                        .fill(Theme.hover)
                    Text(group.label)
                        .font(BrandFonts.hand(max(9, 14 * editor.scale)))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .padding(.horizontal, 14 * editor.scale)
                        .padding(.top, 8 * editor.scale)
                }
                .frame(width: frame.width, height: frame.height)
                .position(x: frame.midX, y: frame.midY)
                .allowsHitTesting(false)
            }
        }
    }

    @ViewBuilder
    private var linkPreview: some View {
        if let link = editor.linking, let source = editor.doc.node(link.from) {
            let target = editor.nodeAt(screen: link.point).map { editor.screenRect($0) } ?? CGRect(origin: link.point, size: .zero)
            CanvasEdgeCurve(from: editor.screenRect(source), to: target)
                .stroke(Theme.brandAccent, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [6, 5]))
                .allowsHitTesting(false)
        }
    }
}

struct CanvasDotGrid: View {
    let scale: CGFloat
    let offset: CGSize

    var body: some View {
        Canvas { context, size in
            var spacing = 24 * scale
            while spacing < 14 {
                spacing *= 2
            }
            let radius = max(0.6, min(1.3, 1.1 * scale))
            let startX = offset.width.truncatingRemainder(dividingBy: spacing) - spacing
            let startY = offset.height.truncatingRemainder(dividingBy: spacing) - spacing
            var dots = Path()
            var y = startY
            while y < size.height + spacing {
                var x = startX
                while x < size.width + spacing {
                    dots.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
                    x += spacing
                }
                y += spacing
            }
            context.fill(dots, with: .color(Theme.textTertiary.opacity(0.28)))
        }
    }
}

struct CanvasNodeView: View {
    @Bindable var editor: CanvasEditor
    let node: CanvasNode

    @Environment(\.appReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool
    @State private var hovering = false
    @State private var appeared = false

    var body: some View {
        let rect = editor.screenRect(node)
        let scale = editor.scale
        let selected = editor.selection.contains(node.id)
        let editing = editor.editingNode == node.id
        let shape = CanvasGeometry.shape(node.shape, scale: scale)
        let inset = CanvasGeometry.textInset(node.shape, size: CGSize(width: node.w, height: node.h))
        let color = CanvasPalette.name(node.color, shape: node.shape)
        let seed = CanvasRough.seed(node.id)
        ZStack {
            shape.fill(CanvasPalette.fill(color))
            if CanvasPalette.hachured(color) {
                CanvasHachure(seed: seed, scale: scale)
                    .stroke(CanvasPalette.stroke(color).opacity(0.38), style: StrokeStyle(lineWidth: max(0.6, 1 * scale), lineCap: .round))
                    .clipShape(shape)
            }
            CanvasRoughOutline(kind: node.shape, seed: seed, scale: scale)
                .stroke(CanvasPalette.stroke(color), style: StrokeStyle(lineWidth: max(0.9, 1.6 * scale), lineCap: .round, lineJoin: .round))
            Group {
                if editing {
                    TextField("", text: $editor.draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .pointerStyle(.horizontalText)
                        .focused($focused)
                        .onSubmit {
                            editor.commitEditing()
                        }
                        .onAppear {
                            focused = true
                        }
                        .onChange(of: focused) { _, now in
                            if !now, editor.editingNode == node.id {
                                editor.commitEditing()
                            }
                        }
                } else {
                    Text(node.text.isEmpty ? " " : node.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(BrandFonts.hand(CanvasEditor.textFontSize * scale))
            .foregroundStyle(Theme.textPrimary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, inset.width * scale)
            .padding(.vertical, inset.height * scale)
        }
        .frame(width: rect.width, height: rect.height)
        .contentShape(shape)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 6 * scale, style: .continuous)
                    .stroke(Theme.brandAccent, style: StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
                    .padding(-7 * scale)
            }
        }
        .overlay {
            if (hovering || selected) && !editing && editor.linking == nil && editor.marquee == nil {
                handles(size: rect.size)
                    .transition(.opacity)
            }
        }
        .pointerStyle(editing ? .horizontalText : editor.draggingNodes ? .grabActive : .grabIdle)
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .gesture(
            DragGesture(minimumDistance: 3, coordinateSpace: .named(CanvasGeometry.space))
                .onChanged { value in
                    editor.beginDrag(node.id)
                    editor.drag(by: value.translation)
                }
                .onEnded { _ in
                    editor.endDrag()
                }
        )
        .onTapGesture(count: 2) {
            editor.beginEditing(node.id)
        }
        .onTapGesture {
            editor.select(node.id, extend: NSEvent.modifierFlags.contains(.shift))
        }
        .scaleEffect(appeared || reduceMotion ? 1 : 0.5)
        .opacity(appeared ? 1 : 0)
        .onAppear {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                appeared = true
            }
        }
        .position(x: rect.midX, y: rect.midY)
    }

    private func handles(size: CGSize) -> some View {
        let points = [
            CGPoint(x: size.width / 2, y: 0),
            CGPoint(x: size.width, y: size.height / 2),
            CGPoint(x: size.width / 2, y: size.height),
            CGPoint(x: 0, y: size.height / 2),
        ]
        return ZStack {
            ForEach(points.indices, id: \.self) { index in
                CanvasHandle(editor: editor, nodeID: node.id, hovering: $hovering)
                    .position(points[index])
            }
        }
        .frame(width: size.width, height: size.height)
    }
}

struct CanvasHandle: View {
    let editor: CanvasEditor
    let nodeID: String
    @Binding var hovering: Bool

    @State private var over = false

    var body: some View {
        Circle()
            .fill(Theme.brandAccent)
            .frame(width: over ? 12 : 9, height: over ? 12 : 9)
            .frame(width: 22, height: 22)
            .contentShape(Circle())
            .onHover { inside in
                over = inside
                if inside {
                    hovering = true
                }
            }
            .springAnimation(value: over)
            .pointerStyle(.rectSelection)
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .named(CanvasGeometry.space))
                    .onChanged { value in
                        editor.linking = (from: nodeID, point: value.location)
                    }
                    .onEnded { value in
                        editor.finishLinking(at: value.location)
                    }
            )
            .help("Arraste até outra caixa para conectar")
    }
}

struct CanvasEdgeView: View {
    let editor: CanvasEditor
    let edge: CanvasEdge
    let from: CGRect
    let to: CGRect

    var body: some View {
        let scale = editor.scale
        let selected = editor.selectedEdges.contains(edge.id)
        let color = selected ? Theme.brandAccent : CanvasPalette.stroke("neutral").opacity(0.85)
        let route = editor.route(for: edge)
        let seed = CanvasRough.seed(edge.id)
        let rough = CanvasGeometry.amplitude(scale) * 0.8
        let width = max(0.9, (selected ? 2.2 : 1.6) * scale)
        ZStack {
            CanvasEdgeCurve(from: from, to: to, route: route, seed: seed, rough: edge.dashed ? 0 : rough)
                .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: edge.dashed ? [7 * scale, 6 * scale] : []))
            CanvasArrowHead(from: from, to: to, route: route, size: max(6, 12 * scale), seed: seed, rough: rough)
                .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
        }
        .contentShape(CanvasEdgeCurve(from: from, to: to, route: route).stroke(lineWidth: 14))
        .clickable()
        .onTapGesture(count: 2) {
            editor.beginEditingEdge(edge.id)
        }
        .onTapGesture {
            editor.selectEdge(edge.id, extend: NSEvent.modifierFlags.contains(.shift))
        }
    }
}

struct CanvasEdgeLabel: View {
    @Bindable var editor: CanvasEditor
    let edge: CanvasEdge

    @FocusState private var focused: Bool

    var body: some View {
        let scale = editor.scale
        let editing = editor.editingEdge == edge.id
        let point = editor.labelPoint(for: edge, route: editor.route(for: edge))
        Group {
            if editing {
                TextField("Rótulo", text: $editor.draft)
                    .textFieldStyle(.plain)
                    .pointerStyle(.horizontalText)
                    .multilineTextAlignment(.center)
                    .focused($focused)
                    .frame(width: 140 * max(scale, 0.6))
                    .onSubmit {
                        editor.commitEditing()
                    }
                    .onAppear {
                        focused = true
                    }
                    .onChange(of: focused) { _, now in
                        if !now, editor.editingEdge == edge.id {
                            editor.commitEditing()
                        }
                    }
            } else if let label = edge.label, !label.isEmpty {
                Text(label)
                    .lineLimit(1)
                    .fixedSize()
                    .clickable()
                    .onTapGesture(count: 2) {
                        editor.beginEditingEdge(edge.id)
                    }
                    .onTapGesture {
                        editor.selectEdge(edge.id, extend: NSEvent.modifierFlags.contains(.shift))
                    }
            }
        }
        .font(BrandFonts.hand(CanvasEditor.labelFontSize * scale))
        .foregroundStyle(editor.selectedEdges.contains(edge.id) ? Theme.brandText : Theme.textSecondary)
        .padding(.horizontal, 9 * scale)
        .padding(.vertical, 3 * scale)
        .background(Theme.background, in: Capsule())
        .opacity(editing || !(edge.label ?? "").isEmpty ? 1 : 0)
        .position(point)
    }
}

struct CanvasSaveBadge: View {
    let state: CanvasSaveState

    var body: some View {
        Text(text)
            .font(TypeScale.caption)
            .foregroundStyle(state == .failed ? Theme.warning : Theme.textTertiary)
            .opacity(text.isEmpty ? 0 : 1)
            .contentTransition(.opacity)
            .springAnimation(value: state)
            .allowsHitTesting(false)
    }

    private var text: String {
        switch state {
        case .idle: ""
        case .pending, .saving: "Salvando…"
        case .saved: "Salvo"
        case .failed: "Sem conexão, tentando de novo"
        }
    }
}

struct CanvasToolbar: View {
    let editor: CanvasEditor

    var body: some View {
        let hasNodes = !editor.selection.isEmpty
        let hasEdges = !editor.targetEdges.isEmpty
        HStack(spacing: Spacing.xxs) {
            GlassMenuButton(help: "Forma", items: {
                CanvasShapeKind.allCases.map { kind in
                    GlassMenuItem(kind.label, systemImage: kind.symbol, isOn: editor.selectionShape == kind.rawValue) {
                        editor.setShape(kind)
                    }
                }
            }) { _ in
                CanvasToolIcon(systemImage: CanvasShapeKind(rawValue: editor.selectionShape ?? "box")?.symbol ?? "square")
            }
            .disabled(!hasNodes)
            .opacity(hasNodes ? 1 : 0.4)

            GlassMenuButton(help: "Cor", items: {
                [GlassMenuItem("Cor da forma", systemImage: "circle.dashed") { editor.setColor(nil) }]
                    + (["neutral"] + CanvasPalette.colors).map { name in
                        GlassMenuItem(CanvasPalette.label(name), id: name, leading: AnyView(Image(nsImage: Self.swatch(name)))) {
                            editor.setColor(name)
                        }
                    }
            }) { _ in
                CanvasToolIcon(systemImage: "circle.lefthalf.filled")
            }
            .disabled(!hasNodes)
            .opacity(hasNodes ? 1 : 0.4)

            CanvasToolButton(systemImage: editor.edgesDashed == true ? "line.diagonal" : "ellipsis", help: editor.edgesDashed == true ? "Linha contínua" : "Linha tracejada") {
                editor.setEdgeStyle(dashed: editor.edgesDashed != true)
            }
            .disabled(!hasEdges)
            .opacity(hasEdges ? 1 : 0.4)

            separator

            Button {
                Task { await editor.arrange() }
            } label: {
                HStack(spacing: Spacing.xs) {
                    if editor.arranging {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "wand.and.sparkles")
                            .font(.system(size: 12, weight: .medium))
                    }
                    Text("Organizar")
                        .font(TypeScale.captionStrong)
                }
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, Spacing.m)
                .frame(height: 30)
                .contentShape(Capsule())
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(editor.doc.nodes.isEmpty || editor.arranging)
            .help("Reorganizar o canvas")

            separator

            CanvasToolButton(systemImage: "minus", help: "Diminuir zoom (⌘−)") {
                editor.zoomStep(-1)
            }
            Button {
                editor.fit(animated: true)
            } label: {
                Text("\(Int((editor.scale * 100).rounded()))%")
                    .font(TypeScale.counter)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 44, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Ajustar à tela (⌘0)")
            CanvasToolButton(systemImage: "plus", help: "Aumentar zoom (⌘+)") {
                editor.zoomStep(1)
            }
        }
        .padding(Spacing.xs)
        .glassSurface(Capsule(), fallback: Theme.surfaceRaised)
        .softElevation(lifted: true)
    }

    private var separator: some View {
        Circle()
            .fill(Theme.textTertiary.opacity(0.5))
            .frame(width: 3, height: 3)
            .padding(.horizontal, Spacing.xs)
    }

    private static func swatch(_ name: String) -> NSImage {
        let color = NSColor(CanvasPalette.stroke(name))
        return NSImage(size: NSSize(width: 12, height: 12), flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
    }
}

struct CanvasToolIcon: View {
    let systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Theme.textPrimary)
            .frame(width: 30, height: 30)
            .contentShape(Circle())
    }
}

struct CanvasToolButton: View {
    let systemImage: String
    let help: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            CanvasToolIcon(systemImage: systemImage)
                .background(hovering ? Theme.hover : Color.clear, in: Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct CanvasSnapshot: View {
    let doc: CanvasDoc
    var padding: CGFloat = 48
    var background: Color = Theme.surfaceRaised

    var body: some View {
        Canvas { context, size in
            let bounds = doc.bounds
            guard !bounds.isNull, bounds.width > 0, bounds.height > 0 else { return }
            let scale = min((size.width - padding * 2) / bounds.width, (size.height - padding * 2) / bounds.height)
            context.translateBy(x: size.width / 2 - bounds.midX * scale, y: size.height / 2 - bounds.midY * scale)
            context.scaleBy(x: scale, y: scale)
            let stroke = StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)
            for group in doc.groups ?? [] {
                let rects = group.nodeIds.compactMap { doc.node($0)?.rect }
                guard let first = rects.first else { continue }
                let box = rects.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: -20, dy: -20)
                context.fill(Path(roundedRect: CGRect(x: box.minX, y: box.minY - 22, width: box.width, height: box.height + 22), cornerRadius: 18), with: .color(Theme.hover))
                if let label = context.resolveSymbol(id: "g-\(group.id)") {
                    context.draw(label, at: CGPoint(x: box.minX + 14, y: box.minY - 12), anchor: .leading)
                }
            }
            var labels: [(String, CGPoint)] = []
            for edge in doc.edges {
                guard let from = doc.node(edge.from), let to = doc.node(edge.to) else { continue }
                let obstacles = doc.nodes.filter { $0.id != from.id && $0.id != to.id }.map(\.rect)
                let route = CanvasGeometry.route(from: from.rect, to: to.rect, obstacles: obstacles, lean: CanvasGeometry.lean(edge.label), scale: 1)
                let curve = CanvasGeometry.curve(from: from.rect, to: to.rect, route: route)
                let seed = CanvasRough.seed(edge.id)
                let color = GraphicsContext.Shading.color(CanvasPalette.stroke("neutral").opacity(0.85))
                if edge.dashed {
                    context.stroke(CanvasGeometry.path(curve), with: color, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [7, 6]))
                } else {
                    context.stroke(CanvasRough.line(curve, seed: seed, amplitude: 0.9), with: color, style: stroke)
                }
                context.stroke(CanvasRough.arrowHead(curve, size: 12, seed: seed, amplitude: 0.9), with: color, style: stroke)
                if let label = edge.label, !label.isEmpty {
                    labels.append((edge.id, CanvasGeometry.labelPoint(curve, text: label, scale: 1, obstacles: doc.nodes.map(\.rect))))
                }
            }
            for node in doc.nodes {
                let base = CanvasGeometry.shape(node.shape, scale: 1).path(in: node.rect)
                let color = CanvasPalette.name(node.color, shape: node.shape)
                let seed = CanvasRough.seed(node.id)
                context.fill(base, with: .color(CanvasPalette.fill(color)))
                if CanvasPalette.hachured(color) {
                    context.drawLayer { layer in
                        layer.clip(to: base)
                        layer.stroke(CanvasRough.hachure(in: node.rect, spacing: 9, seed: seed, amplitude: 1), with: .color(CanvasPalette.stroke(color).opacity(0.38)), style: StrokeStyle(lineWidth: 1, lineCap: .round))
                    }
                }
                context.stroke(CanvasRough.outline(base, seed: seed, amplitude: 1.1), with: .color(CanvasPalette.stroke(color)), style: stroke)
                if let text = context.resolveSymbol(id: "n-\(node.id)") {
                    context.draw(text, at: node.center, anchor: .center)
                }
            }
            for (id, point) in labels {
                if let symbol = context.resolveSymbol(id: "e-\(id)") {
                    context.draw(symbol, at: point, anchor: .center)
                }
            }
        } symbols: {
            ForEach(doc.nodes) { node in
                let inset = CanvasGeometry.textInset(node.shape, size: CGSize(width: node.w, height: node.h))
                Text(node.text)
                    .font(BrandFonts.hand(CanvasEditor.textFontSize))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.center)
                    .frame(width: max(10, node.w - inset.width * 2), height: max(10, node.h - inset.height * 2))
                    .tag("n-\(node.id)")
            }
            ForEach(doc.edges) { edge in
                Text(edge.label ?? "")
                    .font(BrandFonts.hand(CanvasEditor.labelFontSize))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize()
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
                    .background(background, in: Capsule())
                    .tag("e-\(edge.id)")
            }
            ForEach(doc.groups ?? []) { group in
                Text(group.label)
                    .font(BrandFonts.hand(14))
                    .foregroundStyle(Theme.textSecondary)
                    .tag("g-\(group.id)")
            }
        }
        .background(background)
    }
}

struct CanvasThumbnail: View {
    @Environment(AppModel.self) private var model
    let ref: ArtifactRef
    var width: CGFloat = 320

    @State private var doc: CanvasDoc?

    private var center: ArtifactCenter { .shared }

    var body: some View {
        ZStack {
            Theme.surfaceRaised
            if let doc {
                CanvasSnapshot(doc: doc, padding: 16)
                    .transition(.opacity)
            }
        }
        .frame(width: width, height: width * 9 / 16)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .allowsHitTesting(false)
        .springAnimation(value: doc)
        .task(id: "\(ref.id)#\(center.revision)") {
            if let fresh = await CanvasEditor.fetch(client: model.client, path: "/bots/\(ref.botID)/artifacts/\(ref.id)/doc") {
                doc = fresh
            }
        }
    }
}

@MainActor
enum CanvasExporter {
    private static func renderer(_ doc: CanvasDoc) -> ImageRenderer<some View> {
        let bounds = doc.bounds.isNull ? CGRect(x: 0, y: 0, width: 200, height: 120) : doc.bounds
        let scale = min(1, 6000 / max(bounds.width, bounds.height))
        let size = CGSize(width: (bounds.width * scale + 96).rounded(), height: (bounds.height * scale + 96).rounded())
        let view = CanvasSnapshot(doc: doc, padding: 48, background: Theme.background)
            .frame(width: size.width, height: size.height)
            .environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: view)
        renderer.proposedSize = ProposedViewSize(size)
        return renderer
    }

    private static func light<T>(_ work: () -> T?) -> T? {
        var result: T?
        if let appearance = NSAppearance(named: .aqua) {
            appearance.performAsCurrentDrawingAppearance {
                result = work()
            }
        } else {
            result = work()
        }
        return result
    }

    static func png(_ doc: CanvasDoc) -> Data? {
        light {
            let renderer = renderer(doc)
            renderer.scale = 2
            guard let image = renderer.cgImage else { return nil }
            return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        }
    }

    static func pdf(_ doc: CanvasDoc) -> Data? {
        light {
            let renderer = renderer(doc)
            let data = NSMutableData()
            var made = false
            renderer.render { size, render in
                var box = CGRect(origin: .zero, size: size)
                guard let consumer = CGDataConsumer(data: data as CFMutableData),
                      let context = CGContext(consumer: consumer, mediaBox: &box, nil)
                else { return }
                context.beginPDFPage(nil)
                render(context)
                context.endPDFPage()
                context.closePDF()
                made = true
            }
            return made ? data as Data : nil
        }
    }
}
