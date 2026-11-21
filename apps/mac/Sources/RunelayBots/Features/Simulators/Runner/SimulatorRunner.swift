import AppKit
import Foundation

struct ShellResult: Sendable {
    let code: Int32
    let stdout: String
    let stderr: String
}

enum Shell {
    static func run(_ bin: String, _ args: [String], env: [String: String] = [:], cwd: URL? = nil, timeout: Duration = .seconds(60)) async -> ShellResult {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: bin)
            process.arguments = args
            process.environment = LocalCLI.environment(env)
            if let cwd { process.currentDirectoryURL = cwd }
            let out = Pipe()
            let err = Pipe()
            process.standardOutput = out
            process.standardError = err
            process.standardInput = FileHandle.nullDevice
            let collected = ShellBuffer()
            out.fileHandleForReading.readabilityHandler = { handle in collected.appendOut(handle.availableData) }
            err.fileHandleForReading.readabilityHandler = { handle in collected.appendErr(handle.availableData) }
            let once = TunnelOnce()
            process.terminationHandler = { finished in
                out.fileHandleForReading.readabilityHandler = nil
                err.fileHandleForReading.readabilityHandler = nil
                collected.appendOut(out.fileHandleForReading.readDataToEndOfFile())
                collected.appendErr(err.fileHandleForReading.readDataToEndOfFile())
                if once.take() {
                    continuation.resume(returning: ShellResult(code: finished.terminationStatus, stdout: collected.outText, stderr: collected.errText))
                }
            }
            do {
                try process.run()
            } catch {
                if once.take() {
                    continuation.resume(returning: ShellResult(code: 127, stdout: "", stderr: error.localizedDescription))
                }
                return
            }
            let seconds = Double(timeout.components.seconds)
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
                if process.isRunning { process.terminate() }
            }
        }
    }
}

final class ShellBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data()
    private var err = Data()

    func appendOut(_ data: Data) {
        lock.lock()
        out.append(data)
        lock.unlock()
    }

    func appendErr(_ data: Data) {
        lock.lock()
        err.append(data)
        lock.unlock()
    }

    var outText: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: out, as: UTF8.self)
    }

    var errText: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: err, as: UTF8.self)
    }
}

struct SimDevice: Sendable, Equatable, Identifiable {
    let udid: String
    let name: String
    let runtime: String
    let state: String
    let platform: String

    var id: String { udid }
    var booted: Bool { state == "Booted" }

    var json: JSONValue {
        .object([
            "udid": .string(udid),
            "name": .string(name),
            "runtime": .string(runtime),
            "state": .string(state),
            "platform": .string(platform),
        ])
    }
}

enum SimulatorError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let text): text
        }
    }
}

enum SimulatorRunner {
    static let xcrun = "/usr/bin/xcrun"

    static var androidSDK: String {
        "\(LocalCLI.home)/Library/Android/sdk"
    }

