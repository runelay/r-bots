import SwiftUI

struct SecretFormCard: View {
    let approval: Approval
    let form: SecretFormRequest
    let bot: Bot
    let answer: (String) -> Void

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var values: [String: String] = [:]
    @State private var keep = true
    @State private var saving = false
    @State private var error: String?
    @State private var hasEntered = false
    @FocusState private var focused: String?

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
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                hasEntered = true
            }
            focused = form.fields.first?.id
        }
    }

    private var openCard: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            HStack(alignment: .top, spacing: Spacing.m) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.brandText)
                    .frame(width: 32, height: 32)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("\(form.botName ?? bot.name) pediu \(form.fields.count > 1 ? "estes dados" : "um segredo")")
                        .font(TypeScale.sectionTitle)
                        .foregroundStyle(Theme.textPrimary)
                    if !form.reason.isEmpty {
                        Text(form.reason)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            VStack(alignment: .leading, spacing: Spacing.m) {
                ForEach(form.fields) { field in
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text(field.label)
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(Theme.textSecondary)
                        input(field)
                            .textFieldStyle(.plain)
                            .font(field.secure ? TypeScale.mono : TypeScale.rowSubtitle)
                            .focused($focused, equals: field.id)
                            .onSubmit(save)
                            .padding(.horizontal, Spacing.m)
                            .frame(height: 36)
                            .background(Theme.background, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                            .disabled(saving)
                    }
                }
            }

            VStack(alignment: .leading, spacing: Spacing.xs) {
                Label(form.domains.isEmpty ? "Vale para qualquer site" : "Só em \(form.domains.joined(separator: ", "))", systemImage: "globe")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                Label("Vai direto para o Keychain deste Mac. \(form.botName ?? bot.name) nunca vê o valor.", systemImage: "eye.slash")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
            }

            Toggle(isOn: $keep) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Salvar no cofre")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text(keep ? "Fica guardado para os próximos usos." : "Vale por 1 hora e depois vence sozinho.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .disabled(saving)

            if let error {
                FieldError(message: error)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }

            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                Button("Agora não") {
                    values = [:]
                    answer("deny")
                }
                .buttonStyle(.brandSecondary)
                .disabled(saving)
                Button(action: save) {
                    HStack(spacing: Spacing.xs) {
                        if saving {
                            ProgressView().controlSize(.mini)
                        }
                        Text("Salvar")
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

    @ViewBuilder
    private func input(_ field: SecretFormField) -> some View {
        let binding = Binding(get: { values[field.id] ?? "" }, set: { values[field.id] = $0 })
        if field.secure {
            SecureField("", text: binding, prompt: Text("Cole ou digite aqui").foregroundStyle(Theme.textTertiary))
        } else {
            TextField("", text: binding, prompt: Text(field.label).foregroundStyle(Theme.textTertiary))
        }
    }

    private var complete: Bool {
        form.fields.allSatisfy { !(values[$0.id] ?? "").isEmpty }
    }

    private var outcomeLine: some View {
        let saved = approval.resolution == .settled("Salvo no cofre", .approved) || approval.resolution == .answering("approve")
        return HStack(spacing: Spacing.s) {
            Image(systemName: saved ? "lock.fill" : "lock.open")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(saved ? Theme.success : Theme.textTertiary)
            (Text(saved ? "Salvo no cofre" : "Não informado").foregroundStyle(Theme.textSecondary)
                + Text(" · ").foregroundStyle(Theme.textTertiary)
                + Text(form.names.map { "segredo:\($0)" }.joined(separator: ", ")).foregroundStyle(Theme.textTertiary))
                .font(TypeScale.caption)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 24, alignment: .leading)
    }

    private func save() {
        guard complete, !saving else { return }
        saving = true
        error = nil
        let snapshot = values
        let keep = keep
        Task { @MainActor in
            do {
                try await VaultStore.shared.saveForm(form, values: snapshot, keep: keep)
                values = [:]
                saving = false
                answer("approve")
            } catch {
                saving = false
                self.error = (error as? VaultFailure)?.message ?? "Não deu para salvar. Tente de novo."
            }
        }
    }
}
