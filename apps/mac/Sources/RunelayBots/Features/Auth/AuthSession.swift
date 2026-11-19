import AppKit
import AuthenticationServices
import Foundation
import WebKit

enum AuthState: Equatable {
    case checking
    case disabled
    case signedOut(needsOwner: Bool)
    case signedIn(AuthUser)
}

@MainActor
@Observable
final class AuthSession: NSObject {
    static let shared = AuthSession()

    var state: AuthState = .checking
    var expired = false
    var pendingUserCode: String?
    var browserBusy = false

    @ObservationIgnored private var bootedServer: String?
    @ObservationIgnored private var browserTask: Task<Void, Never>?
    @ObservationIgnored private var webSession: ASWebAuthenticationSession?
    @ObservationIgnored private var onSignedIn: (() -> Void)?

    var user: AuthUser? {
        if case .signedIn(let user) = state { return user }
        return nil
    }

    var blocksApp: Bool {
        switch state {
        case .signedOut, .checking: return true
        case .disabled, .signedIn: return false
        }
    }

    private var server: URL { ServerConfig.currentURL() }
    private var client: AuthClient { AuthClient(baseURL: server) }

    private var cachedUserKey: String { "auth.user.\(AuthStore.origin(of: server) ?? "")" }

    func onSignIn(_ action: @escaping () -> Void) {
        onSignedIn = action
    }

    func bootstrap(force: Bool = false) async {
        let origin = AuthStore.origin(of: server)
        guard force || bootedServer != origin else { return }
        bootedServer = origin
        let client = client
        let needsOwner: Bool?
        do {
            needsOwner = try await client.needsOwner()
        } catch {
            state = AuthStore.read(.session) == nil ? .signedOut(needsOwner: false) : cachedSignedIn()
            return
        }
        guard let needsOwner else {
            state = .disabled
            return
        }
        if needsOwner {
            state = .signedOut(needsOwner: true)
            return
        }
        guard let token = AuthStore.read(.session) else {
            state = .signedOut(needsOwner: false)
            return
        }
        do {
            let profile = try await client.profile(token: token)
            apply(profile)
            ensureRunnerKey(token: token)
        } catch AuthFailure.server(401, _) {
            AuthStore.remove(.session)
            state = .signedOut(needsOwner: false)
        } catch {
            state = cachedSignedIn()
        }
    }

    private func cachedSignedIn() -> AuthState {
        if let data = UserDefaults.standard.data(forKey: cachedUserKey),
           let user = try? JSONDecoder().decode(AuthUser.self, from: data) {
            return .signedIn(user)
        }
        return .signedOut(needsOwner: false)
    }

    func signIn(email: String, password: String) async throws {
        let token = try await client.signIn(email: email.trimmingCharacters(in: .whitespaces).lowercased(), password: password)
        try await finish(token: token)
    }

    func setupOwner(name: String, email: String, password: String) async throws {
        let token = try await client.setupOwner(
            name: name.trimmingCharacters(in: .whitespaces),
            email: email.trimmingCharacters(in: .whitespaces).lowercased(),
            password: password
        )
        try await finish(token: token)
    }

    func signInWithBrowser() {
        guard browserTask == nil else { return }
        browserBusy = true
        let client = client
        browserTask = Task { [weak self] in
            defer {
                self?.browserTask = nil
                self?.browserBusy = false
                self?.pendingUserCode = nil
                self?.webSession?.cancel()
                self?.webSession = nil
            }
            do {
                let grant = try await client.startDevice()
                self?.pendingUserCode = grant.userCode
                self?.openBrowser(grant.verificationURL)
                var interval = grant.interval
                let deadline = Date().addingTimeInterval(TimeInterval(grant.expiresIn))
                while !Task.isCancelled, Date() < deadline {
                    try await Task.sleep(for: .seconds(interval))
                    switch try await client.pollDevice(grant) {
                    case .pending:
                        continue
                    case .slowDown:
                        interval += 5
                    case .approved(let token):
                        try await self?.finish(token: token)
                        return
                    case .denied, .expired:
                        return
                    }
                }
            } catch {
                return
            }
        }
    }

    func cancelBrowser() {
        browserTask?.cancel()
    }

    private func openBrowser(_ url: URL) {
        let session = ASWebAuthenticationSession(url: url, callback: .customScheme("runelaybots")) { _, _ in }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        webSession = session
        if !session.start() {
            NSWorkspace.shared.open(url)
        }
    }

    func signOut() async {
        if let token = AuthStore.read(.session) {
            await client.signOut(token: token)
        }
        clearLocal()
        expired = false
        state = .signedOut(needsOwner: false)
    }

    func sessionExpired() {
        guard case .signedIn = state, AuthStore.read(.session) != nil else { return }
        clearLocal()
        expired = true
        state = .signedOut(needsOwner: false)
    }

    private func clearLocal() {
        AuthStore.remove(.session)
        removeCookies()
    }

    private func finish(token: String) async throws {
        let profile = try await client.profile(token: token)
        AuthStore.save(token, as: .session)
        apply(profile)
        expired = false
        ensureRunnerKey(token: token, force: true)
        onSignedIn?()
    }

    private func apply(_ profile: AuthProfile) {
        if let data = try? JSONEncoder().encode(profile.user) {
            UserDefaults.standard.set(data, forKey: cachedUserKey)
        }
        installCookie(profile)
        state = .signedIn(profile.user)
    }

    private func ensureRunnerKey(token: String, force: Bool = false) {
        guard force || AuthStore.read(.runner) == nil else { return }
        let client = client
        Task {
            guard let key = try? await client.runnerKey(token: token) else { return }
            AuthStore.save(key, as: .runner)
            RunnerConnection.shared.restart()
        }
    }

    private func installCookie(_ profile: AuthProfile) {
        guard let cookie = profile.cookie, let host = server.host() else { return }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .domain: host,
            .path: "/",
            .name: cookie.name,
            .value: cookie.value,
            .sameSitePolicy: HTTPCookieStringPolicy.sameSiteLax,
        ]
        if server.scheme == "https" {
            properties[.secure] = "TRUE"
        }
        guard let item = HTTPCookie(properties: properties) else { return }
        HTTPCookieStorage.shared.setCookie(item)
        WKWebsiteDataStore.default().httpCookieStore.setCookie(item)
    }

    private func removeCookies() {
        guard let host = server.host() else { return }
        let storage = HTTPCookieStorage.shared
        for cookie in storage.cookies ?? [] where cookie.domain == host && cookie.name.hasSuffix("session_token") {
            storage.deleteCookie(cookie)
        }
        let store = WKWebsiteDataStore.default().httpCookieStore
        store.getAllCookies { cookies in
            for cookie in cookies where cookie.domain == host && cookie.name.hasSuffix("session_token") {
                store.delete(cookie)
            }
        }
    }
}

extension AuthSession: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}
