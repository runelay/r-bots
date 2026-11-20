import AppKit
import SwiftUI

enum GlassMenuEdge {
    case leading
    case trailing
}

struct GlassMenuItem: Identifiable {
    let id: String
    let title: String
    var systemImage: String?
    var subtitle: String?
    var shortcut: String?
    var isOn: Bool?
    var destructive = false
    var isEnabled = true
    var startsSection = false
    var keepsOpen = false
    var leading: AnyView?
    let action: () -> Void

    init(
        _ title: String,
        id: String? = nil,
        systemImage: String? = nil,
        subtitle: String? = nil,
        shortcut: String? = nil,
        isOn: Bool? = nil,
        destructive: Bool = false,
        isEnabled: Bool = true,
        startsSection: Bool = false,
        keepsOpen: Bool = false,
        leading: AnyView? = nil,
        action: @escaping () -> Void
    ) {
        self.id = id ?? title
        self.title = title
        self.systemImage = systemImage
        self.subtitle = subtitle
        self.shortcut = shortcut
        self.isOn = isOn
        self.destructive = destructive
        self.isEnabled = isEnabled
        self.startsSection = startsSection
        self.keepsOpen = keepsOpen
        self.leading = leading
        self.action = action
    }
}

struct GlassSelectOption<Value: Hashable> {
    let value: Value
    let title: String
    var systemImage: String?
    var subtitle: String?
    var startsSection = false
    var leading: AnyView?

    init(_ title: String, value: Value, systemImage: String? = nil, subtitle: String? = nil, startsSection: Bool = false, leading: AnyView? = nil) {
        self.value = value
        self.title = title
        self.systemImage = systemImage
        self.subtitle = subtitle
        self.startsSection = startsSection
        self.leading = leading
    }
}

extension View {
    func glassPopup<Popup: View>(
        isPresented: Binding<Bool>,
        edge: GlassMenuEdge = .leading,
        @ViewBuilder content: @escaping () -> Popup
    ) -> some View {
        modifier(GlassPopupModifier(isPresented: isPresented, edge: edge, popup: content))
    }

    func glassMenu(
        isPresented: Binding<Bool>,
        edge: GlassMenuEdge = .leading,
        title: String? = nil,
        minWidth: CGFloat = 200,
        items: @escaping () -> [GlassMenuItem]
    ) -> some View {
        glassPopup(isPresented: isPresented, edge: edge) {
            LiveGlassMenu(items: items, title: title, minWidth: minWidth)
        }
    }

    func glassMenuSurface() -> some View {
        modifier(GlassMenuSurface())
    }
}

struct GlassMenuSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .glassPane(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .softElevation(lifted: true)
    }
}

extension EnvironmentValues {
    @Entry var glassPopupDismiss: @MainActor () -> Void = {}
}

struct GlassMenuButton<Label: View>: View {
    var edge: GlassMenuEdge = .leading
    var help: String
    var title: String? = nil
    var minWidth: CGFloat = 200
    let items: () -> [GlassMenuItem]
    @ViewBuilder let label: (_ isOpen: Bool) -> Label

    @State private var isOpen = false

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            label(isOpen)
        }
        .buttonStyle(PressableButtonStyle())
        .glassMenu(isPresented: $isOpen, edge: edge, title: title, minWidth: minWidth, items: items)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(isOpen ? "Aberto" : "")
    }
}

struct GlassMenuIconButton: View {
    let systemImage: String
    let help: String
    var iconSize: CGFloat = 14
    var size: CGFloat = 28
    var weight: Font.Weight = .regular
    var shape: IconButtonShape = .rounded
    var edge: GlassMenuEdge = .leading
    let items: () -> [GlassMenuItem]

    var body: some View {
        GlassMenuButton(edge: edge, help: help, items: items) { isOpen in
            IconButtonFace(systemImage: systemImage, iconSize: iconSize, size: size, weight: weight, shape: shape, isActive: isOpen)
        }
    }
}

enum IconButtonShape {
    case rounded
    case circle
}

struct IconButtonFace: View {
    let systemImage: String
    var iconSize: CGFloat = 14
    var size: CGFloat = 28
    var weight: Font.Weight = .regular
    var shape: IconButtonShape = .rounded
    var isActive = false

    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false

    var body: some View {
        let lit = isEnabled && (isActive || isHovering)
        Image(systemName: systemImage)
            .font(.system(size: iconSize, weight: weight))
            .foregroundStyle(lit ? Theme.textPrimary : Theme.textSecondary)
            .frame(width: size, height: size)
            .background {
                if isActive || (isHovering && isEnabled) {
                    face.fill(isActive ? Theme.selection : Theme.hover)
                }
            }
            .contentShape(face)
            .onHover { isHovering = $0 }
            .springAnimation(value: isHovering)
            .springAnimation(value: isActive)
    }

