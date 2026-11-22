import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class BrowserStore {
    enum State: Equatable {
        case idle
        case loading
        case empty
        case ready
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var botID: String?
    private(set) var info: BrowserInfo?
    private(set) var image: NSImage?
    private(set) var imageVersion = 0
    private(set) var updatedAt: Date?

    @ObservationIgnored private var lastImageData: Data?

    func reset(botID: String?) {
        self.botID = botID
        state = .idle
        info = nil
        image = nil
        updatedAt = nil
        lastImageData = nil
    }

    private(set) var isOpening = false

    func run(client: BotsClient, botID: String, polling: Bool) async {
        await run(client: client, botID: botID) { polling ? 1.5 : nil }
    }

    func run(client: BotsClient, botID: String, interval: @escaping @MainActor () -> Double?) async {
        if self.botID != botID {
            reset(botID: botID)
        }
        await refresh(client: client, botID: botID)
        while !Task.isCancelled {
            guard let seconds = interval() else { return }
            do {
                try await Task.sleep(for: .seconds(seconds))
            } catch {
                return
            }
            await refresh(client: client, botID: botID)
        }
    }

    func open(_ rawURL: String, client: BotsClient, botID: String) async throws {
        var text = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if !text.contains("://") {
            text = "https://" + text
        }
        isOpening = true
        defer { isOpening = false }
        try await client.openBrowser(botID: botID, url: text)
        await refresh(client: client, botID: botID)
    }

    func updatedLabel(now: Date) -> String {
        guard let updatedAt else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(updatedAt)))
        if seconds < 60 {
            return tr("atualizado há %lld s", seconds)
        }
        let minutes = seconds / 60
        if minutes < 60 {
            return tr("atualizado há %lld min", minutes)
        }
        return tr("atualizado há %lld h", minutes / 60)
    }

    private func refresh(client: BotsClient, botID: String) async {
        if image == nil, state != .empty {
            state = .loading
        }
        do {
            guard let latest = try await client.browserInfo(botID: botID) else {
                guard self.botID == botID else { return }
                info = nil
                image = nil
                lastImageData = nil
                state = .empty
                return
            }
            guard self.botID == botID else { return }
            if image != nil, let known = info?.updatedAt, known == latest.updatedAt {
                state = .ready
                return
            }
            info = latest
            let data = try await client.screenshot(botID: botID, path: latest.screenshotPath)
            guard self.botID == botID else { return }
            if let data, data != lastImageData, let decoded = NSImage(data: data) {
                lastImageData = data
                image = decoded
                imageVersion += 1
            }
            updatedAt = latest.updatedDate ?? updatedAt ?? Date()
            state = .ready
        } catch {
            guard !Task.isCancelled, self.botID == botID else { return }
            if image == nil {
                state = .failed(ErrorMessage.describe(error))
            }
        }
    }
}
