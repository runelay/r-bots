import SwiftUI

struct AccountScreen: View {
    @Environment(\.dismiss) private var dismiss
    private let session = AuthSession.shared
    @State private var confirms = false

    var body: some View {
        List {
            if let user = session.user {
                Section {
                    LabeledContent("Nome", value: user.name)
                    LabeledContent("E-mail", value: user.email)
                    LabeledContent("Papel", value: user.isOwner ? tr("Dona do servidor") : tr("Membro"))
                }
                .settingsRow()
            }
            Section {
                Button("Sair da conta", role: .destructive) { confirms = true }
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Conta")
        .confirmationDialog("Sair da conta?", isPresented: $confirms, titleVisibility: .visible) {
            Button("Sair", role: .destructive) {
                Task { await session.signOut() }
            }
        }
    }
}

struct AppearanceScreen: View {
    @AppStorage(PreferenceKeys.appearance) private var appearance = AppearancePreference.system.rawValue

    var body: some View {
        List {
            Section {
                Picker("Tema", selection: $appearance) {
                    ForEach(AppearancePreference.allCases) { option in
                        Text(option.title).tag(option.rawValue)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Tema")
            }
            .settingsRow()
            Section {
                Picker("Idioma", selection: Binding(get: { LanguageStore.shared.selection }, set: { LanguageStore.shared.select($0) })) {
                    ForEach(AppLanguage.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Idioma")
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Aparência")
    }
}

struct BotsSettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var creating = false

    var body: some View {
        List {
            Section {
                ForEach(model.visibleBots) { bot in
                    NavigationLink {
                        BotDetailsScreen(botID: bot.id)
                    } label: {
                        HStack(spacing: Spacing.m) {
                            BotAvatar(bot: bot, mood: .idle, size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(bot.name).foregroundStyle(Theme.textPrimary)
                                if !bot.role.isEmpty {
                                    Text(bot.role)
                                        .font(TypeScale.caption)
                                        .foregroundStyle(Theme.textSecondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
            }
            .settingsRow()
            Section {
                Button("Novo bot", systemImage: "plus") { creating = true }
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Bots")
        .sheet(isPresented: $creating) {
            BotEditorScreen(bot: nil)
                .environment(model)
        }
    }
}

struct VersionsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                LabeledContent("App do iPhone", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                LabeledContent("Servidor", value: model.meta.version ?? tr("sem versão"))
            } footer: {
                Text("O r/bots atualiza com um comando no servidor. O app do iPhone atualiza quando você instala uma build nova.")
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Versões")
        .task { await model.refreshMeta() }
    }
}

struct AboutScreen: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: Spacing.m) {
                    RunelayAppMark(size: 64)
                    Text("r/bots")
                        .font(BrandFonts.sans(22, weight: .semibold))
                    Text("Seu time de bots, no seu servidor.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Spacing.l)
            }
            .listRowBackground(Color.clear)
        }
        .settingsList()
        .navigationTitle("Sobre")
    }
}
