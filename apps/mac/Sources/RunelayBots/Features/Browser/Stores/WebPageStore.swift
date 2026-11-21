import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class WebPageStore {
    static let shared = WebPageStore()
    static let panelKind = "web"

    private(set) var url: URL?
    private(set) var reloadRequest = 0

    private init() {}

    static func isWebURL(_ url: URL) -> Bool {
        ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    }

    static func host(of url: URL?) -> String {
        guard let url else { return "" }
        return url.host() ?? url.absoluteString
    }

    func openLink(_ url: URL, botID: String? = nil) {
        guard Self.isWebURL(url), !NSEvent.modifierFlags.contains(.command) else {
            NSWorkspace.shared.open(url)
            return
        }
        openHere(url, botID: botID)
    }

    func openHere(_ url: URL, botID: String? = nil) {
        guard Self.isWebURL(url) else {
            NSWorkspace.shared.open(url)
            return
        }
        let center = ArtifactCenter.shared
        let showing = center.current?.kind == Self.panelKind
        if showing, self.url == url {
            reloadRequest += 1
        } else {
            self.url = url
        }
        guard !showing else { return }
        center.open(
            ArtifactRef(botID: botID ?? center.current?.botID ?? Self.panelKind, id: Self.panelKind, title: Self.host(of: url), kind: Self.panelKind, version: 1),
            client: BotsClient(baseURL: ServerConfig.currentURL())
        )
    }
}
