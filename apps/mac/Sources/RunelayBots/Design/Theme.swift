import AppKit
import SwiftUI

typealias RGB = (red: Double, green: Double, blue: Double)

enum Theme {
    static let windowFrame = Color.brand(light: 0xF0F0F1, dark: 0x050606)
    static let railBackground = Color.brand(light: 0xF0F0F1, dark: 0x050606)
    static let railSelected = Color.brand(light: 0xE2E3E4, dark: 0x1E1F21)
    static let panelBackground = Color.brand(light: 0xF6F7F7, dark: 0x0E0E0F)
    static let sidebarBackground = Color.brand(light: 0xF5F5F6, dark: 0x0C0C0D)
    static let background = Color.brand(light: 0xFDFDFD, dark: 0x131415)
    static let inspectorBackground = Color.brand(light: 0xF6F7F7, dark: 0x0E0E0F)
    static let panelEdge = Color.dynamic(light: rgb(0x0F0F11), dark: rgb(0xFFFFFF), lightAlpha: 0.08, darkAlpha: 0.06)
    static let paneDivider = Color.dynamic(light: rgb(0x0F0F11), dark: rgb(0xFFFFFF), lightAlpha: 0.07, darkAlpha: 0.05)
    static let surface = Color.brand(light: 0xF0F0F1, dark: 0x1E1F21)
    static let surfaceRaised = Color.brand(light: 0xEAEBEC, dark: 0x232425)
    static let hover = Color.dynamic(light: rgb(0x0F0F11), dark: rgb(0xFFFFFF), lightAlpha: 0.045, darkAlpha: 0.05)
    static let selection = Color.dynamic(light: rgb(0x0F0F11), dark: rgb(0xFFFFFF), lightAlpha: 0.06, darkAlpha: 0.07)

    static let textPrimary = Color.brand(light: 0x0F0F11, dark: 0xF5F5F6)
    static let textSecondary = Color.brand(light: 0x67696C, dark: 0x8F9297)
    static let textTertiary = Color.brand(light: 0x8A8C90, dark: 0x67696B)
    static let onAccent = Color.brand(light: 0xFFFFFF, dark: 0x0C0C0D)

    static let brandAccent = Color.brand(light: 0xBB3F00, dark: 0xFD923E)
    static let userBubble = Color.brand(light: 0xBB3F00, dark: 0xFD923E)
    static let brandText = Color.brand(light: 0xBB3F00, dark: 0xFD923E)
    static let brandAccentRing = NSColor(srgbRed: 0xE6 / 255.0, green: 0x59 / 255.0, blue: 0x09 / 255.0, alpha: 1)
    static let attention = Color.brand(light: 0xD58D25, dark: 0xEEB154)

    static let appIcon = Color.brand(light: 0x070708, dark: 0x070708)
    static let silverFrom = Color.brand(light: 0xFCFCFC, dark: 0xFFFFFF)
    static let silverTo = Color.brand(light: 0x9FA5AE, dark: 0x989FAA)
    static let slashFrom = Color.brand(light: 0xFD923E, dark: 0xFD923E)
    static let slashTo = Color.brand(light: 0xE65909, dark: 0xE65909)

    static let stripe1 = Color.brand(light: 0x4B4D50, dark: 0xC2C4C7)
    static let stripe2 = Color.brand(light: 0xBB3F00, dark: 0xFD923E)
    static let stripe3 = Color.brand(light: 0xE3B47D, dark: 0xA4754E)
    static let stripe4 = Color.brand(light: 0xA9ABAD, dark: 0x67696B)

    static let stripeOnDark1 = Color.brand(light: 0xA85A28, dark: 0xA85A28)
    static let stripeOnDark2 = Color.brand(light: 0xE65909, dark: 0xE65909)
    static let stripeOnDark3 = Color.brand(light: 0xFD923E, dark: 0xFD923E)
    static let stripeOnDark4 = Color.brand(light: 0xE3B47D, dark: 0xE3B47D)
    static let bannerStart = Color.brand(light: 0xE2E3E4, dark: 0x131415)
    static let bannerMiddle = Color.brand(light: 0xEAEBEC, dark: 0x17181A)
    static let bannerEnd = Color.brand(light: 0xF0F0F1, dark: 0x1E1F21)
    static let scrim = Color.dynamic(light: rgb(0x000000), dark: rgb(0x000000), lightAlpha: 0.25, darkAlpha: 0.5)

    static let maskVisible = Color.dynamic(light: rgb(0xFFFFFF), dark: rgb(0xFFFFFF))
    static let maskHidden = Color.dynamic(light: rgb(0xFFFFFF), dark: rgb(0xFFFFFF), lightAlpha: 0, darkAlpha: 0)

    static let success = Color.brand(light: 0x349D62, dark: 0x5EC386)
    static let warning = Color.brand(light: 0xD58D25, dark: 0xEEB154)
    static let danger = Color.brand(light: 0xD33A3C, dark: 0xEF6661)
    static let merged = Color.brand(light: 0x8250DF, dark: 0xA371F7)
    static let updateBadge = Color.dynamic(light: rgb(0x1E3A6E), dark: rgb(0x2984F6), lightAlpha: 0.88, darkAlpha: 0.28)
    static let onUpdateBadge = Color.brand(light: 0xFFFFFF, dark: 0xFFFFFF)
    static let spotify = Color.brand(light: 0x1DB954, dark: 0x1ED760)
    static let spotifyMark = Color.brand(light: 0x000000, dark: 0x000000)

