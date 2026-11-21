import SwiftUI

struct SecretFormCard: View {
    let approval: Approval
    let form: SecretFormRequest
    let bot: Bot
    let answer: (String) -> Void

    @State private var values: [String: String] = [:]
    @State private var keep = true
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        if approval.isOpen {
            VStack(alignment: .leading, spacing: Spacing.m) {
                HStack(alignment: .top, spacing: Spacing.m) {
                    BotAvatar(bot: bot, mood: .waiting, size: 28)
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text("\(bot.name) precisa de um segredo")
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(Theme.attention)
                        Text(form.reason.isEmpty ? form.name : form.reason)
                            .font(BrandFonts.sans(15, weight: .medium))
                            .foregroundStyle(Theme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        if !form.domains.isEmpty {
                            Text("Usado só em \(form.domains.joined(separator: ", "))")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
                ForEach(form.fields, id: \.id) { field in
                    Group {
                        if field.secure {
                            SecureField(field.label, text: binding(field.id))
                        } else {
                            TextField(field.label, text: binding(field.id))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    .font(BrandFonts.sans(15))
                    .padding(.horizontal, Spacing.m)
                    .frame(height: 44)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium + 2, style: .continuous))
                }
                Toggle("Guardar no cofre", isOn: $keep)
                    .font(TypeScale.rowSubtitle)
                if let error {
                    Text(error).font(TypeScale.caption).foregroundStyle(Theme.danger)
                }
                HStack(spacing: Spacing.s) {
                    Button("Agora não") { answer("deny") }
                        .buttonStyle(SoftButtonStyle())
                    Button(saving ? "Salvando…" : "Enviar") { save() }
                        .buttonStyle(SoftButtonStyle(prominent: true))
                        .disabled(saving)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(Spacing.l)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large + 6, style: .continuous))
        } else {
            SystemLine(symbol: "lock", text: approval.summary(for: "approve").0 == "Salvo no cofre" && approval.resolution != .open ? ApprovalCardView.outcome(approval).text : "Segredo")
        }
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { values[id] ?? "" }, set: { values[id] = $0 })
    }

    private func save() {
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                try await VaultStore.shared.saveForm(form, values: values, keep: keep)
                answer("approve")
            } catch {
                self.error = ErrorMessage.describe(error)
            }
        }
    }
}
