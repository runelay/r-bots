import SwiftUI

struct OnboardingView: View {
    let stage: OnboardingStage

    @Environment(\.appReduceMotion) private var reduceMotion
    private let store = OnboardingStore.shared
    private let session = AuthSession.shared

    var body: some View {
        ZStack {
            Theme.windowFrame
                .ignoresSafeArea()
            Group {
                switch stage {
                case .checking:
                    ProgressView()
                        .controlSize(.small)
                case .welcome:
                    WelcomeStep()
                case .server:
                    ServerStep()
                case .outdated:
                    ServerStep(problem: .outdated)
                case .unreachable:
                    ServerStep(problem: .unreachable)
                case .account:
                    SignInScreen()
                case .setup:
                    SetupGuide()
                }
            }
            .id(stage)
            .transition(.onboarding(reduceMotion: reduceMotion))
        }
        .overlay(alignment: .topLeading) {
            if let back = backAction {
                Button(action: back) {
                    Label("Voltar", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(OnboardingGhostButtonStyle())
                .padding(.top, FrameMetrics.stripHeight + Spacing.s)
                .padding(.leading, Spacing.xl)
                .transition(.opacity)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: stage)
    }

    private var backAction: (() -> Void)? {
        switch stage {
        case .server:
            return { store.backToWelcome() }
        case .checking, .account, .welcome, .outdated, .unreachable, .setup:
            return nil
        }
    }
}

private struct WelcomeStep: View {
    private let store = OnboardingStore.shared

    var body: some View {
        VStack(spacing: Spacing.xxl) {
            OnboardingHeader(
                title: "Boas-vindas ao runelay bots",
                description: "Um time de bots que trabalha por você, no seu servidor, com as contas de IA que você já usa."
            )
            VStack(alignment: .leading, spacing: Spacing.m) {
                WelcomeLine(systemImage: "server.rack", text: "Conecte ao seu servidor")
                WelcomeLine(systemImage: "person.crop.circle", text: "Crie a conta dona")
                WelcomeLine(systemImage: "sparkles", text: "Ligue as IAs, as integrações e o Mac")
                WelcomeLine(systemImage: "person.badge.plus", text: "Monte o primeiro bot")
            }
            .padding(Spacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            OnboardingPrimaryButton(title: "Começar", systemImage: "arrow.right") {
                store.begin()
            }
        }
        .frame(width: 380)
    }
}

private struct WelcomeLine: View {
    let systemImage: String
    let text: String

    var body: some View {
        HStack(spacing: Spacing.m) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 20)
            Text(text)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
        }
    }
}

private enum ServerCheck: Equatable {
    case idle
    case testing
    case ok(latency: Int)
    case failed(String)
}

private enum ServerProblem {
    case outdated
    case unreachable

    var title: String {
        switch self {
        case .outdated: "Este servidor está desatualizado"
        case .unreachable: "Não deu para falar com o servidor"
        }
    }

    var description: String {
        switch self {
        case .outdated: "Ele não pede login, e o app só entra com conta. Atualize o servidor ou use outro endereço."
        case .unreachable: "Confira se o servidor está ligado e se o endereço está certo."
        }
    }
}

private struct ServerStep: View {
    var problem: ServerProblem?

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var address = ServerConfig.currentURL().absoluteString
    @State private var check: ServerCheck = .idle
    @FocusState private var focused: Bool
    private let store = OnboardingStore.shared

    private var candidate: URL? {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host() != nil
        else { return nil }
        return url
    }

    private var tested: Bool {
        if case .ok = check { return true }
        return false
    }

    var body: some View {
        VStack(spacing: Spacing.xxl) {
            OnboardingHeader(
                title: problem?.title ?? "Conecte ao seu servidor",
                description: problem?.description
                    ?? "O runelay bots roda num servidor seu. Instalou com o padrão neste Mac? Deixe como está."
            )
            VStack(alignment: .leading, spacing: Spacing.m) {
                OnboardingField(label: "Endereço do servidor") {
                    TextField("", text: $address, prompt: Text(ServerConfig.defaultURL))
                        .autocorrectionDisabled()
                        .focused($focused)
                        .onSubmit(primary)
                        .onChange(of: address) { check = .idle }
                }
                statusLine
                    .frame(minHeight: 20, alignment: .leading)
            }
            VStack(spacing: Spacing.s) {
                OnboardingPrimaryButton(
                    title: tested ? "Continuar" : "Testar conexão",
                    systemImage: tested ? "arrow.right" : "bolt.horizontal",
                    busy: check == .testing,
                    busyTitle: "Testando…",
                    action: primary
                )
                .disabled(candidate == nil || check == .testing)
                if address.trimmingCharacters(in: .whitespacesAndNewlines) != ServerConfig.defaultURL {
                    Button("Usar o padrão") {
                        address = ServerConfig.defaultURL
                    }
                    .buttonStyle(OnboardingGhostButtonStyle())
                    .transition(.opacity)
                }
            }
        }
        .frame(width: 380)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: check)
        .onAppear { focused = true }
    }

    @ViewBuilder
    private var statusLine: some View {
        switch check {
        case .idle:
            Text("Ex.: http://127.0.0.1:2000 ou o endereço do tailnet.")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        case .testing:
            Text("Procurando o servidor…")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
        case .ok(let latency):
            Label("Conectado em \(latency) ms", systemImage: "checkmark.circle.fill")
            .font(TypeScale.caption)
            .foregroundStyle(Theme.success)
            .transition(.opacity)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.circle.fill")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
        }
    }

    private func primary() {
        guard let candidate, check != .testing else { return }
        if tested {
            choose(candidate)
            return
        }
        check = .testing
        Task {
            let client = AuthClient(baseURL: candidate)
            let clock = ContinuousClock()
            let started = clock.now
            do {
                try await client.health()
                let latency = started.duration(to: clock.now).components
                let ms = Int(latency.seconds) * 1000 + Int(latency.attoseconds / 1_000_000_000_000_000)
                guard try await client.setupStatus() != nil else {
                    check = .failed("Este servidor está desatualizado: ele não pede login. Atualize o servidor ou use outro endereço.")
                    return
                }
                check = .ok(latency: max(ms, 1))
            } catch {
                check = .failed("Não respondeu. Confira o endereço e se o servidor está ligado.")
            }
        }
    }

    private func choose(_ url: URL) {
        let value = url.absoluteString
        if value != ServerConfig.currentURL().absoluteString {
            UserDefaults.standard.set(value, forKey: ServerConfig.storageKey)
            model.serverURLChanged()
            Task { await model.reloadAfterSignIn() }
        } else if problem != nil {
            Task { await AuthSession.shared.bootstrap(force: true) }
        }
        store.serverChosen()
    }
}