    private var face: AnyShape {
        switch shape {
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        case .circle: AnyShape(Circle())
        }
    }
}

struct GlassSelect<Value: Hashable>: View {
    let options: [GlassSelectOption<Value>]
    @Binding var selection: Value
    var prefix: String? = nil
    var title: String? = nil
    var help: String = ""
    var maxWidth: CGFloat? = nil
    var edge: GlassMenuEdge = .leading
    var minWidth: CGFloat = 200

    @State private var isOpen = false

    private var currentTitle: String {
        title ?? options.first { $0.value == selection }?.title ?? ""
    }

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            SelectFace(text: currentTitle, prefix: prefix, isOpen: isOpen, maxWidth: maxWidth)
        }
        .buttonStyle(PressableButtonStyle())
        .fixedSize(horizontal: maxWidth == nil, vertical: true)
        .glassPopup(isPresented: $isOpen, edge: edge) {
            GlassMenuList(
                items: menuItems,
                minWidth: minWidth,
                initialHighlight: options.firstIndex { $0.value == selection }
            )
        }
        .help(help)
        .accessibilityLabel(prefix ?? help)
        .accessibilityValue(currentTitle)
    }

    private var menuItems: [GlassMenuItem] {
        options.enumerated().map { index, option in
            GlassMenuItem(
                option.title,
                id: "\(index)",
                systemImage: option.systemImage,
                subtitle: option.subtitle,
                isOn: option.value == selection,
                startsSection: option.startsSection,
                leading: option.leading
            ) {
                selection = option.value
            }
        }
    }
}

struct SelectFace: View {
    let text: String
    var prefix: String? = nil
    var isOpen = false
    var maxWidth: CGFloat? = nil

    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: Spacing.xs) {
            if let prefix {
                Text(prefix)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
            }
            Text(text)
                .foregroundStyle(isEnabled ? Theme.textPrimary : Theme.textTertiary)
                .lineLimit(1)
                .truncationMode(.middle)
                .contentTransition(.opacity)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
        }
        .font(TypeScale.rowSubtitle)
        .padding(.horizontal, Spacing.m)
        .frame(height: 30)
        .frame(maxWidth: maxWidth)
        .background(isOpen ? Theme.selection : isHovering && isEnabled ? Theme.selection : Theme.hover, in: Capsule())
        .contentShape(Capsule())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isOpen)
        .springAnimation(value: text)
    }
}

private struct LiveGlassMenu: View {
    let items: () -> [GlassMenuItem]
    let title: String?
    let minWidth: CGFloat

    var body: some View {
        GlassMenuList(items: items(), title: title, minWidth: minWidth)
    }
}

struct GlassMenuList: View {
    let items: [GlassMenuItem]
    var title: String? = nil
    var minWidth: CGFloat = 200
    var initialHighlight: Int? = nil

    @Environment(\.appReduceMotion) private var reduceMotion
    @Environment(\.glassPopupDismiss) private var dismiss
    @State private var highlighted: Int?
    @State private var appeared = false
    @FocusState private var focused: Bool
    @Namespace private var highlightSpace

