import AppKit
import SwiftUI

enum AccountVariant: Equatable {
    case setup
    case signin
    case invite

    var title: String {
        switch self {
        case .setup: "Configure seus bots na runelay"
        case .signin: "Entrar na sua conta"
        case .invite: "Criar conta com convite"
        }
    }

    var description: String {
        switch self {
        case .setup: "Crie a conta dona deste servidor para começar."
        case .signin: "Use seus dados para entrar."
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

struct SignInScreen: View {
    static let showcaseBreakpoint: CGFloat = 900

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                SignInFormPane()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.background)
                if geometry.size.width >= Self.showcaseBreakpoint {
                    SignInShowcase()
                        .frame(width: geometry.size.width * 0.5)
                        .frame(maxHeight: .infinity)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.2), value: geometry.size.width >= Self.showcaseBreakpoint)
        }
        .ignoresSafeArea()
    }
}

private struct SignInFormPane: View {
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
    @State private var remember = true
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @FocusState private var focus: Field?
    private let session = AuthSession.shared
    private let store = OnboardingStore.shared

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

    private var socialProviders: [SocialProvider] {
        guard variant == .signin else { return [] }
        return session.providers.compactMap(SocialProvider.init(rawValue:))
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: Spacing.xl)
            ZStack {
                if let code = session.pendingUserCode {
                    BrowserPending(code: code)
                        .transition(.onboarding(reduceMotion: reduceMotion))
                } else {
                    form
                        .transition(.onboarding(reduceMotion: reduceMotion))
                }
            }
            .frame(width: 340)
            Spacer(minLength: Spacing.xl)
            footer
        }
        .padding(.horizontal, Spacing.xl)
        .padding(.bottom, Spacing.l)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: variant)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: error)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: notice)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: session.pendingUserCode)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: session.providers)
        .onAppear { focus = asksName ? .name : .email }
    }

    private var topBar: some View {
        HStack(spacing: Spacing.s) {
            Spacer(minLength: Spacing.m)
            if variant != .setup && session.pendingUserCode == nil {
                Text(variant == .signin ? "Não tem conta?" : "Já tem conta?")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .fixedSize()
                Button(variant == .signin ? "Usar convite" : "Entrar") {
                    error = nil
                    notice = nil
                    inviteMode.toggle()
                    focus = inviteMode ? .name : .email
                }
                .buttonStyle(SignInSmallButtonStyle())
            }
        }
        .frame(height: FrameMetrics.stripHeight)
    }

    private var subtitle: String {
        if variant == .signin && session.expired { return "Sua sessão venceu. Entre de novo para continuar de onde parou." }
        return variant.description
    }

    private var form: some View {
        VStack(spacing: Spacing.xl) {
            VStack(spacing: Spacing.l) {
                SignInBadge()
                VStack(spacing: Spacing.xs) {
                    Text(variant.title)
                        .font(BrandFonts.sans(21, weight: .semibold))
                        .tracking(-0.4)
                        .foregroundStyle(Theme.textPrimary)
                        .multilineTextAlignment(.center)
                    Text(subtitle)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .id(variant)
                .transition(.onboarding(reduceMotion: reduceMotion))
            }
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
            if !socialProviders.isEmpty {
                VStack(spacing: Spacing.l) {
                    HStack(spacing: Spacing.s) {
                        ForEach(socialProviders) { provider in
                            SocialButton(provider: provider) {
                                error = nil
                                session.signInWithBrowser(provider: provider.rawValue)
                            }
                            .disabled(busy || session.browserBusy)
                        }
                    }
                    OrDivider()
                }
                .transition(.opacity)
            }
            fields
            if variant == .signin {
                HStack(spacing: Spacing.s) {
                    Toggle(isOn: $remember) {
                        Text("Manter conectado")
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .toggleStyle(.checkbox)
                    .clickable()
                    Spacer(minLength: Spacing.s)
                    if session.status?.passwordReset == true {
                        Button("Esqueci a senha?", action: resetPassword)
                            .buttonStyle(.plain)
                            .font(TypeScale.rowSubtitle.weight(.medium))
                            .foregroundStyle(Theme.textPrimary)
                            .underline()
                            .clickable()
                    }
                }
            }
            if let error {
                Text(error)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            } else if let notice {
                Text(notice)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.success)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            VStack(spacing: Spacing.s) {
                Button(action: submit) {
                    HStack(spacing: Spacing.s) {
                        if busy {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.background)
                        }
                        Text(variant.submit)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .buttonStyle(SignInPrimaryButtonStyle())
                .disabled(!canSubmit)
                if variant == .signin && session.status?.passkey != false {
                    Button {
                        error = nil
                        session.signInWithBrowser()
                    } label: {
                        Label("Entrar com Touch ID", systemImage: "touchid")
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .buttonStyle(OnboardingGhostButtonStyle())
                    .disabled(busy || session.browserBusy)
                }
            }
        }
    }

    private var fields: some View {
        VStack(spacing: Spacing.l) {
            if asksName {
                SignInField(label: "Nome", systemImage: "person", text: $name, prompt: "Seu nome", content: .name)
                    .focused($focus, equals: .name)
                    .onSubmit { focus = .email }
                    .transition(.onboarding(reduceMotion: reduceMotion))
            }
            SignInField(label: "E-mail", systemImage: "envelope", text: $email, prompt: "voce@exemplo.com", content: .username)
                .focused($focus, equals: .email)
                .onSubmit { focus = variant == .invite ? .code : .password }
            if variant == .invite {
                SignInField(
                    label: "Código do convite",
                    systemImage: "ticket",
                    text: $code,
                    prompt: "rbi_…",
                    content: .oneTimeCode,
                    mono: true
                )
                .focused($focus, equals: .code)
                .onSubmit { focus = .password }
                .transition(.onboarding(reduceMotion: reduceMotion))
            }
            SignInField(
                label: "Senha",
                systemImage: "lock",
                text: $password,
                prompt: variant == .signin ? "Sua senha" : "Pelo menos 10 caracteres",
                content: variant == .signin ? .password : .newPassword,
                secure: true
            )
            .focused($focus, equals: .password)
            .onSubmit(submit)
        }
    }

    private var footer: some View {
        HStack(spacing: Spacing.m) {
            Text("© 2026 runelay bots")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
                .fixedSize()
            Spacer(minLength: Spacing.m)
            if session.pendingUserCode == nil {
                Button {
                    store.backToServer()
                } label: {
                    Label(ServerConfig.currentURL().host() ?? "Servidor", systemImage: "server.rack")
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .buttonStyle(.plain)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .clickable()
                .help("Trocar o servidor")
            }
            Label("PT", systemImage: "globe")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .fixedSize()
        }
        .frame(height: 24)
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        notice = nil
        let current = variant
        Task {
            do {
                switch current {
                case .setup:
                    try await session.setupOwner(name: name, email: email, password: password)
                case .invite:
                    try await session.acceptInvite(code: code, name: name, email: email, password: password)
                case .signin:
                    try await session.signIn(email: email, password: password, remember: remember)
                }
                password = ""
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func resetPassword() {
        guard email.contains("@") else {
            error = "Escreva o seu e-mail primeiro."
            focus = .email
            return
        }
        error = nil
        Task {
            do {
                try await session.requestPasswordReset(email: email)
                notice = "Se o e-mail tiver conta, chega um link para trocar a senha."
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

enum SocialProvider: String, Identifiable, CaseIterable {
    case apple
    case google
    case github

    var id: String { rawValue }

    var name: String {
        switch self {
        case .apple: "Apple"
        case .google: "Google"
        case .github: "GitHub"
        }
    }
}

private struct SocialButton: View {
    let provider: SocialProvider
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            SocialMark(provider: provider)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help("Entrar com \(provider.name)")
        .accessibilityLabel("Entrar com \(provider.name)")
    }
}

private struct SocialMark: View {
    let provider: SocialProvider

    var body: some View {
        switch provider {
        case .apple:
            Image(systemName: "apple.logo")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
        case .google:
            if let image = SocialLogos.google {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 16, height: 16)
            }
        case .github:
            if let image = SocialLogos.github {
                Image(nsImage: image)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 16, height: 16)
                    .foregroundStyle(Theme.textPrimary)
            }
        }
    }
}

@MainActor
private enum SocialLogos {
    static let google: NSImage? = load("google", subdirectory: "Logos/auth")
    static let github: NSImage? = {
        let image = load("github", subdirectory: "Logos/si")
        image?.isTemplate = true
        return image
    }()

    private static func load(_ name: String, subdirectory: String) -> NSImage? {
        guard let url = ResourceBundle.bundle?.url(forResource: name, withExtension: "svg", subdirectory: subdirectory) else {
            return nil
        }
        return NSImage(contentsOf: url)
    }
}

private struct OrDivider: View {
    var body: some View {
        HStack(spacing: Spacing.m) {
            Capsule()
                .fill(Theme.paneDivider)
                .frame(height: 1)
            Text("OU")
                .font(BrandFonts.sans(11, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(Theme.textTertiary)
                .fixedSize()
            Capsule()
                .fill(Theme.paneDivider)
                .frame(height: 1)
        }
    }
}

private struct SignInBadge: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(Theme.surface.opacity(0.7))
                .frame(width: 84, height: 84)
            RunelayAppMark(size: 58)
                .softElevation(lifted: true)
        }
        .accessibilityHidden(true)
    }
}

private struct SignInField: View {
    let label: String
    let systemImage: String
    @Binding var text: String
    let prompt: String
    let content: NSTextContentType
    var secure = false
    var mono = false
    @State private var revealed = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs + 2) {
            HStack(spacing: 2) {
                Text(label)
                    .foregroundStyle(Theme.textPrimary)
                Text("*")
                    .foregroundStyle(Theme.brandAccent)
                    .accessibilityHidden(true)
            }
            .font(TypeScale.captionStrong)
            HStack(spacing: Spacing.s) {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: 16)
                Group {
                    if secure && !revealed {
                        SecureField("", text: $text, prompt: Text(prompt))
                    } else {
                        TextField("", text: $text, prompt: Text(prompt))
                            .autocorrectionDisabled()
                    }
                }
                .textContentType(content)
                .textFieldStyle(.plain)
                .font(mono ? BrandFonts.mono(13) : TypeScale.body)
                if secure {
                    Button {
                        revealed.toggle()
                    } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye")
                            .font(.system(size: 13, weight: .regular))
                            .foregroundStyle(Theme.textTertiary)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .clickable()
                    .help(revealed ? "Esconder a senha" : "Mostrar a senha")
                    .accessibilityLabel(revealed ? "Esconder a senha" : "Mostrar a senha")
                }
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 44)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
    }
}

private struct SignInPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(BrandFonts.sans(14, weight: .semibold))
            .foregroundStyle(Theme.background)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(
                LinearGradient(
                    colors: [Theme.textPrimary.opacity(hovering ? 0.86 : 0.92), Theme.textPrimary],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
            )
            .opacity(isEnabled ? (configuration.isPressed ? 0.88 : 1) : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .clickable()
            .onHover { hovering = $0 }
            .animation(Motion.animation(reduceMotion: reduceMotion), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}

private struct SignInSmallButtonStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textPrimary)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, Spacing.m)
            .frame(height: 28)
            .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .clickable()
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}

private struct BrowserPending: View {
    let code: String
    private let session = AuthSession.shared

    var body: some View {
        VStack(spacing: Spacing.l) {
            SignInBadge()
            Text("Confirme no navegador. O código tem que ser este:")
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

private struct ShowcaseSlide {
    let lead: String
    let rest: String
    let moods: [CharacterMood]
}

private struct SignInShowcase: View {
    private static let slides = [
        ShowcaseSlide(
            lead: "Um time de bots que trabalha por você.",
            rest: " Cada um tem nome, rosto e função, e conversa como um colega.",
            moods: [.speaking, .idle, .thinking]
        ),
        ShowcaseSlide(
            lead: "Seus bots usam as IAs que você já assina.",
            rest: " Claude, Codex, Cursor e Grok, rodando no seu servidor.",
            moods: [.thinking, .speaking, .idle]
        ),
        ShowcaseSlide(
            lead: "Nada importante acontece sem você.",
            rest: " Ações sensíveis pedem aprovação e os segredos ficam no seu Mac.",
            moods: [.waiting, .idle, .speaking]
        ),
    ]
    private static let cast: [(id: String, glyph: String, accent: String)] = [
        ("showcase-crown", "crown", "orange"),
        ("showcase-visor", "visor", "violet"),
        ("showcase-antenna", "antenna", "teal"),
    ]

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var index = 0
    @State private var hovering = false

    var body: some View {
        let slide = Self.slides[index]
        ZStack {
            Theme.surface
            ShowcaseGrid()
            VStack(alignment: .leading, spacing: Spacing.xxl) {
                HStack(spacing: Spacing.l) {
                    ForEach(Array(Self.cast.enumerated()), id: \.offset) { position, member in
                        BotCharacter(
                            botID: member.id,
                            glyph: member.glyph,
                            accent: member.accent,
                            mood: slide.moods[position],
                            size: 44
                        )
                        .frame(width: 56, height: 56)
                        .background(Theme.background.opacity(0.7), in: Circle())
                    }
                }
                (Text(slide.lead).foregroundStyle(Theme.textPrimary)
                    + Text(slide.rest).foregroundStyle(Theme.textSecondary))
                    .font(BrandFonts.sans(26, weight: .semibold))
                    .tracking(-0.6)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .id(index)
                    .transition(.opacity)
                HStack(spacing: Spacing.xs + 2) {
                    ForEach(Self.slides.indices, id: \.self) { position in
                        Button {
                            withAnimation(Motion.animation(reduceMotion: reduceMotion)) { index = position }
                        } label: {
                            Capsule()
                                .fill(position == index ? Theme.textPrimary : Theme.textTertiary.opacity(0.5))
                                .frame(width: position == index ? 18 : 6, height: 6)
                                .frame(height: 16)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .clickable()
                        .accessibilityLabel("Mostrar a frase \(position + 1)")
                    }
                }
            }
            .frame(maxWidth: 440, alignment: .leading)
            .padding(.horizontal, Spacing.xxl * 2)
        }
        .onHover { hovering = $0 }
        .task(id: hovering ? -1 : index) {
            guard !hovering else { return }
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            withAnimation(reduceMotion ? Motion.reduced : .easeInOut(duration: 0.6)) {
                index = (index + 1) % Self.slides.count
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ShowcaseGrid: View {
    var body: some View {
        Canvas { context, size in
            let step: CGFloat = 40
            var path = Path()
            var x: CGFloat = 0
            while x <= size.width {
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: size.height))
                x += step
            }
            var y: CGFloat = 0
            while y <= size.height {
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: size.width, y: y))
                y += step
            }
            context.stroke(path, with: .foreground, lineWidth: 1)
        }
        .foregroundStyle(Theme.textPrimary.opacity(0.05))
        .mask(
            RadialGradient(
                colors: [Theme.maskVisible, Theme.maskHidden],
                center: .center,
                startRadius: 40,
                endRadius: 420
            )
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
