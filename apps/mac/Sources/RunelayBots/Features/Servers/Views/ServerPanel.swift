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
            Group {
                if let server {
                    switch tab.wrappedValue {
                    case .preview:
                        preview(server)
                            .transition(.opacity)
                    case .logs:
                        ServerLogView(store: logs)
                            .transition(.opacity)
                    }
                } else {
                    PanelEmptyState(systemImage: "stop.circle", title: "Servidor encerrado", message: "Ele foi parado ou saiu da lista.")
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .springAnimation(value: tab.wrappedValue)
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
                    ServerStatusLabel(server: server)
                }
                .layoutPriority(1)
            }
            Spacer(minLength: Spacing.m)
            if let server, !server.isMobile {
                PillTabs(tabs: ServerStore.PanelTab.allCases, selection: tab) { $0.title }
                    .scaleEffect(0.9)
                    .fixedSize()
            }
            if let server {
                if server.status == .running, !server.isMobile {
                    BlockHeaderButton(systemImage: "arrow.clockwise.circle", help: "Recarregar a prévia") {
                        reloadToken += 1
                    }
                    BlockHeaderButton(systemImage: "safari", help: "Abrir no navegador") {
                        store.openInBrowser(server)
                    }
                }
                GlassMenuButton(edge: .trailing, help: "Ações do servidor", items: { ServerActions.items(server, botID: ref.botID) }) { isOpen in
                    BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen)
                }
                .fixedSize()
            }
            BlockHeaderButton(
                systemImage: presentation.fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                help: presentation.fullScreen ? "Voltar ao painel  ⇧⌘F" : "Tela cheia  ⇧⌘F",
                isActive: presentation.fullScreen
            ) {
                presentation.toggleFullScreen()
            }
            BlockHeaderButton(systemImage: "xmark", help: "Fechar") {
                presentation.close()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 48)
        .springAnimation(value: server?.status)
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
