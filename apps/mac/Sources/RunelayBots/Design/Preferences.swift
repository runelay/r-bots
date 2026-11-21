import SwiftUI

enum AppearancePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "Sistema"
        case .light: "Claro"
        case .dark: "Escuro"
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
        case .system: "Sistema"
        case .reduced: "Ligado"
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
        case .small: "Pequeno"
        case .regular: "Médio"
        case .large: "Grande"
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
