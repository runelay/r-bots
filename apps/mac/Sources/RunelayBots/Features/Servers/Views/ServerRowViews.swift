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
            .help(ServerTool.label(tool))
    }
}

struct ServerStatusLabel: View {
    let server: DevServerInfo

    var body: some View {
        HStack(spacing: Spacing.xs + 2) {
            ServerStatusDot(status: server.status)
            Text(server.status.label)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
                .contentTransition(.opacity)
            if server.status.isLive {
                Text(":\(server.port)")
                    .font(TypeScale.monoInline)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .springAnimation(value: server.status)
    }
}

enum ServerActions {
    @MainActor
    static func items(_ server: DevServerInfo, botID: String) -> [GlassMenuItem] {
        let store = ServerStore.shared
        var items: [GlassMenuItem] = []
        if server.status == .running {
            items.append(GlassMenuItem("Abrir no painel", systemImage: "sidebar.right") {
                store.openPanel(server, botID: botID, tab: .preview)
            })
            items.append(GlassMenuItem("Abrir no navegador", systemImage: "safari") {
                store.openInBrowser(server)
            })
            items.append(GlassMenuItem("Copiar URL", systemImage: "link") {
                store.copyURL(server)
            })
        }
        items.append(GlassMenuItem("Logs", systemImage: "text.alignleft", startsSection: server.status == .running) {
            store.openPanel(server, botID: botID, tab: .logs)
        })
        items.append(GlassMenuItem(server.status.isLive ? "Reiniciar" : "Rodar de novo", systemImage: "arrow.clockwise") {
            store.restart(server.id)
        })
        if server.status.isLive {
            items.append(GlassMenuItem("Parar", systemImage: "stop.fill", destructive: true) {
                store.stop(server.id)
            })
        } else {
            items.append(GlassMenuItem("Tirar da lista", systemImage: "xmark") {
                store.forget(server.id)
            })
        }
        return items
    }
}

struct ServerRow: View {
    let server: DevServerInfo
    let botID: String

    @State private var hovering = false

    var body: some View {
        HStack(spacing: Spacing.m) {
            Button {
                ServerStore.shared.openPanel(server, botID: botID, tab: server.status == .running && !server.isMobile ? .preview : .logs)
            } label: {
                HStack(spacing: Spacing.m) {
                    ServerToolTile(tool: server.tool)
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(server.title)
                            .font(TypeScale.rowTitle)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        HStack(spacing: Spacing.s) {
                            ServerStatusLabel(server: server)
                            if !server.subtitle.isEmpty {
                                Text(server.subtitle)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textTertiary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            .help(server.command)

            if ServerStore.shared.busy.contains(server.id) {
                ProgressView()
                    .controlSize(.mini)
                    .transition(.opacity)
            }
            GlassMenuButton(edge: .trailing, help: "Ações do servidor", items: { ServerActions.items(server, botID: botID) }) { isOpen in
                BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen)
            }
            .fixedSize()
            .opacity(hovering ? 1 : 0.0001)
        }
        .padding(.vertical, Spacing.xs)
        .padding(.horizontal, Spacing.s)
        .background(hovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }
}

struct ServersSection: View {
    let bot: Bot

    @State private var running = false

    private var store: ServerStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            SectionCaption(title: "Servidores") {
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
                Text("Nada rodando. Suba o app, a API ou o Expo de um repositório liberado.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.horizontal, Spacing.xs)
                    .transition(.opacity)
            } else {
                VStack(spacing: Spacing.xxs) {
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
                    .padding(.horizontal, Spacing.xs)
                    .transition(.opacity)
            }
        }
        .springAnimation(value: store.visible.map(\.id))
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
        .help(server.command)
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
