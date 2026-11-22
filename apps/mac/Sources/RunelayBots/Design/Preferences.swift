import SwiftUI

enum AppearancePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: tr("Sistema")
        case .light: tr("Claro")
        case .dark: tr("Escuro")
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum MotionPreference: String, CaseIterable, Identifiable {
    case system
    case reduced

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: tr("Sistema")
        case .reduced: tr("Ligado")
        }
    }
}

enum ConversationTextSize: String, CaseIterable, Identifiable {
    case small
    case regular
    case large

    var id: String { rawValue }

    var title: String {
        switch self {
        case .small: tr("Pequeno")
        case .regular: tr("Médio")
        case .large: tr("Grande")
        }
    }

    var pointSize: CGFloat {
        switch self {
        case .small: 14
        case .regular: 15
        case .large: 17
        }
    }
}

enum PreferenceKeys {
    static let appearance = "appearance"
    static let motion = "motionPreference"
    static let textSize = "conversationTextSize"
    static let sidebarCollapsed = "sidebarCollapsed"
}

enum AppInfo {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
}

extension EnvironmentValues {
    @Entry var appReduceMotion = false
    @Entry var conversationFontSize: CGFloat = 15
}
