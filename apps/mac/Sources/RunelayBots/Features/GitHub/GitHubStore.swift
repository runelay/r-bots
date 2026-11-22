import AppKit
import Foundation
import Observation

extension BotsClient {
    func githubOverview(filter: GHFilter, repo: String?, query: String, cursor: String?, refresh: Bool) async throws -> GHOverview {
        var items = [URLQueryItem(name: "filter", value: filter.rawValue)]
        if let repo { items.append(URLQueryItem(name: "repo", value: repo)) }
        if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        if refresh { items.append(URLQueryItem(name: "refresh", value: "1")) }
        return try await boardRequest("/github/pulls", query: items, as: GHOverview.self)
    }

    func githubSummary() async throws -> GHCounts {
        try await boardRequest("/github/summary", as: GHSummaryReply.self).counts
    }

    private static func pullPath(_ repo: String, _ number: Int) -> String {
        let parts = repo.split(separator: "/").map { pathPart(String($0)) }
        return "/github/repos/\(parts.joined(separator: "/"))/pulls/\(number)"
    }

    func githubPull(repo: String, number: Int, refresh: Bool) async throws -> GHPullDetail {
        let query = refresh ? [URLQueryItem(name: "refresh", value: "1")] : []
        return try await boardRequest(Self.pullPath(repo, number), query: query, as: GHPullReply.self).pull
    }

    func githubAction<T: Decodable>(repo: String, number: Int, action: String, body: [String: JSONValue], as type: T.Type) async throws -> T {
        try await boardRequest(Self.pullPath(repo, number) + "/\(action)", method: "POST", body: body, timeout: 90, as: type)
    }
}

enum LoadPhase: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

@MainActor
@Observable
final class GitHubStore {
    static let shared = GitHubStore()

    var filter: GHFilter = .mine
    var repo: String?
    var query = ""
    private(set) var phase: LoadPhase = .idle
    private(set) var items: [GHPull] = []
    private(set) var counts: GHCounts = .zero
    private(set) var repos: [GHRepoGroup] = []
    private(set) var viewer: GHPerson?
    private(set) var total = 0
    private(set) var nextCursor: String?
    private(set) var loadingMore = false
    private(set) var refreshing = false
    private(set) var selectedKey: String?
    private(set) var detail: GHPullDetail?
    private(set) var detailPhase: LoadPhase = .idle
    private(set) var busy: String?
    private(set) var notice: BoardNotice?
    private(set) var summary: GHCounts?
    private(set) var summaryError: String?

    @ObservationIgnored private var client: BotsClient?
    @ObservationIgnored private var loadToken = 0
    @ObservationIgnored private var detailTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var focusTarget: (repo: String, number: Int)?

    var selected: GHPull? {
        guard let selectedKey else { return nil }
        return items.first { $0.key == selectedKey } ?? (detail?.pull.key == selectedKey ? detail?.pull : nil)
    }

    var allCount: Int { repos.reduce(0) { $0 + $1.count } }

    func attach(_ client: BotsClient) {
        self.client = client
    }

    func setFilter(_ next: GHFilter) {
        guard next != filter else { return }
        filter = next
        Task { await load() }
    }

    func setRepo(_ next: String?) {
        guard next != repo else { return }
        repo = next
        Task { await load() }
    }

    func search(_ text: String) async {
        query = text
        try? await Task.sleep(for: .milliseconds(320))
        guard !Task.isCancelled, query == text else { return }
        await load()
    }

    func load(refresh: Bool = false) async {
        guard let client else { return }
        loadToken += 1
        let token = loadToken
        if !refresh || phase != .loaded { phase = .loading }
        if refresh { refreshing = true }
        defer { if token == loadToken { refreshing = false } }
        do {
            let overview = try await client.githubOverview(filter: filter, repo: repo, query: query, cursor: nil, refresh: refresh)
            guard token == loadToken else { return }
            apply(overview, append: false)
            phase = .loaded
            summary = overview.counts.repoIndependent(repo: repo) ?? summary
            if let focus = focusTarget {
                focusTarget = nil
                select(repo: focus.repo, number: focus.number)
            } else if selectedKey == nil, let first = items.first {
                select(first)
            } else if selectedKey != nil {
                await reloadDetail(refresh: refresh)
            }
        } catch {
            guard token == loadToken else { return }
            phase = .failed(error.localizedDescription)
        }
    }

    func loadMore() async {
        guard let client, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let token = loadToken
        do {
            let overview = try await client.githubOverview(filter: filter, repo: repo, query: query, cursor: cursor, refresh: false)
            guard token == loadToken else { return }
            apply(overview, append: true)
        } catch {
            show(.failure(error.localizedDescription))
        }
    }

    private func apply(_ overview: GHOverview, append: Bool) {
        viewer = overview.viewer
        counts = overview.counts
        repos = overview.repos
        total = overview.total
        nextCursor = overview.nextCursor
        if append {
            let known = Set(items.map(\.key))
            items += overview.items.filter { !known.contains($0.key) }
        } else {
            items = overview.items
        }
    }

