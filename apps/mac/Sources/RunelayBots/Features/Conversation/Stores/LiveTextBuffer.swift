import Foundation
import Observation

@MainActor
@Observable
final class LiveTextBuffer {
    private(set) var texts: [String: String] = [:]
    @ObservationIgnored private var pending: [String: String] = [:]
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private let interval: Duration = .milliseconds(33)

    func seed(_ id: String, text: String) {
        pending[id] = nil
        texts[id] = text
    }

    func append(_ id: String, delta: String) {
        pending[id] = (pending[id] ?? texts[id] ?? "") + delta
        guard flushTask == nil else { return }
        flushTask = Task { [weak self, interval] in
            try? await Task.sleep(for: interval)
            self?.flush()
        }
    }

    func current(_ id: String) -> String? {
        pending[id] ?? texts[id]
    }

    func finish(_ id: String) {
        pending[id] = nil
        if texts[id] != nil {
            texts[id] = nil
        }
    }

    func clear() {
        flushTask?.cancel()
        flushTask = nil
        pending.removeAll()
        if !texts.isEmpty {
            texts.removeAll()
        }
    }

    private func flush() {
        flushTask = nil
        guard !pending.isEmpty else { return }
        var next = texts
        for (id, text) in pending {
            next[id] = text
        }
        pending.removeAll()
        texts = next
    }
}