    private static let rowHeight: CGFloat = 30
    private static let richRowHeight: CGFloat = 40
    private static let visibleRows = 10

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                Text(title)
                    .font(BrandFonts.sans(11, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .padding(.horizontal, Spacing.s)
                    .padding(.top, Spacing.xxs)
                    .padding(.bottom, Spacing.xs)
            }
            if items.count > Self.visibleRows {
                ScrollViewReader { proxy in
                    ScrollView {
                        rows
                    }
                    .scrollIndicators(.never)
                    .scrollEdgesHidden()
                    .frame(height: scrollHeight)
                    .onChange(of: highlighted) { _, index in
                        guard let index, items.indices.contains(index) else { return }
                        proxy.scrollTo(items[index].id)
                    }
                    .onAppear {
                        guard let initialHighlight, items.indices.contains(initialHighlight) else { return }
                        proxy.scrollTo(items[initialHighlight].id, anchor: .center)
                    }
                }
            } else {
                rows
            }
        }
        .padding(Spacing.xs + 1)
        .frame(minWidth: minWidth, alignment: .leading)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onKeyPress(.downArrow) { move(by: 1) }
        .onKeyPress(.upArrow) { move(by: -1) }
        .onKeyPress(.home) { jump(toFirst: true) }
        .onKeyPress(.end) { jump(toFirst: false) }
        .onKeyPress(.return) { activateHighlighted() }
        .onKeyPress(.space) { activateHighlighted() }
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .springAnimation(value: highlighted)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title ?? "Menu")
        .onAppear {
            highlighted = initialHighlight
            appeared = true
            Task { @MainActor in
                focused = true
            }
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0, item.startsSection || (item.destructive && !items[index - 1].destructive) {
                    Rectangle()
                        .fill(Theme.paneDivider)
                        .frame(height: 1)
                        .padding(.horizontal, Spacing.xs)
                        .padding(.vertical, Spacing.xxs)
                        .opacity(appeared ? 1 : 0)
                }
                row(item, index: index)
                    .id(item.id)
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared || reduceMotion ? 0 : -4)
                    .animation(
                        reduceMotion ? Motion.reduced : Motion.spring.delay(0.025 * Double(min(index, 8)) + 0.03),
                        value: appeared
                    )
            }
        }
    }

    private var scrollHeight: CGFloat {
        let height = items.prefix(Self.visibleRows).reduce(CGFloat(0)) { total, item in
            total + (item.subtitle == nil ? Self.rowHeight : Self.richRowHeight) + 2
        }
        return height + Self.rowHeight / 2
    }

    private var hasLeading: Bool {
        items.contains { $0.systemImage != nil || $0.leading != nil }
    }

    private func row(_ item: GlassMenuItem, index: Int) -> some View {
        let isHighlighted = highlighted == index && item.isEnabled
        let tint = item.destructive ? Theme.danger : Theme.textPrimary
        return Button {
            activate(index)
        } label: {
            HStack(spacing: Spacing.s) {
                if let leading = item.leading {
                    leading
                        .frame(width: 20, height: 20)
                } else if let symbol = item.systemImage {
                    Image(systemName: symbol)
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(item.destructive ? Theme.danger : isHighlighted ? Theme.textPrimary : Theme.textSecondary)
                        .frame(width: 20)
                } else if hasLeading {
                    Color.clear
                        .frame(width: 20, height: 1)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(tint)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    if let subtitle = item.subtitle {
                        Text(subtitle)
                            .font(BrandFonts.sans(11))
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: Spacing.l)
                if let shortcut = item.shortcut, item.isOn != true {
                    Text(shortcut)
                        .font(BrandFonts.sans(11, weight: .medium))
                        .foregroundStyle(Theme.textTertiary)
                        .fixedSize()
                }
                if let isOn = item.isOn {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.brandText)
                        .scaleEffect(isOn ? 1 : 0.4)
                        .opacity(isOn ? 1 : 0)
                        .springAnimation(value: isOn)
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: item.subtitle == nil ? Self.rowHeight : Self.richRowHeight)
            .background {
                if isHighlighted {
                    RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                        .fill(Theme.hover)
                        .matchedGeometryEffect(id: "highlight", in: highlightSpace)
                }
            }
            .contentShape(Rectangle())
            .opacity(item.isEnabled ? 1 : 0.4)
        }
        .buttonStyle(.plain)
        .focusable(false)
        .disabled(!item.isEnabled)
        .clickable()
        .onHover { hovering in
            if hovering {
                highlighted = index
            } else if highlighted == index {
                highlighted = nil
            }
        }
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(item.isOn == true ? [.isButton, .isSelected] : .isButton)
    }

    private func move(by step: Int) -> KeyPress.Result {
        let enabled = items.indices.filter { items[$0].isEnabled }
        guard !enabled.isEmpty else { return .handled }
        guard let current = highlighted, let position = enabled.firstIndex(of: current) else {
            highlighted = step > 0 ? enabled.first : enabled.last
            return .handled
        }
        highlighted = enabled[(position + step + enabled.count) % enabled.count]
        return .handled
    }

    private func jump(toFirst: Bool) -> KeyPress.Result {
        let enabled = items.indices.filter { items[$0].isEnabled }
        highlighted = toFirst ? enabled.first : enabled.last
        return .handled
    }

    private func activateHighlighted() -> KeyPress.Result {
        guard let highlighted else { return .ignored }
        activate(highlighted)
        return .handled
    }

    private func activate(_ index: Int) {
        guard items.indices.contains(index) else { return }
        let item = items[index]
        guard item.isEnabled else { return }
        if item.keepsOpen {
            item.action()
        } else {
            dismiss()
            item.action()
        }
    }
}

private struct GlassPopupModifier<Popup: View>: ViewModifier {
    @Binding var isPresented: Bool
    let edge: GlassMenuEdge
    let popup: () -> Popup

