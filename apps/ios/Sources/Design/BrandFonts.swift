import CoreText
import SwiftUI
import UIKit

enum BrandFonts {
    static let sansFamily = "Inter"
    static let monoFamily = "JetBrains Mono"
    static let wordmarkFamily = "Geist"

    static let availableFamilies: Set<String> = {
        let files = [("Inter-Variable", "ttf"), ("JetBrainsMono-Variable", "ttf"), ("Geist", "woff2"), ("Virgil", "woff2")]
        for (name, ext) in files {
            if let url = Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "Fonts") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
        return Set(UIFont.familyNames)
    }()

    static func prepare() {
        _ = availableFamilies
        let large = uiSans(32, weight: .bold)
        let inline = uiSans(17, weight: .semibold)
        let appearance = UINavigationBar.appearance()
        appearance.largeTitleTextAttributes = [.font: large]
        appearance.titleTextAttributes = [.font: inline]
    }

    static func uiSans(_ size: CGFloat, weight: UIFont.Weight) -> UIFont {
        guard availableFamilies.contains(sansFamily) else {
            return .systemFont(ofSize: size, weight: weight)
        }
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: sansFamily,
            .traits: [UIFontDescriptor.TraitKey.weight: weight],
        ])
        return UIFont(descriptor: descriptor, size: size)
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

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard availableFamilies.contains(monoFamily) else {
            return .system(size: size, weight: weight, design: .monospaced)
        }
        return Font.custom(monoFamily, size: size).weight(weight)
    }
}
