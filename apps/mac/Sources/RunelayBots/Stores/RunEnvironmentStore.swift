import Foundation
import Observation

@MainActor
@Observable
final class RunEnvironmentStore {
    static let shared = RunEnvironmentStore()

    private(set) var snapshot: RunEnvironments?
    private(set) var failure: String?

    @ObservationIgnored private var server: URL?
    @ObservationIgnored private var pending: String?
    @ObservationIgnored private var failureTask: Task<Void, Never>?

    private init() {}

    func refresh() async {
        let url = ServerConfig.currentURL()
        if url != server {
            server = url
            snapshot = nil
            pending = nil
        }
        let result = try? await BotsClient(baseURL: url).environments()
        guard url == server else { return }
        guard var next = result else {
            snapshot = nil
            return
        }
        if let pending {
            next.selected = pending
        }
        snapshot = next
    }

    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(15))
        }
    }

    func select(_ id: String) {
        guard var next = snapshot, next.selected != id,
            let target = next.environments.first(where: { $0.id == id }), target.canRun,
            let url = server
        else { return }
        let previous = next.selected
        next.selected = id
        snapshot = next
        pending = id
        Task {
            do {
                try await BotsClient(baseURL: url).selectEnvironment(id)
                if pending == id {
                    pending = nil
                }
            } catch {
                guard pending == id, url == server else { return }
                pending = nil
                snapshot?.selected = previous
                flash(tr("Não deu para trocar para %@. Tente de novo.", target.label))
            }
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