    static var adb: String? {
        let path = "\(androidSDK)/platform-tools/adb"
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    static var emulator: String? {
        let path = "\(androidSDK)/emulator/emulator"
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    static var maestro: String? {
        let candidates = ["\(LocalCLI.home)/.maestro/bin/maestro", "/opt/homebrew/bin/maestro", "/usr/local/bin/maestro"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static var javaHome: [String: String] {
        for path in ["/opt/homebrew/opt/openjdk@17", "/opt/homebrew/opt/openjdk", "/usr/local/opt/openjdk@17"] where FileManager.default.fileExists(atPath: "\(path)/bin/java") {
            return ["JAVA_HOME": path, "MAESTRO_CLI_NO_ANALYTICS": "1", "MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED": "true"]
        }
        return ["MAESTRO_CLI_NO_ANALYTICS": "1", "MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED": "true"]
    }

    static func iosDevices() async -> [SimDevice] {
        let result = await Shell.run(xcrun, ["simctl", "list", "devices", "available", "-j"], timeout: .seconds(30))
        guard let json = JSONValue.parse(result.stdout), case .object(let runtimes) = json["devices"] ?? .null else { return [] }
        var devices: [SimDevice] = []
        for (runtime, list) in runtimes where runtime.contains("iOS") {
            let label = runtime.components(separatedBy: ".").last?.replacingOccurrences(of: "iOS-", with: "iOS ").replacingOccurrences(of: "-", with: ".") ?? runtime
            for item in list.arrayValue ?? [] {
                guard let udid = item["udid"]?.stringValue else { continue }
                devices.append(SimDevice(udid: udid, name: item["name"]?.stringValue ?? "iPhone", runtime: label, state: item["state"]?.stringValue ?? "Shutdown", platform: "ios"))
            }
        }
        return devices.sorted { ($0.booted ? 0 : 1, $0.runtime, $0.name) < ($1.booted ? 0 : 1, $1.runtime, $1.name) }
    }

    static func androidDevices() async -> [SimDevice] {
        guard let emulator else { return [] }
        let result = await Shell.run(emulator, ["-list-avds"], timeout: .seconds(20))
        var running = Set<String>()
        if let adb {
            let devices = await Shell.run(adb, ["devices"], timeout: .seconds(10))
            for line in devices.stdout.split(separator: "\n") where line.hasPrefix("emulator-") {
                let serial = String(line.split(separator: "\t").first ?? "")
                let name = await Shell.run(adb, ["-s", serial, "emu", "avd", "name"], timeout: .seconds(10))
                if let first = name.stdout.split(separator: "\n").first { running.insert(first.trimmingCharacters(in: .whitespaces)) }
            }
        }
        return result.stdout.split(separator: "\n").map { line in
            let name = line.trimmingCharacters(in: .whitespaces)
            return SimDevice(udid: "avd:\(name)", name: name.replacingOccurrences(of: "_", with: " "), runtime: "Android", state: running.contains(name) ? "Booted" : "Shutdown", platform: "android")
        }.filter { !$0.name.isEmpty }
    }

    static func maestroVersion() async -> String? {
        guard let maestro else { return nil }
        let result = await Shell.run(maestro, ["--version"], env: javaHome, timeout: .seconds(30))
        return result.stdout.split(separator: "\n").last.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    static func list() async -> JSONValue {
        async let ios = iosDevices()
        async let android = androidDevices()
        async let version = maestroVersion()
        let devices = await ios + android
        let maestroVersion = await version
        return .object([
            "devices": .array(devices.map(\.json)),
            "android": .object(["sdk": .bool(emulator != nil), "adb": .bool(adb != nil)]),
            "maestro": .object(["installed": .bool(maestro != nil), "version": maestroVersion.map(JSONValue.string) ?? .null]),
        ])
    }

    static func bootedUDID() async -> String? {
        await iosDevices().first(where: \.booted)?.udid
    }

    static func target(_ body: JSONValue) async throws -> String {
        if let udid = body["udid"]?.stringValue, !udid.isEmpty { return udid }
        if let udid = await bootedUDID() { return udid }
        throw SimulatorError.message("Nenhum simulador ligado. Ligue um antes.")
    }

    static func boot(_ udid: String) async throws -> JSONValue {
        if udid.hasPrefix("avd:") {
            guard let emulator else { throw SimulatorError.message("O Android SDK não tem o emulador.") }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: emulator)
            process.arguments = ["-avd", String(udid.dropFirst(4))]
            process.environment = LocalCLI.environment()
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            return .object(["udid": .string(udid), "state": .string("Booting")])
        }
        let boot = await Shell.run(xcrun, ["simctl", "boot", udid], timeout: .seconds(120))
        if boot.code != 0, !boot.stderr.contains("current state: Booted") {
            throw SimulatorError.message(LocalCLI.clean(boot.stderr).isEmpty ? "Não consegui ligar o simulador." : LocalCLI.clean(boot.stderr))
        }
        _ = await Shell.run("/usr/bin/open", ["-g", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid], timeout: .seconds(20))
        _ = await Shell.run(xcrun, ["simctl", "bootstatus", udid, "-b"], timeout: .seconds(180))
        return .object(["udid": .string(udid), "state": .string("Booted")])
    }

    static func shutdown(_ udid: String) async throws -> JSONValue {
        if udid.hasPrefix("avd:") {
            guard let adb else { throw SimulatorError.message("Sem adb (platform-tools) para desligar o emulador.") }
            _ = await Shell.run(adb, ["emu", "kill"], timeout: .seconds(30))
            return .object(["udid": .string(udid), "state": .string("Shutdown")])
        }
        let result = await Shell.run(xcrun, ["simctl", "shutdown", udid], timeout: .seconds(60))
        if result.code != 0, !result.stderr.contains("current state: Shutdown") {
            throw SimulatorError.message(LocalCLI.clean(result.stderr))
        }
        return .object(["udid": .string(udid), "state": .string("Shutdown")])
    }

    static func openURL(_ url: String, udid: String) async throws -> JSONValue {
        let result = await Shell.run(xcrun, ["simctl", "openurl", udid, url], timeout: .seconds(60))
        if result.code != 0 { throw SimulatorError.message(LocalCLI.clean(result.stderr)) }
        return .object(["url": .string(url)])
    }

    static func screenshotData(udid: String, maxHeight: CGFloat = 1100) async throws -> (Data, Int, Int) {
        let file = FileManager.default.temporaryDirectory.appending(path: "rb-sim-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        let result = await Shell.run(xcrun, ["simctl", "io", udid, "screenshot", "--type=png", file.path(percentEncoded: false)], timeout: .seconds(30))
        guard result.code == 0, let image = NSImage(contentsOf: file), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw SimulatorError.message(LocalCLI.clean(result.stderr).isEmpty ? "Não consegui tirar o print." : LocalCLI.clean(result.stderr))
        }
        return try jpeg(cg, maxHeight: maxHeight)
    }

    static func jpeg(_ cg: CGImage, maxHeight: CGFloat) throws -> (Data, Int, Int) {
        let scale = min(1, maxHeight / CGFloat(cg.height))
        let width = Int(CGFloat(cg.width) * scale)
        let height = Int(CGFloat(cg.height) * scale)
        guard
            let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else {
            throw SimulatorError.message("Não consegui reduzir o print.")
        }
        context.interpolationQuality = .high
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage(), let data = NSBitmapImageRep(cgImage: scaled).representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else {
            throw SimulatorError.message("Não consegui reduzir o print.")
        }
        return (data, width, height)
    }

    static func yamlString(_ text: String) -> String {
        "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    static func quickFlow(_ step: String) -> String {
        "appId: runelay.any\n---\n\(step)\n"
    }

    static func tapStep(_ body: JSONValue) throws -> String {
        if let text = body["text"]?.stringValue, !text.isEmpty { return "- tapOn: \(yamlString(text))" }
        if let id = body["id"]?.stringValue, !id.isEmpty { return "- tapOn:\n    id: \(yamlString(id))" }
        if let x = body["x"]?.doubleValue, let y = body["y"]?.doubleValue { return "- tapOn:\n    point: \"\(Int(x))%,\(Int(y))%\"" }
        throw SimulatorError.message("Diga text, id ou x e y.")
    }

    static func perform(op: String, body: JSONValue) async -> [String: JSONValue] {
        do {
            let result: JSONValue
            switch op {
            case "sim.list":
                result = await list()
            case "sim.boot":
                result = try await boot(body["udid"]?.stringValue ?? "")
            case "sim.shutdown":
                result = try await shutdown(body["udid"]?.stringValue ?? "")
            case "sim.open_url":
                result = try await openURL(body["url"]?.stringValue ?? "", udid: try await target(body))
            case "sim.screenshot":
                let (data, width, height) = try await screenshotData(udid: try await target(body))
                result = .object(["base64": .string(data.base64EncodedString()), "mimeType": .string("image/jpeg"), "width": .number(Double(width)), "height": .number(Double(height))])
            case "sim.tunnel":
                let port = try await MetroTunnel.shared.ensure(remote: body["port"]?.intValue ?? 0)
                result = .object(["localPort": .number(Double(port))])
            case "sim.tap":
                let run = try await MaestroRunner.run(flow: quickFlow(try tapStep(body)), name: "tap.yaml", udid: try await target(body))
                guard run.passed else { throw SimulatorError.message(run.error ?? "Não achei onde tocar.") }
                result = .object(["ok": .bool(true)])
            case "sim.type":
                let run = try await MaestroRunner.run(flow: quickFlow("- inputText: \(yamlString(body["text"]?.stringValue ?? ""))"), name: "type.yaml", udid: try await target(body))
                guard run.passed else { throw SimulatorError.message(run.error ?? "Não consegui digitar.") }
                result = .object(["ok": .bool(true)])
            case "maestro.run":
                let udid = try await target(body)
                let run = try await MaestroRunner.run(flow: body["flow"]?.stringValue ?? "", name: body["name"]?.stringValue ?? "flow.yaml", udid: udid)
                result = run.json
            case "maestro.install":
                result = try await MaestroRunner.install()
            default:
                return ["ok": .bool(false), "error": .string("Pedido desconhecido: \(op).")]
            }
            return ["ok": .bool(true), "result": result]
        } catch {
            return ["ok": .bool(false), "error": .string(error.localizedDescription)]
        }
    }
}
