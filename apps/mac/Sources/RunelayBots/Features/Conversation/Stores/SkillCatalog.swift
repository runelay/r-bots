import Foundation

@MainActor
@Observable
final class SkillCatalog {
    static let shared = SkillCatalog()

    private(set) var results: [SkillSummary] = []
    private(set) var query: String?
    private(set) var isLoading = false
    private(set) var failed = false
    private(set) var unavailable = false
    private var cache: [String: (at: Date, items: [SkillSummary])] = [:]
    private var task: Task<Void, Never>?
    private var prefetchTask: Task<Void, Never>?

    func prefetch(client: BotsClient) {
        guard prefetchTask == nil, cache[""] == nil else { return }
        prefetchTask = Task { [weak self] in
            let items = try? await client.skills(query: "")
            guard let self else { return }
            self.prefetchTask = nil
            guard let items else { return }
            self.cache[""] = (Date(), items)
            if self.query == "" && (self.isLoading || self.failed) {
                self.task?.cancel()
                self.results = items
                self.isLoading = false
                self.failed = false
            }
        }
    }

    func search(_ text: String, client: BotsClient) {
        let term = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard term != query else { return }
        load(term, client: client)
    }

    func retry(client: BotsClient) {
        guard let query else { return }
        cache[query] = nil
        load(query, client: client)
    }

    func forgetServer() {
        close()
        prefetchTask?.cancel()
        prefetchTask = nil
        cache = [:]
        results = []
        unavailable = false
    }

    func close() {
        task?.cancel()
        query = nil
        isLoading = false
        failed = false
    }

    private func load(_ term: String, client: BotsClient) {
        query = term
        task?.cancel()
        failed = false
        if let hit = cache[term], Date().timeIntervalSince(hit.at) < 60 {
            results = hit.items
            isLoading = false
            return
        }
        isLoading = true
        task = Task { [weak self] in
            if !term.isEmpty {
                try? await Task.sleep(for: .milliseconds(140))
            }
            guard !Task.isCancelled else { return }
            let outcome: Result<[SkillSummary], Error>
            do {
                outcome = .success(try await client.skills(query: term))
            } catch {
                outcome = .failure(error)
            }
            guard !Task.isCancelled, let self, self.query == term else { return }
            switch outcome {
            case .success(let items):
                self.cache[term] = (Date(), items)
                self.results = items
                self.unavailable = false
            case .failure(let error) where BotsClient.isNotConfigured(error):
                self.cache[term] = (Date(), [])
                self.results = []
                self.unavailable = true
            case .failure:
                self.results = []
                self.failed = true
            }
            self.isLoading = false
        }
    }
}
