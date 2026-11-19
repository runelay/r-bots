import AppKit
import SwiftUI

struct BrowserReplay: Equatable {
    let botID: String
    let url: String
    let title: String?
    let call: ToolCall
}

extension AppModel {
    func showBrowserAction(_ call: ToolCall, botID: String) {
        guard let bot = selectedBot, bot.id == botID, bot.hasBrowser else { return }
        let url = ActionPhrase(call: call).url?.absoluteString
        let isWorking = status(for: bot.id) == .working || call.status.isActive
        let client = client
        Task {
            let info = try? await client.browserInfo(botID: bot.id)
            let alive = info?.alive ?? true
            if alive || isWorking {
                browserReplay = nil
                switchComputerSurface("browser")
                openComputer()
                if !isWorking, let url, !Self.samePage(info?.url ?? liveSession?.url, url) {
                    openPage(url)
                }
            } else if let url {
                browserReplay = BrowserReplay(botID: bot.id, url: url, title: call.output?["title"]?.stringValue, call: call)
                switchComputerSurface("browser")
                openComputer()
            } else {
                switchComputerSurface("browser")
                openComputer()
            }
        }
    }

    func reopenBrowserReplay() {
        guard let replay = browserReplay else { return }
        browserReplay = nil
        openPage(replay.url)
    }

    private static func samePage(_ current: String?, _ target: String) -> Bool {
        guard let current, !current.isEmpty else { return false }
        let normalize: (String) -> String = { value in
            var text = value.lowercased()
            while text.hasSuffix("/") { text.removeLast() }
            return text
        }
        return normalize(current) == normalize(target)
    }
}

struct BrowserReplayView: View {
    @Environment(AppModel.self) private var model
    let replay: BrowserReplay

    @State private var image: NSImage?

    var body: some View {
        ZStack {
            Theme.railBackground
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
            VStack {
                HStack(spacing: Spacing.m) {
                    ActionIcon(phrase: ActionPhrase(call: replay.call), size: 16)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Esta sessão do navegador já terminou")
                            .font(TypeScale.rowTitle)
                            .foregroundStyle(Theme.textPrimary)
                        Text("Você está vendo como \(replay.title ?? SiteName.bareHost(URL(string: replay.url)?.host() ?? replay.url)) ficou na hora da ação.")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                    Button("Abrir de novo") {
                        model.reopenBrowserReplay()
                    }
                    .buttonStyle(SmallPillButtonStyle(kind: .primary))
                }
                .padding(.leading, Spacing.m)
                .padding(.trailing, Spacing.s)
                .padding(.vertical, Spacing.s)
                .glassSurface(Capsule(), fallback: Theme.surfaceRaised)
                .padding(.top, Spacing.l)
                Spacer(minLength: 0)
            }
        }
        .springAnimation(value: image != nil)
        .task(id: replay.call.id) {
            image = await ActionShots.load(call: replay.call, model: model)
        }
    }
}
