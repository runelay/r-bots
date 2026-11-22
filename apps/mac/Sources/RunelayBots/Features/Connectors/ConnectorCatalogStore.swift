import AppKit
import Foundation
import Observation

struct CatalogConnector: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    let name: String
    let description: String
    let icon: String?
    let auth: String
    let tokenUrl: String?
    let featured: Bool
    var installed: Bool
    var sourceName: String?
    var status: String?

    var connectionName: String { sourceName ?? id }
    var needsLogin: Bool { installed && status == "needs_auth" }

    private enum CodingKeys: String, CodingKey {
        case id, name, description, icon, auth, tokenUrl, featured, installed, sourceName, status
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? id
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? ""
        icon = try? container.decodeIfPresent(String.self, forKey: .icon)
        auth = (try? container.decodeIfPresent(String.self, forKey: .auth)) ?? "oauth"
        tokenUrl = try? container.decodeIfPresent(String.self, forKey: .tokenUrl)
        featured = (try? container.decodeIfPresent(Bool.self, forKey: .featured)) ?? false
        installed = (try? container.decodeIfPresent(Bool.self, forKey: .installed)) ?? false
        sourceName = try? container.decodeIfPresent(String.self, forKey: .sourceName)
        status = try? container.decodeIfPresent(String.self, forKey: .status)
    }
}

struct CatalogSection: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    let title: String
    var items: [CatalogConnector]
}

struct ConnectorCatalog: Hashable, Sendable, Decodable {
    var featured: [CatalogConnector]
    var sections: [CatalogSection]

    var isEmpty: Bool { featured.isEmpty && sections.isEmpty }

    var all: [CatalogConnector] { featured + sections.flatMap(\.items) }

    mutating func update(_ id: String, _ change: (inout CatalogConnector) -> Void) {
        for index in featured.indices where featured[index].id == id {
            change(&featured[index])
        }
        for section in sections.indices {
            for index in sections[section].items.indices where sections[section].items[index].id == id {
                change(&sections[section].items[index])
            }
        }
    }
}

struct CatalogInstallResult: Decodable, Sendable {
    let sourceName: String
    let status: String?
    let error: String?
    let authorizationUrl: String?
}

struct CatalogLoginResult: Decodable, Sendable {
    let authorizationUrl: String?
}

extension BotsClient {
    func connectorCatalog(query: String) async throws -> ConnectorCatalog {
        let items = query.isEmpty ? [] : [URLQueryItem(name: "query", value: query)]
        let data = try await catalogCall(try request(path: "/connectors/catalog", query: items))
        return try JSONDecoder().decode(ConnectorCatalog.self, from: data)
    }

    func installConnector(id: String, token: String?) async throws -> CatalogInstallResult {
        var urlRequest = try request(path: "/connectors/\(Self.catalogEscape(id))/install")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 45
        if let token {
            urlRequest.httpBody = try JSONEncoder().encode(["token": token])
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try JSONDecoder().decode(CatalogInstallResult.self, from: try await catalogCall(urlRequest))
    }

    func reconnectConnector(sourceName: String) async throws -> CatalogLoginResult {
        var urlRequest = try request(path: "/connectors/\(Self.catalogEscape(sourceName))/reconnect")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 45
        return try JSONDecoder().decode(CatalogLoginResult.self, from: try await catalogCall(urlRequest))
    }

    func removeConnector(sourceName: String) async throws {
        var urlRequest = try request(path: "/connectors/\(Self.catalogEscape(sourceName))")
        urlRequest.httpMethod = "DELETE"
        _ = try await catalogCall(urlRequest)
    }

    private func catalogCall(_ urlRequest: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }
        if http.statusCode == 404, urlRequest.url?.path.hasSuffix("/catalog") == true {
            throw ClientError.unsupported
        }
        guard (200..<300).contains(http.statusCode) else {
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw ClientError.http(http.statusCode, json?["error"]?.stringValue ?? json?["error"]?["message"]?.stringValue)
        }
        return data
    }

    private static func catalogEscape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}

enum CatalogLinks {
    static let dashboard = URL(string: "https://app.runelay.com/connectors")
    static let site = URL(string: "https://runelay.com")
}

@MainActor
@Observable
final class ConnectorCatalogStore {
    private(set) var state: LoadState<ConnectorCatalog> = .idle
    private(set) var query = ""
    private(set) var isSearching = false
    private(set) var pending: Set<String> = []
    var detail: String?
    var pendingRemoval: CatalogConnector?
    var tokenRequest: CatalogConnector?

    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var awaitingBrowser = false

    var catalog: ConnectorCatalog? {
        if case .loaded(let catalog) = state {
            return catalog
        }
        return nil
    }

