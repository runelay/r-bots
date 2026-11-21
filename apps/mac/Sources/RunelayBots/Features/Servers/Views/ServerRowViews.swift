import SwiftUI

struct ServerStatusDot: View {
    let status: DevServerInfo.Status
    var size: CGFloat = 8

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var pulse = false
    @State private var ping = false

    private var color: Color {
        switch status {
        case .starting: Theme.attention
        case .running: Theme.success
        case .exited: Theme.danger
        case .stopped: Theme.textTertiary
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .opacity(status == .starting && pulse ? 0.35 : 1)
            .background {
                Circle()
                    .stroke(color, lineWidth: 1.5)
                    .scaleEffect(ping ? 2.4 : 1)
                    .opacity(ping ? 0 : 0.6)
                    .opacity(status == .running ? 1 : 0)
            }
            .animation(Motion.animation(reduceMotion: reduceMotion), value: status)
            .onAppear { update(status, initial: true) }
            .onChange(of: status) { _, next in update(next, initial: false) }
            .accessibilityLabel(status.label)
    }

    private func update(_ next: DevServerInfo.Status, initial: Bool) {
        if next == .starting, !reduceMotion {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                pulse = true
            }
        } else {
            withAnimation(.easeOut(duration: 0.2)) {
                pulse = false
            }
        }
        if next == .running, !initial, !reduceMotion {
            ping = false
            withAnimation(.easeOut(duration: 0.9)) {
                ping = true
            }
        } else if next != .running {
            ping = false
        }
    }
}

struct ServerToolTile: View {
    let tool: String
    var size: CGFloat = 32

    var body: some View {
        Image(systemName: ServerTool.symbol(tool))
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(Theme.textSecondary)
            .frame(width: size, height: size)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .accessibilityLabel(ServerTool.label(tool))
    }
}

struct ServerStatusLabel: View {
    let server: DevServerInfo
    var showsBranch = false

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.xs + 2) {
            ServerStatusDot(status: server.status)
            Text(server.status.label)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .fixedSize()
                .contentTransition(.opacity)
            if server.status.isLive {
                Text(verbatim: ":\(server.port)")
                    .font(TypeScale.caption.monospacedDigit())
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
            }
            if showsBranch, !server.subtitle.isEmpty {
                Text("·")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .fixedSize()
                Text(server.subtitle)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
            }
        }
        .springAnimation(value: server.status)
    }
}

enum ServerActions {
    @MainActor
    static func items(_ server: DevServerInfo, botID: String) -> [GlassMenuItem] {
        let store = ServerStore.shared
        var items: [GlassMenuItem] = [
            GlassMenuItem(server.branch ?? server.name, id: "about", systemImage: server.branch == nil ? "folder" : "arrow.triangle.branch", subtitle: server.command, isEnabled: false) {}
        ]
        if server.status == .running {
            items.append(
                GlassMenuItem("Abrir no painel", systemImage: "sidebar.right", startsSection: true) {
                    store.openPanel(server, botID: botID, tab: .preview)
                })
            items.append(
                GlassMenuItem("Abrir no navegador", systemImage: "safari") {
                    store.openInBrowser(server)
                })
            items.append(
                GlassMenuItem("Copiar URL", systemImage: "link") {
                    store.copyURL(server)
                })
        }
        if server.isMobile, let device = SimulatorStore.shared.preferredDevice {
            items.append(
                GlassMenuItem(device.booted ? "Desligar \(device.name)" : "Ligar \(device.name)", systemImage: "power") {
                    SimulatorStore.shared.toggle(device)
                })
        }
        items.append(
            GlassMenuItem("Logs", systemImage: "text.alignleft", startsSection: server.status != .running) {
                store.openPanel(server, botID: botID, tab: .logs)
            })
        items.append(
            GlassMenuItem(server.status.isLive ? "Reiniciar" : "Rodar de novo", systemImage: "arrow.clockwise") {
                store.restart(server.id)
            })
        if server.status.isLive {
            items.append(
                GlassMenuItem("Parar", systemImage: "stop.fill", destructive: true) {
                    store.stop(server.id)
                })
        } else {
            items.append(
                GlassMenuItem("Tirar da lista", systemImage: "xmark") {
                    store.forget(server.id)
                })
        }
        return items
    }
}

