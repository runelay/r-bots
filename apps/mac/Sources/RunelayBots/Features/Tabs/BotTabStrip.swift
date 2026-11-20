import AppKit
import SwiftUI

enum TabMetrics {
    static let maxWidth: CGFloat = 196
    static let minWidth: CGFloat = 64
    static let height: CGFloat = 30
    static let addWidth: CGFloat = 36
}

struct BotTabStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let leadingFlush: Bool

    @State private var dragging: String?
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            let order = model.tabs.order
            let available = max(geometry.size.width - TabMetrics.addWidth - ChromeTabShape.flare * 2, 0)
            let fitted = order.isEmpty ? TabMetrics.maxWidth : (available / CGFloat(order.count)).rounded(.down)
            let width = min(max(fitted, TabMetrics.minWidth), TabMetrics.maxWidth)
            let scrolls = width * CGFloat(order.count) > available + 0.5
            Group {
                if scrolls {
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal) {
                            row(order: order, width: width)
                                .padding(.horizontal, ChromeTabShape.flare)
                        }
                        .scrollIndicators(.never)
                        .scrollEdgesHidden()
                        .frame(width: available + ChromeTabShape.flare * 2)
                        .onAppear {
                            if let active = model.activeTabID {
                                proxy.scrollTo(active)
                            }
                        }
                        .onChange(of: model.activeTabID) { _, active in
                            guard let active else { return }
                            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                                proxy.scrollTo(active)
                            }
                        }
                    }
                } else {
                    row(order: order, width: width)
                        .padding(.leading, leadingFlush ? 0 : ChromeTabShape.flare)
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
            .overlay(alignment: .bottomLeading) {
                NewTabButton()
                    .padding(.bottom, Spacing.xs + 1)
                    .offset(x: addButtonX(scrolls: scrolls, available: available, width: width, count: order.count))
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func addButtonX(scrolls: Bool, available: CGFloat, width: CGFloat, count: Int) -> CGFloat {
        if scrolls {
            return available + ChromeTabShape.flare * 2 + Spacing.xxs
        }
        let start = leadingFlush ? 0 : ChromeTabShape.flare
        return start + width * CGFloat(count) + (count == 0 ? 0 : ChromeTabShape.flare - Spacing.xxs)
    }

    private func row(order: [String], width: CGFloat) -> some View {
        let from = dragging.flatMap { order.firstIndex(of: $0) }
        let target = from.map { targetIndex(from: $0, width: width, count: order.count) }
        return HStack(spacing: 0) {
            ForEach(Array(order.enumerated()), id: \.element) { index, botID in
                if let bot = model.bot(id: botID) {
                    let isActive = model.activeTabID == botID
                    BotTabItem(
                        bot: bot,
                        index: index,
                        width: width,
                        isActive: isActive,
                        flushLeading: leadingFlush && index == 0,
                        isDragging: dragging == botID
                    )
                    .offset(x: shift(index: index, from: from, target: target, width: width))
                    .zIndex(dragging == botID ? 3 : isActive ? 2 : 1)
                    .gesture(drag(botID, width: width, count: order.count))
                    .id(botID)
                }
            }
        }
        .frame(height: TabMetrics.height + Spacing.xs + 1, alignment: .bottom)
        .offset(y: 1)
        .animation(reduceMotion ? Motion.reduced : Motion.spring, value: order)
        .animation(reduceMotion ? Motion.reduced : Motion.spring, value: target)
    }

    private func targetIndex(from: Int, width: CGFloat, count: Int) -> Int {
        let moved = Int((dragOffset / max(width, 1)).rounded())
        return min(max(from + moved, 0), count - 1)
    }

    private func shift(index: Int, from: Int?, target: Int?, width: CGFloat) -> CGFloat {
        guard let from, let target else { return 0 }
        if index == from {
            return dragOffset
        }
        if from < target, index > from, index <= target {
            return -width
        }
        if from > target, index >= target, index < from {
            return width
        }
        return 0
    }

    private func drag(_ botID: String, width: CGFloat, count: Int) -> some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .onChanged { value in
                if dragging != botID {
                    dragging = botID
                }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    dragOffset = value.translation.width
                }
            }
            .onEnded { _ in
                guard let from = model.tabs.index(of: botID) else {
                    dragging = nil
                    dragOffset = 0
                    return
                }
                let target = targetIndex(from: from, width: width, count: count)
                withAnimation(reduceMotion ? Motion.reduced : Motion.spring) {
                    model.moveTab(botID, to: target)
                    dragging = nil
                    dragOffset = 0
                }
            }
    }
}

