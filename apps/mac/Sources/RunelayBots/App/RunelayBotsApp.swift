import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        ComputerExecutor.shared.start()
        RunnerConnection.shared.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
struct RunelayBotsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    init() {
        BrandFonts.prepare()
    }

    var body: some Scene {
        WindowGroup("runelay bots") {
            RootView()
                .environment(model)
                .id(ObjectIdentifier(model))
                .frame(minWidth: 820, minHeight: 620)
                .onAppear {
                    ComputerExecutor.shared.attach(model)
                    ServerProfiles.shared.onActivate = { [self] in
                        reloadForActiveProfile()
                    }
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1320, height: 840)
        .commands {
            AppCommands(model: model)
            ServerProfileCommands(model: model)
        }

        WindowGroup("Conversa", for: String.self) { $botID in
            BotWindowView(botID: botID)
                .environment(model)
        }
        .defaultSize(width: 720, height: 780)
    }
}

extension RunelayBotsApp {
    @MainActor
    private func reloadForActiveProfile() {
        let previous = model
        previous.shutdown()
        ArtifactCenter.shared.forgetServer()
        BlockCenter.shared.forgetServer()
        SkillCatalog.shared.forgetServer()
        UsageStore.shared.forgetServer()
        DeviceStore.shared.items = []
        DeviceStore.shared.state = .loading
        DeviceStore.shared.error = nil
        let fresh = AppModel()
        if previous.settingsPresented {
            fresh.settingsSection = previous.settingsSection
            fresh.settingsPresented = true
        }
        model = fresh
        ComputerExecutor.shared.attach(fresh)
        RunnerConnection.shared.restart()
        Task { await AuthSession.shared.bootstrap(force: true) }
    }
}

struct ServerProfileCommands: Commands {
    let model: AppModel
    private let profiles = ServerProfiles.shared

    var body: some Commands {
        CommandMenu("Servidor") {
            ForEach(Array(profiles.profiles.enumerated()), id: \.element.id) { index, profile in
                Toggle(profile.name, isOn: Binding(
                    get: { profiles.active.id == profile.id },
                    set: { if $0 { profiles.activate(profile.id) } }
                ))
                .keyboardShortcut(index < 9 ? KeyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [.control, .command]) : nil)
            }
            Divider()
            Button("Gerenciar servidores…") {
                model.openSettings(.server)
            }
        }
    }
}

struct BotWindowView: View {
    @Environment(AppModel.self) private var model
    let botID: String?

    var body: some View {
        Group {
            if let botID, let bot = model.bot(id: botID) {
                if let store = model.conversation(for: botID) {
                    ConversationView(store: store, bot: bot, focusToken: 0)
                        .id(ObjectIdentifier(store))
                } else {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .task {
                            model.ensureThread(for: botID)
                        }
                }
            } else {
                PanelEmptyState(
                    systemImage: "bubble.left.and.bubble.right",
                    title: "Conversa indisponível",
                    message: "Esse bot não está mais na lista."
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 480, minHeight: 520)
        .background(Theme.background)
        .navigationTitle(botID.flatMap { model.bot(id: $0)?.name } ?? "Conversa")
    }
}

struct AppCommands: Commands {
    let model: AppModel
    @AppStorage(PreferenceKeys.sidebarCollapsed) private var sidebarCollapsed = false

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Nova conversa") {
                model.newConversation()
            }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(model.selectedBot.map { $0.isGroup || $0.isPending } ?? true)
            Button("Trocar permissão da conversa") {
                model.cycleSelectedPermission()
            }
            .keyboardShortcut("p", modifiers: [.command, .shift])
            .disabled(model.selectedBot.map { $0.isGroup || $0.isPending } ?? true)
            Button("Novo bot") {
                model.openEditor(for: nil)
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            Button("Bots arquivados") {
                model.openSettings(.bots)
            }
        }
        CommandGroup(replacing: .appSettings) {
            Button("Ajustes…") {
                model.openSettings()
            }
            .keyboardShortcut(",", modifiers: .command)
            Button("Configurar de novo…") {
                model.closeSettings()
                OnboardingStore.shared.restart()
            }
            .disabled(AuthSession.shared.user == nil)
        }
        CommandGroup(after: .sidebar) {
            Button(sidebarCollapsed ? "Mostrar conversas" : "Ocultar conversas") {
                sidebarCollapsed.toggle()
            }
            .keyboardShortcut("s", modifiers: [.control, .command])
            Button(model.inspectorPresented ? "Ocultar inspetor" : "Mostrar inspetor") {
                model.toggleInspector()
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
        }
        CommandGroup(after: .pasteboard) {
            Button("Limpar conversa") {
                model.clearSelectedConversation()
            }
            .keyboardShortcut("k", modifiers: .command)
            .disabled(model.selectedBot.map { !model.canClearConversation($0) } ?? true)
        }
    }
}
