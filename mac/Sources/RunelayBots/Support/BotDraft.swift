import Foundation

struct BotDraft: Equatable {
    var name: String
    var accent: String
    var glyph: String

    init(bot: Bot?) {
        name = bot?.name ?? ""
        accent = bot?.accent ?? "orange"
        glyph = bot.map { $0.glyph.flatMap { $0 == "auto" ? nil : $0 } ?? $0.id } ?? "face-1"
    }

    var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var previewID: String {
        let slug = BotDraft.slug(name)
        return slug.isEmpty ? "novo-bot" : slug
    }

    var body: JSONValue {
        .object([
            "name": .string(trimmedName),
            "accent": .string(accent),
            "glyph": .string(glyph)
        ])
    }

    func localErrors() -> [String: String] {
        if trimmedName.isEmpty {
            return ["name": "Dê um nome para o bot."]
        }
        if trimmedName.count > 40 {
            return ["name": "Use até 40 caracteres."]
        }
        return [:]
    }

    static func slug(_ text: String) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "pt_BR"))
        var result = ""
        var lastWasDash = false
        for scalar in folded.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII {
                result.unicodeScalars.append(scalar)
                lastWasDash = false
            } else if !lastWasDash && !result.isEmpty {
                result.append("-")
                lastWasDash = true
            }
        }
        while result.hasSuffix("-") {
            result.removeLast()
        }
        return result.lowercased()
    }
}
