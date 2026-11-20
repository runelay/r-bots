import AppKit
import Observation
import SwiftUI
import WebKit

final class ArtifactWKWebView: WKWebView {
    var interactive = true

    override func hitTest(_ point: NSPoint) -> NSView? {
        interactive ? super.hitTest(point) : nil
    }

    override func scrollWheel(with event: NSEvent) {
        if interactive {
            super.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }

    override var acceptsFirstResponder: Bool { interactive }
}

enum WebPageFailure: Equatable {
    case status(Int)
    case network
}

struct ArtifactWebView: View {
    let url: URL
    var interactive = true
    var zoom: CGFloat = 1
    var focusToken = 0
    var sameOrigin = false
    var navigator: WebNavigator?
    var onLoad: () -> Void = {}

    @State private var ready = false
    @State private var failed = false
    @State private var renewed = false
    @State private var reloadToken = 0

    var body: some View {
        ZStack {
            if ready {
                AuthenticatedWebView(
                    url: url,
                    interactive: interactive,
                    zoom: zoom,
                    focusToken: focusToken,
                    reloadToken: reloadToken,
                    sameOrigin: sameOrigin,
                    navigator: navigator,
                    onLoad: onLoad,
                    onFailure: handle
                )
                .opacity(failed ? 0 : 1)
            }
            if failed {
                WebPageErrorView(retry: retry)
                    .transition(.opacity)
            }
        }
        .springAnimation(value: failed)
        .task(id: url) {
            renewed = false
            failed = false
            _ = await AuthSession.shared.prepareWebCookie()
            ready = true
        }
    }

    private func handle(_ failure: WebPageFailure) {
        guard failure == .status(401), !renewed else {
            failed = true
            return
        }
        renewed = true
        Task {
            guard await AuthSession.shared.prepareWebCookie(force: true) else {
                failed = true
                return
            }
            reloadToken += 1
        }
    }

    private func retry() {
        renewed = false
        Task {
            _ = await AuthSession.shared.prepareWebCookie(force: true)
            failed = false
            reloadToken += 1
        }
    }
}

struct WebPageErrorView: View {
    let retry: () -> Void

    var body: some View {
        VStack(spacing: Spacing.m) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Theme.textTertiary)
            Text("Não deu para abrir esta página")
                .font(TypeScale.rowTitle)
                .foregroundStyle(Theme.textPrimary)
            Button("Tentar de novo", action: retry)
                .buttonStyle(.brandSecondary)
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
}

struct AuthenticatedWebView: NSViewRepresentable {
    let url: URL
    var interactive = true
    var zoom: CGFloat = 1
    var focusToken = 0
    var reloadToken = 0
    var sameOrigin = false
    var navigator: WebNavigator?
    var onLoad: () -> Void = {}
    var onFailure: (WebPageFailure) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> ArtifactWKWebView {
        let view = ArtifactWKWebView(frame: .zero, configuration: WebSession.configuration())
        view.interactive = interactive
        view.pageZoom = zoom
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        context.coordinator.sync(self)
        context.coordinator.loadedURL = url
        context.coordinator.focusToken = focusToken
        context.coordinator.reloadToken = reloadToken
        navigator?.attach(view)
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: ArtifactWKWebView, context: Context) {
        view.interactive = interactive
        context.coordinator.sync(self)
        navigator?.attach(view)
        if view.pageZoom != zoom {
            view.pageZoom = zoom
        }
        if context.coordinator.loadedURL != url || context.coordinator.reloadToken != reloadToken {
            context.coordinator.loadedURL = url
            context.coordinator.reloadToken = reloadToken
            view.load(URLRequest(url: url))
        }
        if context.coordinator.focusToken != focusToken {
            context.coordinator.focusToken = focusToken
            DispatchQueue.main.async {
                view.window?.makeFirstResponder(view)
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: URL?
        var interactive = true
        var focusToken = 0
        var reloadToken = 0
        var sameOrigin = false
        weak var navigator: WebNavigator?
        var onLoad: () -> Void = {}
        var onFailure: (WebPageFailure) -> Void = { _ in }
        private var refused = false

        func sync(_ parent: AuthenticatedWebView) {
            interactive = parent.interactive
            sameOrigin = parent.sameOrigin
            navigator = parent.navigator
            onLoad = parent.onLoad
            onFailure = parent.onFailure
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onLoad()
            if interactive {
                webView.window?.makeFirstResponder(webView)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if let navigator, navigator.permits(target, type: navigationAction.navigationType) {
                decisionHandler(.allow)
                return
            }
            if Self.sameDocument(target, loadedURL) || (sameOrigin && Self.sameOrigin(target, loadedURL)) {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(target.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(target)
            }
            decisionHandler(.cancel)
        }

        private static func sameOrigin(_ target: URL, _ loaded: URL?) -> Bool {
            guard let loaded else { return false }
            return target.scheme?.lowercased() == loaded.scheme?.lowercased()
                && target.host?.lowercased() == loaded.host?.lowercased()
                && target.port == loaded.port
        }

        private static func sameDocument(_ target: URL, _ loaded: URL?) -> Bool {
            guard let loaded,
                  var left = URLComponents(url: target, resolvingAgainstBaseURL: false),
                  var right = URLComponents(url: loaded, resolvingAgainstBaseURL: false) else { return false }
            left.fragment = nil
            right.fragment = nil
            return left.url == right.url
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
            if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, http.statusCode >= 400 {
                refused = true
                decisionHandler(.cancel)
                onFailure(.status(http.statusCode))
                return
            }
            refused = false
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
            if refused, nsError.domain == "WebKitErrorDomain", nsError.code == 102 { return }
            onFailure(.network)
        }
    }
}

@MainActor
@Observable
final class WebNavigator {
    private(set) var url: URL?
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var isLoading = false
    private(set) var progress: Double = 0

    @ObservationIgnored private weak var webView: WKWebView?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var requested: URL?

    var isAttached: Bool { webView != nil }

    func attach(_ view: WKWebView) {
        guard view !== webView else { return }
        webView = view
        observations = [
            view.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.url = view.url }
            },
            view.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.canGoBack = view.canGoBack }
            },
            view.observe(\.canGoForward, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.canGoForward = view.canGoForward }
            },
            view.observe(\.isLoading, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.isLoading = view.isLoading }
            },
            view.observe(\.estimatedProgress, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.progress = view.estimatedProgress }
            },
        ]
    }

    func goBack() {
        webView?.goBack()
    }

    func goForward() {
        webView?.goForward()
    }

    func reload() {
        webView?.reload()
    }

    func load(_ target: URL) {
        requested = target
        webView?.load(URLRequest(url: target))
    }

    func permits(_ target: URL, type: WKNavigationType) -> Bool {
        if type == .backForward || type == .reload { return true }
        guard let requested, requested.absoluteString == target.absoluteString else { return false }
        self.requested = nil
        return true
    }
}
