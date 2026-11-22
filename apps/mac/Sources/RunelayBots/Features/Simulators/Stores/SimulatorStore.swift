import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class SimulatorStore {
    static let shared = SimulatorStore()
    static let panelKind = "simulator"

    private(set) var devices: [SimDevice] = []
    private(set) var loading = false
    private(set) var busy: Set<String> = []
    private(set) var failure: String?
    private(set) var maestroInstalled = false
    var pendingApp: [String: String] = [:]
    var preferredUDID: String = UserDefaults.standard.string(forKey: "simulators.preferred") ?? "" {
        didSet { UserDefaults.standard.set(preferredUDID, forKey: "simulators.preferred") }
    }

    var preferredDevice: SimDevice? {
        let ios = iosDevices
        return ios.first { $0.udid == preferredUDID } ?? ios.first(where: \.booted) ?? ios.first
    }

    func openApp(_ server: DevServerInfo, botID: String, client: BotsClient) {
        Task {
            if devices.isEmpty { await refresh() }
            guard let device = preferredDevice else {
                flash(tr("Nenhum simulador no Xcode deste Mac."))
                return
            }
            pendingApp[device.udid] = server.id
            openPanel(device, botID: botID, client: client)
        }
    }

    func takePending(_ udid: String) -> DevServerInfo? {
        guard let id = pendingApp.removeValue(forKey: udid) else { return nil }
        return ServerStore.shared.server(id: id)
    }

    @ObservationIgnored private var failureTask: Task<Void, Never>?

    private init() {}

    var iosDevices: [SimDevice] { devices.filter { $0.platform == "ios" } }
    var androidDevices: [SimDevice] { devices.filter { $0.platform == "android" } }

    func device(_ udid: String) -> SimDevice? {
        devices.first { $0.udid == udid }
    }

    func refresh() async {
        loading = true
        let list = await SimulatorRunner.list()
        devices = (list["devices"]?.arrayValue ?? []).compactMap { item in
            guard let udid = item["udid"]?.stringValue else { return nil }
            return SimDevice(
                udid: udid,
                name: item["name"]?.stringValue ?? "",
                runtime: item["runtime"]?.stringValue ?? "",
                state: item["state"]?.stringValue ?? "Shutdown",
                platform: item["platform"]?.stringValue ?? "ios"
            )
        }
        maestroInstalled = list["maestro"]?["installed"]?.boolValue ?? false
        loading = false
    }

    func toggle(_ device: SimDevice) {
        perform(device.udid) {
            if device.booted {
                _ = try await SimulatorRunner.shutdown(device.udid)
            } else {
                _ = try await SimulatorRunner.boot(device.udid)
            }
        }
    }

    func openPanel(_ device: SimDevice, botID: String, client: BotsClient) {
        ArtifactCenter.shared.open(
            ArtifactRef(botID: botID, id: device.udid, title: device.name, kind: Self.panelKind, version: 1),
            client: client
        )
    }

    func openURL(_ url: String, udid: String) {
        perform(udid) {
            _ = try await SimulatorRunner.openURL(url, udid: udid)
        }
    }

    func openExpo(server: DevServerInfo, client: BotsClient) {
        perform(server.id) {
            var request = try client.request(path: "/simulators/open-expo")
            request.httpMethod = "POST"
            request.timeoutInterval = 90
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(JSONValue.object(["server": .string(server.id)]))
            let (data, response) = try await URLSession.shared.data(for: request)
            AuthStore.reportUnauthorized(response)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let json = try? JSONDecoder().decode(JSONValue.self, from: data)
                throw SimulatorError.message(json?["error"]?.stringValue ?? tr("Não consegui abrir no simulador."))
            }
        }
    }

    func screenshot(udid: String, into conversation: ConversationStore?) {
        perform(udid) {
            let (data, _, _) = try await SimulatorRunner.screenshotData(udid: udid, maxHeight: 1600)
            let file = FileManager.default.temporaryDirectory.appending(path: tr("Simulador %@.jpg", Self.stamp()))
            try data.write(to: file)
            guard let conversation else { throw SimulatorError.message(tr("Abra uma conversa para anexar o print.")) }
            conversation.attachFiles([file], ownsFiles: true)
        }
    }

    private static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH.mm.ss"
        return formatter.string(from: Date())
    }

    private func perform(_ key: String, _ action: @escaping @MainActor () async throws -> Void) {
        busy.insert(key)
        Task {
            do {
                try await action()
            } catch {
                flash(error.localizedDescription)
            }
            busy.remove(key)
            await refresh()
        }
    }

    private func flash(_ message: String) {
        failure = message
        failureTask?.cancel()
        failureTask = Task {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            failure = nil
        }
    }
}
