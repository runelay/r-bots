import AppKit
import Foundation
import Observation
import PDFKit
import WebKit

struct ArtifactRef: Equatable, Hashable, Sendable {
    let botID: String
    let id: String
    var title: String
    let kind: String
    var version: Int
}

struct ArtifactVersionInfo: Decodable, Equatable, Hashable, Sendable {
    let n: Int
    let createdAt: String?
}

struct ArtifactSummary: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let kind: String
    let version: Int
    let updatedAt: String?
    let versions: [ArtifactVersionInfo]

    var updatedDate: Date? {
        guard let updatedAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: updatedAt)
    }

    func ref(botID: String) -> ArtifactRef {
        ArtifactRef(botID: botID, id: id, title: title, kind: kind, version: version)
    }
}

enum ArtifactKindInfo {
    static func label(_ kind: String) -> String {
        switch kind {
        case "slides": "Apresentação"
        case "dashboard": "Dashboard"
        case "canvas": "Canvas"
        default: "Página"
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "slides": "rectangle.on.rectangle"
        case "dashboard": "chart.bar.xaxis"
        case "canvas": "point.3.connected.trianglepath.dotted"
        default: "doc.richtext"
        }
    }

    static func subtitle(kind: String, version: Int) -> String {
        version > 1 ? "\(label(kind)) · v\(version)" : label(kind)
    }
}

@MainActor
@Observable
final class ArtifactCenter {
    static let shared = ArtifactCenter()

    private(set) var current: ArtifactRef?
    private(set) var versions: [ArtifactVersionInfo] = []
    private(set) var selectedVersion = 1
    private(set) var presenting = false
    private(set) var revision = 0
    private(set) var libraries: [String: [ArtifactSummary]] = [:]
    private(set) var busy: String?
    private(set) var status: String?
    private(set) var focusToken = 0
    private(set) var canvas: CanvasEditor?

    @ObservationIgnored private var client: BotsClient?
    @ObservationIgnored private var enteredFullScreen = false
    @ObservationIgnored private var statusTask: Task<Void, Never>?

    var currentURL: URL? {
        guard let current, let client else { return nil }
        return Self.url(client: client, botID: current.botID, id: current.id, version: selectedVersion)
    }

    static func url(client: BotsClient, botID: String, id: String, version: Int) -> URL? {
        try? client.request(path: "/bots/\(botID)/artifacts/\(id)/v/\(version).html").url
    }

    var isBlock: Bool {
        current.map { BlockKind.isBlockKind($0.kind) } ?? false
    }

    func open(_ ref: ArtifactRef, client: BotsClient) {
        self.client = client
        canvas?.flush()
        if BlockKind.isBlockKind(ref.kind) {
            canvas = nil
            presenting = false
            status = nil
            versions = []
            current = ref
            BlockCenter.shared.open(ref, client: client)
            return
        }
        BlockCenter.shared.close()
        current = ref
        selectedVersion = ref.version
        versions = []
        status = nil
        presenting = false
        if ref.kind == "canvas" {
            let editor = CanvasEditor(ref: ref, client: client)
            canvas = editor
            Task { await editor.load() }
        } else {
            canvas = nil
        }
        Task { await loadVersions() }
    }

    func close() {
        if presenting {
            leaveFullScreen()
        }
        presenting = false
        canvas?.flush()
        canvas = nil
        if isBlock {
            BlockCenter.shared.close()
        }
        current = nil
        status = nil
    }

    func forgetServer() {
        close()
        libraries = [:]
        versions = []
        busy = nil
    }

    func openFiles(botID: String, client: BotsClient) {
        open(ArtifactRef(botID: botID, id: BlockKind.filesKind, title: "Arquivos do bot", kind: BlockKind.filesKind, version: 1), client: client)
    }

    func retitle(_ ref: ArtifactRef) {
        guard isBlock else { return }
        current = ref
    }

    func select(version: Int) {
        selectedVersion = version
        focusToken += 1
        if let canvas {
            Task { await canvas.load(version: version) }
        }
    }

    func noteSaved(_ ref: ArtifactRef, version: Int) {
        revision += 1
        guard current?.id == ref.id else { return }
        selectedVersion = version
        Task { await loadVersions() }
    }

    func noteChange(_ ref: ArtifactRef, byUser: Bool = false) {
        revision += 1
        guard current?.id == ref.id, !byUser, !isBlock else { return }
        canvas?.reloadIfClean(version: ref.version)
        current?.title = ref.title
        if ref.version > selectedVersion {
            selectedVersion = ref.version
        }
        Task { await loadVersions() }
    }

    func togglePresenting() {
        guard current != nil else { return }
        if presenting {
            presenting = false
            leaveFullScreen()
        } else {
            presenting = true
            if let window = NSApp.keyWindow ?? NSApp.mainWindow, !window.styleMask.contains(.fullScreen) {
                enteredFullScreen = true
                window.toggleFullScreen(nil)
            }
        }
        focusToken += 1
    }

    func escape() {
        if presenting {
            togglePresenting()
        } else {
            close()
        }
    }

    func loadLibrary(botID: String, client: BotsClient) async {
        self.client = self.client ?? client
        guard let request = try? client.request(path: "/bots/\(botID)/artifacts"),
              let result = try? await URLSession.shared.data(for: request),
              (result.1 as? HTTPURLResponse)?.statusCode == 200,
              let items = try? JSONDecoder().decode([ArtifactSummary].self, from: result.0)
        else { return }
        libraries[botID] = items
    }

