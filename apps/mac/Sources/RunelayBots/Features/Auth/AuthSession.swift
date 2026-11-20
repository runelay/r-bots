import AppKit
import AuthenticationServices
import Foundation
import WebKit

enum AuthState: Equatable {
    case checking
    case outdated
    case unreachable
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
    var status: SetupStatus?
    var providers: [String] = []

    @ObservationIgnored private var bootedServer: String?
    @ObservationIgnored private var browserTask: Task<Void, Never>?
    @ObservationIgnored private var webSession: ASWebAuthenticationSession?
    @ObservationIgnored private var onSignedIn: (() -> Void)?

    var user: AuthUser? {
        if case .signedIn(let user) = state { return user }
        return nil
    }

    var needsOwner: Bool {
        if case .signedOut(let needsOwner) = state { return needsOwner }
        return false
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
        if state == .outdated || state == .unreachable { state = .checking }
        let client = client
        let fetched: SetupStatus?
        do {
            fetched = try await client.setupStatus()
        } catch {
            state = AuthStore.read(.session) != nil ? cachedSignedIn() : .unreachable
            return
        }
        status = fetched
        guard let fetched else {
            providers = []
            state = .outdated
            return
        }
        providers = await client.providers()
        if fetched.needsOwner {
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

    func signIn(email: String, password: String, remember: Bool) async throws {
        let token = try await client.signIn(
            email: email.trimmingCharacters(in: .whitespaces).lowercased(),
            password: password,
            remember: remember
        )
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

    func acceptInvite(code: String, name: String, email: String, password: String) async throws {
        let token = try await client.acceptInvite(
            code: code.trimmingCharacters(in: .whitespacesAndNewlines),
            name: name.trimmingCharacters(in: .whitespaces),
            email: email.trimmingCharacters(in: .whitespaces).lowercased(),
            password: password
        )
        try await finish(token: token)
    }

    func requestPasswordReset(email: String) async throws {
        try await client.requestPasswordReset(email: email.trimmingCharacters(in: .whitespaces).lowercased())
    }

    func changePassword(current: String, new: String) async throws {
        guard let token = AuthStore.read(.session) else { throw AuthFailure.server(401, nil) }
        if let fresh = try await client.changePassword(token: token, current: current, new: new), fresh != token {
            AuthStore.save(fresh, as: .session)
            if let profile = try? await client.profile(token: fresh) {
                apply(profile)
            }
        }
    }

    func uploadAvatar(_ data: Data, mime: String) async throws {
        guard let token = AuthStore.read(.session), var user else { throw AuthFailure.server(401, nil) }
        user.image = try await client.uploadAvatar(token: token, data: data, mime: mime)
        store(user)
    }

    func removeAvatar() async throws {
        guard let token = AuthStore.read(.session), var user else { throw AuthFailure.server(401, nil) }
        try await client.removeAvatar(token: token)
        user.image = nil
        store(user)
    }

    func updateName(_ name: String) async throws {
        guard let token = AuthStore.read(.session) else { throw AuthFailure.server(401, nil) }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        try await client.updateName(token: token, name: trimmed)
        apply(try await client.profile(token: token))
    }

    func avatarData(path: String) async throws -> Data {
        guard let token = AuthStore.read(.session) else { throw AuthFailure.server(401, nil) }
        return try await client.avatar(path: path, token: token)
    }

    private func store(_ user: AuthUser) {
        if let data = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(data, forKey: cachedUserKey)
        }
        state = .signedIn(user)
    }

    func signInWithBrowser(provider: String? = nil) {
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
                self?.openBrowser(Self.browserURL(grant.verificationURL, provider: provider))
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

    private static func browserURL(_ url: URL, provider: String?) -> URL {
        guard let provider, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "provider", value: provider)]
        return components.url ?? url
    }

    func cancelBrowser() {
        browserTask?.cancel()
    }

    private func openBrowser(_ url: URL) {
        let session = ASWebAuthenticationSession(url: url, callback: .customScheme("runelaybots"), completionHandler: Self.browserCompletion(for: self))
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        webSession = session
        if !session.start() {
            NSWorkspace.shared.open(url)
        }
    }

    nonisolated private static func browserCompletion(for owner: AuthSession) -> @Sendable (URL?, (any Error)?) -> Void {
        { [weak owner] _, error in
            guard error != nil, let owner else { return }
            Task { @MainActor in
                owner.cancelBrowser()
            }
        }
    }

    func signOut() async {
        if let token = AuthStore.read(.session) {
            await client.signOut(token: token)
        }
        clearLocal()
        expired = false
        state = .signedOut(needsOwner: false)
        await bootstrap(force: true)
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
        installCookie(profile)
        store(profile.user)
    }

    private func ensureRunnerKey(token: String, force: Bool = false) {
        guard force || AuthStore.read(.device) == nil else { return }
        Task {
            await DeviceStore.shared.register(sessionToken: token, automatic: !force)
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
