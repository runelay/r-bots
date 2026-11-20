import Foundation
import WebKit

@MainActor
enum WebSession {
    static let dataStore = WKWebsiteDataStore.nonPersistent()

    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        return configuration
    }

    static func install(_ cookie: HTTPCookie) async {
        HTTPCookieStorage.shared.setCookie(cookie)
        await dataStore.httpCookieStore.setCookie(cookie)
    }

    static func removeSessionCookies(host: String) async {
        let storage = HTTPCookieStorage.shared
        for cookie in storage.cookies ?? [] where cookie.domain == host && cookie.name.hasSuffix("session_token") {
            storage.deleteCookie(cookie)
        }
        let store = dataStore.httpCookieStore
        for cookie in await store.allCookies() where cookie.domain == host && cookie.name.hasSuffix("session_token") {
            await store.deleteCookie(cookie)
        }
    }
}
