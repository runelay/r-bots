import AppKit
import SwiftUI

enum LinearPalette {
    static func color(hex raw: String?) -> Color? {
        guard var hex = raw?.trimmingCharacters(in: .whitespaces), !hex.isEmpty else { return nil }
        if hex.hasPrefix("#") { hex.removeFirst() }
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        let rgb = Theme.rgb(value)
        let lifted = Theme.rgb(liftedHex(value))
        return Color.dynamic(light: rgb, dark: lifted)
    }

    private static func liftedHex(_ value: Int) -> Int {
        let red = (value >> 16) & 0xFF
        let green = (value >> 8) & 0xFF
        let blue = value & 0xFF
        let luminance = 0.2126 * Double(red) + 0.7152 * Double(green) + 0.0722 * Double(blue)
        guard luminance < 90 else { return value }
        func lift(_ channel: Int) -> Int { min(255, channel + (255 - channel) * 35 / 100) }
        return (lift(red) << 16) | (lift(green) << 8) | lift(blue)
    }

    static let urgent = Color.brand(light: 0xE5622B, dark: 0xFC7840)
    static let completed = Color.brand(light: 0x5E6AD2, dark: 0x8A93F0)
    static let canceled = Color.brand(light: 0x8A95A5, dark: 0x95A2B3)
    static let backlog = Color.brand(light: 0x9CA1AA, dark: 0xBEC2C8)
    static let unstarted = Color.brand(light: 0x8B9099, dark: 0xD6D7DA)
    static let triage = Color.brand(light: 0xE5622B, dark: 0xFC7840)

    static func state(type: String, name: String) -> Color {
        switch type {
        case "triage": return triage
        case "backlog": return backlog
        case "unstarted": return unstarted
        case "completed": return completed
        case "canceled", "duplicate": return canceled
        case "started": return started(name)
        default: return backlog
        }
    }

    static func started(_ name: String) -> Color {
        let lowered = name.lowercased()
        if lowered.contains("corre") || lowered.contains("fix") { return Color.brand(light: 0xD64545, dark: 0xEB5757) }
        if lowered.contains("review") || lowered.contains("revis") { return Color.brand(light: 0x2F9A65, dark: 0x4CB782) }
        if lowered.contains("test") || lowered.contains("qa") { return Color.brand(light: 0x1797AD, dark: 0x26B5CE) }
        if lowered.contains("deploy") || lowered.contains("release") { return Color.brand(light: 0x2D86E0, dark: 0x4EA7FC) }
        if lowered.contains("aguard") || lowered.contains("wait") || lowered.contains("bloq") || lowered.contains("block") {
            return Color.brand(light: 0xD9822B, dark: 0xF2994A)
        }
        return Color.brand(light: 0xC9A227, dark: 0xF2C94C)
    }

    static func startedFill(_ name: String) -> Double {
        let lowered = name.lowercased()
        if lowered.contains("deploy") || lowered.contains("release") { return 0.85 }
        if lowered.contains("test") || lowered.contains("qa") { return 0.75 }
        if lowered.contains("review") || lowered.contains("revis") || lowered.contains("corre") { return 0.6 }
        if lowered.contains("aguard") || lowered.contains("wait") { return 0.35 }
        return 0.5
    }
}

struct LinearStateGlyph: View {
    let type: String
    let name: String
    var size: CGFloat = 12

    private var color: Color { LinearPalette.state(type: type, name: name) }

    var body: some View {
        ZStack {
            switch type {
            case "backlog":
                Circle()
                    .strokeBorder(color, style: StrokeStyle(lineWidth: size * 0.13, dash: [size * 0.17, size * 0.12]))
            case "unstarted", "triage":
                Circle().strokeBorder(color, lineWidth: size * 0.13)
            case "started":
                Circle().strokeBorder(color, lineWidth: size * 0.13)
                PieSlice(fraction: LinearPalette.startedFill(name))
                    .fill(color)
                    .padding(size * 0.25)
            case "completed":
                Circle().fill(color)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.5, weight: .heavy))
                    .foregroundStyle(Theme.background)
            default:
                Circle().fill(color)
                Image(systemName: "xmark")
                    .font(.system(size: size * 0.45, weight: .heavy))
                    .foregroundStyle(Theme.background)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct PieSlice: Shape {
    var fraction: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        path.move(to: center)
        path.addArc(center: center, radius: min(rect.width, rect.height) / 2, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * fraction), clockwise: false)
        path.closeSubpath()
        return path
    }
}

enum LinearIconKind: Equatable {
    case emoji(String)
    case symbol(String)
    case monogram(String)
}

