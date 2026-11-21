import SwiftUI

enum SettingsRoute: Hashable {
    case connectors
    case routines
    case usage
    case accounts
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
                Section("Time") {
                    link("Conectores", "point.3.connected.trianglepath.dotted", .connectors)
                    link("Rotinas", "clock", .routines)
                    link("Uso e limites", "chart.bar", .usage)
                    link("Contas de IA", "person.2", .accounts)
                    link("Integrações", "puzzlepiece.extension", .integrations)
                    link("Cofre", "lock", .vault)
                    link("Dispositivos", "iphone.and.arrow.forward", .devices)
                }
                .settingsRow()
                Section("Este iPhone") {
                    link("Notificações", "bell", .notifications)
                    link("Servidores", "server.rack", .servers)
                    LabeledContent("Versão do app", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
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
                case .connectors: ConnectorsScreen()
                case .routines: RoutinesScreen()
                case .usage: UsageScreen()
                case .accounts: AccountsScreen()
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

    private func link(_ title: String, _ symbol: String, _ route: SettingsRoute) -> some View {
        NavigationLink(value: route) {
            Label {
                Text(title)
            } icon: {
                Image(systemName: symbol)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }
}
