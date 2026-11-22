import AppKit
import Foundation
import Observation
import SwiftUI

extension BotsClient {
    func linearViews(refresh: Bool) async throws -> [LNView] {
        let query = refresh ? [URLQueryItem(name: "refresh", value: "1")] : []
        return try await boardRequest("/linear/views", query: query, as: LNViewsReply.self).views
    }

    func linearLabels() async throws -> [LNLabel] {
        try await boardRequest("/linear/labels", as: LNLabelsReply.self).labels
    }

    func linearUsers() async throws -> [LNUser] {
        try await boardRequest("/linear/users", as: LNUsersReply.self).users
    }

    func linearProjects() async throws -> [LNProject] {
        try await boardRequest("/linear/projects", as: LNProjectsReply.self).projects
    }

    func linearBoard(view: String, query: String, label: String?, project: String?, cursor: String?, refresh: Bool) async throws -> LNBoard {
        var items = [URLQueryItem(name: "view", value: view)]
        if let label { items.append(URLQueryItem(name: "label", value: label)) }
        if let project { items.append(URLQueryItem(name: "project", value: project)) }
        if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        if refresh { items.append(URLQueryItem(name: "refresh", value: "1")) }
        return try await boardRequest("/linear/board", query: items, timeout: 60, as: LNBoard.self)
    }

    func linearIssue(_ id: String) async throws -> LNIssueDetail {
        try await boardRequest("/linear/issues/\(Self.pathPart(id))", as: LNIssueReply.self).issue
    }

    func linearAction(_ id: String, action: String, body: [String: JSONValue] = [:]) async throws -> LNMoveReply {
        try await boardRequest("/linear/issues/\(Self.pathPart(id))/\(action)", method: "POST", body: body, as: LNMoveReply.self)
    }

    func linearAssign(_ id: String) async throws {
        struct Reply: Decodable, Sendable { let assigned: Bool }
        _ = try await boardRequest("/linear/issues/\(Self.pathPart(id))/assign", method: "POST", body: [:], as: Reply.self)
    }

    func linearSummary() async throws -> LNSummary {
        try await boardRequest("/linear/summary", as: LNSummary.self)
    }
}

@MainActor
@Observable
final class LinearStore {
    static let shared = LinearStore()

    private(set) var views: [LNView] = []
    private(set) var viewID = UserDefaults.standard.string(forKey: "linear.view") ?? "mine"
    var query = ""
    private(set) var phase: LoadPhase = .idle
    private(set) var columns: [LNColumn] = []
    private(set) var cards: [LNCard] = []
    private(set) var nextCursor: String?
    private(set) var searchable = true
    private(set) var loadingMore = false
    private(set) var refreshing = false
    private(set) var selectedID: String?
    private(set) var detail: LNIssueDetail?
    private(set) var detailPhase: LoadPhase = .idle
    private(set) var busy: String?
    private(set) var notice: BoardNotice?
    private(set) var summary: LNSummary?
    private(set) var labels: [LNLabel] = []
    private(set) var projects: [LNProject] = []
    private(set) var users: [LNUser] = []
    private(set) var labelFilter = UserDefaults.standard.string(forKey: "linear.label")
    private(set) var projectFilter = UserDefaults.standard.string(forKey: "linear.project")
    private(set) var summaryError: String?

    @ObservationIgnored private var client: BotsClient?
    @ObservationIgnored private var token = 0
    @ObservationIgnored private var detailTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    var currentView: LNView? { views.first { $0.id == viewID } }

    var projectViewActive: Bool { viewID.hasPrefix("project:") }

    var activeProject: String? { projectViewActive ? nil : projectFilter }

    func labelColor(_ name: String) -> Color? {
        let lowered = name.lowercased()
        return LinearPalette.color(hex: labels.first { $0.name.lowercased() == lowered }?.color)
    }

    func avatar(for name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        let lowered = name.lowercased()
        return users.first {
            $0.name.lowercased() == lowered || $0.displayName?.lowercased() == lowered || $0.email?.lowercased() == lowered
        }?.avatarUrl
    }

    func project(named name: String) -> LNProject? {
        projects.first { $0.name == name }
    }

    func loadCatalogs() async {
        guard let client else { return }
        async let loadedLabels = try? client.linearLabels()
        async let loadedProjects = try? client.linearProjects()
        async let loadedUsers = try? client.linearUsers()
        if let value = await loadedLabels { labels = value }
        if let value = await loadedProjects { projects = value }
        if let value = await loadedUsers { users = value }
    }

    func setLabelFilter(_ name: String?) {
        guard name != labelFilter else { return }
        labelFilter = name
        UserDefaults.standard.set(name, forKey: "linear.label")
        Task { await load() }
    }

    func setProjectFilter(_ id: String?) {
        guard id != projectFilter else { return }
        projectFilter = id
        UserDefaults.standard.set(id, forKey: "linear.project")
        Task { await load() }
    }

    func attach(_ client: BotsClient) {
        self.client = client
    }

    func cards(in column: LNColumn) -> [LNCard] {
        cards.filter { $0.column == column.key }
    }

    func start() async {
        if labels.isEmpty || projects.isEmpty || users.isEmpty { Task { await loadCatalogs() } }
        if views.isEmpty { await loadViews(refresh: false) }
        if phase == .idle || cards.isEmpty { await load() }
    }

    func loadViews(refresh: Bool) async {
        guard let client else { return }
        do {
            views = try await client.linearViews(refresh: refresh)
            if !views.contains(where: { $0.id == viewID }), let first = views.first {
                viewID = first.id
            }
        } catch {
            if views.isEmpty { phase = .failed(error.localizedDescription) }
        }
    }

