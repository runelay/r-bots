import AppKit
import SwiftUI

struct IntegrationFormRequest: Equatable {
    let id: String
    let name: String
    let description: String
    let unlocks: String
    let keyURL: URL?
    let needsURL: Bool
    let url: String?
    let reason: String

    init?(_ value: JSONValue?) {
        guard let value, let id = value["id"]?.stringValue else { return nil }
        self.id = id
        name = value["name"]?.stringValue ?? id
        description = value["description"]?.stringValue ?? ""
        unlocks = value["unlocks"]?.stringValue ?? ""
        keyURL = value["keyUrl"]?.stringValue.flatMap(URL.init(string:))
        needsURL = value["needsUrl"]?.boolValue ?? false
        url = value["url"]?.stringValue
        reason = value["reason"]?.stringValue ?? ""
    }
}

struct IntegrationFormCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let approval: Approval
    let form: IntegrationFormRequest
    let bot: Bot
    let answer: (String) -> Void

    @State private var key = ""
    @State private var address = ""
    @State private var saving = false
    @State private var error: String?
    @State private var hasEntered = false
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if approval.isOpen {
                openCard
                    .scaleEffect(hasEntered || reduceMotion ? 1 : 0.96, anchor: .topLeading)
                    .opacity(hasEntered ? 1 : 0)
                    .transition(.asymmetric(insertion: .opacity, removal: reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94, anchor: .leading))))
            } else {
                outcomeLine
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -4)))
            }
        }
        .springAnimation(value: approval.resolution)
        .onAppear {
            guard !hasEntered else { return }
            address = form.url ?? ""
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                hasEntered = true
            }
            focused = true
        }
    }

    private var openCard: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            HStack(alignment: .top, spacing: Spacing.m) {
                IntegrationLogo(id: form.id, name: form.name)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("\(bot.name) quer configurar \(form.name)")
                        .font(TypeScale.sectionTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text(approval.reason ?? form.description)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if form.needsURL {
                field("Endereço do seu \(form.name)") {
                    TextField("", text: $address, prompt: Text("https://…").foregroundStyle(Theme.textTertiary))
                        .font(TypeScale.rowSubtitle)
                }
            }
            field("Chave de API") {
                SecureField("", text: $key, prompt: Text("Cole a chave aqui").foregroundStyle(Theme.textTertiary))
                    .font(TypeScale.mono)
                    .focused($focused)
            }

            VStack(alignment: .leading, spacing: Spacing.xs) {
                if let url = form.keyURL {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label("Pegar a chave em \(url.host() ?? url.absoluteString)", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.plain)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.brandText)
                }
                Label("O servidor confere e guarda cifrado. \(bot.name) nunca vê a chave.", systemImage: "eye.slash")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
            }

            if let error {
                FieldError(message: error)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }

            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                Button("Agora não") {
                    key = ""
                    answer("deny")
                }
                .buttonStyle(.brandSecondary)
                .disabled(saving)
                Button(action: save) {
                    HStack(spacing: Spacing.xs) {
                        if saving {
                            ProgressView().controlSize(.mini)
                        }
                        Text(saving ? "Conferindo…" : "Salvar")
                    }
                }
                .buttonStyle(.brandPrimary)
                .disabled(saving || !complete)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: 480, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .animation(Motion.animation(reduceMotion: reduceMotion), value: error)
    }

    private func field(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
            content()
                .textFieldStyle(.plain)
                .onSubmit(save)
                .padding(.horizontal, Spacing.m)
                .frame(height: 36)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .disabled(saving)
        }
    }

    private var complete: Bool {
        !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (!form.needsURL || !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var outcomeLine: some View {
        let saved = approval.resolution == .answering("approve")
            || approval.resolution == .settled("\(form.name) configurado", .approved)
        return HStack(spacing: Spacing.s) {
            Image(systemName: saved ? "key.horizontal.fill" : "key.horizontal")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(saved ? Theme.success : Theme.textTertiary)
            Text(saved ? "\(form.name) configurado" : "\(form.name) não configurado")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 24, alignment: .leading)
    }

    private func save() {
        guard complete, !saving else { return }
        saving = true
        error = nil
        let snapshot = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = form.needsURL ? address.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let client = model.client
        Task { @MainActor in
            do {
                _ = try await client.saveIntegration(id: form.id, key: snapshot, url: url)
                key = ""
                saving = false
                answer("approve")
            } catch {
                saving = false
                self.error = error.localizedDescription
            }
        }
    }
}
