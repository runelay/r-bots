import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class ServerStore {
    enum PanelTab: String, CaseIterable, Identifiable {
        case preview
        case logs

        var id: String { rawValue }
        var title: String { self == .preview ? tr("Prévia") : tr("Logs") }
    }

    static let shared = ServerStore()
    static let panelKind = "server"

    private(set) var servers: [DevServerInfo] = []
    private(set) var busy: Set<String> = []
    private(set) var failure: String?
    private(set) var profiles: [RunProfile] = []
    var panelTabs: [String: PanelTab] = [:]

    @ObservationIgnored private(set) var client: BotsClient?
    @ObservationIgnored private var failureTask: Task<Void, Never>?

    private init() {}

    static func isServerKind(_ kind: String) -> Bool { kind == panelKind }

    static func isPaneKind(_ kind: String) -> Bool {
        kind == panelKind || kind == SimulatorStore.panelKind || kind == TestStore.panelKind || kind == SideThread.panelKind
            || kind == WebPageStore.panelKind
    }

    func attach(_ client: BotsClient) {
        self.client = client
    }

    func server(id: String) -> DevServerInfo? {
        servers.first { $0.id == id }
    }

    var visible: [DevServerInfo] {
        servers.filter { $0.status != .stopped }
    }

    func applySnapshot(_ value: JSONValue?) {
        guard let items = value?.arrayValue else { return }
        servers = items.compactMap(DevServerInfo.init)
    }

    func applyLine(_ value: JSONValue) {
        guard let server = DevServerInfo(value["server"]) else { return }
        if value["removed"]?.boolValue == true {
            servers.removeAll { $0.id == server.id }
            return
        }
        if let index = servers.firstIndex(where: { $0.id == server.id }) {
            servers[index] = server
        } else {
            servers.insert(server, at: 0)
        }
    }

    func reset() {
        servers = []
        profiles = []
    }

    func refresh() async {
        guard let client else { return }
        if let list = try? await client.devServers() {
            servers = list
        }
    }

    func loadProfiles() async {
        guard let client else { return }
        profiles = (try? await client.serverProfiles()) ?? profiles
    }

    func previewURL(for server: DevServerInfo) -> URL? {
        guard let client, let path = server.previewPath else { return nil }
        return try? client.request(path: path).url
    }

    func panelTab(for id: String) -> PanelTab {
        panelTabs[id] ?? .logs
    }

    func openPanel(_ server: DevServerInfo, botID: String, tab: PanelTab) {
        guard let client else { return }
        panelTabs[server.id] = server.isMobile ? .logs : tab
        ArtifactCenter.shared.open(
            ArtifactRef(botID: botID, id: server.id, title: server.title, kind: Self.panelKind, version: 1),
            client: client
        )
    }

    func openInBrowser(_ server: DevServerInfo, location: String? = nil) {
        Task {
            guard let url = await browserURL(server, location: location) else { return }
            NSWorkspace.shared.open(url)
        }
    }

    func copyURL(_ server: DevServerInfo) {
        Task {
            guard let url = await browserURL(server, location: nil) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url.absoluteString, forType: .string)
        }
    }

    private func browserURL(_ server: DevServerInfo, location: String?) async -> URL? {
        guard let client,
            let path = try? await client.previewLink(id: server.id),
            let root = try? client.request(path: path).url
        else { return nil }
        guard let location else { return root }
        return PreviewAddress.proxyURL(root: root, location: location) ?? root
    }

    func start(path: String?, script: String?, profile: String?) async -> DevServerInfo? {
        guard let client else { return nil }
        do {
            let server = try await client.startServer(path: path, script: script, profile: profile)
            if let server {
                applyLine(.object(["server": serverJSON(server)]))
            }
            return server
        } catch {
            flash(ErrorMessage.describe(error))
            return nil
        }
    }

    func stop(_ id: String) {
        run(id) { client in try await client.stopServer(id: id) }
    }

    func restart(_ id: String) {
        run(id) { client in try await client.restartServer(id: id) }
    }

    func forget(_ id: String) {
        servers.removeAll { $0.id == id }
        run(id) { client in try await client.forgetServer(id: id) }
    }

    func saveProfile(name: String, path: String, script: String) async {
        guard let client else { return }
        do {
            _ = try await client.saveServerProfile(name: name, path: path, script: script)
            await loadProfiles()
        } catch {
            flash(ErrorMessage.describe(error))
        }
    }

    func deleteProfile(_ id: String) async {
        guard let client else { return }
        profiles.removeAll { $0.id == id }
        try? await client.deleteServerProfile(id: id)
    }

    private func run(_ id: String, _ action: @escaping @Sendable (BotsClient) async throws -> Void) {
        guard let client else { return }
        busy.insert(id)
        Task {
            do {
                try await action(client)
            } catch {
                flash(ErrorMessage.describe(error))
            }
            busy.remove(id)
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

    private func serverJSON(_ server: DevServerInfo) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(server.id),
            "name": .string(server.name),
            "kind": .string(server.kind),
            "command": .string(server.command),
            "tool": .string(server.tool),
            "startedBy": .string(server.startedBy),
            "envKeys": .array(server.envKeys.map(JSONValue.string)),
            "port": .number(Double(server.port)),
            "status": .string(server.status.rawValue),
            "cwd": .string(server.cwd),
        ]
        if let branch = server.branch { object["branch"] = .string(branch) }
        if let script = server.script { object["script"] = .string(script) }
        if let path = server.previewPath { object["previewPath"] = .string(path) }
        if let startedAt = server.startedAt { object["startedAt"] = .string(startedAt) }
        return .object(object)
    }
}
