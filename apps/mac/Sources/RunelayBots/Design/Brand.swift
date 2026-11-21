import AppKit
import CoreText
import SwiftUI

enum ResourceBundle {
    static let bundle: Bundle? = {
        let name = "RunelayBots_RunelayBots.bundle"
        let roots = [
            Bundle.main.resourceURL,
            Bundle.main.bundleURL,
            Bundle.main.executableURL?.deletingLastPathComponent()
        ]
        for root in roots.compactMap({ $0 }) {
            if let bundle = Bundle(url: root.appendingPathComponent(name)) {
                return bundle
            }
        }
        return nil
    }()
}

enum BrandFonts {
    static let sansFamily = "Inter"
    static let monoFamily = "JetBrains Mono"
    static let wordmarkFamily = "Geist"

    static let availableFamilies: Set<String> = {
        for name in ["Inter-Variable", "JetBrainsMono-Variable"] {
            if let url = ResourceBundle.bundle?.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
        for name in ["Virgil", "Geist"] {
            if let url = ResourceBundle.bundle?.url(forResource: name, withExtension: "woff2", subdirectory: "Fonts") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
        let names = (CTFontManagerCopyAvailableFontFamilyNames() as NSArray) as? [String] ?? []
        return Set(names)
    }()

    static func prepare() {
        _ = availableFamilies
    }

    static func sans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard availableFamilies.contains(sansFamily) else {
            return .system(size: size, weight: weight)
        }
        return Font.custom(sansFamily, size: size).weight(weight)
    }

    static func wordmark(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        guard availableFamilies.contains(wordmarkFamily) else {
            return sans(size, weight: weight)
        }
        return Font.custom(wordmarkFamily, size: size).weight(weight)
    }

    static let handFamily = "Virgil 3 YOFF"
    static let handFallback = "Chalkboard SE"

    static func hand(_ size: CGFloat) -> Font {
        if availableFamilies.contains(handFamily) {
            return Font.custom(handFamily, size: size)
        }
        return Font.custom(handFallback, size: size)
    }

    static func handNSFont(_ size: CGFloat) -> NSFont {
        _ = availableFamilies
        return NSFont(name: "Virgil3YOFF", size: size) ?? NSFont(name: "ChalkboardSE-Regular", size: size) ?? NSFont.systemFont(ofSize: size)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard availableFamilies.contains(monoFamily) else {
            return .system(size: size, weight: weight, design: .monospaced)
        }
        return Font.custom(monoFamily, size: size).weight(weight)
    }
}

@MainActor
enum BrandAssets {
    static let claude: NSImage? = load("provider-claude")
    static let openAI: NSImage? = templateLoad("provider-openai")
    static let cursor: NSImage? = templateLoad("provider-cursor")
    static let grokOnDark: NSImage? = load("provider-grok-dark")
    static let grokOnLight: NSImage? = load("provider-grok-light")
    static let runelay: NSImage? = load("runelay")

    static let github: NSImage? = simpleIcon("github")
    static let linear: NSImage? = simpleIcon("linear")
    static let googleCalendar: NSImage? = simpleIcon("googlecalendar")

    private static func simpleIcon(_ slug: String) -> NSImage? {
        guard let url = ResourceBundle.bundle?.url(forResource: slug, withExtension: "svg", subdirectory: "Logos/si"),
              let image = NSImage(contentsOf: url)
        else { return nil }
        image.isTemplate = true
        return image
    }

    static func connector(_ key: String) -> NSImage? {
        for ext in ["svg", "png"] {
            if let url = ResourceBundle.bundle?.url(forResource: key, withExtension: ext, subdirectory: "Logos/connectors"),
               let image = NSImage(contentsOf: url) {
                return image
            }
        }
        return nil
    }

    private static func templateLoad(_ name: String) -> NSImage? {
        let image = load(name)
        image?.isTemplate = true
        return image
    }

    private static func load(_ name: String) -> NSImage? {
        guard let url = ResourceBundle.bundle?.url(forResource: name, withExtension: "svg", subdirectory: "Logos") else {
            return nil
        }
        return NSImage(contentsOf: url)
    }
}

enum BrandMark {
    case github
    case linear
    case googleCalendar

    @MainActor var image: NSImage? {
        switch self {
        case .github: BrandAssets.github
        case .linear: BrandAssets.linear
        case .googleCalendar: BrandAssets.googleCalendar
        }
    }

    var fallbackSymbol: String {
        switch self {
        case .github: "arrow.triangle.pull"
        case .linear: "circle.dashed"
        case .googleCalendar: "calendar"
        }
    }

    static let linearColor = Color.dynamic(light: Theme.rgb(0x5E6AD2), dark: Theme.rgb(0x8A93F0))
}

struct BrandMarkImage: View {
    let mark: BrandMark
    var size: CGFloat = 16

