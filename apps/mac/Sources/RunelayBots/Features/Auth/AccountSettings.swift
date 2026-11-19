import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct AccountSettings: View {
    private let session = AuthSession.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            if let user = session.user {
                PhotoGroup(hasPhoto: user.image != nil)
                ProfileGroup(user: user)
                PasswordGroup()
            } else {
                SystemIdentityGroup()
                Text(session.serverSupportsLogin
                    ? "Você está usando este servidor sem conta. Crie a conta dona para proteger os bots e as conversas."
                    : "Este servidor ainda não pede login. Quando ele for atualizado, o app pede para criar a conta dona.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            OnboardingGroup()
        }
    }
}

private struct SystemIdentityGroup: View {
    private let identity = UserIdentity.shared

    var body: some View {
        SettingsGroup(caption: "Neste Mac") {
            HStack(spacing: Spacing.m) {
                UserAvatar(size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(identity.displayName)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text("Nome e foto da sua conta do macOS.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.m)
        }
    }
}

private struct PhotoGroup: View {
    let hasPhoto: Bool
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var busy = false
    @State private var targeted = false
    @State private var failure: String?
    private let session = AuthSession.shared
    private let identity = UserIdentity.shared

    var body: some View {
        SettingsGroup(caption: "Foto") {
            HStack(spacing: Spacing.l) {
                UserAvatar(size: 64)
                    .overlay {
                        Circle()
                            .strokeBorder(Theme.brandAccent, lineWidth: 2)
                            .opacity(targeted ? 1 : 0)
                    }
                    .overlay {
                        if busy {
                            Circle()
                                .fill(Theme.scrim)
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                VStack(alignment: .leading, spacing: 2) {
                    Text(hasPhoto ? "Sua foto" : "Adicione uma foto")
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text(failure ?? "Escolha ou arraste uma imagem. Ela é recortada em quadrado.")
                        .font(TypeScale.caption)
                        .foregroundStyle(failure == nil ? Theme.textSecondary : Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.opacity)
                }
                Spacer(minLength: Spacing.m)
                if hasPhoto {
                    Button("Remover", action: remove)
                        .buttonStyle(.brandSecondary)
                        .disabled(busy)
                }
                Button(action: choose) {
                    HStack(spacing: Spacing.xs + 2) {
                        Image(systemName: "photo")
                            .font(.system(size: 12, weight: .semibold))
                        Text(hasPhoto ? "Trocar" : "Escolher")
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .buttonStyle(.brandSecondary)
                .disabled(busy)
            }
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.m)
            .contentShape(Rectangle())
            .dropDestination(for: URL.self) { urls, _ in
                guard let url = urls.first, let image = NSImage(contentsOf: url) else { return false }
                upload(image)
                return true
            } isTargeted: { targeted = $0 }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: targeted)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: failure)
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = "Usar foto"
        guard panel.runModal() == .OK, let url = panel.url, let image = NSImage(contentsOf: url) else { return }
        upload(image)
    }

    private func upload(_ image: NSImage) {
        guard !busy else { return }
        guard let data = AvatarImage.squareJPEG(from: image) else {
            failure = "Não deu para ler essa imagem."
            return
        }
        failure = nil
        busy = true
        if let preview = NSImage(data: data) {
            identity.show(preview, for: nil)
        }
        Task {
            do {
                try await session.uploadAvatar(data, mime: "image/jpeg")
                if let preview = NSImage(data: data) {
                    identity.show(preview, for: session.user?.image)
                }
            } catch {
                failure = error.localizedDescription
                await identity.refresh()
            }
            busy = false
        }
    }

    private func remove() {
        busy = true
        failure = nil
        Task {
            do {
                try await session.removeAvatar()
            } catch {
                failure = error.localizedDescription
            }
            await identity.refresh()
            busy = false
        }
    }
}

private struct ProfileGroup: View {
    let user: AuthUser
    @State private var leaving = false
    private let session = AuthSession.shared

    var body: some View {
        SettingsGroup(caption: "Conta") {
            SettingsRow(title: user.name, detail: user.isOwner ? "\(user.email) · dona da conta" : user.email) {
                Button {
                    leaving = true
                    Task {
                        await session.signOut()
                        leaving = false
                    }
                } label: {
                    HStack(spacing: Spacing.xs + 2) {
                        if leaving {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        Text("Sair")
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .buttonStyle(.brandSecondary)
                .disabled(leaving)
            }
        }
    }
}

private struct PasswordGroup: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var current = ""
    @State private var fresh = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var feedback: (text: String, failed: Bool)?
    private let session = AuthSession.shared

    private var mismatch: Bool { !confirm.isEmpty && confirm != fresh }

    private var canSave: Bool {
        !busy && !current.isEmpty && fresh.count >= 10 && fresh == confirm
    }

    var body: some View {
        SettingsGroup(caption: "Senha") {
            VStack(alignment: .leading, spacing: Spacing.m) {
                field("Senha atual", text: $current, content: .password)
                field("Nova senha (10 caracteres ou mais)", text: $fresh, content: .newPassword)
                field("Repita a nova senha", text: $confirm, content: .newPassword)
                HStack(spacing: Spacing.s) {
                    if mismatch {
                        Text("As senhas novas não são iguais.")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.danger)
                            .transition(.opacity)
                    } else if let feedback {
                        Text(feedback.text)
                            .font(TypeScale.caption)
                            .foregroundStyle(feedback.failed ? Theme.danger : Theme.success)
                            .transition(.opacity)
                    } else {
                        Text("Ao trocar, os outros aparelhos saem da conta.")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    Spacer(minLength: Spacing.s)
                    Button(action: save) {
                        HStack(spacing: Spacing.xs + 2) {
                            if busy {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(Theme.onAccent)
                            } else {
                                Image(systemName: "key")
                                    .font(.system(size: 12, weight: .semibold))
                            }
                            Text("Trocar senha")
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .buttonStyle(.brandPrimary)
                    .disabled(!canSave)
                }
            }
            .padding(Spacing.l)
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: mismatch)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: feedback?.text)
    }

    private func field(_ title: String, text: Binding<String>, content: NSTextContentType) -> some View {
        SecureField("", text: text, prompt: Text(title))
            .textContentType(content)
            .textFieldStyle(.plain)
            .font(TypeScale.body)
            .padding(.horizontal, Spacing.m)
            .frame(height: 40)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .onChange(of: text.wrappedValue) { feedback = nil }
    }

    private func save() {
        guard canSave else { return }
        busy = true
        Task {
            do {
                try await session.changePassword(current: current, new: fresh)
                current = ""
                fresh = ""
                confirm = ""
                feedback = ("Senha trocada.", false)
            } catch {
                feedback = (error.localizedDescription, true)
            }
            busy = false
        }
    }
}

private struct OnboardingGroup: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        SettingsGroup(caption: "Primeiros passos") {
            SettingsRow(title: "Refazer os primeiros passos", detail: "Contas de IA, integrações, permissões do Mac e o primeiro bot.") {
                Button {
                    OnboardingStore.shared.restart()
                    model.closeSettings()
                } label: {
                    HStack(spacing: Spacing.xs + 2) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 12, weight: .semibold))
                        Text("Abrir")
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .buttonStyle(.brandSecondary)
            }
        }
    }
}
