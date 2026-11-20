import SwiftUI

struct AuthGate: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @AppStorage(ServerConfig.storageKey) private var serverURL = ServerConfig.defaultURL
    private let session = AuthSession.shared
    private let onboarding = OnboardingStore.shared

    private var stage: OnboardingStage? {
        onboarding.stage(for: session, serverHasBots: serverHasBots)
    }

    private var serverHasBots: Bool? {
        switch model.bots {
        case .loaded(let list): list.contains { !$0.isPending }
        case .failed: true
        case .idle, .loading: nil
        }
    }

    private var editingBot: Bool {
        if case .editor = model.activeSheet { return stage == .setup }
        return false
    }

    func body(content: Content) -> some View {
        ZStack {
            content
                .allowsHitTesting(stage == nil || editingBot)
            if let stage, !editingBot {
                OnboardingView(stage: stage)
                    .transition(.onboarding(reduceMotion: reduceMotion))
                    .zIndex(10)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: stage)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: editingBot)
        .task(id: serverURL) {
            session.onSignIn {
                RunnerConnection.shared.restart()
                Task { await model.reloadAfterSignIn() }
            }
            await session.bootstrap()
        }
        .task(id: stage == .checking && session.user != nil) {
            guard stage == .checking, session.user != nil else { return }
            if case .idle = model.bots { await model.loadBots() }
        }
    }
}

extension View {
    func authGate() -> some View {
        modifier(AuthGate())
    }
}