struct BotTabItem: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    let index: Int
    let width: CGFloat
    let isActive: Bool
    let flushLeading: Bool
    let isDragging: Bool

    @State private var isHovering = false
    @State private var isHoveringClose = false

    private var compact: Bool {
        width < 104
    }

    var body: some View {
        let mood = model.tabMood(bot.id)
        let attention = model.tabHasAttention(bot.id)
        let showsClose = (isActive && !compact) || isHovering
        HStack(spacing: Spacing.s - 2) {
            avatar(mood: mood)
            Text(bot.name)
                .font(TypeScale.rowSubtitle.weight(isActive ? .medium : .regular))
                .foregroundStyle(isActive || isHovering ? Theme.textPrimary : Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            ZStack {
                if showsClose {
                    closeButton
                        .transition(.opacity)
                } else if attention {
                    Circle()
                        .fill(mood == .waiting ? Theme.attention : Theme.brandAccent)
                        .frame(width: 6, height: 6)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .frame(width: showsClose || attention ? 16 : 0, height: 16)
        }
        .padding(.leading, flushLeading ? Spacing.m : Spacing.s + 2)
        .padding(.trailing, Spacing.xs + 2)
        .frame(width: width, height: TabMetrics.height)
        .background {
            if isActive {
                ChromeTabShape(leftFlush: flushLeading)
                    .fill(Theme.background)
                    .padding(.leading, flushLeading ? 0 : -ChromeTabShape.flare)
                    .padding(.trailing, -ChromeTabShape.flare)
                    .padding(.bottom, -(Spacing.xs + 1))
                    .frame(maxHeight: .infinity, alignment: .top)
                    .transition(.opacity)
            } else if isHovering || isDragging {
                RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                    .fill(Theme.hover)
                    .padding(.horizontal, Spacing.xxs)
                    .padding(.bottom, Spacing.xxs)
            }
        }
        .padding(.bottom, Spacing.xs + 1)
        .contentShape(Rectangle())
        .onTapGesture {
            model.activateTab(bot.id)
        }
        .overlay {
            MiddleClickArea {
                model.closeTab(bot.id)
            }
        }
        .onHover { hovering in
            isHovering = hovering
            if hovering {
                model.prefetchTab(bot.id)
            }
        }
        .clickable()
        .springAnimation(value: isHovering)
        .springAnimation(value: isActive)
        .springAnimation(value: attention)
        .help(index < 9 ? "\(bot.name) (⌘\(index + 1))" : bot.name)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(bot.name)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction {
            model.activateTab(bot.id)
        }
        .accessibilityAction(named: "Fechar aba") {
            model.closeTab(bot.id)
        }
        .contextMenu {
            Button("Ver perfil de \(bot.name)") {
                model.openProfile(bot)
            }
            Divider()
            Button("Fechar aba") {
                model.closeTab(bot.id)
            }
            Button("Fechar as outras abas") {
                model.closeOtherTabs(keeping: bot.id)
            }
            .disabled(model.tabs.order.count < 2)
        }
    }

    @ViewBuilder
    private func avatar(mood: CharacterMood) -> some View {
        if bot.isGroup {
            GroupAvatar(members: model.members(of: bot), size: 16)
        } else {
            BotCharacter(bot: bot, mood: mood, size: 16)
        }
    }

    private var closeButton: some View {
        Button {
            model.closeTab(bot.id)
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 8.5, weight: .bold))
                .foregroundStyle(isHoveringClose ? Theme.textPrimary : Theme.textTertiary)
                .frame(width: 16, height: 16)
                .background(isHoveringClose ? Theme.hover : Theme.maskHidden, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering in
            isHoveringClose = hovering
        }
        .help("Fechar aba (⌘W)")
        .accessibilityLabel("Fechar \(bot.name)")
    }
}

struct NewTabButton: View {
    @Environment(AppModel.self) private var model
    @State private var isHovering = false

    private var isOpen: Bool {
        model.floatingMenu == .tabPicker
    }

    var body: some View {
        Button {
            model.floatingMenu = isOpen ? nil : .tabPicker
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isOpen || isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 26, height: 26)
                .background(isOpen ? Theme.selection : isHovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .springAnimation(value: isOpen)
        .anchorPreference(key: FloatingMenuAnchorKey.self, value: .bounds) { [.tabPicker: $0] }
        .help("Nova aba (⌘T)")
        .accessibilityLabel("Nova aba")
    }
}

struct BotQuickPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    private var results: [Bot] {
        let bots = model.sortedBots.filter { !$0.isPending && !$0.isArchived }
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return bots }
        return bots.filter {
            $0.name.localizedStandardContains(term) || $0.role.localizedStandardContains(term)
        }
    }

    var body: some View {
        let list = results
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.s) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textTertiary)
                TextField("Abrir bot", text: $query)
                    .textFieldStyle(.plain)
                    .font(TypeScale.rowSubtitle)
                    .focused($focused)
                    .onSubmit {
                        choose(list.indices.contains(highlighted) ? list[highlighted] : nil)
                    }
                    .onKeyPress(.downArrow) {
                        highlighted = min(highlighted + 1, max(list.count - 1, 0))
                        return .handled
                    }
                    .onKeyPress(.upArrow) {
                        highlighted = max(highlighted - 1, 0)
                        return .handled
                    }
            }
            .padding(.horizontal, Spacing.s + 2)
            .frame(height: 32)
            .background(Theme.hover, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))

            if list.isEmpty {
                Text("Nenhum bot com esse nome")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .padding(.horizontal, Spacing.s)
                    .frame(height: 32)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 2) {
                            ForEach(Array(list.enumerated()), id: \.element.id) { index, bot in
                                row(bot, index: index)
                                    .id(bot.id)
                            }
                        }
                    }
                    .scrollIndicators(.never)
                    .frame(maxHeight: min(CGFloat(list.count) * 34, 306))
                    .onChange(of: highlighted) { _, index in
                        guard list.indices.contains(index) else { return }
                        proxy.scrollTo(list[index].id)
                    }
                }
            }
        }
        .padding(Spacing.xs + 1)
        .frame(width: 272, alignment: .leading)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous), fallback: Theme.surfaceRaised)
        .softElevation(lifted: true)
        .onAppear {
            focused = true
        }
        .onChange(of: query) {
            highlighted = 0
        }
        .springAnimation(value: highlighted)
    }

    private func row(_ bot: Bot, index: Int) -> some View {
        let isOpen = model.tabs.contains(bot.id)
        return Button {
            choose(bot)
        } label: {
            HStack(spacing: Spacing.s) {
                if bot.isGroup {
                    GroupAvatar(members: model.members(of: bot), size: 18)
                } else {
                    BotCharacter(bot: bot, mood: .idle, size: 18)
                }
                Text(bot.name)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                let role = bot.role.trimmingCharacters(in: .whitespaces)
                if !role.isEmpty, role.lowercased() != bot.name.lowercased() {
                    Text(role)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: Spacing.s)
                if isOpen {
                    Circle()
                        .fill(Theme.textTertiary)
                        .frame(width: 5, height: 5)
                        .help("Já está aberto em uma aba")
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 32)
            .background(highlighted == index ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering in
            if hovering {
                highlighted = index
            }
        }
    }

    private func choose(_ bot: Bot?) {
        guard let bot else { return }
        model.floatingMenu = nil
        model.open(bot.id, placement: .new)
    }
}

struct MiddleClickArea: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> MiddleClickView {
        let view = MiddleClickView()
        view.action = action
        return view
    }

    func updateNSView(_ nsView: MiddleClickView, context: Context) {
        nsView.action = action
    }
}

final class MiddleClickView: NSView {
    var action: (() -> Void)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let event = NSApp.currentEvent,
              event.type == .otherMouseDown || event.type == .otherMouseUp,
              event.buttonNumber == 2
        else { return nil }
        return super.hitTest(point)
    }

    override func otherMouseDown(with event: NSEvent) {}

    override func otherMouseUp(with event: NSEvent) {
        guard event.buttonNumber == 2 else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard bounds.contains(point) else { return }
        action?()
    }
}
