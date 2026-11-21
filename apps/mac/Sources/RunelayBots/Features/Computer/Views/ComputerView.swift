import AppKit
import SwiftUI

struct ComputerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let bot: Bot

    @State private var address = ""
    @State private var showsActions = false
    @State private var showsControlHint = false
    @FocusState private var addressFocused: Bool

    private var store: BrowserStore { model.browser }
    private var live: BrowserLiveSession? { model.liveSession }
    private var isLive: Bool { live.map { $0.phase != .unsupported } ?? false }
    private var isDesktop: Bool { model.computerSurface == "desktop" }
    private var status: BotStatus { model.status(for: bot.id) }
    private var isUserControlled: Bool { isLive && live?.isUserControlled == true }

    private var currentURL: String {
        if isLive, let live, !live.url.isEmpty {
            return live.url
        }
        return store.info?.url ?? ""
    }

    private var pendingApproval: Approval? {
        model.selectedConversation?.approvals.values
            .filter { $0.isOpen && $0.secretForm == nil }
            .sorted { $0.id < $1.id }
            .first
    }

    var body: some View {
        VStack(spacing: 0) {
            chrome
            ZStack {
                pageArea
                VStack {
                    Spacer(minLength: 0)
                    HStack(alignment: .bottom) {
                        actionsButton
                        Spacer(minLength: Spacing.m)
                        if let approval = pendingApproval {
                            MiniApprovalCard(
                                approval: approval,
                                call: approval.callID.flatMap { model.selectedConversation?.toolCalls[$0] }
                            ) { optionID in
                                model.selectedConversation?.respond(approvalID: approval.id, optionID: optionID)
                            }
                            .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .bottomTrailing)))
                        }
                    }
                    .padding(Spacing.l)
                }
                VStack {
                    Spacer(minLength: 0)
                    controlPill
                        .padding(.bottom, Spacing.l)
                }
            }
            .background(Theme.railBackground)
        }
        .task(id: "\(bot.id)|\(isLive)|\(isDesktop)") {
            guard !isLive, !isDesktop else { return }
            await store.run(client: model.client, botID: bot.id) {
                fastPolling ? 1 : 5
            }
        }
        .onAppear {
            address = currentURL
        }
        .onChange(of: currentURL) {
            if !addressFocused {
                address = currentURL
            }
        }
        .springAnimation(value: showsControlHint)
        .springAnimation(value: isUserControlled)
        .springAnimation(value: pendingApproval?.id)
    }

    private var fastPolling: Bool {
        if status == .working {
            return true
        }
        if let ended = model.selectedConversation?.lastTurnEndedAt {
            return Date().timeIntervalSince(ended) < 30
        }
        return false
    }

    private var chrome: some View {
        VStack(spacing: 0) {
            HStack(spacing: Spacing.s) {
                if bot.hasBrowser && bot.hasDesktop {
                    ChoicePills(
                        options: ComputerSurfaceOption.allCases,
                        selection: Binding(
                            get: { ComputerSurfaceOption(rawValue: model.computerSurface) ?? .browser },
                            set: { model.switchComputerSurface($0.rawValue) }
                        ),
                        title: \.title
                    )
                }
                if isDesktop {
                    Text(pageTitle.isEmpty ? "Desktop de \(bot.name)" : pageTitle)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(spacing: Spacing.xxs) {
                        RoundIconButton(systemImage: "arrow.backward", help: "Voltar página", size: 28) {
                            live?.command("back")
                        }
                        .disabled(!(isLive && live?.canGoBack == true))
                        RoundIconButton(systemImage: "arrow.forward", help: "Avançar página", size: 28) {
                            live?.command("forward")
                        }
                        .disabled(!(isLive && live?.canGoForward == true))
                        RoundIconButton(
                            systemImage: live?.loading == true ? "xmark" : "arrow.clockwise",
                            help: live?.loading == true ? "Parar" : "Recarregar",
                            size: 28
                        ) {
                            live?.command(live?.loading == true ? "stop" : "reload")
                        }
                        .disabled(!isLive)
                    }

                    addressField
                }

                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                    .help(statusText)
                    .accessibilityLabel(statusText)

                RoundIconButton(systemImage: "xmark", help: "Fechar (Esc)") {
                    model.closeComputer()
                }
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 52)

            LoadingLine(isLoading: isLive && live?.loading == true)
                .frame(height: 2)
        }
    }

    private var addressField: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: lockSymbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
                .symbolEffect(.pulse, options: .repeating, isActive: store.isOpening)
            TextField("Digite um endereço e tecle Enter", text: $address)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
                .focused($addressFocused)
                .onSubmit {
                    if isLive, let live {
                        live.navigate(address)
                    } else {
                        model.openPage(address)
                    }
                    addressFocused = false
                }
                .contextMenu {
                    Button {
                        let pasteboard = NSPasteboard.general
                        pasteboard.clearContents()
                        pasteboard.setString(currentURL, forType: .string)
                    } label: {
                        Label("Copiar endereço", systemImage: "doc.on.doc")
                    }
                }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 32)
        .frame(maxWidth: .infinity)
        .glassSurface(Capsule(), interactive: true, fallback: addressFocused ? Theme.surfaceRaised : Theme.surface)
        .help(pageTitle)
        .springAnimation(value: addressFocused)
    }

    private var pageArea: some View {
        ZStack {
            BrowserCanvas(
                session: isLive ? live : nil,
                fallbackImage: isLive || isDesktop ? nil : store.image,
                fallbackVersion: store.imageVersion,
                isInteractive: isUserControlled,
                onInput: { message in
                    live?.send(message)
                },
                onBlockedClick: {
                    guard isLive else { return }
                    showsControlHint = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.6))
                        showsControlHint = false
                    }
                }
            )

            if isLive, let live, live.isStale || !live.hasFrame {
                OverlayCaption(text: isDesktop ? "Conectando ao desktop…" : "Conectando ao navegador…", showsSpinner: true)
                    .transition(.opacity)
            } else if isDesktop && !isLive {
                VStack(spacing: Spacing.s) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(Theme.textTertiary)
                    Text("O desktop ainda não está disponível no servidor.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                }
            } else if !isLive && store.image == nil {
                emptyState
            }

            if let replay = model.browserReplay, !isDesktop {
                BrowserReplayView(replay: replay)
                    .transition(.opacity)
            }

            if showsControlHint {
                VStack {
                    Spacer()
                    OverlayCaption(text: "Assuma o controle para interagir", showsSpinner: false)
                        .padding(.bottom, 76)
                }
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: live?.hasFrame)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: live?.isStale)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: model.browserReplay)
    }

    private var controlPill: some View {
        HStack(spacing: Spacing.m) {
            HStack(spacing: Spacing.s) {
                Image(systemName: isUserControlled ? "hand.point.up.left.fill" : "eye")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isUserControlled ? Theme.brandText : Theme.textSecondary)
                    .contentTransition(.symbolEffect(.replace))
                Text(isUserControlled ? "Você está no controle" : "Assistindo")
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .contentTransition(.opacity)
            }
            .padding(.leading, Spacing.m)
            if isLive {
                if isUserControlled {
                    Button("Devolver ao bot") {
                        model.setBrowserControl(user: false)
                    }
                    .buttonStyle(.brandSecondary)
                } else {
                    Button("Assumir o controle") {
                        model.setBrowserControl(user: true)
                    }
                    .buttonStyle(.brandPrimary)
                }
            }
        }
        .padding(Spacing.xs + 2)
        .padding(.trailing, isLive ? 0 : Spacing.s)
        .glassSurface(Capsule(), fallback: Theme.surfaceRaised)
    }

    private var actionsButton: some View {
        let actions = (model.selectedConversation?.orderedToolCalls ?? []).filter { $0.name.hasPrefix("browser") }
        return Button {
            showsActions.toggle()
        } label: {
            HStack(spacing: Spacing.xs + 2) {
                Image(systemName: "list.bullet")
                    .font(.system(size: 11, weight: .medium))
                Text(actions.isEmpty ? "Ações" : "Ações (\(actions.count))")
                    .font(TypeScale.captionStrong)
            }
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, Spacing.m)
            .frame(height: 30)
            .glassSurface(Capsule(), interactive: true, fallback: Theme.surfaceRaised)
        }
        .buttonStyle(PressableButtonStyle())
        .popover(isPresented: $showsActions, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: Spacing.s) {
                Label("Ações do navegador", systemImage: "list.bullet")
                    .font(TypeScale.sectionCaption)
                    .foregroundStyle(Theme.textSecondary)
                if actions.isEmpty {
                    Text("Nenhuma ação nesta conversa.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                } else {
                    ScrollView {
                        VStack(spacing: Spacing.xxs) {
                            ForEach(actions.reversed()) { call in
                                CompactToolRow(call: call)
                            }
                        }
                    }
                    .scrollEdgesHidden()
                    .frame(maxHeight: 320)
                }
            }
            .padding(Spacing.m)
            .frame(width: 380)
            .environment(model)
        }
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.s) {
            Image(systemName: "globe")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Theme.textTertiary)
            Text(store.state == .loading ? "Carregando a página…" : "Nenhuma página aberta ainda")
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
            Text("Digite um endereço na barra acima para testar o navegador de \(bot.name), ou peça na conversa.")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
    }

    private var pageTitle: String {
        if isLive, let live, !live.title.isEmpty {
            return live.title
        }
        return store.info?.title ?? ""
    }

    private var lockSymbol: String {
        if store.isOpening || (isLive && live?.loading == true) {
            return "circle.dotted"
        }
        return currentURL.hasPrefix("https://") ? "lock.fill" : "globe"
    }

    private var statusText: String {
        if isUserControlled {
            return "Você está no controle"
        }
        switch status {
        case .working: return "Navegando"
        case .awaitingApproval: return "Esperando aprovação"
        default: return "Em repouso"
        }
    }

    private var statusColor: Color {
        if isUserControlled {
            return Theme.brandAccent
        }
        switch status {
        case .working: return Theme.brandAccent
        case .awaitingApproval: return Theme.attention
        default: return Theme.textTertiary
        }
    }
}

