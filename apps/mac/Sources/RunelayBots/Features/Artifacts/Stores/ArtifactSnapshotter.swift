import AppKit
import WebKit

@MainActor
final class ArtifactSnapshotter: NSObject, WKNavigationDelegate {
    static let shared = ArtifactSnapshotter()

    private let cache = NSCache<NSURL, NSImage>()
    private var webView: WKWebView?
    private var window: NSWindow?
    private var loaded: CheckedContinuation<Bool, Never>?
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var teardown: Task<Void, Never>?

    override private init() {
        super.init()
        cache.countLimit = 60
    }

    func cached(_ url: URL) -> NSImage? {
        cache.object(forKey: url as NSURL)
    }

    func snapshot(_ url: URL, width: CGFloat) async -> NSImage? {
        if let hit = cached(url) {
            return hit
        }
        while busy {
            await withCheckedContinuation { waiting.append($0) }
        }
        if let hit = cached(url) {
            return hit
        }
        busy = true
        teardown?.cancel()
        defer {
            busy = false
            if waiting.isEmpty {
                scheduleTeardown()
            } else {
                waiting.removeFirst().resume()
            }
        }
        _ = await AuthSession.shared.prepareWebCookie()
        let view = prepare()
        window?.orderBack(nil)
        defer { window?.orderOut(nil) }
        let ok = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            loaded = continuation
            view.load(URLRequest(url: url))
        }
        guard ok, !Task.isCancelled else { return nil }
        try? await Task.sleep(for: .milliseconds(500))
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = NSNumber(value: Double(width * 2))
        guard let image = try? await view.takeSnapshot(configuration: configuration) else { return nil }
        cache.setObject(image, forKey: url as NSURL)
        return image
    }

    private func prepare() -> WKWebView {
        if let webView {
            return webView
        }
        let configuration = WebSession.configuration()
        let size = ArtifactPDFRenderer.pageSize
        let view = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: configuration)
        let host = NSWindow(contentRect: CGRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        host.isReleasedWhenClosed = false
        host.ignoresMouseEvents = true
        host.contentView = view
        view.navigationDelegate = self
        webView = view
        window = host
        return view
    }

    private func scheduleTeardown() {
        teardown?.cancel()
        teardown = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled, let self, !self.busy else { return }
            self.webView?.navigationDelegate = nil
            self.window?.contentView = nil
            self.window?.close()
            self.webView = nil
            self.window = nil
        }
    }

    private func finish(_ ok: Bool) {
        loaded?.resume(returning: ok)
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(false)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, http.statusCode >= 400 {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(false)
    }
}
