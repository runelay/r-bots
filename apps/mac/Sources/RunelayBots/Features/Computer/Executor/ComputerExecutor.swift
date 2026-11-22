import AppKit
import Carbon.HIToolbox
import Observation

enum ExecutorState: Equatable {
    case starting
    case running
    case failed(String)
}

@MainActor
@Observable
final class ComputerActivity {
    var executor: ExecutorState = .starting
    var permissions = ComputerPermissionsSnapshot()
    var botId: String?
    var botName: String?
    var lastAction: String?
    var isActive = false
    var isRecording = false

    func refreshPermissions() {
        permissions = ComputerPermissionsSnapshot.current()
    }
}

@MainActor
final class ComputerExecutor {
    static let shared = ComputerExecutor()

    let activity = ComputerActivity()
    private var started = false
    private let accessibility = AccessibilityTools()
    private let input = InputTools()
    private let recorder = ScreenRecorder()
    private let shell = ShellRunner()
    var eventSink: (@MainActor (JSONValue) -> Void)?
    private var barriers: [String: (failure: ToolFailure, until: Date)] = [:]
    private var idleTask: Task<Void, Never>?
    private var monitor: Any?
    private var lastUserActionAt = Date.distantPast
    private var lastUserMoveAt = Date.distantPast
    private var overlay: ComputerOverlay?
    private var turnWatch: Task<Void, Never>?
    private var sawTurnRunning = false
    var botLookup: (@MainActor (String) -> Bot?)?
    var statusLookup: (@MainActor (String) -> BotStatus)?
    var openPrompt: (@MainActor (IslandPrompt) -> Void)?

    private static let pointerTools: Set<String> = ["click", "type", "key", "scroll", "drag"]

    func start() {
        guard !started else { return }
        started = true
        activity.refreshPermissions()
        activity.executor = .running
        overlay = ComputerOverlay(
            stop: { ComputerExecutor.shared.stopFromUser() },
            open: { ComputerExecutor.shared.openPrompt?($0) }
        )
        installTakeoverMonitor()
        let legacyToken = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/runelay bots/executor.token")
        try? FileManager.default.removeItem(at: legacyToken)
    }