    func choose(_ id: String) {
        guard id != viewID else { return }
        viewID = id
        UserDefaults.standard.set(id, forKey: "linear.view")
        query = ""
        Task { await load() }
    }

    func search(_ text: String) async {
        query = text
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled, query == text else { return }
        await load()
    }

    func load(refresh: Bool = false) async {
        guard let client else { return }
        token += 1
        let current = token
        if !refresh || phase != .loaded { phase = .loading }
        if refresh { refreshing = true }
        defer { if current == token { refreshing = false } }
        do {
            let board = try await client.linearBoard(view: viewID, query: searchable ? query : "", label: labelFilter, project: activeProject, cursor: nil, refresh: refresh)
            guard current == token else { return }
            columns = board.columns
            cards = board.issues
            nextCursor = board.nextCursor
            searchable = board.searchable
            phase = .loaded
            if refresh, selectedID != nil { await reloadDetail() }
        } catch {
            guard current == token else { return }
            phase = .failed(error.localizedDescription)
        }
    }

    func loadMore() async {
        guard let client, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let current = token
        do {
            let board = try await client.linearBoard(view: viewID, query: searchable ? query : "", label: labelFilter, project: activeProject, cursor: cursor, refresh: false)
            guard current == token else { return }
            let known = Set(cards.map(\.id))
            cards += board.issues.filter { !known.contains($0.id) }
            for column in board.columns where !columns.contains(where: { $0.key == column.key }) {
                columns.append(column)
            }
            recount()
            nextCursor = board.nextCursor
        } catch {
            show(.failure(error.localizedDescription))
        }
    }

    private func recount() {
        for index in columns.indices {
            columns[index].count = cards.filter { $0.column == columns[index].key }.count
        }
    }

    func poll() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(90))
            guard !Task.isCancelled, busy == nil else { continue }
            await load(refresh: true)
        }
    }

    func loadSummary() async {
        guard let client else { return }
        do {
            summary = try await client.linearSummary()
            summaryError = nil
        } catch {
            summaryError = error.localizedDescription
        }
    }

    func select(_ id: String?) {
        selectedID = id
        detailTask?.cancel()
        guard id != nil else {
            detail = nil
            return
        }
        if detail?.card.id != id { detail = nil }
        detailTask = Task { await reloadDetail() }
    }

    func focus(identifier: String) {
        select(identifier.uppercased())
    }

    func reloadDetail() async {
        guard let client, let id = selectedID else { return }
        if detail?.card.id != id { detailPhase = .loading }
        do {
            let loaded = try await client.linearIssue(id)
            guard !Task.isCancelled, selectedID == id else { return }
            detail = loaded
            detailPhase = .loaded
        } catch {
            guard !Task.isCancelled, selectedID == id else { return }
            if detail?.card.id != id { detailPhase = .failed(error.localizedDescription) }
        }
    }

    func move(_ id: String, to columnKey: String) async {
        guard let client, let index = cards.firstIndex(where: { $0.id == id }) else { return }
        let original = cards[index]
        guard original.column != columnKey, let column = columns.first(where: { $0.key == columnKey }) else { return }
        cards[index].column = column.key
        cards[index].state = column.name
        cards[index].stateType = column.type
        recount()
        do {
            let reply = try await client.linearAction(id, action: "state", body: ["column": .string(columnKey)])
            if let fresh = cards.firstIndex(where: { $0.id == id }) {
                cards[fresh].column = reply.column
                cards[fresh].state = reply.state
                cards[fresh].stateType = reply.stateType
            }
            recount()
            if selectedID == id { await reloadDetail() }
        } catch {
            if let fresh = cards.firstIndex(where: { $0.id == id }) {
                cards[fresh] = original
            }
            recount()
            show(.failure(tr("Não deu para mover %@: %@", id, error.localizedDescription)))
        }
    }

    func startIssue(_ id: String) async {
        guard let client, busy == nil else { return }
        busy = "start"
        defer { busy = nil }
        do {
            let reply = try await client.linearAction(id, action: "start")
            apply(reply)
            if let branch = reply.branch, !branch.isEmpty {
                copy(branch)
                show(.success(tr("%1$@ em %2$@. Branch copiada", id, reply.state)))
            } else {
                show(.success(tr("%1$@ em %2$@", id, reply.state)))
            }
            if selectedID == id { await reloadDetail() }
        } catch {
            show(.failure(error.localizedDescription))
        }
    }

    func assignToMe(_ id: String) async {
        guard let client, busy == nil else { return }
        busy = "assign"
        defer { busy = nil }
        do {
            try await client.linearAssign(id)
            show(.success(tr("%@ agora é seu", id)))
            if selectedID == id { await reloadDetail() }
            if let fresh = detail, fresh.card.id == id, let index = cards.firstIndex(where: { $0.id == id }) {
                cards[index].assignee = fresh.card.assignee
            }
        } catch {
            show(.failure(error.localizedDescription))
        }
    }

    private func apply(_ reply: LNMoveReply) {
        if let index = cards.firstIndex(where: { $0.id == reply.id }) {
            cards[index].column = reply.column
            cards[index].state = reply.state
            cards[index].stateType = reply.stateType
            if !columns.contains(where: { $0.key == reply.column }) {
                columns.append(LNColumn(key: reply.column, name: reply.state, type: reply.stateType, count: 0))
            }
            recount()
        }
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func show(_ next: BoardNotice) {
        notice = next
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(next.isError ? 6 : 3))
            guard !Task.isCancelled else { return }
            notice = nil
        }
    }

    func dismissNotice() {
        notice = nil
    }
}
