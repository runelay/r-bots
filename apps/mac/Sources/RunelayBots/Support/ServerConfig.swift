import Foundation

enum ServerConfig {
    static let storageKey = "serverURL"
    static let defaultURL = "http://127.0.0.1:2000"

    static func currentURL() -> URL {
        let stored = UserDefaults.standard.string(forKey: storageKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !stored.isEmpty, let url = URL(string: stored), url.scheme != nil, url.host() != nil {
            return url
        }
        guard let fallback = URL(string: defaultURL) else {
            preconditionFailure("defaultURL is a valid literal URL")
        }
        return fallback
    }
}