    var body: some View {
        if let image = mark.image {
            Image(nsImage: image)
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            Image(systemName: mark.fallbackSymbol)
                .font(.system(size: size * 0.9, weight: .medium))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

struct RunelaySymbol: Shape {
    var split: CGFloat = 0

    var animatableData: CGFloat {
        get { split }
        set { split = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / 572, rect.height / 592)
        let originX = rect.midX - 572 * scale / 2 - 226 * scale
        let originY = rect.midY - 592 * scale / 2 - 216 * scale
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: originX + x * scale, y: originY + y * scale)
        }
        var path = Path()
        path.addPath(half(centerX: 492, centerY: 541 + split, direction: -1, point: point))
        path.addPath(half(centerX: 532, centerY: 482 - split, direction: 1, point: point))
        return path
    }

    private func half(centerX: CGFloat, centerY: CGFloat, direction: CGFloat, point: (CGFloat, CGFloat) -> CGPoint) -> Path {
        let radius: CGFloat = 256
        let handle = radius * 0.5523
        var path = Path()
        path.move(to: point(centerX, centerY - radius))
        path.addCurve(
            to: point(centerX + direction * radius, centerY),
            control1: point(centerX + direction * handle, centerY - radius),
            control2: point(centerX + direction * radius, centerY - handle)
        )
        path.addCurve(
            to: point(centerX, centerY + radius),
            control1: point(centerX + direction * radius, centerY + handle),
            control2: point(centerX + direction * handle, centerY + radius)
        )
        path.closeSubpath()
        return path
    }
}

struct RunelayAppMark: View {
    var size: CGFloat = 32
    var split = false

    var body: some View {
        RunelaySymbol(split: split ? 28 : 0)
            .fill(LinearGradient(colors: [Theme.silverFrom, Theme.silverTo], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size * 0.56, height: size * 0.56)
            .frame(width: size, height: size)
            .background(Theme.appIcon, in: RoundedRectangle(cornerRadius: size * 0.31, style: .continuous))
            .accessibilityLabel("r/bots")
    }
}

struct RunelayWordmark: View {
    var text = "runelay"
    var height: CGFloat = 18

    var body: some View {
        Text(text)
            .font(BrandFonts.wordmark(height))
            .tracking(-0.035 * height)
            .foregroundStyle(Theme.textPrimary)
            .accessibilityLabel(text)
    }
}


struct ProviderLogo: View {
    let provider: String
    var size: CGFloat = 16

    var body: some View {
        switch provider {
        case "claude":
            logo(BrandAssets.claude, template: false)
        case "codex", "openai", "chatgpt":
            logo(BrandAssets.openAI, template: true)
        case "cursor":
            logo(BrandAssets.cursor, template: true)
        case "grok", "xai":
            GrokLogo(size: size)
        default:
            Image(systemName: "bolt")
                .font(.system(size: size * 0.7, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: size, height: size)
        }
    }

    @ViewBuilder
    private func logo(_ image: NSImage?, template: Bool) -> some View {
        if let image {
            Image(nsImage: image)
                .renderingMode(template ? .template : .original)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(Theme.textPrimary)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "cpu")
                .font(.system(size: size * 0.7))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: size, height: size)
        }
    }
}

struct GrokLogo: View {
    @Environment(\.colorScheme) private var colorScheme
    let size: CGFloat

    var body: some View {
        if let image = colorScheme == .dark ? BrandAssets.grokOnDark : BrandAssets.grokOnLight {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "bolt")
                .font(.system(size: size * 0.7, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: size, height: size)
        }
    }
}

struct RunelayMark: View {
    var size: CGFloat = 16

    var body: some View {
        if let image = BrandAssets.runelay {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .accessibilityLabel("runelay")
        }
    }
}

struct ConnectorLogo: View {
    let name: String
    var icon: String? = nil
    var size: CGFloat = 16

    var body: some View {
        let store = BrandIconStore.shared
        if let slug, let brand = store.icon(slug: slug) {
            Image(nsImage: brand.image)
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(Theme.textPrimary)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            Text(String(ConnectorNames.pretty(name).trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                .font(BrandFonts.mono(size * 0.72, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }

    var slug: String? {
        if let icon, !icon.isEmpty, !icon.hasPrefix("/"), !icon.hasPrefix("http") {
            return icon
        }
        let key = ConnectorNames.key(name)
        let guesses: [String: String] = [
            "google_calendar": "googlecalendar",
            "cloudflare_docs": "cloudflare",
            "meta_social_technologies": "meta"
        ]
        return guesses[key] ?? (key.contains("_") ? nil : key)
    }
}

struct ConnectorTile: View {
    let name: String
    var icon: String? = nil
    var size: CGFloat = 36

    var body: some View {
        if let fullBleed {
            Image(nsImage: fullBleed)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fill)
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
                .accessibilityHidden(true)
        } else {
            ConnectorLogo(name: name, icon: icon, size: size * 0.5)
                .frame(width: size, height: size)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        }
    }

    private var fullBleed: NSImage? {
        guard let icon, icon.hasPrefix("/") else { return nil }
        return BrandAssets.connector(ConnectorNames.key(icon)) ?? ConnectorLogoStore.shared.image(for: icon)
    }
}