struct InspectorRowCard<Leading: View, Content: View, Trailing: View, Footer: View>: View {
    let action: () -> Void
    @ViewBuilder let leading: Leading
    @ViewBuilder let content: Content
    @ViewBuilder let trailing: (_ hovering: Bool) -> Trailing
    @ViewBuilder var footer: Footer

    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            row
            footer
                .padding(.leading, 32 + Spacing.m)
        }
        .padding(.leading, Spacing.l)
        .padding(.trailing, Spacing.s)
        .padding(.vertical, Spacing.s)
        .frame(minHeight: Metrics.rowHeight)
        .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }

    private var row: some View {
        HStack(alignment: .center, spacing: Spacing.m) {
            Button(action: action) {
                HStack(alignment: .center, spacing: Spacing.m) {
                    leading
                        .frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        content
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            trailing(hovering)
                .frame(width: 28, height: 28)
        }
    }
}

extension InspectorRowCard where Footer == EmptyView {
    init(action: @escaping () -> Void, @ViewBuilder leading: () -> Leading, @ViewBuilder content: () -> Content, @ViewBuilder trailing: @escaping (_ hovering: Bool) -> Trailing) {
        self.init(action: action, leading: leading, content: content, trailing: trailing, footer: { EmptyView() })
    }
}

enum ProjectOpen {
    @MainActor
    static func open(_ server: DevServerInfo, botID: String) {
        let store = ServerStore.shared
        if server.isMobile, let client = store.client {
            SimulatorStore.shared.openApp(server, botID: botID, client: client)
        } else if server.tool == "wrangler" || server.status != .running {
            store.openPanel(server, botID: botID, tab: .logs)
        } else {
            store.openPanel(server, botID: botID, tab: .preview)
        }
    }
}

struct DevicePicker: View {
    private var store: SimulatorStore { .shared }

    var body: some View {
        let ios = store.iosDevices
        if let current = store.preferredDevice {
            GlassSelect(
                options: ios.map { GlassSelectOption("\($0.name) · \($0.runtime)", value: $0.udid, systemImage: "iphone", subtitle: $0.booted ? "Ligado" : nil) },
                selection: Binding(get: { current.udid }, set: { store.preferredUDID = $0 }),
                prefix: "no",
                title: current.name,
                help: "Trocar o aparelho",
                maxWidth: 190
            )
            .fixedSize()
        }
    }
}

struct ServerRow: View {
    let server: DevServerInfo
    let botID: String

    var body: some View {
        InspectorRowCard {
            ProjectOpen.open(server, botID: botID)
        } leading: {
            ServerToolTile(tool: server.tool)
        } content: {
            Text(server.title)
                .font(TypeScale.rowTitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            ServerStatusLabel(server: server, showsBranch: true)
        } trailing: { hovering in
            if ServerStore.shared.busy.contains(server.id) {
                ProgressView()
                    .controlSize(.mini)
                    .transition(.opacity)
            } else {
                GlassMenuButton(edge: .trailing, help: "Ações do servidor", items: { ServerActions.items(server, botID: botID) }) { isOpen in
                    BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen)
                }
                .fixedSize()
                .opacity(hovering ? 1 : 0.0001)
            }
        } footer: {
            if server.isMobile, server.status == .running {
                DevicePicker()
            }
        }
        .accessibilityLabel("\(server.title), \(server.status.label), porta \(server.port)\(server.branch.map { ", branch \($0)" } ?? "")")
    }
}

struct ServersSection: View {
    let bot: Bot

    @State private var running = false

    private var store: ServerStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            SectionCaption(title: "Projetos rodando") {
                Button {
                    running.toggle()
                } label: {
                    Label("Rodar projeto", systemImage: "play.fill")
                        .font(TypeScale.sectionCaption)
                        .foregroundStyle(Theme.textSecondary)
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(PressableButtonStyle())
                .glassPopup(isPresented: $running, edge: .trailing) {
                    RunProjectPopover(botID: bot.id)
                }
            }
            if store.visible.isEmpty {
                Text("Nada rodando. O servidor roda o código; a prévia (web) ou o simulador (iPhone) mostram o app.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.horizontal, Spacing.l)
                    .transition(.opacity)
            } else {
                VStack(spacing: Spacing.s) {
                    ForEach(store.visible) { server in
                        ServerRow(server: server, botID: bot.id)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
            }
            if let failure = store.failure {
                Text(failure)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, Spacing.l)
                    .transition(.opacity)
            }
        }
        .springAnimation(value: store.visible.map(\.id))
        .task(id: store.visible.contains { $0.isMobile }) {
            if store.visible.contains(where: \.isMobile) { await SimulatorStore.shared.refresh() }
        }
        .springAnimation(value: store.failure)
    }
}

struct ServerCard: View {
    @Environment(AppModel.self) private var model
    let ref: ArtifactRef

    @State private var hovering = false

    private var server: DevServerInfo? { ServerStore.shared.server(id: ref.id) }

    var body: some View {
        Group {
            if let server {
                card(server)
            } else {
                HStack(spacing: Spacing.s) {
                    Image(systemName: "stop.circle")
                        .font(.system(size: 12, weight: .medium))
                    Text("\(ref.title) · servidor encerrado")
                        .font(TypeScale.caption)
                }
                .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.leading, 20 + Spacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func card(_ server: DevServerInfo) -> some View {
        HStack(spacing: Spacing.m) {
            ServerToolTile(tool: server.tool, size: 30)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(server.title)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                ServerStatusLabel(server: server)
            }
            Spacer(minLength: Spacing.m)
            if server.status == .running, !server.isMobile {
                ServerCardButton(title: "Abrir", systemImage: "sidebar.right") {
                    ServerStore.shared.openPanel(server, botID: ref.botID, tab: .preview)
                }
            }
            ServerCardButton(title: "Logs", systemImage: "text.alignleft") {
                ServerStore.shared.openPanel(server, botID: ref.botID, tab: .logs)
            }
        }
        .padding(Spacing.m)
        .frame(width: 440, alignment: .leading)
        .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: server.status)
    }
}

struct ServerCardButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, Spacing.m)
                .frame(height: 28)
                .background(hovering ? Theme.selection : Theme.hover, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }
}
