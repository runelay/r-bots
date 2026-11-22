import Foundation
import Observation
import SwiftUI
import Synchronization

enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case system
    case portuguese = "pt-BR"
    case english = "en"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: tr("Sistema")
        case .portuguese: "Português (Brasil)"
        case .english: "English"
        }
    }

    var resolved: AppLanguage {
        guard self == .system else { return self }
        for identifier in Locale.preferredLanguages {
            switch Locale(identifier: identifier).language.languageCode?.identifier {
            case "pt": return .portuguese
            case "en": return .english
            default: continue
            }
        }
        return .english
    }
}

final class LanguageStore: Observable, Sendable {
    static let shared = LanguageStore()
    static let defaultsKey = "appLanguage"

    private struct State {
        var selection: AppLanguage
        var language: AppLanguage
    }

    private let registrar = ObservationRegistrar()
    private let state: Mutex<State>

    private init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey).flatMap(AppLanguage.init(rawValue:)) ?? .system
        state = Mutex(State(selection: stored, language: stored.resolved))
    }

    var selection: AppLanguage {
        registrar.access(self, keyPath: \.selection)
        return state.withLock { $0.selection }
    }

    var language: AppLanguage {
        registrar.access(self, keyPath: \.selection)
        return state.withLock { $0.language }
    }

    var code: String { language.rawValue }

    var locale: Locale {
        var components = Locale.Components(locale: .current)
        components.languageComponents = Locale.Language.Components(identifier: code)
        return Locale(components: components)
    }

    @MainActor
    func select(_ selection: AppLanguage) {
        guard update(selection) else { return }
        Task {
            try? await BotsClient(baseURL: ServerConfig.currentURL()).updatePreferences(.object(["language": .string(selection.rawValue)]))
        }
    }

    @MainActor
    func sync() async {
        guard let preferences = try? await BotsClient(baseURL: ServerConfig.currentURL()).preferences() else { return }
        apply(preferences)
    }

    func apply(_ preferences: JSONValue) {
        guard let raw = preferences["language"]?.stringValue, let selection = AppLanguage(rawValue: raw) else { return }
        update(selection)
    }

    @discardableResult
    private func update(_ selection: AppLanguage) -> Bool {
        guard state.withLock({ $0.selection }) != selection else { return false }
        UserDefaults.standard.set(selection.rawValue, forKey: Self.defaultsKey)
        registrar.withMutation(of: self, keyPath: \.selection) {
            state.withLock { $0 = State(selection: selection, language: selection.resolved) }
        }
        return true
    }

    fileprivate func translate(_ key: String) -> String {
        guard language == .english, let bundle = Self.englishBundle else { return key }
        return bundle.localizedString(forKey: key, value: key, table: nil)
    }

    private static let englishBundle: Bundle? = {
        guard let path = Bundle.main.path(forResource: AppLanguage.english.rawValue, ofType: "lproj") else { return nil }
        return Bundle(path: path)
    }()
}

func tr(_ key: String) -> String {
    LanguageStore.shared.translate(key)
}

func tr(_ key: String, _ arguments: any CVarArg...) -> String {
    let store = LanguageStore.shared
    return String(format: store.translate(key), locale: store.locale, arguments: arguments)
}

extension URLRequest {
    mutating func setAppLanguage() {
        setValue(LanguageStore.shared.code, forHTTPHeaderField: "Accept-Language")
    }
}

private struct AppLanguageModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.environment(\.locale, LanguageStore.shared.locale)
    }
}

extension View {
    func appLanguage() -> some View {
        modifier(AppLanguageModifier())
    }
}