    static let elevationShadow = Color.dynamic(light: rgb(0x000000), dark: rgb(0x000000), lightAlpha: 0.06, darkAlpha: 0.10)
    static let elevationShadowLifted = Color.dynamic(light: rgb(0x000000), dark: rgb(0x000000), lightAlpha: 0.08, darkAlpha: 0.12)

    static func accent(_ name: String) -> Color {
        let palette = palette(for: name)
        return Color.dynamic(light: palette.light, dark: palette.dark)
    }

    static func accentBubble(_ name: String) -> Color {
        surfaceRaised
    }

    static func status(_ status: BotStatus) -> Color {
        switch status {
        case .idle: textTertiary
        case .working: brandText
        case .awaitingApproval: attention
        case .error: danger
        }
    }

    static func toolStatus(_ status: ToolCallStatus) -> Color {
        switch status {
        case .requested, .running, .interrupted, .other: textTertiary
        case .completed: success
        case .failed: danger
        case .rejected: textSecondary
        }
    }

    static func connection(_ status: ConnectionStatus) -> Color {
        switch status {
        case .unknown, .checking: textTertiary
        case .online: success
        case .offline: danger
        }
    }

    static func rgb(_ hex: Int) -> RGB {
        (
            Double((hex >> 16) & 0xFF) / 255,
            Double((hex >> 8) & 0xFF) / 255,
            Double(hex & 0xFF) / 255
        )
    }

    static let swatchAccents = ["white", "grey", "red", "orange", "amber", "yellow", "green", "teal", "blue", "indigo", "violet", "pink"]

    static func accentName(_ name: String) -> String {
        switch name.lowercased() {
        case "electric", "blue": "Azul"
        case "green": "Verde"
        case "teal", "cyan": "Ciano"
        case "violet", "purple": "Violeta"
        case "pink": "Rosa"
        case "indigo": "Índigo"
        case "sky", "light": "Azul claro"
        case "royal": "Azul royal"
        case "white": "Branco"
        case "grey", "gray": "Cinza"
        case "red": "Vermelho"
        case "orange": "Laranja"
        case "amber": "Âmbar"
        case "yellow": "Amarelo"
        default: name
        }
    }

    private static func palette(for name: String) -> (light: RGB, dark: RGB) {
        switch name.lowercased() {
        case "electric", "blue": return (rgb(0x1F6FE0), rgb(0x2984F6))
        case "teal", "cyan": return (rgb(0x0B8FA8), rgb(0x22C3DC))
        case "green": return (rgb(0x2E9E5B), rgb(0x34D27A))
        case "white": return (rgb(0x3A3A3A), rgb(0xF2F2F2))
        case "grey", "gray": return (rgb(0x7A7A7A), rgb(0x9A9A9A))
        case "red": return (rgb(0xD93636), rgb(0xFF5C5C))
        case "orange": return (rgb(0xE0661A), rgb(0xFF8A3D))
        case "amber": return (rgb(0xC98A00), rgb(0xFFB52E))
        case "yellow": return (rgb(0xB89A00), rgb(0xFFD60A))
        case "violet", "purple": return (rgb(0x7A4FE0), rgb(0xA27CFF))
        case "pink": return (rgb(0xD63A86), rgb(0xFF5FA8))
        case "indigo": return (rgb(0x3B3FC4), rgb(0x6A6EF2))
        case "sky", "light": return (rgb(0x3D86D6), rgb(0x9CC8FF))
        case "royal": return (rgb(0x1652C8), rgb(0x4F86F0))
        default:
            if let hex = hexRGB(name) {
                return (hex, hex)
            }
            return (rgb(0x1F6FE0), rgb(0x2984F6))
        }
    }

    private static func hexRGB(_ text: String) -> RGB? {
        var hex = text.trimmingCharacters(in: .whitespaces)
        if hex.hasPrefix("#") {
            hex.removeFirst()
        }
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        return rgb(value)
    }
}

extension Color {
    static func brand(light: Int, dark: Int) -> Color {
        dynamic(light: Theme.rgb(light), dark: Theme.rgb(dark))
    }

    static func dynamic(light: RGB, dark: RGB, lightAlpha: Double = 1, darkAlpha: Double = 1) -> Color {
        let lightRed = light.red
        let lightGreen = light.green
        let lightBlue = light.blue
        let darkRed = dark.red
        let darkGreen = dark.green
        let darkBlue = dark.blue
        let color = NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            if isDark {
                return NSColor(srgbRed: darkRed, green: darkGreen, blue: darkBlue, alpha: darkAlpha)
            }
            return NSColor(srgbRed: lightRed, green: lightGreen, blue: lightBlue, alpha: lightAlpha)
        }
        return Color(nsColor: color)
    }
}
