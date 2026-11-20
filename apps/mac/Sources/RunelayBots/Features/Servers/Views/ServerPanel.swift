import SwiftUI

struct ServerPanel: View {
    let ref: ArtifactRef

    @State private var logs: ServerLogStore
    @State private var reloadToken = 0

    private var store: ServerStore { .shared }
    private var presentation: BlockPresentation { .shared }
    private var server: DevServerInfo? { store.server(id: ref.id) }

    init(ref: ArtifactRef) {
        self.ref = ref
        _logs = State(initialValue: ServerLogStore(serverID: ref.id))
    }

    private var tab: Binding<ServerStore.PanelTab> {
        Binding(
            get: { store.panelTab(for: ref.id) },
            set: { store.panelTabs[ref.id] = $0 }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .zIndex(1)
            if let server, !server.isMobile {
                HStack {
                    PillTabs(tabs: ServerStore.PanelTab.allCases, selection: tab) { $0.title }
                        .fixedSize()
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Spacing.m)
                .padding(.bottom, Spacing.s)
            }
            ZStack {
                if let server {
                    let showsPreview = tab.wrappedValue == .preview && !server.isMobile
                    if !server.isMobile {
                        preview(server)
                            .opacity(showsPreview ? 1 : 0)
                            .allowsHitTesting(showsPreview)
                            .accessibilityHidden(!showsPreview)
                    }
                    ServerLogView(store: logs)
                        .opacity(showsPreview ? 0 : 1)
                        .allowsHitTesting(!showsPreview)
                        .accessibilityHidden(showsPreview)
                } else {
                    PanelEmptyState(systemImage: "stop.circle", title: "Servidor encerrado", message: "Ele foi parado ou saiu da lista.")
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Motion.spring, value: tab.wrappedValue)
        }
        .onAppear {
            if let client = store.client {
                logs.start(client: client)
            }
        }
        .onDisappear {
            logs.stop()
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            if let server {
                ServerToolTile(tool: server.tool, size: 28)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(server.title)
                        .font(TypeScale.rowSubtitle.weight(.medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    ServerStatusLabel(server: server, showsBranch: true)
                }
                .layoutPriority(1)
            }
            Spacer(minLength: Spacing.s)
            if let server, server.status == .running, !server.isMobile {
                BlockHeaderButton(systemImage: "safari", help: "Abrir no navegador") {
                    store.openInBrowser(server)
                }
            }
            BlockHeaderButton(
                systemImage: presentation.fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                help: presentation.fullScreen ? "Voltar ao painel  ⇧⌘F" : "Tela cheia  ⇧⌘F",
                isActive: presentation.fullScreen
            ) {
                presentation.toggleFullScreen()
            }
            if let server {
                GlassMenuButton(edge: .trailing, help: "Mais", items: { menuItems(server) }) { isOpen in
                    BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen)
                }
                .fixedSize()
            }
            BlockHeaderButton(systemImage: "xmark", help: "Fechar") {
                presentation.close()
            }
            .layoutPriority(2)
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 48)
        .springAnimation(value: server?.status)
    }

    private func menuItems(_ server: DevServerInfo) -> [GlassMenuItem] {
        var items: [GlassMenuItem] = []
        if server.status == .running, !server.isMobile {
            items.append(GlassMenuItem("Recarregar a prévia", systemImage: "arrow.clockwise.circle") {
                reloadToken += 1
                store.panelTabs[ref.id] = .preview
            })
        }
        items += ServerActions.items(server, botID: ref.botID).filter { $0.id != "Abrir no painel" && $0.id != "Logs" && $0.id != "Abrir no navegador" }
        return items
    }

    @ViewBuilder
    private func preview(_ server: DevServerInfo) -> some View {
        if server.status == .running, let url = store.previewURL(for: server) {
            ArtifactWebView(url: url, focusToken: reloadToken)
                .id("\(url.absoluteString)#\(reloadToken)")
        } else if server.status == .starting {
            VStack(spacing: Spacing.m) {
                ProgressView()
                    .controlSize(.small)
                Text("Subindo \(server.toolLabel)…")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            PanelEmptyState(
                systemImage: server.status == .exited ? "exclamationmark.triangle" : "stop.circle",
                title: server.status == .exited ? "O servidor caiu" : "Servidor parado",
                message: "Veja os logs ou rode de novo pelo menu."
            )
            .frame(maxHeight: .infinity)
        }
    }
}

struct ServerLogView: View {
    @Bindable var store: ServerLogStore

    @State private var follow = true

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                BlockSearchField(text: $store.query, prompt: "Buscar no log")
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(store.plainText, forType: .string)
                } label: {
                    BlockHeaderIcon(systemImage: "doc.on.doc", isActive: false)
                }
                .buttonStyle(PressableButtonStyle())
                .help("Copiar o log")
            }
            .padding(.horizontal, Spacing.l)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(store.filtered) { line in
                            Text(line.text)
                                .font(TypeScale.mono)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("end")
                            .onAppear { follow = true }
                            .onDisappear { follow = false }
                    }
                    .padding(.horizontal, Spacing.l)
                    .padding(.bottom, Spacing.l)
                }
                .scrollEdgesHidden()
                .overlay {
                    if store.filtered.isEmpty {
                        Text(store.query.isEmpty ? "Sem linhas ainda." : "Nada encontrado.")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .transition(.opacity)
                    }
                }
                .onChange(of: store.lines.last?.id) { _, _ in
                    if follow {
                        proxy.scrollTo("end", anchor: .bottom)
                    }
                }
                .onAppear {
                    proxy.scrollTo("end", anchor: .bottom)
                }
            }
        }
        .padding(.top, Spacing.xs)
    }
}
