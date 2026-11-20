import Foundation
import Observation

enum OnboardingStage: Equatable {
    case checking
    case welcome
    case server
    case outdated
    case unreachable
    case account
    case setup
}

enum SetupStepID: String, CaseIterable, Identifiable, Codable {
    case profile
    case bot
    case accounts
    case integrations
    case connectors
    case computer

    var id: String { rawValue }

    var railName: String {
        switch self {
        case .profile: "Seu perfil"
        case .bot: "Primeiro bot"
        case .accounts: "Contas de IA"
        case .integrations: "Integrações"
        case .connectors: "Conectores"
        case .computer: "Uso do Mac"
        }
    }

    var optional: Bool {
        switch self {
        case .profile, .bot, .accounts: false
        case .integrations, .connectors, .computer: true
        }
    }
}

private struct ServerProgress: Codable {
    var finished = false
    var marks: [SetupStepID] = []
    var skipped: [SetupStepID] = []
    var startedEmpty: Bool?
    var baseline: [String]?
}

@MainActor
@Observable
final class OnboardingStore {
    static let shared = OnboardingStore()

    private static let startedKey = "onboarding.v1.started"
    private static let ignoredPrefixes = ["NS", "Apple", "com.apple", "AK", "WebKit", "onboarding.", "auth."]

    var intro: OnboardingStage?
    var picked: SetupStepID?
    private var progress: [String: ServerProgress] = [:]
    @ObservationIgnored private let existingInstall: Bool

    private init() {
        let domain = Bundle.main.bundleIdentifier.flatMap { UserDefaults.standard.persistentDomain(forName: $0) } ?? [:]
        let used = domain.keys.contains { key in !Self.ignoredPrefixes.contains { key.hasPrefix($0) } }
        let tokenFile = FileManager.default.fileExists(atPath: RunnerToken.file.path)
        existingInstall = used || tokenFile
        let started = UserDefaults.standard.bool(forKey: Self.startedKey)
        intro = existingInstall || started ? nil : .welcome
    }

    private var key: String {
        let origin = AuthStore.origin(of: ServerConfig.currentURL()) ?? ""
        let user = AuthSession.shared.user?.id ?? ""
        return "onboarding.v2.\(origin).\(user)"
    }

    private var stored: ServerProgress? {
        let key = key
        if let cached = progress[key] { return cached }
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return (try? JSONDecoder().decode(ServerProgress.self, from: data)) ?? ServerProgress(finished: true)
    }

    private var current: ServerProgress {
        get { stored ?? ServerProgress() }
        set {
            let key = key
            progress[key] = newValue
            if let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: key)
            }
        }
    }

    func stage(for session: AuthSession, serverHasBots: Bool?) -> OnboardingStage? {
        if let intro { return intro }
        switch session.state {
        case .checking:
            return .checking
        case .outdated:
            return .outdated
        case .unreachable:
            return .unreachable
        case .signedOut:
            return .account
        case .signedIn:
            if let saved = stored {
                return saved.finished || saved.startedEmpty != true ? nil : .setup
            }
            guard let serverHasBots else { return .checking }
            return serverHasBots ? nil : .setup
        }
    }

    var baseline: Set<String>? { stored?.baseline.map(Set.init) }

    func guideStarted(visibleBots: [String]) {
        if let saved = stored {
            guard saved.startedEmpty == true, saved.baseline == nil else { return }
            var next = saved
            next.baseline = visibleBots
            current = next
            return
        }
        guard visibleBots.isEmpty else { return }
        current = ServerProgress(startedEmpty: true, baseline: [])
    }

    var marks: [SetupStepID] { current.marks }
    var skipped: [SetupStepID] { current.skipped }

    func begin() {
        intro = .server
    }

    func backToWelcome() {
        intro = .welcome
    }

    func backToServer() {
        intro = .server
    }

    func serverChosen() {
        UserDefaults.standard.set(true, forKey: Self.startedKey)
        intro = nil
    }

    func mark(_ step: SetupStepID) {
        var next = current
        if !next.marks.contains(step) { next.marks.append(step) }
        next.skipped.removeAll { $0 == step }
        current = next
        picked = nil
    }

    func skip(_ step: SetupStepID) {
        var next = current
        if !next.skipped.contains(step) { next.skipped.append(step) }
        current = next
        picked = nil
    }

    func finish() {
        var next = current
        next.finished = true
        current = next
        picked = nil
    }

    func restart() {
        current = ServerProgress(startedEmpty: true)
        picked = SetupStepID.allCases.first
    }
}
