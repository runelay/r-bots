import SwiftUI

struct SignInScreen: View {
    private enum Field: Hashable {
        case server
        case email
        case password
    }

    private let session = AuthSession.shared
    @State private var server = UserDefaults.standard.string(forKey: ServerConfig.storageKey) ?? ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var signedIn = 0
    @FocusState private var focus: Field?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var canSubmit: Bool {
        !busy && ServerConfig.parse(AuthSession.normalized(server)) != nil && email.contains("@") && !password.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.xxl) {
                header
                VStack(spacing: Spacing.l) {
                    field("Servidor", hint: "Endereço do seu r/bots, com a porta.") {
                        TextField("http://100.64.0.1:2000", text: $server)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .server)
                            .submitLabel(.next)
                            .onSubmit { focus = .email }
                    }
                    field("E-mail") {
                        TextField("voce@exemplo.com", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focus = .password }
                    }
                    field("Senha") {
                        SecureField("Sua senha", text: $password)
                            .textContentType(.password)
                            .focused($focus, equals: .password)
                            .submitLabel(.go)
                            .onSubmit(submit)
                    }
                }
                if let error {
                    Text(error)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.danger)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(Motion.insertion(reduceMotion: reduceMotion))
                }
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, Spacing.xl)
            .padding(.top, 72)
            .padding(.bottom, Spacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button(action: submit) {
                HStack(spacing: Spacing.s) {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                            .tint(Theme.onAccent)
                    }
                    Text(busy ? "Entrando…" : "Entrar")
                }
            }
            .buttonStyle(BrandPrimaryButtonStyle())
            .disabled(!canSubmit)
            .frame(maxWidth: 420)
            .padding(.horizontal, Spacing.xl)
            .padding(.top, Spacing.s)
            .padding(.bottom, Spacing.m)
            .frame(maxWidth: .infinity)
            .background(Theme.background)
        }
        .background(Theme.background.ignoresSafeArea())
        .animation(Motion.animation(reduceMotion: reduceMotion), value: error)
        .sensoryFeedback(.success, trigger: signedIn)
        .onAppear {
            if session.expired {
                error = "Sua sessão expirou. Entre de novo."
            } else if session.state == .unreachable {
                error = "Não consegui falar com o servidor. Confira o endereço."
            }
            focus = server.isEmpty ? .server : .email
        }
    }

    private var header: some View {
        VStack(spacing: Spacing.l) {
            RunelayAppMark(size: 64)
            VStack(spacing: Spacing.xs + 2) {
                Text("Entrar no r/bots")
                    .font(BrandFonts.sans(26, weight: .semibold))
                    .tracking(-0.5)
                    .foregroundStyle(Theme.textPrimary)
                Text("Conecte ao seu servidor para acompanhar o time de bots.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func field<Content: View>(_ label: String, hint: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Text(label)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
            content()
                .font(BrandFonts.sans(16))
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, Spacing.l)
                .frame(height: 50)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            if let hint {
                Text(hint)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        focus = nil
        Task {
            defer { busy = false }
            do {
                try await session.signIn(server: server, email: email, password: password)
                password = ""
                signedIn += 1
            } catch let failure as AuthFailure {
                switch failure {
                case .server(401, _):
                    error = "E-mail ou senha não conferem."
                default:
                    error = failure.errorDescription ?? "Não deu para entrar."
                }
            } catch {
                self.error = ErrorMessage.describe(error)
            }
        }
    }
}
