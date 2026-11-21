import SwiftUI

enum SettingsRoute: Hashable {
    case account
    case appearance
    case shortcuts
    case bots
    case versions
    case about
    case connectors
    case routines
    case usage
    case aiAccounts
    case integrations
    case vault
    case devices
    case servers
    case notifications
}

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    private let session = AuthSession.shared
    @State private var confirmsSignOut = false
    @State private var signingOut = false

    var body: some View {
        NavigationStack {
            List {
                if let user = session.user {
                    Section {
                        HStack(spacing: Spacing.m) {
                            Text(String(user.name.prefix(1)).uppercased())
                                .font(BrandFonts.sans(20, weight: .semibold))
                                .foregroundStyle(Theme.onAccent)
                                .frame(width: 48, height: 48)
                                .background(Theme.brandAccent, in: Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.name)
                                    .font(BrandFonts.sans(17, weight: .semibold))
                                    .foregroundStyle(Theme.textPrimary)
                                Text(user.email)
                                    .font(TypeScale.rowSubtitle)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .padding(.vertical, Spacing.xs)
                    }
                    .settingsRow()
                }
                Section("Conta e servidor") {
                    link("Servidores", "server.rack", SettingsTint.blue, .servers)
                    link("Conta", "person.crop.circle.fill", SettingsTint.graphite, .account)
                    link("Dispositivos", "laptopcomputer.and.iphone", SettingsTint.teal, .devices)
                    link("Cofre", "lock.shield.fill", SettingsTint.indigo, .vault)
                }
                .settingsRow()
                Section("App") {
                    link("Aparência", "circle.lefthalf.filled", SettingsTint.slate, .appearance)
                    link("Notificações", "bell.badge.fill", SettingsTint.red, .notifications)
                    link("Atalhos", "command", SettingsTint.graphite, .shortcuts)
                }
                .settingsRow()
                Section("Bots e automação") {
                    link("Bots", "person.2.fill", SettingsTint.orange, .bots)
                    link("Contas de IA", "key.fill", SettingsTint.amber, .aiAccounts)
                    link("Integrações", "puzzlepiece.extension.fill", SettingsTint.green, .integrations)
                }
                .settingsRow()
                Section("Sobre") {
                    link("Versões", "arrow.down.circle.fill", SettingsTint.blue, .versions)
                    link("Sobre", "info", SettingsTint.graphite, .about)
                }
                .settingsRow()
                Section {
                    Button(role: .destructive) {
                        confirmsSignOut = true
                    } label: {
                        HStack {
                            Text("Sair da conta")
                            Spacer()
                            if signingOut {
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(signingOut)
                }
                .settingsRow()
            }
            .settingsList()
            .navigationTitle("Ajustes")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: SettingsRoute.self) { route in
                switch route {
                case .account: AccountScreen()
                case .appearance: AppearanceScreen()
                case .shortcuts: ShortcutsScreen()
                case .bots: BotsSettingsScreen()
                case .versions: VersionsScreen()
                case .about: AboutScreen()
                case .connectors: ConnectorsScreen()
                case .routines: RoutinesScreen()
                case .usage: UsageScreen()
                case .aiAccounts: AccountsScreen()
                case .integrations: IntegrationsScreen()
                case .vault: VaultScreen()
                case .devices: DevicesScreen()
                case .servers: ServersScreen()
                case .notifications: NotificationsScreen()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
            .confirmationDialog("Sair da conta?", isPresented: $confirmsSignOut, titleVisibility: .visible) {
                Button("Sair", role: .destructive) {
                    signingOut = true
                    Task {
                        await session.signOut()
                        signingOut = false
                        dismiss()
                    }
                }
            } message: {
                Text("Você volta para a tela de login deste aparelho.")
            }
        }
        .environment(model)
    }

    private func link(_ title: String, _ symbol: String, _ color: Color, _ route: SettingsRoute) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: Spacing.m) {
                SettingsTile(symbol: symbol, color: color, size: 29)
                Text(title)
                    .foregroundStyle(Theme.textPrimary)
            }
        }
    }
}
