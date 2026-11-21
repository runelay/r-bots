import AppKit
import Foundation

struct MaestroStep: Sendable {
    let name: String
    let status: String
    let durationMs: Int?
    let error: String?
}

struct MaestroRun: Sendable {
    let passed: Bool
    let durationMs: Int
    let steps: [MaestroStep]
    let error: String?
    let screenshot: String?
    let log: String
    let device: String

    var json: JSONValue {
        var object: [String: JSONValue] = [
            "passed": .bool(passed),
            "durationMs": .number(Double(durationMs)),
            "steps": .array(
                steps.map { step in
                    var item: [String: JSONValue] = ["name": .string(step.name), "status": .string(step.status)]
                    if let duration = step.durationMs { item["durationMs"] = .number(Double(duration)) }
                    if let error = step.error { item["error"] = .string(error) }
                    return .object(item)
                }),
            "log": .string(log),
            "device": .string(device),
        ]
        if let error { object["error"] = .string(error) }
        if let screenshot { object["screenshot"] = .string(screenshot) }
        return .object(object)
    }
}

enum MaestroRunner {
    static func install() async throws -> JSONValue {
        if let path = SimulatorRunner.maestro {
            return .object(["installed": .bool(true), "path": .string(path)])
        }
        let result = await Shell.run("/bin/bash", ["-c", "curl -fsSL \"https://get.maestro.mobile.dev\" | bash"], env: SimulatorRunner.javaHome, timeout: .seconds(600))
        guard result.code == 0, let path = SimulatorRunner.maestro else {
            throw SimulatorError.message("A instalação do Maestro falhou: \(LocalCLI.clean(result.stderr).suffix(400))")
        }
        return .object(["installed": .bool(true), "path": .string(path)])
    }

    static func label(_ command: JSONValue?) -> String {
        guard case .object(let wrapper) = command ?? .null, let (kind, value) = wrapper.first(where: { _, value in value != .null }) else { return "passo" }
        let names: [String: String] = [
            "tapOnElement": "Tocar", "tapOnPoint": "Tocar no ponto", "tapOnPointV2": "Tocar no ponto",
            "inputTextCommand": "Digitar", "assertConditionCommand": "Ver", "assertCommand": "Ver",
            "launchAppCommand": "Abrir o app", "openLinkCommand": "Abrir link", "scrollCommand": "Rolar",
            "scrollUntilVisible": "Rolar até ver", "takeScreenshotCommand": "Print", "backPressCommand": "Voltar",
            "swipeCommand": "Deslizar", "waitForAnimationToEndCommand": "Esperar a animação", "stopAppCommand": "Fechar o app",
            "clearStateCommand": "Limpar o app", "hideKeyboardCommand": "Fechar o teclado", "eraseTextCommand": "Apagar texto",
            "applyConfigurationCommand": "Configurar", "defineVariablesCommand": "Variáveis", "runFlowCommand": "Rodar flow",
            "extendedWaitUntilCommand": "Esperar", "pressKeyCommand": "Tecla",
        ]
        let base = names[kind] ?? kind.replacingOccurrences(of: "Command", with: "")
        let detail = describe(value)
        return detail.isEmpty ? base : "\(base) \(detail)"
    }

    static func describe(_ value: JSONValue) -> String {
        for key in ["textRegex", "text", "idRegex", "id", "link", "appId", "path", "label"] {
            if let text = value[key]?.stringValue, !text.isEmpty { return "“\(text)”" }
        }
        for key in ["selector", "condition", "visible", "notVisible", "element"] {
            if let inner = value[key], inner != .null {
                let detail = describe(inner)
                if !detail.isEmpty { return detail }
            }
        }
        if let point = value["point"]?.stringValue { return point }
        return ""
    }

    static func files(in directory: URL) -> [URL] {
        guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return [] }
        return enumerator.compactMap { $0 as? URL }.sorted { $0.path < $1.path }
    }

    static func steps(in directory: URL) -> [MaestroStep] {
        let found = files(in: directory)
        guard let file = found.first(where: { $0.lastPathComponent.hasPrefix("commands") && $0.pathExtension == "json" }),
            let data = try? Data(contentsOf: file),
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return [] }
        return (json.arrayValue ?? []).compactMap { item in
            let metadata = item["metadata"]
            let raw = metadata?["status"]?.stringValue ?? "COMPLETED"
            if raw == "PENDING" { return nil }
            let kind = item["command"]?.objectValue?.first(where: { $0.value != .null })?.key ?? ""
            if kind == "applyConfigurationCommand" || kind == "defineVariablesCommand" { return nil }
            let status = raw == "FAILED" ? "failed" : raw == "SKIPPED" ? "skipped" : "passed"
            let error = metadata?["error"]?["message"]?.stringValue
            return MaestroStep(name: label(item["command"]), status: status, durationMs: metadata?["duration"]?.intValue, error: error)
        }
    }

    static func run(flow: String, name: String, udid: String) async throws -> MaestroRun {
        guard let maestro = SimulatorRunner.maestro else {
            throw SimulatorError.message("O Maestro não está instalado no Mac. Use maestro_install.")
        }
        guard !flow.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw SimulatorError.message("O flow está vazio.") }
        let root = FileManager.default.temporaryDirectory.appending(path: "rb-maestro-\(UUID().uuidString)")
        let debug = root.appending(path: "debug")
        try FileManager.default.createDirectory(at: debug, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let safeName = name.replacingOccurrences(of: "/", with: "-")
        let file = root.appending(path: safeName.hasSuffix(".yaml") || safeName.hasSuffix(".yml") ? safeName : "\(safeName).yaml")
        try flow.write(to: file, atomically: true, encoding: .utf8)
        let started = Date()
        let result = await Shell.run(
            maestro,
            ["--device", udid, "test", file.path(percentEncoded: false), "--debug-output", debug.path(percentEncoded: false), "--flatten-debug-output", "--no-ansi"],
            env: SimulatorRunner.javaHome,
            cwd: root,
            timeout: .seconds(900)
        )
        let duration = Int(Date().timeIntervalSince(started) * 1000)
        let steps = steps(in: debug)
        let failedStep = steps.first { $0.status == "failed" }
        let log = LocalCLI.clean(result.stdout + "\n" + result.stderr)
        let passed = result.code == 0 && failedStep == nil
        var screenshot: String?
        let pngs = (files(in: debug) + files(in: root).filter { $0.deletingLastPathComponent() == root }).filter { $0.pathExtension == "png" }
        let failure = pngs.first { $0.lastPathComponent.contains("❌") }
        if let shot = passed ? pngs.last : (failure ?? pngs.last),
            let image = NSImage(contentsOf: shot), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
            let shrunk = try? SimulatorRunner.jpeg(cg, maxHeight: 900)
        {
            screenshot = shrunk.0.base64EncodedString()
        } else if let shot = try? await SimulatorRunner.screenshotData(udid: udid, maxHeight: 900) {
            screenshot = shot.0.base64EncodedString()
        }
        let device = await SimulatorRunner.iosDevices().first { $0.udid == udid }.map { "\($0.name) · \($0.runtime)" } ?? udid
        let error = passed ? nil : failedStep?.error ?? log.split(separator: "\n").last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }).map(String.init)
        return MaestroRun(passed: passed, durationMs: duration, steps: steps, error: error, screenshot: screenshot, log: String(log.suffix(60_000)), device: device)
    }
}