enum LinearIcons {
    private static let shortcodes: [String: String] = [
        "rocket": "🚀", "fire": "🔥", "star": "⭐", "star2": "🌟", "sparkles": "✨", "bug": "🐛", "zap": "⚡",
        "tada": "🎉", "eyes": "👀", "heart": "❤️", "brain": "🧠", "compass": "🧭", "chart_with_upwards_trend": "📈",
        "bar_chart": "📊", "memo": "📝", "books": "📚", "book": "📖", "gear": "⚙️", "hammer_and_wrench": "🛠️",
        "hammer": "🔨", "wrench": "🔧", "package": "📦", "art": "🎨", "iphone": "📱", "computer": "💻",
        "moneybag": "💰", "dollar": "💵", "money_with_wings": "💸", "shopping_cart": "🛒", "rotating_light": "🚨",
        "warning": "⚠️", "white_check_mark": "✅", "dart": "🎯", "bulb": "💡", "lock": "🔒", "key": "🔑",
        "globe_with_meridians": "🌐", "earth_americas": "🌎", "calendar": "📅", "date": "📅", "mega": "📣",
        "loudspeaker": "📢", "handshake": "🤝", "wave": "👋", "crown": "👑", "gem": "💎", "seedling": "🌱",
        "robot_face": "🤖", "robot": "🤖", "test_tube": "🧪", "construction": "🚧", "mag": "🔍", "inbox_tray": "📥",
        "speech_balloon": "💬", "briefcase": "💼", "house": "🏠", "trophy": "🏆", "gift": "🎁", "clipboard": "📋",
        "pushpin": "📌", "link": "🔗", "video_camera": "📹", "camera": "📷", "movie_camera": "🎥", "rainbow": "🌈",
        "sunny": "☀️", "crescent_moon": "🌙", "coffee": "☕", "pizza": "🍕", "muscle": "💪", "100": "💯",
        "thumbsup": "👍", "+1": "👍", "rocket_ship": "🚀", "satellite": "🛰️", "magnet": "🧲", "shield": "🛡️",
        "bell": "🔔", "envelope": "✉️", "email": "📧", "phone": "📞", "truck": "🚚", "factory": "🏭",
        "office": "🏢", "school": "🏫", "mortar_board": "🎓", "stethoscope": "🩺", "pill": "💊", "dna": "🧬",
        "microscope": "🔬", "telescope": "🔭", "flag": "🚩", "checkered_flag": "🏁", "hourglass": "⏳", "alarm_clock": "⏰",
        "cyclone": "🌀", "ocean": "🌊", "palm_tree": "🌴", "cactus": "🌵", "four_leaf_clover": "🍀", "unicorn": "🦄",
        "fox_face": "🦊", "cat": "🐱", "dog": "🐶", "owl": "🦉", "bee": "🐝", "octopus": "🐙", "whale": "🐳",
    ]

    private static let symbols: [(String, String)] = [
        ("checklist", "checklist"), ("rocket", "paperplane.fill"), ("feather", "leaf.fill"), ("bug", "ladybug.fill"),
        ("star", "star.fill"), ("heart", "heart.fill"), ("flag", "flag.fill"), ("bolt", "bolt.fill"),
        ("lightning", "bolt.fill"), ("fire", "flame.fill"), ("flame", "flame.fill"), ("book", "book.closed.fill"),
        ("briefcase", "briefcase.fill"), ("calendar", "calendar"), ("chart", "chart.bar.fill"), ("graph", "chart.bar.fill"),
        ("code", "chevron.left.forwardslash.chevron.right"), ("cube", "cube.fill"), ("box", "shippingbox.fill"),
        ("globe", "globe"), ("world", "globe"), ("home", "house.fill"), ("house", "house.fill"),
        ("lightbulb", "lightbulb.fill"), ("idea", "lightbulb.fill"), ("lock", "lock.fill"), ("megaphone", "megaphone.fill"),
        ("mobile", "iphone"), ("phone", "iphone"), ("people", "person.3.fill"), ("users", "person.3.fill"),
        ("team", "person.3.fill"), ("person", "person.fill"), ("user", "person.fill"), ("puzzle", "puzzlepiece.fill"),
        ("sparkle", "sparkles"), ("target", "target"), ("tool", "wrench.and.screwdriver.fill"),
        ("wrench", "wrench.and.screwdriver.fill"), ("truck", "truck.box.fill"), ("money", "dollarsign.circle.fill"),
        ("dollar", "dollarsign.circle.fill"), ("cart", "cart.fill"), ("shield", "shield.fill"),
        ("database", "cylinder.split.1x2.fill"), ("cloud", "cloud.fill"), ("paint", "paintbrush.fill"),
        ("design", "paintbrush.fill"), ("document", "doc.text.fill"), ("doc", "doc.text.fill"), ("folder", "folder.fill"),
        ("gift", "gift.fill"), ("inbox", "tray.fill"), ("link", "link"), ("map", "map.fill"), ("mail", "envelope.fill"),
        ("message", "bubble.left.fill"), ("chat", "bubble.left.fill"), ("music", "music.note"),
        ("search", "magnifyingglass"), ("settings", "gearshape.fill"), ("gear", "gearshape.fill"), ("video", "video.fill"),
        ("eye", "eye.fill"), ("ticket", "ticket.fill"), ("trophy", "trophy.fill"), ("education", "graduationcap.fill"),
        ("school", "graduationcap.fill"), ("diamond", "diamond.fill"), ("circle", "circle.fill"), ("square", "square.fill"),
        ("triangle", "triangle.fill"), ("hexagon", "hexagon.fill"), ("compass", "safari.fill"), ("clock", "clock.fill"),
        ("bell", "bell.fill"), ("key", "key.fill"), ("leaf", "leaf.fill"), ("tree", "tree.fill"), ("sun", "sun.max.fill"),
        ("moon", "moon.fill"), ("camera", "camera.fill"), ("image", "photo.fill"), ("brain", "brain.head.profile"),
        ("robot", "cpu.fill"), ("server", "server.rack"), ("terminal", "terminal.fill"), ("api", "point.3.connected.trianglepath.dotted"),
        ("layers", "square.3.layers.3d"), ("stack", "square.stack.3d.up.fill"), ("grid", "square.grid.2x2.fill"),
        ("list", "list.bullet"), ("kanban", "rectangle.split.3x1.fill"), ("road", "road.lanes"), ("roadmap", "map.fill"),
        ("growth", "chart.line.uptrend.xyaxis"), ("support", "lifepreserver.fill"), ("help", "questionmark.circle.fill"),
    ]

