import SwiftUI

struct AuthGate: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @AppStorage(ServerConfig.storageKey) private var serverURL = ServerConfig.defaultURL
    private let session = AuthSession.shared

    func body(content: Content) -> some View {
        ZStack {
            content
                .allowsHitTesting(!session.blocksApp)
            if session.blocksApp {
                LoginView()
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
                    .zIndex(10)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: session.blocksApp)
        .task(id: serverURL) {
            session.onSignIn {
                RunnerConnection.shared.restart()
                Task { await model.checkConnection() }
            }
            await session.bootstrap()
        }
    }
}

extension View {
    func authGate() -> some View {
        modifier(AuthGate())
    }
}

struct LoginView: View {
    private enum Field: Hashable {
        case name
        case email
        case password
    }

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    private let session = AuthSession.shared

    private var needsOwner: Bool {
        if case .signedOut(let needsOwner) = session.state { return needsOwner }
        return false
    }

    private var canSubmit: Bool {
        !busy && email.contains("@") && password.count >= (needsOwner ? 10 : 1) && (!needsOwner || !name.isEmpty)
    }

    var body: some View {
        ZStack {
            Theme.windowFrame
                .ignoresSafeArea()
            if session.state == .checking {
                ProgressView()
                    .controlSize(.small)
                    .transition(.opacity)
            } else {
                card
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: session.state)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: error)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: session.pendingUserCode)
        .onAppear {
            focus = needsOwner ? .name : .email
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            header
            if let code = session.pendingUserCode {
                browserPending(code)
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            } else {
                form
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
            if let error {
                Text(error)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
        .padding(Spacing.xxl)
        .frame(width: 380)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.composer, style: .continuous), fallback: Theme.background)
        .softElevation(lifted: true)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                RunelayMark(size: 20)
                Text("runelay bots")
                    .font(BrandFonts.wordmark(15))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.bottom, Spacing.s)
            Text(needsOwner ? "Criar a conta do dono" : "Entrar")
                .font(TypeScale.heroName)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Text(subtitle)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(session.expired ? Theme.attention : Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var subtitle: String {
        if needsOwner { return "Primeiro acesso a este servidor. Depois disso, novas pessoas entram só por convite." }
        if session.expired { return "Sua sessão venceu. Entre de novo para continuar de onde parou." }
        return "Use a conta deste servidor."
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            if needsOwner {
                field("Nome", text: $name, field: .name, content: nil)
            }
            field("E-mail", text: $email, field: .email, content: .username)
            SecureField("", text: $password, prompt: Text(needsOwner ? "Senha (10 caracteres ou mais)" : "Senha"))
                .textContentType(needsOwner ? .newPassword : .password)
                .modifier(LoginFieldStyle())
                .focused($focus, equals: .password)
                .onSubmit(submit)
            Button(action: submit) {
                HStack(spacing: Spacing.xs + 2) {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(needsOwner ? "Criar e entrar" : "Entrar")
                        .lineLimit(1)
                        .fixedSize()
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.brandPrimary)
            .disabled(!canSubmit)
            .padding(.top, Spacing.xs)
            if !needsOwner {
                Button {
                    error = nil
                    session.signInWithBrowser()
                } label: {
                    Label("Entrar com Touch ID", systemImage: "touchid")
                        .lineLimit(1)
                        .fixedSize()
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.brandSecondary)
                .disabled(busy || session.browserBusy)
            }
        }
    }

    private func browserPending(_ code: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text("Confirme no navegador com Touch ID. O código tem que ser este:")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
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
                .buttonStyle(.brandSecondary)
            }
        }
    }

    private func field(_ title: String, text: Binding<String>, field: Field, content: NSTextContentType?) -> some View {
        TextField("", text: text, prompt: Text(title))
            .textContentType(content)
            .autocorrectionDisabled()
            .modifier(LoginFieldStyle())
            .focused($focus, equals: field)
            .onSubmit {
                focus = field == .name ? .email : .password
            }
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        Task {
            do {
                if needsOwner {
                    try await session.setupOwner(name: name, email: email, password: password)
                } else {
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

private struct LoginFieldStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(TypeScale.body)
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, Spacing.s + 2)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }
}