struct MiniApprovalCard: View {
    let approval: Approval
    let call: ToolCall?
    let answer: (String) -> Void

    var body: some View {
        let phrase = ActionPhrase(approval: approval, call: call)
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                if let image = approval.previewImage.flatMap(NSImage.init(data:)) {
                    ActionThumbnail(image: image, width: 56, height: 38)
                } else {
                    ActionIcon(phrase: phrase, connector: call?.connectorName, size: 18)
                        .frame(width: 32, height: 32)
                        .background(Theme.selection, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(phrase.text)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                    if let reason = approval.reason {
                        Text(reason)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                }
            }
            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                Button("Agora não") { answer("deny") }
                    .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                Button("Permitir") { answer("approve") }
                    .buttonStyle(SmallPillButtonStyle(kind: .primary))
            }
        }
        .padding(Spacing.m)
        .frame(width: 320, alignment: .leading)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.medium + 2, style: .continuous), fallback: Theme.surfaceRaised)
    }
}

struct OverlayCaption: View {
    let text: String
    let showsSpinner: Bool

    var body: some View {
        HStack(spacing: Spacing.s) {
            if showsSpinner {
                ProgressView()
                    .controlSize(.small)
            }
            Text(text)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 32)
        .background(Theme.surfaceRaised, in: Capsule())
        .softElevation()
    }
}

struct LoadingLine: View {
    let isLoading: Bool
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            if isLoading {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion || !AppActivity.shared.isLive)) { context in
                    let progress = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
                    Capsule()
                        .fill(Theme.brandAccent)
                        .frame(width: geometry.size.width * 0.3)
                        .offset(x: reduceMotion ? 0 : (geometry.size.width * 1.3) * progress - geometry.size.width * 0.3)
                }
                .transition(.opacity)
            }
        }
        .clipped()
    }
}

enum ComputerSurfaceOption: String, CaseIterable, Identifiable {
    case browser
    case desktop

    var id: String { rawValue }

    var title: String {
        switch self {
        case .browser: "Navegador"
        case .desktop: "Desktop"
        }
    }
}