    static func kind(icon: String?, name: String) -> LinearIconKind {
        guard let icon = icon?.trimmingCharacters(in: .whitespaces), !icon.isEmpty else { return .monogram(initial(name)) }
        if icon.hasPrefix(":"), icon.hasSuffix(":"), icon.count > 2 {
            let code = String(icon.dropFirst().dropLast()).lowercased()
            if let emoji = shortcodes[code] { return .emoji(emoji) }
            return .monogram(initial(name))
        }
        if icon.unicodeScalars.contains(where: { $0.properties.isEmojiPresentation || $0.value > 0x2100 }) {
            return .emoji(icon)
        }
        let key = icon.lowercased().filter(\.isLetter)
        if let match = symbols.first(where: { $0.0 == key }) ?? symbols.first(where: { key.contains($0.0) }),
            NSImage(systemSymbolName: match.1, accessibilityDescription: nil) != nil
        {
            return .symbol(match.1)
        }
        return .monogram(initial(name))
    }

    private static func initial(_ name: String) -> String {
        name.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "•"
    }
}

struct LinearEntityIcon: View {
    let icon: String?
    let color: String?
    let name: String
    var size: CGFloat = 16
    var fallbackColor: Color = BrandMark.linearColor

    private var tint: Color { LinearPalette.color(hex: color) ?? fallbackColor }

    var body: some View {
        Group {
            switch LinearIcons.kind(icon: icon, name: name) {
            case .emoji(let emoji):
                Text(emoji)
                    .font(.system(size: size * 0.86))
                    .frame(width: size, height: size)
            case .symbol(let symbol):
                Image(systemName: symbol)
                    .font(.system(size: size * 0.72, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: size, height: size)
            case .monogram(let letter):
                Text(letter)
                    .font(BrandFonts.sans(size * 0.58, weight: .bold))
                    .foregroundStyle(tint)
                    .frame(width: size, height: size)
                    .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            }
        }
        .accessibilityHidden(true)
    }
}

struct LinearViewIcon: View {
    let view: LNView
    var size: CGFloat = 16

    var body: some View {
        if view.kind == "mine" {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: size * 0.82, weight: .regular))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: size, height: size)
        } else if view.kind == "view", view.icon == nil {
            Image(systemName: "line.3.horizontal.decrease.circle.fill")
                .font(.system(size: size * 0.82, weight: .regular))
                .foregroundStyle(LinearPalette.color(hex: view.color) ?? Theme.textSecondary)
                .frame(width: size, height: size)
        } else {
            LinearEntityIcon(icon: view.icon, color: view.color, name: view.name, size: size)
        }
    }
}

struct LinearLabelTag: View {
    let name: String
    let color: Color?
    var compact = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color ?? Theme.textTertiary)
                .frame(width: 7, height: 7)
            Text(name)
                .font(BrandFonts.sans(compact ? 10.5 : 11, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .frame(height: compact ? 19 : 20)
        .background(Theme.surface, in: Capsule())
        .fixedSize()
    }
}

struct LinearProjectTag: View {
    let name: String
    let project: LNProject?

    var body: some View {
        HStack(spacing: 4) {
            LinearEntityIcon(icon: project?.icon, color: project?.color, name: name, size: 12)
            Text(name)
                .font(BrandFonts.sans(10.5, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 6)
        .frame(height: 19)
        .background(Theme.surface, in: Capsule())
        .fixedSize()
        .help("Projeto \(name)")
    }
}
