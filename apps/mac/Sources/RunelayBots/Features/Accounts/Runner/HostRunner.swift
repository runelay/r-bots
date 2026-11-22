import Foundation
import OSLog
import Observation
import Security
import Synchronization

enum HostRunnerState: Equatable, Sendable {
    case off
    case starting
    case connected
    case disconnected
    case needsClaude
    case signedOut
    case unavailable

    var label: String {
        switch self {
        case .off: tr("Desligado")
        case .starting: tr("Conectando…")
        case .connected: tr("Conectado")
        case .disconnected: tr("Desconectado")
        case .needsClaude: tr("Falta login no claude")
        case .signedOut: tr("Entre na sua conta")
        case .unavailable: tr("Este build não traz o runner")
        }
    }

    var hint: String? {
        switch self {
        case .needsClaude: tr("Rode claude no Terminal e faça login.")
        case .signedOut: tr("Conecte este Mac em Ajustes › Dispositivos.")
        case .unavailable: tr("Instale o app pelo make-app.sh.")
        default: nil
        }
    }
}

struct HostRunnerLaunch: Sendable {
    let executable: URL
    let arguments: [String]
    let environment: [String: String]

    static let workspacesPath = "runelay-bots/workspaces"

    static var bundledBun: URL? {
        Bundle.main.resourceURL?.appending(path: "bun/bun")
    }

    static var bundledScript: URL? {
        Bundle.main.resourceURL?.appending(path: "runner/main.js")
    }

    static var searchPath: [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let base = ["/opt/homebrew/bin", "\(home)/.local/bin", "/usr/local/bin", "\(home)/.claude/local", "\(home)/.bun/bin"]
        let inherited = (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return (base + inherited + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).filter { seen.insert($0).inserted }
    }

    static var machineName: String {
        Host.current().localizedName ?? ProcessInfo.processInfo.hostName
    }

    static func make(server: URL, token: String) -> HostRunnerLaunch? {
        guard let bun = bundledBun, let script = bundledScript,
            FileManager.default.isExecutableFile(atPath: bun.path),
            FileManager.default.fileExists(atPath: script.path),
            let origin = AuthStore.origin(of: server)
        else { return nil }
        let workspaces = FileManager.default.homeDirectoryForCurrentUser.appending(path: workspacesPath)
        try? FileManager.default.createDirectory(at: workspaces, withIntermediateDirectories: true)
        var environment = ProcessInfo.processInfo.environment
        for key in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"] {
            environment.removeValue(forKey: key)
        }
        environment["PATH"] = searchPath.joined(separator: ":")
        environment["RBOTS_PROVIDER"] = "host"
        environment["RBOTS_URL"] = origin
        environment["RBOTS_DEVICE_TOKEN"] = token
        environment["RBOTS_RUNNER_NAME"] = machineName
        environment["RBOTS_ENVIRONMENT"] = "mac"
        environment["RBOTS_WORKSPACES_DIR"] = workspaces.path
        return HostRunnerLaunch(executable: bun, arguments: [script.path], environment: environment)
    }
}

enum ClaudeCLI {
    static var installed: Bool {
        HostRunnerLaunch.searchPath.contains { FileManager.default.isExecutableFile(atPath: "\($0)/claude") }
    }

    static var loggedIn: Bool {
        let file = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude/.credentials.json")
        if FileManager.default.fileExists(atPath: file.path) { return true }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Code-credentials",
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnAttributes as String: true,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    static var ready: Bool {
        installed && loggedIn
    }

    static func complains(_ line: String) -> Bool {
        let text = line.lowercased()
        guard text.contains("claude") else { return false }
        return ["not logged in", "please run /login", "invalid api key", "não está logado", "sem login", "not found", "não encontrado", "enoent"].contains {
            text.contains($0)
        }
    }
}

private final class LineSplitter: Sendable {
    private let buffer = Mutex(Data())
    private let emit: @Sendable (String) -> Void

    init(emit: @escaping @Sendable (String) -> Void) {
        self.emit = emit
    }

