import SwiftUI

enum FloatingMenuID: Hashable {
    case sidebarFilter
    case sidebarNew
    case connectorsAdd
    case connectorOptions(String)
    case tabPicker

    var alignsTrailing: Bool {
        switch self {
        case .connectorsAdd, .connectorOptions: true
        default: false
        }
    }
}

struct FloatingMenuAnchorKey: PreferenceKey {
    static let defaultValue: [FloatingMenuID: Anchor<CGRect>] = [:]

    static func reduce(value: inout [FloatingMenuID: Anchor<CGRect>], nextValue: () -> [FloatingMenuID: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

struct FloatingMenuItem: Identifiable {
    let id: String
    let title: String
    let systemImage: String
    var isOn: Bool?
    var destructive = false
    let action: () -> Void
}

struct FloatingMenuButton: View {
    @Environment(AppModel.self) private var model
    let id: FloatingMenuID
    let systemImage: String
    let help: String
    var iconSize: CGFloat = 14

    @State private var isHovering = false

    private var isOpen: Bool { model.floatingMenu == id }

    var body: some View {
        Button {
            model.floatingMenu = isOpen ? nil : id
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: iconSize, weight: .regular))
                .foregroundStyle(isOpen || isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 30, height: 30)
                .background(isOpen ? Theme.selection : isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .springAnimation(value: isOpen)
        .anchorPreference(key: FloatingMenuAnchorKey.self, value: .bounds) { [id: $0] }
        .help(help)
        .accessibilityLabel(help)
    }
}

struct FloatingMenuLayer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let anchors: [FloatingMenuID: Anchor<CGRect>]

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                if let id = model.floatingMenu, let anchor = anchors[id] {
                    let rect = proxy[anchor]
                    Rectangle()
                        .fill(Theme.maskHidden)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            model.floatingMenu = nil
                        }
                    Button("") {
                        model.floatingMenu = nil
                    }
                    .keyboardShortcut(.cancelAction)
                    .opacity(0)
                    .frame(width: 0, height: 0)

                    let corner: UnitPoint = id.alignsTrailing ? .topTrailing : .topLeading
                    Group {
                        if id == .tabPicker {
                            BotQuickPicker()
                        } else {
                            FloatingMenuPanel(items: items(for: id))
                        }
                    }
                        .id(id)
                        .fixedSize()
                        .frame(width: id.alignsTrailing ? rect.maxX : nil, alignment: .topTrailing)
                        .offset(x: id.alignsTrailing ? 0 : rect.minX, y: rect.maxY + 6)
                        .transition(
                            reduceMotion
                                ? .opacity
                                : .asymmetric(
                                    insertion: .opacity
                                        .combined(with: .scale(scale: 0.86, anchor: corner))
                                        .combined(with: .offset(y: -6)),
                                    removal: .opacity.combined(with: .scale(scale: 0.96, anchor: corner))
                                )
                        )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .animation(
            reduceMotion ? Motion.reduced : .spring(response: 0.32, dampingFraction: 0.78),
            value: model.floatingMenu
        )
    }

    private func items(for id: FloatingMenuID) -> [FloatingMenuItem] {
        switch id {
        case .sidebarFilter:
            [
                FloatingMenuItem(id: "group", title: "Agrupar por seção", systemImage: "rectangle.3.group", isOn: model.groupBySection) {
                    model.groupBySection.toggle()
                },
                FloatingMenuItem(id: "hidden", title: "Mostrar ocultos", systemImage: "eye", isOn: model.showHiddenBots) {
                    model.showHiddenBots.toggle()
                },
            ]
        case .sidebarNew:
            [
                FloatingMenuItem(id: "bot", title: "Novo bot", systemImage: "person.badge.plus") {
                    model.floatingMenu = nil
                    model.openEditor(for: nil)
                },
                FloatingMenuItem(id: "group", title: "Novo grupo", systemImage: "person.3") {
                    model.floatingMenu = nil
                    model.openGroupEditor(for: nil)
                },
            ]
        case .connectorsAdd:
            model.catalog.addMenuItems(model: model)
        case .connectorOptions(let id):
            model.catalog.optionItems(for: id, model: model)
        case .tabPicker:
            []
        }
    }
}

struct FloatingMenuPanel: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let items: [FloatingMenuItem]

    @State private var hovered: String?
    @State private var appeared = false
    @Namespace private var highlight

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if item.destructive && index > 0 {
                    Rectangle()
                        .fill(Theme.paneDivider)
                        .frame(height: 1)
                        .padding(.vertical, Spacing.xxs)
                        .opacity(appeared ? 1 : 0)
                }
                row(item)
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared || reduceMotion ? 0 : -4)
                    .animation(
                        reduceMotion ? Motion.reduced : Motion.spring.delay(0.03 * Double(index) + 0.04),
                        value: appeared
                    )
            }
        }
        .padding(Spacing.xs + 1)
        .frame(minWidth: 200, alignment: .leading)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous), fallback: Theme.surfaceRaised)
        .softElevation(lifted: true)
        .onAppear {
            appeared = true
        }
        .springAnimation(value: hovered)
    }

    private func row(_ item: FloatingMenuItem) -> some View {
        Button(action: item.action) {
            HStack(spacing: Spacing.s) {
                Image(systemName: item.systemImage)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(item.destructive ? Theme.danger : hovered == item.id ? Theme.textPrimary : Theme.textSecondary)
                    .frame(width: 18)
                Text(item.title)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(item.destructive ? Theme.danger : Theme.textPrimary)
                Spacer(minLength: Spacing.l)
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
            .frame(height: 30)
            .background {
                if hovered == item.id {
                    RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                        .fill(Theme.hover)
                        .matchedGeometryEffect(id: "highlight", in: highlight)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering in
            if hovering {
                hovered = item.id
            } else if hovered == item.id {
                hovered = nil
            }
        }
    }
}
