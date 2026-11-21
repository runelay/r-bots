import AppKit
import SwiftUI

@MainActor
@Observable
final class FaviconStore {
    static let shared = FaviconStore()

    private(set) var version = 0
    @ObservationIgnored private var cache: [String: NSImage] = [:]
    @ObservationIgnored private var missing: Set<String> = []
    @ObservationIgnored private var inFlight: Set<String> = []

    func icon(host rawHost: String) -> NSImage? {
        let host = SiteName.bareHost(rawHost.lowercased())
        _ = version
        if let cached = cache[host] {
            return cached
        }
        guard !missing.contains(host), !inFlight.contains(host) else { return nil }
        inFlight.insert(host)
        Task {
            defer { inFlight.remove(host) }
            var components = URLComponents(string: "https://www.google.com/s2/favicons")
            components?.queryItems = [URLQueryItem(name: "domain", value: host), URLQueryItem(name: "sz", value: "64")]
            guard let url = components?.url,
                  let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = NSImage(data: data)
            else {
                missing.insert(host)
                return
            }
            cache[host] = image
            version += 1
        }
        return nil
    }
}

enum AppIcons {
    @MainActor private static var cache: [String: NSImage] = [:]

    @MainActor
    static func icon(bundleID: String?, name: String?) -> NSImage? {
        let key = bundleID ?? name ?? ""
        guard !key.isEmpty else { return nil }
        if let cached = cache[key] {
            return cached
        }
        var url: URL?
        if let bundleID {
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
        }
        if url == nil, let name, !name.isEmpty {
            let candidates = ["/Applications/\(name).app", "/System/Applications/\(name).app", "/System/Applications/Utilities/\(name).app", "/System/Library/CoreServices/\(name).app"]
            url = candidates.map { URL(fileURLWithPath: $0) }.first { FileManager.default.fileExists(atPath: $0.path) }
        }
        guard let url else { return nil }
        let image = NSWorkspace.shared.icon(forFile: url.path)
        cache[key] = image
        return image
    }
}

struct ActionIcon: View {
    let phrase: ActionPhrase
    var connector: String? = nil
    var size: CGFloat = 16

    var body: some View {
        Group {
            if let connector {
                ConnectorLogo(name: connector, size: size - 2)
            } else if let host = phrase.host, let image = FaviconStore.shared.icon(host: host) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
            } else if let image = AppIcons.icon(bundleID: phrase.bundleID, name: phrase.app) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: phrase.host != nil ? "globe" : phrase.symbol)
                    .font(.system(size: size * 0.7, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct ActionThumbnail: View {
    let image: NSImage
    var width: CGFloat = 64
    var height: CGFloat = 44

    var body: some View {
        Image(nsImage: image)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fill)
            .frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct ShotThumbnail: View {
    @Environment(AppModel.self) private var model
    let call: ToolCall
    var width: CGFloat = 56
    var height: CGFloat = 36

    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                ActionThumbnail(image: image, width: width, height: height)
                    .transition(.opacity)
            } else {
                Color.clear.frame(width: 0, height: height)
            }
        }
        .springAnimation(value: image != nil)
        .task(id: call.id + (call.screenshotPath ?? "") + (call.output?["screenshot"]?.stringValue ?? "")) {
            image = await ActionShots.load(call: call, model: model)
        }
    }
}

enum ActionShots {
    static func hasShot(_ call: ToolCall) -> Bool {
        call.screenshotPath != nil || call.output?["screenshot"]?.stringValue != nil
    }

    @MainActor
    static func load(call: ToolCall, model: AppModel) async -> NSImage? {
        if let path = call.screenshotPath {
            let expanded = (path as NSString).expandingTildeInPath
            let data = await Task.detached { try? Data(contentsOf: URL(fileURLWithPath: expanded)) }.value
            return data.flatMap(NSImage.init(data:))
        }
        guard let remote = call.output?["screenshot"]?.stringValue else { return nil }
        let file = (remote as NSString).lastPathComponent
        guard file.hasSuffix(".png"), let botID = call.viaAgent ?? model.selectedBot?.id else { return nil }
        let data = try? await model.client.screenshot(botID: botID, path: "/bots/\(botID)/browser/screenshots/\(file)")
        return data.flatMap(NSImage.init(data:))
    }
}

struct SmallPillButtonStyle: ButtonStyle {
    enum Kind {
        case primary
        case neutral
    }

    let kind: Kind
    @Environment(\.appReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(TypeScale.captionStrong)
            .foregroundStyle(kind == .primary ? Theme.onAccent : Theme.textPrimary)
            .padding(.horizontal, Spacing.m)
            .frame(height: 28)
            .background(kind == .primary ? Theme.brandAccent : Theme.selection, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .contentShape(Capsule())
            .clickable()
            .animation(Motion.animation(reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}