    func feed(_ chunk: Data) {
        let lines: [String] = buffer.withLock { pending in
            pending.append(chunk)
            var found: [String] = []
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = pending[pending.startIndex..<newline]
                found.append(String(decoding: line, as: UTF8.self))
                pending.removeSubrange(pending.startIndex...newline)
            }
            return found
        }
        for line in lines where !line.isEmpty {
            emit(line)
        }
    }
}

@MainActor
@Observable
final class HostRunner {
    static let shared = HostRunner()
    static let enabledKey = "hostRunner.enabled"
    private static let logger = Logger(subsystem: "runelay.bots", category: "host-runner")

    private(set) var state: HostRunnerState = .off
    var enabled: Bool = UserDefaults.standard.bool(forKey: HostRunner.enabledKey) {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
            if enabled {
                start()
            } else {
                stop()
            }
        }
    }

    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var claudeComplained = false

    private init() {}

    func start() {
        guard enabled, loop == nil else { return }
        state = .starting
        loop = Task { @MainActor [weak self] in
            await self?.supervise()
        }
    }

    func stop() {
        halt()
        state = .off
    }

    func restart() {
        guard enabled else { return }
        halt()
        claudeComplained = false
        start()
    }

    func shutdown() {
        loop?.cancel()
        loop = nil
        guard let process, process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning, Date() < deadline {
            usleep(20_000)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
    }

    private func halt() {
        loop?.cancel()
        loop = nil
        generation += 1
        process?.terminate()
        process = nil
    }

    private func supervise() async {
        var delay: Double = 1
        while !Task.isCancelled {
            let server = ServerConfig.currentURL()
            guard let token = AuthStore.read(.device, server: server) else {
                state = .signedOut
                try? await Task.sleep(for: .seconds(10))
                continue
            }
            guard let launch = HostRunnerLaunch.make(server: server, token: token) else {
                state = .unavailable
                Self.logger.error("bundled bun or runner missing")
                return
            }
            if state != .connected {
                state = ClaudeCLI.ready ? .starting : .needsClaude
            }
            let started = Date()
            let status = await run(launch)
            guard !Task.isCancelled else { return }
            Self.logger.notice("runner exited status=\(status, privacy: .public)")
            if Date().timeIntervalSince(started) > 60 {
                delay = 1
            }
            state = claudeComplained || !ClaudeCLI.ready ? .needsClaude : .disconnected
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 60)
        }
    }

    private func run(_ launch: HostRunnerLaunch) async -> Int32 {
        generation += 1
        let current = generation
        let child = Process()
        child.executableURL = launch.executable
        child.arguments = launch.arguments
        child.environment = launch.environment
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let output = Pipe()
        let errors = Pipe()
        child.standardOutput = output
        child.standardError = errors
        child.standardInput = FileHandle.nullDevice
        let splitter = LineSplitter { line in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    HostRunner.shared.handle(line, generation: current)
                }
            }
        }
        for pipe in [output, errors] {
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                } else {
                    splitter.feed(chunk)
                }
            }
        }
        let (exits, exited) = AsyncStream<Int32>.makeStream()
        child.terminationHandler = { finished in
            exited.yield(finished.terminationStatus)
            exited.finish()
        }
        do {
            try child.run()
        } catch {
            Self.logger.error("runner failed to start: \(error.localizedDescription, privacy: .public)")
            return -1
        }
        process = child
        Self.logger.notice("runner started pid=\(child.processIdentifier, privacy: .public)")
        for await status in exits {
            return status
        }
        return -1
    }

    private func handle(_ line: String, generation: Int) {
        Self.logger.notice("\(line, privacy: .public)")
        guard generation == self.generation, enabled else { return }
        if ClaudeCLI.complains(line) {
            claudeComplained = true
            state = .needsClaude
            return
        }
        if line.contains("runner conectado") {
            state = claudeComplained || !ClaudeCLI.ready ? .needsClaude : .connected
            Task { await RunEnvironmentStore.shared.refresh() }
        } else if line.contains("runner desconectado") || line.contains("runner parado") {
            state = claudeComplained ? .needsClaude : .disconnected
            Task { await RunEnvironmentStore.shared.refresh() }
        }
    }
}