    func poll() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled, busy == nil else { continue }
            await load(refresh: true)
        }
    }

    func loadSummary() async {
        guard let client else { return }
        do {
            summary = try await client.githubSummary()
            summaryError = nil
        } catch {
            summaryError = error.localizedDescription
        }
    }

    func select(_ pull: GHPull) {
        select(repo: pull.repo, number: pull.number)
    }

    func select(repo: String, number: Int) {
        let key = "\(repo)#\(number)"
        if selectedKey == key, detail?.pull.key == key { return }
        selectedKey = key
        if detail?.pull.key != key {
            detail = nil
        }
        detailTask?.cancel()
        detailTask = Task { await reloadDetail(refresh: false) }
    }

    func focus(repo: String, number: Int) {
        if phase == .loaded || !items.isEmpty {
            select(repo: repo, number: number)
        } else {
            focusTarget = (repo, number)
            selectedKey = "\(repo)#\(number)"
        }
    }

    func move(by offset: Int) {
        guard !items.isEmpty else { return }
        let index = items.firstIndex { $0.key == selectedKey } ?? -1
        let next = min(max(index + offset, 0), items.count - 1)
        select(items[next])
    }

    func reloadDetail(refresh: Bool) async {
        guard let client, let key = selectedKey, let target = Self.parse(key) else { return }
        if detail?.pull.key != key { detailPhase = .loading }
        do {
            let loaded = try await client.githubPull(repo: target.repo, number: target.number, refresh: refresh)
            guard !Task.isCancelled, selectedKey == key else { return }
            detail = loaded
            detailPhase = .loaded
        } catch {
            guard !Task.isCancelled, selectedKey == key else { return }
            if detail?.pull.key != key {
                detailPhase = .failed(error.localizedDescription)
            }
        }
    }

    private static func parse(_ key: String) -> (repo: String, number: Int)? {
        guard let hash = key.lastIndex(of: "#"), let number = Int(key[key.index(after: hash)...]) else { return nil }
        return (String(key[..<hash]), number)
    }

    private func perform(_ label: String, success: String, _ work: @escaping (BotsClient, String, Int) async throws -> GHPullDetail) async {
        guard let client, let key = selectedKey, let target = Self.parse(key), busy == nil else { return }
        busy = label
        defer { busy = nil }
        do {
            let updated = try await work(client, target.repo, target.number)
            if selectedKey == key { detail = updated }
            replace(updated.pull)
            show(.success(success))
        } catch {
            show(.failure(error.localizedDescription))
        }
    }

    private func replace(_ pull: GHPull) {
        if let index = items.firstIndex(where: { $0.key == pull.key }) {
            items[index] = pull
        }
    }

    func merge(method: GHMergeMethod, deleteBranch: Bool) async {
        await perform("merge", success: tr("PR mergeado")) { client, repo, number in
            let reply = try await client.githubAction(
                repo: repo,
                number: number,
                action: "merge",
                body: ["method": .string(method.rawValue), "deleteBranch": .bool(deleteBranch)],
                as: GHMergeReply.self
            )
            return reply.pull
        }
        await loadSummary()
    }

    func review(event: String, body: String) async {
        let success = event == "approve" ? tr("Você aprovou o PR") : event == "request_changes" ? tr("Pedido de mudanças enviado") : tr("Revisão enviada")
        await perform("review", success: success) { client, repo, number in
            try await client.githubAction(
                repo: repo,
                number: number,
                action: "review",
                body: ["event": .string(event), "body": .string(body)],
                as: GHPullReply.self
            ).pull
        }
    }

    func comment(_ body: String) async {
        await perform("comment", success: tr("Comentário enviado")) { client, repo, number in
            try await client.githubAction(repo: repo, number: number, action: "comment", body: ["body": .string(body)], as: GHPullReply.self).pull
        }
    }

    func reply(threadID: String, body: String) async {
        await perform("reply", success: tr("Resposta enviada")) { client, repo, number in
            try await client.githubAction(
                repo: repo,
                number: number,
                action: "reply",
                body: ["threadId": .string(threadID), "body": .string(body)],
                as: GHPullReply.self
            ).pull
        }
    }

    func markReady() async {
        await perform("ready", success: tr("PR pronto para revisão")) { client, repo, number in
            try await client.githubAction(repo: repo, number: number, action: "ready", body: [:], as: GHPullReply.self).pull
        }
    }

    func rerunFailed() async {
        await perform("rerun", success: tr("Checks que falharam rodando de novo")) { client, repo, number in
            try await client.githubAction(repo: repo, number: number, action: "rerun", body: [:], as: GHRerunReply.self).pull
        }
    }

    func copy(_ text: String, notice: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        show(.success(notice))
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

extension GHCounts {
    func repoIndependent(repo: String?) -> GHCounts? {
        repo == nil ? self : nil
    }
}

struct BoardNotice: Equatable, Identifiable {
    let id = UUID()
    let text: String
    let isError: Bool

    static func success(_ text: String) -> BoardNotice { BoardNotice(text: text, isError: false) }
    static func failure(_ text: String) -> BoardNotice { BoardNotice(text: text, isError: true) }
}