    @Environment(AppModel.self) private var model: AppModel?
    @Environment(\.appReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.background {
            GlassPopupAnchor(
                isPresented: $isPresented,
                edge: edge,
                reduceMotion: reduceMotion,
                popup: {
                    AnyView(
                        popup()
                            .environment(model)
                            .environment(\.appReduceMotion, reduceMotion)
                    )
                }
            )
        }
    }
}

private struct GlassPopupAnchor: NSViewRepresentable {
    @Binding var isPresented: Bool
    let edge: GlassMenuEdge
    let reduceMotion: Bool
    let popup: () -> AnyView

    func makeCoordinator() -> GlassPopupPresenter {
        GlassPopupPresenter()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.setAccessibilityElement(false)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        let presenter = context.coordinator
        let binding = $isPresented
        presenter.onDismiss = {
            binding.wrappedValue = false
        }
        if isPresented {
            if presenter.isShown {
                presenter.update(popup())
            } else {
                let root = popup()
                let edge = edge
                let reduceMotion = reduceMotion
                Task { @MainActor in
                    guard binding.wrappedValue, !presenter.isShown else { return }
                    presenter.present(from: view, edge: edge, reduceMotion: reduceMotion, content: root)
                }
            }
        } else if presenter.isShown {
            presenter.dismiss()
        }
    }

    static func dismantleNSView(_ view: NSView, coordinator: GlassPopupPresenter) {
        coordinator.dismiss(animated: false)
    }
}

@Observable
@MainActor
private final class GlassPopupPhase {
    var shown = false
    var flipped = false
}

private final class GlassPopupPanel: NSPanel {
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            onCancel?()
        } else {
            super.keyDown(with: event)
        }
    }
}

private struct GlassPopupRoot: View {
    let phase: GlassPopupPhase
    let edge: GlassMenuEdge
    let content: AnyView
    let dismiss: @MainActor () -> Void
    let onSize: @MainActor (CGSize) -> Void

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        let corner: UnitPoint = switch (edge, phase.flipped) {
        case (.leading, false): .topLeading
        case (.trailing, false): .topTrailing
        case (.leading, true): .bottomLeading
        case (.trailing, true): .bottomTrailing
        }
        content
            .glassMenuSurface()
            .fixedSize()
            .onGeometryChange(for: CGSize.self) { $0.size } action: { onSize($0) }
            .scaleEffect(phase.shown || reduceMotion ? 1 : 0.9, anchor: corner)
            .offset(y: phase.shown || reduceMotion ? 0 : (phase.flipped ? 6 : -6))
            .opacity(phase.shown ? 1 : 0)
            .environment(\.glassPopupDismiss, dismiss)
            .padding(GlassPopupPresenter.margin)
            .frame(
                maxWidth: .infinity,
                maxHeight: .infinity,
                alignment: Alignment(horizontal: edge == .leading ? .leading : .trailing, vertical: phase.flipped ? .bottom : .top)
            )
    }
}

@MainActor
private final class GlassPopupPresenter {
    static let margin: CGFloat = 22
    static let gap: CGFloat = 6

    var onDismiss: (() -> Void)?
    private(set) var isShown = false

    private var panel: GlassPopupPanel?
    private var hosting: NSHostingView<AnyView>?
    private weak var anchor: NSView?
    private weak var parent: NSWindow?
    private var edge: GlassMenuEdge = .leading
    private var reduceMotion = false
    private var content = AnyView(EmptyView())
    private let phase = GlassPopupPhase()
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []
    private var contentSize: CGSize = .zero

