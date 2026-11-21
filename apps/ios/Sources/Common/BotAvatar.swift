import SwiftUI

struct BotAvatar: View {
    let botID: String
    var glyph: String?
    let accent: String
    let mood: CharacterMood
    var size: CGFloat = 32

    var body: some View {
        BotCharacter(botID: botID, glyph: glyph, accent: "#FFFFFF", mood: mood, size: size * 0.74)
            .frame(width: size, height: size)
            .background(Theme.accent(accent), in: Circle())
            .accessibilityHidden(true)
    }
}

extension BotAvatar {
    init(bot: Bot, mood: CharacterMood, size: CGFloat) {
        self.init(botID: bot.id, glyph: bot.glyph, accent: bot.accent, mood: mood, size: size)
    }
}

extension Bot {
    var headline: String {
        role.isEmpty ? name : "\(name) | \(role)"
    }
}