    func openInBrowser() async {
        guard let current, let url = currentURL else { return }
        busy = "browser"
        defer { busy = nil }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            var html = String(decoding: data, as: UTF8.self)
            if let policy = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Security-Policy"),
               let head = html.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
                html.insert(contentsOf: "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">", at: head.upperBound)
            }
            let file = try Self.downloadsFile(name: current.title, ext: "html")
            try html.write(to: file, atomically: true, encoding: .utf8)
            NSWorkspace.shared.open(file)
            flash("Salvo em Downloads e aberto no navegador")
        } catch {
            flash("Não consegui abrir no navegador")
        }
    }

    func exportPDF() async {
        guard let current, let url = currentURL else { return }
        busy = "pdf"
        defer { busy = nil }
        do {
            let renderer = ArtifactPDFRenderer()
            let data = try await renderer.render(url: url, slides: current.kind == "slides")
            let file = try Self.downloadsFile(name: current.title, ext: "pdf")
            try data.write(to: file)
            NSWorkspace.shared.activateFileViewerSelecting([file])
            flash("PDF salvo em Downloads")
        } catch {
            flash("Não consegui exportar o PDF")
        }
    }

    func exportCanvas(pdf: Bool) {
        guard let current, let canvas else { return }
        guard let data = pdf ? CanvasExporter.pdf(canvas.doc) : CanvasExporter.png(canvas.doc),
              let file = try? Self.downloadsFile(name: current.title, ext: pdf ? "pdf" : "png"),
              (try? data.write(to: file)) != nil
        else {
            flash(pdf ? "Não consegui exportar o PDF" : "Não consegui exportar a imagem")
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([file])
        flash(pdf ? "PDF salvo em Downloads" : "Imagem salva em Downloads")
    }

    func copyMermaid() {
        guard let canvas else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(canvas.mermaid, forType: .string)
        flash("Copiado como Mermaid")
    }

    func copyLink() {
        guard let url = currentURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
        flash("Link copiado")
    }

    private func loadVersions() async {
        guard let current, let client,
              let request = try? client.request(path: "/bots/\(current.botID)/artifacts/\(current.id)"),
              let result = try? await URLSession.shared.data(for: request),
              (result.1 as? HTTPURLResponse)?.statusCode == 200,
              let summary = try? JSONDecoder().decode(ArtifactSummary.self, from: result.0),
              self.current?.id == summary.id
        else { return }
        versions = summary.versions
        self.current?.title = summary.title
    }

    private func leaveFullScreen() {
        guard enteredFullScreen else { return }
        enteredFullScreen = false
        if let window = NSApp.keyWindow ?? NSApp.mainWindow, window.styleMask.contains(.fullScreen) {
            window.toggleFullScreen(nil)
        }
    }

    private func flash(_ text: String) {
        status = text
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.status = nil
        }
    }

    private static func downloadsFile(name: String, ext: String) throws -> URL {
        let folder = try FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let cleaned = name
            .components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>\n\r\t"))
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return folder.appendingPathComponent(cleaned.isEmpty ? "artefato" : String(cleaned.prefix(120))).appendingPathExtension(ext)
    }
}

enum ArtifactPDFError: Error {
    case load
    case empty
}

@MainActor
final class ArtifactPDFRenderer: NSObject, WKNavigationDelegate {
    static let pageSize = CGSize(width: 1280, height: 720)

    private let webView: WKWebView
    private let window: NSWindow
    private var loaded: CheckedContinuation<Void, Error>?

    override init() {
        webView = WKWebView(frame: CGRect(origin: .zero, size: Self.pageSize), configuration: WebSession.configuration())
        window = NSWindow(
            contentRect: CGRect(x: -20000, y: -20000, width: Self.pageSize.width, height: Self.pageSize.height),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.contentView = webView
        webView.navigationDelegate = self
    }

    func render(url: URL, slides: Bool) async throws -> Data {
        _ = await AuthSession.shared.prepareWebCookie()
        window.orderBack(nil)
        defer { window.orderOut(nil) }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            loaded = continuation
            webView.load(URLRequest(url: url))
        }
        try await Task.sleep(for: .milliseconds(1200))
        guard slides else {
            return try await webView.pdf(configuration: WKPDFConfiguration())
        }
        let count = await evaluateInt("typeof window.slideCount === 'number' ? window.slideCount : document.querySelectorAll('.slide').length")
        guard count > 0 else {
            return try await webView.pdf(configuration: WKPDFConfiguration())
        }
        let document = PDFDocument()
        let configuration = WKPDFConfiguration()
        configuration.rect = CGRect(origin: .zero, size: Self.pageSize)
        for index in 0..<count {
            _ = await evaluateInt(Self.goToScript(index: index, count: count))
            try await Task.sleep(for: .milliseconds(350))
            let data = try await webView.pdf(configuration: configuration)
            if let page = PDFDocument(data: data)?.page(at: 0) {
                document.insert(page, at: document.pageCount)
            }
        }
        guard document.pageCount > 0, let data = document.dataRepresentation() else { throw ArtifactPDFError.empty }
        return data
    }

    private static func goToScript(index: Int, count: Int) -> String {
        """
        (function(){
          if (typeof window.goToSlide === 'function') { window.goToSlide(\(index)); return 1; }
          const fire = key => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: key, bubbles: true }));
          if (\(index) === 0) { fire('Home'); for (let i = 0; i < \(count); i++) fire('ArrowLeft'); } else { fire('ArrowRight'); }
          return 0;
        })()
        """
    }

    private func evaluateInt(_ script: String) async -> Int {
        await withCheckedContinuation { (continuation: CheckedContinuation<Int, Never>) in
            webView.evaluateJavaScript(script) { value, _ in
                let number = (value as? NSNumber)?.intValue ?? 0
                continuation.resume(returning: number)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded?.resume()
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loaded?.resume(throwing: ArtifactPDFError.load)
        loaded = nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, http.statusCode >= 400 {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loaded?.resume(throwing: ArtifactPDFError.load)
        loaded = nil
    }
}