    func item(id: String) -> CatalogConnector? {
        catalog?.all.first { $0.id == id }
    }

    func load(model: AppModel) async {
        if catalog == nil {
            state = .loading
        }
        do {
            state = .loaded(try await model.client.connectorCatalog(query: query))
        } catch {
            if catalog == nil {
                state = .failed(ErrorMessage.describe(error))
            } else {
                model.showNotice(ErrorMessage.describe(error))
            }
        }
        isSearching = false
    }

    func search(_ text: String, model: AppModel) {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled, next != query else { return }
            query = next
            isSearching = true
            await load(model: model)
        }
    }

    func appBecameActive(model: AppModel) {
        guard awaitingBrowser else { return }
        awaitingBrowser = false
        Task {
            await load(model: model)
            model.refreshConnectors()
        }
    }

    func requestInstall(_ item: CatalogConnector, model: AppModel) {
        if item.auth == "api_key" {
            tokenRequest = item
        } else {
            install(item, token: nil, model: model)
        }
    }

    func install(_ item: CatalogConnector, token: String?, model: AppModel) {
        guard !pending.contains(item.id) else { return }
        let snapshot = state
        pending.insert(item.id)
        mark(item.id, installed: true, sourceName: item.connectionName, status: item.auth == "oauth" ? "needs_auth" : "idle")
        Task {
            defer { pending.remove(item.id) }
            do {
                let result = try await model.client.installConnector(id: item.id, token: token)
                if let link = result.authorizationUrl, let url = URL(string: link) {
                    awaitingBrowser = true
                    NSWorkspace.shared.open(url)
                } else if item.auth == "api_key", result.status != "ok" {
                    model.showNotice(result.error ?? tr("O %@ não aceitou o token.", item.name))
                } else {
                    model.showNotice(tr("%@ instalado.", item.name))
                }
            } catch {
                state = snapshot
                model.showNotice(ErrorMessage.describe(error))
            }
            await load(model: model)
            model.refreshConnectors()
        }
    }

    func reconnect(_ item: CatalogConnector, model: AppModel) {
        guard !pending.contains(item.id) else { return }
        pending.insert(item.id)
        Task {
            defer { pending.remove(item.id) }
            do {
                let result = try await model.client.reconnectConnector(sourceName: item.connectionName)
                if let link = result.authorizationUrl, let url = URL(string: link) {
                    awaitingBrowser = true
                    NSWorkspace.shared.open(url)
                } else {
                    model.showNotice(tr("%@ já está conectado.", item.name))
                }
            } catch {
                model.showNotice(ErrorMessage.describe(error))
            }
        }
    }

    func remove(_ item: CatalogConnector, model: AppModel) {
        let snapshot = state
        mark(item.id, installed: false, sourceName: nil, status: nil)
        if detail == item.connectionName {
            detail = nil
        }
        Task {
            do {
                try await model.client.removeConnector(sourceName: item.connectionName)
                model.showNotice(tr("%@ removido.", item.name))
            } catch {
                state = snapshot
                model.showNotice(ErrorMessage.describe(error))
            }
            await load(model: model)
            model.refreshConnectors()
        }
    }

    func addMenuItems(model: AppModel) -> [GlassMenuItem] {
        [
            GlassMenuItem(tr("Conexão personalizada"), systemImage: "powerplug") {
                Self.openDashboard()
            },
            GlassMenuItem(tr("Importar de outro cliente"), systemImage: "square.and.arrow.down") {
                Self.openDashboard()
            },
        ]
    }

    func optionItems(for id: String, model: AppModel) -> [GlassMenuItem] {
        guard let item = item(id: id) else { return [] }
        var items = [
            GlassMenuItem(tr("Abrir"), systemImage: "arrow.up.forward.square") { [weak self] in
                self?.detail = item.connectionName
            }
        ]
        if item.auth == "oauth" {
            items.append(
                GlassMenuItem(tr("Reconectar"), systemImage: "arrow.clockwise") { [weak self] in
                    self?.reconnect(item, model: model)
                })
        }
        items.append(
            GlassMenuItem(tr("Remover"), systemImage: "trash", destructive: true) { [weak self] in
                self?.pendingRemoval = item
            })
        return items
    }

    private func mark(_ id: String, installed: Bool, sourceName: String?, status: String?) {
        guard var catalog else { return }
        catalog.update(id) { item in
            item.installed = installed
            item.sourceName = sourceName
            item.status = status
        }
        state = .loaded(catalog)
    }

    private static func openDashboard() {
        if let url = CatalogLinks.dashboard {
            NSWorkspace.shared.open(url)
        }
    }
}
