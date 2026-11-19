import AppKit
import CoreGraphics
import Foundation
import ImageIO
import Observation

struct FrameImage: @unchecked Sendable {
    let image: CGImage
    let pageWidth: Double
    let pageHeight: Double
}

enum LiveEvent: Sendable {
    case opened
    case frame(FrameImage)
    case state(JSONValue)
}

enum LiveOutcome: Sendable {
    case closed(receivedAny: Bool)
    case unsupported
}

@MainActor
@Observable
final class BrowserLiveSession {
    enum Phase: Equatable {
        case idle
        case connecting
        case live
        case unsupported
    }

    let botID: String
    let surface: String
    private(set) var phase: Phase = .idle
    private(set) var url = ""
    private(set) var title = ""
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var loading = false
    private(set) var controller = "bot"
    private(set) var hasFrame = false
    private(set) var isStale = false

    @ObservationIgnored weak var renderer: BrowserFrameView?
    @ObservationIgnored private(set) var lastFrame: FrameImage?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var loopTask: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var lastFrameAt = Date.distantPast

    init(botID: String, surface: String = "browser") {
        self.botID = botID
        self.surface = surface
    }

    var isUserControlled: Bool { controller == "user" }

    func start(client: BotsClient) {
        guard loopTask == nil else { return }
        guard let url = client.liveURL(botID: botID, surface: surface) else {
            phase = .unsupported
            return
        }
        loopTask = Task { [weak self] in
            var failures = 0
            while !Task.isCancelled {
                guard let self else { return }
                if self.phase != .unsupported {
                    self.phase = .connecting
                }
                var request = URLRequest(url: url)
                AuthStore.authorize(&request)
                let socket = URLSession.shared.webSocketTask(with: request)
                self.socket = socket
                socket.resume()
                let outcome = await Self.receive(on: socket) { [weak self] event in
                    await self?.handle(event)
                }
                if Task.isCancelled { return }
                let delay: Double
                switch outcome {
                case .unsupported:
                    self.phase = .unsupported
                    delay = 30
                case .closed(let receivedAny):
                    failures = receivedAny ? 1 : failures + 1
                    delay = min(0.5 * Double(1 << min(failures, 4)), 8)
                }
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return
                }
            }
        }
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self else { return }
                let stale = self.phase != .live && Date().timeIntervalSince(self.lastFrameAt) > 1
                if stale != self.isStale {
                    self.isStale = stale
                }
            }
        }
    }

    func stop() {
        loopTask?.cancel()
        watchTask?.cancel()
        loopTask = nil
        watchTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    func send(_ message: JSONValue) {
        guard phase == .live, let socket,
              let data = try? JSONEncoder().encode(message),
              let text = String(data: data, encoding: .utf8)
        else { return }
        Task {
            try? await socket.send(.string(text))
        }
    }

    func navigate(_ rawURL: String) {
        var text = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if !text.contains("://") {
            text = "https://" + text
        }
        loading = true
        send(.object(["type": .string("navigate"), "url": .string(text)]))
    }

    func command(_ type: String) {
        send(.object(["type": .string(type)]))
    }

    func setControl(user: Bool, client: BotsClient, failed: @escaping @MainActor (String) -> Void) {
        let previous = controller
        controller = user ? "user" : "bot"
        let botID = botID
        let surface = surface
        Task {
            do {
                try await client.browserControl(botID: botID, mode: user ? "user" : "bot", surface: surface)
            } catch {
                controller = previous
                failed(ErrorMessage.describe(error))
            }
        }
    }

    private func handle(_ event: LiveEvent) {
        switch event {
        case .opened:
            phase = .live
        case .frame(let frame):
            lastFrame = frame
            lastFrameAt = Date()
            renderer?.show(frame)
            if phase != .live {
                phase = .live
            }
            if !hasFrame {
                hasFrame = true
            }
            if isStale {
                isStale = false
            }
        case .state(let value):
            phase = .live
            if let newURL = value["url"]?.stringValue, newURL != url { url = newURL }
            if let newTitle = value["title"]?.stringValue, newTitle != title { title = newTitle }
            if let back = value["canGoBack"]?.boolValue, back != canGoBack { canGoBack = back }
            if let forward = value["canGoForward"]?.boolValue, forward != canGoForward { canGoForward = forward }
            if let isLoading = value["loading"]?.boolValue, isLoading != loading { loading = isLoading }
            if let owner = value["controller"]?.stringValue, owner != controller { controller = owner }
        }
    }

    nonisolated private static func receive(
        on socket: URLSessionWebSocketTask,
        deliver: @escaping @Sendable (LiveEvent) async -> Void
    ) async -> LiveOutcome {
        var receivedAny = false
        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await socket.receive()
            } catch {
                if !receivedAny, let status = (socket.response as? HTTPURLResponse)?.statusCode,
                   status == 404 || status == 400 || status == 426 || status == 405 {
                    return .unsupported
                }
                if !receivedAny, (error as? URLError)?.code == .badServerResponse {
                    return .unsupported
                }
                return .closed(receivedAny: receivedAny)
            }
            if !receivedAny {
                receivedAny = true
                await deliver(.opened)
            }
            let text: String?
            switch message {
            case .string(let value): text = value
            case .data(let data): text = String(data: data, encoding: .utf8)
            @unknown default: text = nil
            }
            guard let text, let value = JSONValue.parse(text) else { continue }
            switch value["type"]?.stringValue {
            case "frame":
                guard let encoded = value["data"]?.stringValue,
                      let data = Data(base64Encoded: encoded),
                      let image = decode(data)
                else { continue }
                let width = value["width"]?.doubleValue ?? Double(image.width)
                let height = value["height"]?.doubleValue ?? Double(image.height)
                await deliver(.frame(FrameImage(image: image, pageWidth: width, pageHeight: height)))
            case "state":
                await deliver(.state(value))
            default:
                continue
            }
        }
        return .closed(receivedAny: receivedAny)
    }

    nonisolated private static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        let width = image.width
        let height = image.height
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return image }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage() ?? image
    }
}
