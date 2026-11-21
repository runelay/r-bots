import SwiftUI

@main
struct RBotsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    init() {
        BrandFonts.prepare()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(PreferenceKeys.appearance) private var appearance = AppearancePreference.system.rawValue
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let session = AuthSession.shared

    private var stage: Stage {
        switch session.state {
        case .checking: .checking
        case .signedIn: .main
        case .signedOut, .unreachable: .signIn
        }
    }

    private enum Stage: Equatable {
        case checking
        case signIn
        case main
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            switch stage {
            case .checking:
                ProgressView()
                    .controlSize(.small)
                    .transition(.opacity)
            case .signIn:
                SignInScreen()
                    .transition(.opacity)
            case .main:
                MainView()
                    .transition(.opacity)
            }
        }
        .environment(model)
        .environment(\.appReduceMotion, reduceMotion)
        .tint(Theme.brandAccent)
        .preferredColorScheme(AppearancePreference(rawValue: appearance)?.colorScheme)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: stage)
        .task {
            await session.bootstrap()
        }
        .onChange(of: stage) { _, next in
            if next != .main {
                model.stop()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: model.enterBackground()
            case .active: model.enterForeground()
            default: break
            }
        }
    }
}

enum Route: Hashable {
    case conversation(botID: String)
}

struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [Route] = []
    @State private var showsSettings = false

    var body: some View {
        NavigationStack(path: $path) {
            BotListScreen(path: $path, showsSettings: $showsSettings)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .conversation(let botID):
                        BotConversationScreen(botID: botID)
                    }
                }
        }
        .sheet(isPresented: $showsSettings) {
            SettingsScreen()
        }
        .onChange(of: NotificationRouter.shared.pendingBotID) { _, botID in
            guard let botID else { return }
            NotificationRouter.shared.pendingBotID = nil
            showsSettings = false
            path = [.conversation(botID: botID)]
        }
        .task(id: AuthSession.shared.serverRevision) {
            path = []
            model.stop()
            await model.start()
            await LocalNotifier.requestAuthorization()
        }
    }
}