    func present(from anchor: NSView, edge: GlassMenuEdge, reduceMotion: Bool, content: AnyView) {
        guard let parent = anchor.window else {
            onDismiss?()
            return
        }
        teardown()
        self.anchor = anchor
        self.parent = parent
        self.edge = edge
        self.reduceMotion = reduceMotion
        self.content = content
        phase.shown = false
        phase.flipped = false

        let panel = GlassPopupPanel(
            contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .popUpMenu
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = true
        panel.animationBehavior = .none
        panel.isMovable = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        panel.appearance = parent.effectiveAppearance
        panel.onCancel = { [weak self] in
            self?.requestDismiss()
        }

        let hosting = NSHostingView(rootView: root())
        hosting.sizingOptions = []
        panel.contentView = hosting
        self.panel = panel
        self.hosting = hosting
        isShown = true

        let fitting = hosting.fittingSize
        contentSize = CGSize(width: fitting.width - 2 * Self.margin, height: fitting.height - 2 * Self.margin)
        panel.setFrame(frame(for: contentSize), display: false)
        hosting.rootView = root()

        parent.addChildWindow(panel, ordered: .above)
        panel.makeKeyAndOrderFront(nil)
        installMonitors()

        Task { @MainActor [weak self] in
            guard let self, self.isShown else { return }
            withAnimation(reduceMotion ? Motion.reduced : .spring(response: 0.32, dampingFraction: 0.78)) {
                self.phase.shown = true
            }
        }
        NSAccessibility.post(element: panel, notification: .created)
    }

    func update(_ content: AnyView) {
        self.content = content
        hosting?.rootView = root()
    }

    func dismiss(animated: Bool = true) {
        guard isShown else { return }
        isShown = false
        removeMonitors()
        let panel = panel
        let hosting = hosting
        let parent = parent
        self.panel = nil
        self.hosting = nil
        if let panel {
            parent?.removeChildWindow(panel)
            if parent?.isVisible == true {
                parent?.makeKey()
            }
        }
        guard let panel else { return }
        if animated {
            withAnimation(reduceMotion ? Motion.reduced : .easeOut(duration: 0.12)) {
                phase.shown = false
            }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(140))
                panel.orderOut(nil)
                hosting?.rootView = AnyView(EmptyView())
            }
        } else {
            panel.orderOut(nil)
            hosting?.rootView = AnyView(EmptyView())
        }
    }

    private func requestDismiss() {
        guard isShown else { return }
        dismiss()
        onDismiss?()
    }

    private func teardown() {
        if isShown {
            dismiss(animated: false)
        }
    }

    private func root() -> AnyView {
        AnyView(
            GlassPopupRoot(
                phase: phase,
                edge: edge,
                content: content,
                dismiss: { [weak self] in self?.requestDismiss() },
                onSize: { [weak self] size in self?.resize(to: size) }
            )
            .environment(\.appReduceMotion, reduceMotion)
        )
    }

    private func resize(to size: CGSize) {
        guard isShown, let panel else { return }
        guard abs(size.width - contentSize.width) > 0.5 || abs(size.height - contentSize.height) > 0.5 else { return }
        contentSize = size
        panel.setFrame(frame(for: size), display: true)
    }

    private func frame(for size: CGSize) -> NSRect {
        let margin = Self.margin
        let width = size.width + margin * 2
        let height = size.height + margin * 2
        guard let anchor, let window = anchor.window else {
            return NSRect(x: 0, y: 0, width: width, height: height)
        }
        let rect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
        let visible = (window.screen ?? NSScreen.main)?.visibleFrame ?? rect.insetBy(dx: -2000, dy: -2000)

        var x = edge == .leading ? rect.minX - margin : rect.maxX - size.width - margin
        x = min(max(x, visible.minX - margin + 4), visible.maxX - width + margin - 4)

        let below = rect.minY - Self.gap - size.height
        let fitsBelow = below >= visible.minY + 4
        let fitsAbove = rect.maxY + Self.gap + size.height <= visible.maxY - 4
        let flipped = !fitsBelow && fitsAbove
        if phase.flipped != flipped {
            phase.flipped = flipped
        }
        let y = flipped ? rect.maxY + Self.gap - margin : below - margin
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private func installMonitors() {
        let local = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            let swallow = MainActor.assumeIsolated { () -> Bool in
                guard let self, self.isShown else { return false }
                if self.owns(event.window) {
                    return false
                }
                let onAnchor: Bool = {
                    guard let anchor = self.anchor, event.window === anchor.window else { return false }
                    return anchor.bounds.contains(anchor.convert(event.locationInWindow, from: nil))
                }()
                self.requestDismiss()
                return onAnchor
            }
            return swallow ? nil : event
        }
        if let local {
            monitors.append(local)
        }
        let global = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            Task { @MainActor in
                self?.requestDismiss()
            }
        }
        if let global {
            monitors.append(global)
        }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.requestDismiss()
            }
        })
        if let parent {
            observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: parent, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.requestDismiss()
                }
            })
        }
        if let panel {
            observers.append(center.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.isShown, NSApp.modalWindow == nil, !self.owns(NSApp.keyWindow) else { return }
                    self.requestDismiss()
                }
            })
        }
    }

    private func owns(_ window: NSWindow?) -> Bool {
        guard let panel else { return false }
        var current = window
        while let candidate = current {
            if candidate === panel {
                return true
            }
            current = candidate.parent
        }
        return false
    }

    private func removeMonitors() {
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors.removeAll()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
    }
}
