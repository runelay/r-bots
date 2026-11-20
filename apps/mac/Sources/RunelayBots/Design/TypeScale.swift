import SwiftUI

enum TypeScale {
    static let appTitle = BrandFonts.sans(15, weight: .semibold)
    static let panelTitle = BrandFonts.sans(15, weight: .semibold)
    static let sectionTitle = BrandFonts.sans(14, weight: .semibold)
    static let sectionCaption = BrandFonts.sans(12.5, weight: .medium)
    static let rowTitle = BrandFonts.sans(14, weight: .medium)
    static let rowSubtitle = BrandFonts.sans(13)
    static let body = BrandFonts.sans(15)
    static let narration = BrandFonts.sans(13.5)
    static let caption = BrandFonts.sans(12)
    static let captionStrong = BrandFonts.sans(12, weight: .medium)
    static let mono = BrandFonts.mono(12)
    static let monoInline = BrandFonts.mono(11.5)
    static let counter = BrandFonts.sans(12, weight: .semibold).monospacedDigit()
    static let tileName = BrandFonts.sans(12, weight: .medium)
    static let heroName = BrandFonts.sans(20, weight: .semibold)
    static let pageTitle = BrandFonts.sans(23, weight: .semibold)
    static let wordmarkSuffix = BrandFonts.sans(15, weight: .medium)
}

enum Spacing {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 28
}

enum Radius {
    static let small: CGFloat = 8
    static let medium: CGFloat = 10
    static let large: CGFloat = 14
    static let composer: CGFloat = 26
}

enum Metrics {
    static let transcriptWidth: CGFloat = 720
    static let pageWidth: CGFloat = 1100
    static let formWidth: CGFloat = 720
    static let settingsGutter: CGFloat = Spacing.xxl + Spacing.s
    static let pageTitleTracking: CGFloat = -0.4
    static let sidebarWidth: CGFloat = 288
    static let inspectorWidth: CGFloat = 320
    static let conversationMinWidth: CGFloat = 420
    static let headerHeight: CGFloat = 56
    static let rowHeight: CGFloat = 56
    static let bodyLineSpacing: CGFloat = 5
}
