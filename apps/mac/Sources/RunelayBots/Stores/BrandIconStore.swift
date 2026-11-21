import AppKit
import Foundation
import Observation

struct BrandIcon {
    let image: NSImage
    let isMonochromeDark: Bool
}

@MainActor
@Observable
final class BrandIconStore {
    static let shared = BrandIconStore()

    private(set) var version = 0
    @ObservationIgnored private var cache: [String: BrandIcon] = [:]
    @ObservationIgnored private var missing: Set<String> = []
    @ObservationIgnored private var inFlight: Set<String> = []

    private static var cacheDirectory: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        return base.appendingPathComponent("runelay bots/icons", isDirectory: true)
    }

    func icon(slug rawSlug: String) -> BrandIcon? {
        let slug = rawSlug.lowercased()
        _ = version
        if let cached = cache[slug] {
            return cached
        }
        if missing.contains(slug) {
            return nil
        }
        if let url = ResourceBundle.bundle?.url(forResource: slug, withExtension: "svg", subdirectory: "Logos/si"),
            let icon = Self.load(url)
        {
            cache[slug] = icon
            return icon
        }
        if let directory = Self.cacheDirectory {
            let file = directory.appendingPathComponent("\(slug).svg")
            if let icon = Self.load(file) {
                cache[slug] = icon
                return icon
            }
        }
        fetch(slug)
        return nil
    }

    private func fetch(_ slug: String) {
        guard !inFlight.contains(slug), let url = URL(string: "https://cdn.simpleicons.org/\(slug)") else { return }
        inFlight.insert(slug)
        Task {
            defer { inFlight.remove(slug) }
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                (response as? HTTPURLResponse)?.statusCode == 200,
                let directory = Self.cacheDirectory
            else {
                missing.insert(slug)
                return
            }
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("\(slug).svg")
            try? data.write(to: file)
            if let icon = Self.load(file) {
                cache[slug] = icon
                version += 1
            } else {
                missing.insert(slug)
            }
        }
    }

    private static func load(_ url: URL) -> BrandIcon? {
        guard let data = try? Data(contentsOf: url), let image = NSImage(data: data) else { return nil }
        let text = String(data: data, encoding: .utf8) ?? ""
        let dark = isDarkFill(text)
        if dark {
            image.isTemplate = true
        }
        return BrandIcon(image: image, isMonochromeDark: dark)
    }

    private static func isDarkFill(_ svg: String) -> Bool {
        guard let range = svg.range(of: "fill=\"#") else { return false }
        let hex = svg[range.upperBound...].prefix(6)
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return false }
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.25
    }
}
