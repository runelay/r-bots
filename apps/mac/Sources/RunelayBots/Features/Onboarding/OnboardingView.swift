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
                    AccountStep()
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
        case .account:
            return session.pendingUserCode == nil ? { store.backToServer() } : nil
        case .checking, .welcome, .outdated, .unreachable, .setup:
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

private enum AccountVariant: Equatable {
    case setup
    case signin
    case invite

    var title: String {
        switch self {
        case .setup: "Configurar este runelay bots"
        case .signin: "Entrar"
        case .invite: "Criar conta"
        }
    }

    var description: String {
        switch self {
        case .setup: "Crie a conta dona. Ela administra os bots, as conversas e as chaves deste servidor."
        case .signin: "Seus bots e conversas ficam no servidor, iguais em todos os seus Macs."
        case .invite: "Use o convite que a dona ou o dono deste servidor mandou."
        }
    }

    var submit: String {
        switch self {
        case .setup: "Criar conta dona"
        case .signin: "Entrar"
        case .invite: "Criar conta"
        }
    }
}

private struct AccountStep: View {
    private enum Field: Hashable {
        case name
        case email
        case code
        case password
    }

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var inviteMode = false
    @State private var name = ""
    @State private var email = ""
    @State private var code = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    private let session = AuthSession.shared

    private var variant: AccountVariant {
        if session.needsOwner { return .setup }
        return inviteMode ? .invite : .signin
    }

    private var asksName: Bool { variant != .signin }

    private var canSubmit: Bool {
        guard !busy, email.contains("@") else { return false }
        switch variant {
        case .setup: return !name.trimmingCharacters(in: .whitespaces).isEmpty && password.count >= 10
        case .invite: return !name.trimmingCharacters(in: .whitespaces).isEmpty && !code.isEmpty && password.count >= 10
        case .signin: return !password.isEmpty
        }
    }

    private var existingBots: Int {
        if case .loaded(let bots) = model.bots { return bots.filter { !$0.isPending }.count }
        return 0
    }

    var body: some View {
        VStack(spacing: Spacing.xxl) {
            OnboardingHeader(title: variant.title, description: subtitle)
            if let code = session.pendingUserCode {
                BrowserPending(code: code)
                    .transition(.onboarding(reduceMotion: reduceMotion))
            } else {
                form
                    .transition(.onboarding(reduceMotion: reduceMotion))
            }
        }
        .frame(width: 380)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: variant)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: error)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: session.pendingUserCode)
        .onAppear { focus = asksName ? .name : .email }
    }

    private var subtitle: String {
        if variant == .signin && session.expired { return "Sua sessão venceu. Entre de novo para continuar de onde parou." }
        return variant.description
    }

    private var form: some View {
        VStack(spacing: Spacing.l) {
            if variant == .setup && existingBots > 0 {
                Label(
                    existingBots == 1
                        ? "Seu bot e as conversas continuam aqui e passam a ser desta conta."
                        : "Seus \(existingBots) bots e as conversas continuam aqui e passam a ser desta conta.",
                    systemImage: "person.2"
                )
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.s + 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            }
            VStack(spacing: Spacing.m) {
                if asksName {
                    OnboardingField(label: "Nome") {
                        TextField("", text: $name)
                            .textContentType(.name)
                            .focused($focus, equals: .name)
                            .onSubmit { focus = .email }
                    }
                    .transition(.onboarding(reduceMotion: reduceMotion))
                }
                OnboardingField(label: "E-mail") {
                    TextField("", text: $email)
                        .textContentType(.username)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .onSubmit { focus = variant == .invite ? .code : .password }
                }
                if variant == .invite {
                    OnboardingField(label: "Código do convite", hint: "Quem administra o servidor gera o convite em Ajustes › Conta.") {
                        TextField("", text: $code, prompt: Text("rbi_…"))
                            .autocorrectionDisabled()
                            .font(BrandFonts.mono(13))
                            .focused($focus, equals: .code)
                            .onSubmit { focus = .password }
                    }
                    .transition(.onboarding(reduceMotion: reduceMotion))
                }
                OnboardingField(label: "Senha", hint: variant == .signin ? nil : "Pelo menos 10 caracteres.") {
                    SecureField("", text: $password)
                        .textContentType(variant == .signin ? .password : .newPassword)
                        .focused($focus, equals: .password)
                        .onSubmit(submit)
                }
            }
            if let error {
                Text(error)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            VStack(spacing: Spacing.s) {
                OnboardingPrimaryButton(title: variant.submit, busy: busy, action: submit)
                    .disabled(!canSubmit)
                if variant == .signin && session.status?.passkey != false {
                    Button {
                        error = nil
                        session.signInWithBrowser()
                    } label: {
                        Label("Entrar com Touch ID", systemImage: "touchid")
                            .lineLimit(1)
                            .fixedSize()
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                    }
                    .buttonStyle(.brandSecondary)
                    .disabled(busy || session.browserBusy)
                }
            }
            footer
        }
    }

    @ViewBuilder
    private var footer: some View {
        if variant != .setup {
            HStack(spacing: Spacing.xs) {
                Text(variant == .signin ? "Primeira vez?" : "Já tem conta?")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                Button(variant == .signin ? "Usar convite" : "Entrar") {
                    error = nil
                    inviteMode.toggle()
                    focus = inviteMode ? .name : .email
                }
                .buttonStyle(.plain)
                .font(TypeScale.rowSubtitle.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .clickable()
            }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        let current = variant
        Task {
            do {
                switch current {
                case .setup:
                    try await session.setupOwner(name: name, email: email, password: password)
                case .invite:
                    try await session.acceptInvite(code: code, name: name, email: email, password: password)
                case .signin:
                    try await session.signIn(email: email, password: password)
                }
                password = ""
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

private struct BrowserPending: View {
    let code: String
    private let session = AuthSession.shared

    var body: some View {
        VStack(spacing: Spacing.l) {
            Text("Confirme no navegador com Touch ID. O código tem que ser este:")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text(code)
                .font(BrandFonts.mono(22, weight: .semibold))
                .tracking(3)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .fixedSize()
                .frame(maxWidth: .infinity)
                .padding(.vertical, Spacing.m)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                .textSelection(.enabled)
            HStack(spacing: Spacing.s) {
                ProgressView()
                    .controlSize(.small)
                Text("Esperando a confirmação")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: Spacing.s)
                Button("Cancelar") {
                    session.cancelBrowser()
                }
                .buttonStyle(OnboardingGhostButtonStyle())
            }
        }
    }
}
