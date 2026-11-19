import Foundation
import Observation

enum OnboardingStage: Equatable {
    case checking
    case welcome
    case server
    case account
    case setup
}

enum SetupStepID: String, CaseIterable, Identifiable, Codable {
    case accounts
    case integrations
    case computer
    case bot

    var id: String { rawValue }

    var title: String {
        switch self {
        case .accounts: "Conecte suas contas de IA"
        case .integrations: "Ligue as integrações que quiser"
        case .computer: "Libere o Mac para os bots"
        case .bot: "Crie o primeiro bot"
        }
    }

    var description: String {
        switch self {
        case .accounts:
            "Os bots rodam nas assinaturas já logadas nas suas máquinas. Entre no Claude Code, Codex, Grok ou Cursor e confira aqui."
        case .integrations:
            "Tudo opcional: cada chave liga uma parte a mais, como a voz ou os conectores da runelay. A chave fica cifrada no servidor."
        case .computer:
            "Com estas permissões um bot pode ver a tela, clicar e digitar quando você pedir. Toda ação passa por você ou pelo Jev."
        case .bot:
            "Dê um nome, um rosto e diga o que ele faz. Dá para mudar tudo depois."
        }
    }

    var doneSummary: String {
        switch self {
        case .accounts: "Contas prontas."
        case .integrations: "Integrações em dia."
        case .computer: "Mac liberado."
        case .bot: "Time montado."
        }
    }

    var skipLabel: String {
        switch self {
        case .accounts, .bot: "Pular por enquanto"
        case .integrations, .computer: "Deixar para depois"
        }
    }

    var systemImage: String {
        switch self {
        case .accounts: "sparkles"
        case .integrations: "key.horizontal"
        case .computer: "desktopcomputer"
        case .bot: "person.badge.plus"
        }
    }
}

private struct ServerProgress: Codable {
    var pending = false
    var finished = false
    var marks: [SetupStepID] = []
    var active: SetupStepID?
}

@MainActor
@Observable
final class OnboardingStore {
    static let shared = OnboardingStore()

    private static let startedKey = "onboarding.v1.started"
    private static let ignoredPrefixes = ["NS", "Apple", "com.apple", "AK", "WebKit", "onboarding.", "auth."]

    var intro: OnboardingStage?
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

    private var origin: String { AuthStore.origin(of: ServerConfig.currentURL()) ?? "" }

    private var current: ServerProgress {
        get {
            if let cached = progress[origin] { return cached }
            guard let data = UserDefaults.standard.data(forKey: "onboarding.v1.\(origin)"),
                  let stored = try? JSONDecoder().decode(ServerProgress.self, from: data)
            else { return ServerProgress() }
            return stored
        }
        set {
            progress[origin] = newValue
            if let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: "onboarding.v1.\(origin)")
            }
        }
    }

    func stage(for session: AuthSession) -> OnboardingStage? {
        if let intro { return intro }
        switch session.state {
        case .checking:
            return .checking
        case .signedOut:
            return .account
        case .signedIn, .disabled:
            return current.pending && !current.finished ? .setup : nil
        }
    }

    var marks: [SetupStepID] { current.marks }

    var activeStep: SetupStepID? {
        get { current.active }
        set { current.active = newValue }
    }

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
        startSetupIfNeeded()
    }

    func signedIn() {
        startSetupIfNeeded()
    }

    func skippedAccount() {
        startSetupIfNeeded()
    }

    private func startSetupIfNeeded() {
        guard !current.finished, !current.pending else { return }
        current.pending = true
    }

    func mark(_ step: SetupStepID) {
        var next = current
        if !next.marks.contains(step) { next.marks.append(step) }
        next.active = nil
        current = next
    }

    func finish() {
        var next = current
        next.finished = true
        next.pending = false
        next.active = nil
        current = next
    }

    func restart() {
        current = ServerProgress(pending: true)
    }
}