    func attach(_ model: AppModel) {
        botLookup = { model.bot(id: $0) }
        statusLookup = { model.status(for: $0) }
        openPrompt = { prompt in
            model.openConversation(prompt.bot.id, sessionID: prompt.store.sessionId)
            NSApp.activate()
            if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
                if window.isMiniaturized {
                    window.deminiaturize(nil)
                }
                window.makeKeyAndOrderFront(nil)
            }
        }
    }

    func overlayScreensChanged() {
        overlay?.screensChanged()
    }

    func overlayAppActivityChanged() {
        overlay?.refreshPrompts()
    }

    func surface(_ prompt: IslandPrompt) -> Bool {
        overlay?.present(prompt) ?? false
    }

    func stopFromUser() {
        guard let botId = activity.botId else { return }
        interrupt(botId: botId, failure: .stopped, event: "stop")
    }

    private func interrupt(botId: String, failure: ToolFailure, event: String) {
        barriers[botId] = (failure, Date().addingTimeInterval(4))
        shell.terminateAll()
        broadcast(["type": .string(event), "botId": .string(botId)])
        endActivity()
    }

    func health() -> JSONValue {
        activity.refreshPermissions()
        return .object([
            "ok": .bool(true),
            "app": .string("runelay bots"),
            "version": .string(AppInfo.version),
            "permissions": activity.permissions.json,
            "recording": .bool(recorder.isRecording),
        ])
    }

    func perform(tool rawName: String, body: JSONValue) async -> (status: Int, body: JSONValue) {
        let name = rawName.hasPrefix("computer_") ? String(rawName.dropFirst("computer_".count)) : rawName
        do {
            let data = try JSONEncoder().encode(body)
            let call = try ExecutorCall(tool: name, body: data)
            try checkBarrier(call.botId)
            noteActivity(call)
            let usesPointer = Self.pointerTools.contains(call.tool)
            if usesPointer {
                try await waitForUserPause(botId: call.botId)
            }
            let startedAt = Date()
            var result = try await run(call)
            try checkBarrier(call.botId)
            if usesPointer, lastUserActionAt > startedAt, case .object(var object) = result {
                object["userInterrupted"] = .bool(true)
                object["note"] = .string(tr("A pessoa mexeu no Mac durante esta ação. Tire um print para conferir se deu certo antes de seguir."))
                result = .object(object)
            }
            return (200, .object(["ok": .bool(true), "result": result]))
        } catch let failure as ToolFailure {
            return (failure.status, failure.json)
        } catch {
            return (500, .object(["ok": .bool(false), "code": .string("executor_error"), "error": .string(error.localizedDescription)]))
        }
    }

    private func run(_ call: ExecutorCall) async throws -> JSONValue {
        switch call.tool {
        case "screenshot":
            return try await ScreenTools.screenshot(display: call.number("display").map { Int($0) }, region: call.rect("region"))
        case "ui_tree":
            return try accessibility.tree(appQuery: call.string("app"), session: call.sessionId)
        case "apps":
            return accessibility.apps()
        case "windows":
            return accessibility.windows()
        case "click":
            return try await click(call)
        case "type":
            return try await type(call)
        case "key":
            try accessibility.requireTrusted()
            let combo = try call.requiredString("combo")
            try input.key(combo)
            return .object(["pressed": .string(combo)])
        case "scroll":
            try accessibility.requireTrusted()
            let point = try optionalPoint(call)
            input.scroll(at: point, deltaX: call.number("deltaX") ?? 0, deltaY: call.number("deltaY") ?? 3)
            return .object(["scrolled": .bool(true)])
        case "drag":
            try accessibility.requireTrusted()
            let from = CGPoint(x: try call.requiredNumber("fromX"), y: try call.requiredNumber("fromY"))
            let to = CGPoint(x: try call.requiredNumber("toX"), y: try call.requiredNumber("toY"))
            await overlay?.moveCursor(to: from)
            overlay?.follow(to: to, duration: 0.3)
            await input.drag(from: from, to: to)
            overlay?.scheduleCursorHide()
            return .object(["from": .object(["x": .point(from.x), "y": .point(from.y)]), "to": .object(["x": .point(to.x), "y": .point(to.y)])])
        case "open":
            return try await open(call)
        case "applescript":
            return try applescript(call)
        case "files_list":
            return try await offMain { try FileTools.list(call) }
        case "files_read":
            return try await offMain { try FileTools.read(call) }
        case "files_move":
            return try await offMain { try FileTools.move(call) }
        case "files_rename":
            return try await offMain { try FileTools.rename(call) }
        case "files_mkdir":
            return try await offMain { try FileTools.mkdir(call) }
        case "files_trash":
            return try await offMain { try FileTools.trash(call) }
        case "files_write":
            return try await offMain { try FileTools.write(call) }
        case "shell_run":
            return try await shell.run(call)
        case "record_start":
            let result = try await recorder.start(
                display: call.number("display").map { Int($0) },
                window: call.string("window"),
                region: call.rect("region"),
                botName: call.botName
            )
            activity.isRecording = recorder.isRecording
            return result
        case "record_stop":
            defer { activity.isRecording = recorder.isRecording }
            return try await recorder.stop()
        case "record_status":
            return recorder.status()
        default:
            throw ToolFailure(404, code: "unknown_tool", tr("A ferramenta %@ não existe no executor.", call.tool))
        }
    }

    private func offMain(_ work: @escaping @Sendable () throws -> JSONValue) async throws -> JSONValue {
        try await Task.detached(priority: .userInitiated) { try work() }.value
    }

    private func click(_ call: ExecutorCall) async throws -> JSONValue {
        try accessibility.requireTrusted()
        let button = call.string("button") ?? "left"
        let double = call.bool("double")
        if let elementId = call.string("elementId") {
            let element = try accessibility.element(elementId, session: call.sessionId)
            let frame = accessibility.frame(of: element).flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
            if let frame {
                await overlay?.moveCursor(to: CGPoint(x: frame.midX, y: frame.midY))
            }
            if button == "left", !double, accessibility.press(element) {
                showClick()
                return .object(["elementId": .string(elementId), "method": .string("ax_press")])
            }
            guard let frame else {
                throw ToolFailure(422, code: "element_without_frame", tr("O elemento %@ não tem posição na tela.", elementId))
            }
            let point = CGPoint(x: frame.midX, y: frame.midY)
            await input.click(at: point, button: button, double: double, restoreTo: userCursorToRestore())
            showClick()
            return .object(["elementId": .string(elementId), "method": .string("mouse"), "x": .point(point.x), "y": .point(point.y)])
        }
        guard let point = try optionalPoint(call) else {
            throw ToolFailure.badArgs(tr("Informe elementId ou x e y."))
        }
        await overlay?.moveCursor(to: point)
        await input.click(at: point, button: button, double: double, restoreTo: userCursorToRestore())
        showClick()
        return .object(["method": .string("mouse"), "x": .point(point.x), "y": .point(point.y)])
    }

    private func type(_ call: ExecutorCall) async throws -> JSONValue {
        try accessibility.requireTrusted()
        guard var text = call.rawString("text"), !text.isEmpty else { throw ToolFailure.badArgs(tr("Falta o campo \"text\".")) }
        let secretRefs = VaultText.refs(in: text)
        let onlySecrets = !secretRefs.isEmpty && text.replacingOccurrences(of: "segredo:[a-z0-9][a-z0-9_-]{0,63}", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).isEmpty
        if !secretRefs.isEmpty {
            do {
                text = try await VaultStore.shared.substitute(text, botId: call.botId, botName: call.botName, tool: "computer_type", domain: FrontmostPage.host())
            } catch let failure as VaultFailure {
                throw ToolFailure(403, code: "secret_denied", failure.message)
            }
        }
        if !onlySecrets, accessibility.focusedIsSecure() || IsSecureEventInputEnabled() {
            throw ToolFailure(403, code: "secure_field", tr("O foco está num campo de senha. Não digito em campo seguro, peça para a pessoa digitar."))
        }
        if let frame = accessibility.focusedFrame() {
            await overlay?.moveCursor(to: CGPoint(x: frame.minX + min(24, frame.width / 2), y: frame.midY))
        }
        defer { overlay?.scheduleCursorHide() }
        let botId = call.botId
        let startedAt = Date()
        var interruption: ToolFailure?
        let typed = await input.type(text) { [weak self] in
            guard let self else { return false }
            if let barrier = self.barriers[botId] {
                interruption = barrier.failure
                return false
            }
            if self.lastUserActionAt > startedAt {
                interruption = .userInterrupted(typed: 0, total: text.count)
                return false
            }
            return true
        }
        if let interruption {
            throw interruption.code == "user_interrupted" ? ToolFailure.userInterrupted(typed: typed, total: text.count) : interruption
        }
        if !secretRefs.isEmpty {
            return .object(["typed": .string(secretRefs.map { "segredo:\($0)" }.joined(separator: ", "))])
        }
        return .object(["typed": .int(text.count)])
    }

    private func waitForUserPause(botId: String) async throws {
        let deadline = Date().addingTimeInterval(15)
        while Date().timeIntervalSince(lastUserActionAt) < 1.2 {
            try checkBarrier(botId)
            guard Date() < deadline else { throw ToolFailure.userBusy }
            try? await Task.sleep(for: .milliseconds(150))
        }
    }

    private func userCursorToRestore() -> CGPoint? {
        guard Date().timeIntervalSince(lastUserMoveAt) < 2 else { return nil }
        return InputTools.cursorLocation()
    }

    private func showClick() {
        overlay?.pulse()
        overlay?.scheduleCursorHide()
    }

    private func optionalPoint(_ call: ExecutorCall) throws -> CGPoint? {
        if let elementId = call.string("elementId") {
            let element = try accessibility.element(elementId, session: call.sessionId)
            guard let frame = accessibility.frame(of: element) else {
                throw ToolFailure(422, code: "element_without_frame", tr("O elemento %@ não tem posição na tela.", elementId))
            }
            return CGPoint(x: frame.midX, y: frame.midY)
        }
        guard let x = call.number("x"), let y = call.number("y") else { return nil }
        return CGPoint(x: x, y: y)
    }

    private func open(_ call: ExecutorCall) async throws -> JSONValue {
        let workspace = NSWorkspace.shared
        if let raw = call.string("url") {
            guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme != "file" else {
                throw ToolFailure.badArgs(tr("URL inválida: %@. Para arquivos use path.", raw))
            }
            guard workspace.open(url) else { throw ToolFailure(500, code: "open_failed", tr("O macOS não abriu %@.", raw)) }
            return .object(["opened": .string(raw)])
        }
        if let raw = call.string("path") {
            let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
            let url = try sandbox.resolve(raw)
            guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else {
                throw ToolFailure(404, code: "not_found", tr("%@ não existe.", url.path(percentEncoded: false)))
            }
            guard workspace.open(url) else { throw ToolFailure(500, code: "open_failed", tr("O macOS não abriu %@.", raw)) }
            return .object(["opened": .string(url.path(percentEncoded: false))])
        }
        guard let app = call.string("app") else { throw ToolFailure.badArgs(tr("Informe app, url ou path.")) }
        guard let appURL = applicationURL(app) else {
            throw ToolFailure(404, code: "app_not_found", tr("Não achei o app \"%@\" no Mac.", app))
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        do {
            let running = try await workspace.openApplication(at: appURL, configuration: configuration)
            return .object(["opened": .string(running.localizedName ?? app), "bundleId": running.bundleIdentifier.map(JSONValue.string) ?? .null])
        } catch {
            throw ToolFailure(500, code: "open_failed", tr("Não deu para abrir %1$@: %2$@", app, error.localizedDescription))
        }
    }

    private func applicationURL(_ query: String) -> URL? {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) {
            return url
        }
        let name = query.hasSuffix(".app") ? query : "\(query).app"
        let home = FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)
        let folders = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", "\(home)/Applications"]
        for folder in folders {
            let candidate = URL(fileURLWithPath: folder).appending(path: name)
            if FileManager.default.fileExists(atPath: candidate.path(percentEncoded: false)) {
                return candidate
            }
        }
        let lowered = query.lowercased()
        for folder in folders {
            let items = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
            if let match = items.first(where: { $0.lowercased() == "\(lowered).app" }) {
                return URL(fileURLWithPath: folder).appending(path: match)
            }
        }
        return nil
    }

    private func applescript(_ call: ExecutorCall) throws -> JSONValue {
        let source = try call.requiredString("script")
        guard let script = NSAppleScript(source: source) else { throw ToolFailure.badArgs(tr("AppleScript inválido.")) }
        var error: NSDictionary?
        let descriptor = script.executeAndReturnError(&error)
        if let error {
            let number = error[NSAppleScript.errorNumber] as? Int ?? 0
            let message = error[NSAppleScript.errorMessage] as? String ?? tr("Erro desconhecido.")
            if number == -1743 || number == -1744 {
                throw ToolFailure(403, code: "automation_denied", tr("O macOS bloqueou a automação. Libere o r/bots em Ajustes do Sistema → Privacidade e Segurança → Automação."))
            }
            throw ToolFailure(422, code: "applescript_error", tr("AppleScript falhou (%1$lld): %2$@", number, message))
        }
        return .object(["result": descriptor.stringValue.map(JSONValue.string) ?? .null])
    }

    private func checkBarrier(_ botId: String) throws {
        guard let barrier = barriers[botId] else { return }
        if barrier.until < Date() {
            barriers.removeValue(forKey: botId)
            return
        }
        throw barrier.failure
    }

    private func noteActivity(_ call: ExecutorCall) {
        activity.botId = call.botId
        activity.botName = call.botName
        activity.lastAction = call.tool
        if !activity.isActive {
            activity.isActive = true
            sawTurnRunning = false
            overlay?.begin(botID: call.botId, botName: call.botName, bot: botLookup?(call.botId))
            watchTurn(botId: call.botId)
        }
        idleTask?.cancel()
        idleTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            self?.endActivity()
        }
    }

    private func endActivity() {
        idleTask?.cancel()
        idleTask = nil
        activity.isActive = false
        turnWatch?.cancel()
        turnWatch = nil
        overlay?.end()
    }

    private func watchTurn(botId: String) {
        turnWatch?.cancel()
        turnWatch = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, let status = self.statusLookup?(botId) else { continue }
                let running = status == .working || status == .awaitingApproval
                if running {
                    self.sawTurnRunning = true
                } else if self.sawTurnRunning {
                    self.endActivity()
                    return
                }
            }
        }
    }

    private func installTakeoverMonitor() {
        let matching: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel, .mouseMoved, .leftMouseDragged]
        monitor = NSEvent.addGlobalMonitorForEvents(matching: matching) { event in
            let userData = event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0
            let isMove = event.type == .mouseMoved || event.type == .leftMouseDragged
            MainActor.assumeIsolated {
                ComputerExecutor.shared.userInput(userData: userData, isMove: isMove)
            }
        }
    }

    private func userInput(userData: Int64, isMove: Bool) {
        guard activity.isActive, userData != InputTools.marker, Date().timeIntervalSince(input.lastSyntheticAt) > 0.4 else { return }
        if isMove {
            lastUserMoveAt = Date()
        } else {
            lastUserActionAt = Date()
        }
    }

    private func broadcast(_ object: [String: JSONValue]) {
        eventSink?(.object(object))
    }
}
