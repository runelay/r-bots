import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        ComputerExecutor.shared.start()
        RunnerConnection.shared.start()
        HostRunner.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        HostRunner.shared.shutdown()
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
        WindowGroup("r/bots") {
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
        HostRunner.shared.restart()
        Task { await AuthSession.shared.bootstrap(force: true) }
    }
}

struct ServerProfileCommands: Commands {
    let model: AppModel
    private let profiles = ServerProfiles.shared

    var body: some Commands {
        CommandMenu("Servidor") {
            ForEach(Array(profiles.profiles.enumerated()), id: \.element.id) { index, profile in
                Toggle(
                    profile.name,
                    isOn: Binding(
                        get: { profiles.active.id == profile.id },
                        set: { if $0 { profiles.activate(profile.id) } }
                    )
                )
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
        .onAppear {
            if let botID {
                model.attachWindow(botID: botID)
            }
        }
        .onDisappear {
            if let botID {
                model.detachWindow(botID: botID)
            }
        }
        .navigationTitle(botID.flatMap { model.bot(id: $0)?.name } ?? "Conversa")
    }
}

struct AppCommands: Commands {
    let model: AppModel
    @AppStorage(PreferenceKeys.sidebarCollapsed) private var sidebarCollapsed = false

    @MainActor
    private func closeTabOrWindow() {
        let key = NSApp.keyWindow
        if let key, let main = WindowChrome.shared.mainWindow, key !== main {
            key.performClose(nil)
        } else if model.activeSheet != nil {
            model.dismissSheet()
        } else if model.section == .conversations, !model.settingsPresented, model.activeTabID != nil {
            model.closeActiveTab()
        } else {
            key?.performClose(nil)
        }
    }

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
            Divider()
            Button("Nova aba") {
                model.openTabPicker()
            }
            .keyboardShortcut("t", modifiers: .command)
            Button("Fechar aba") {
                closeTabOrWindow()
            }
            .keyboardShortcut("w", modifiers: .command)
            Button("Reabrir aba fechada") {
                model.reopenClosedTab()
            }
            .keyboardShortcut("t", modifiers: [.command, .shift])
        }
        CommandMenu("Abas") {
            Button("Próxima aba") {
                model.cycleTab(by: 1)
            }
            .keyboardShortcut("}", modifiers: .command)
            Button("Aba anterior") {
                model.cycleTab(by: -1)
            }
            .keyboardShortcut("{", modifiers: .command)
            Divider()
            ForEach(1..<10, id: \.self) { number in
                Button(number == 9 ? "Última aba" : "Aba \(number)") {
                    model.selectTab(at: number == 9 ? Int.max : number - 1)
                }
                .keyboardShortcut(KeyEquivalent(Character("\(number)")), modifiers: .command)
                .disabled(model.modelPickerOpen)
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
            Divider()
            Button("Conversas") {
                model.go(to: .conversations)
            }
            .keyboardShortcut("1", modifiers: [.command, .option])
            Button("GitHub") {
                model.go(to: .git)
            }
            .keyboardShortcut("2", modifiers: [.command, .option])
            Button("Linear") {
                model.go(to: .linear)
            }
            .keyboardShortcut("3", modifiers: [.command, .option])
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
