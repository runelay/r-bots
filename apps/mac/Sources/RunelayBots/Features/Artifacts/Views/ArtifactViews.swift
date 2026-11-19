import AppKit
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

struct ArtifactWebView: NSViewRepresentable {
    let url: URL
    var interactive = true
    var zoom: CGFloat = 1
    var focusToken = 0
    var onLoad: () -> Void = {}

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> ArtifactWKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = ArtifactWKWebView(frame: .zero, configuration: configuration)
        view.interactive = interactive
        view.pageZoom = zoom
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        context.coordinator.interactive = interactive
        context.coordinator.onLoad = onLoad
        context.coordinator.loadedURL = url
        context.coordinator.focusToken = focusToken
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: ArtifactWKWebView, context: Context) {
        view.interactive = interactive
        context.coordinator.interactive = interactive
        context.coordinator.onLoad = onLoad
        if view.pageZoom != zoom {
            view.pageZoom = zoom
        }
        if context.coordinator.loadedURL != url {
            context.coordinator.loadedURL = url
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
        var onLoad: () -> Void = {}

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onLoad()
            if interactive {
                webView.window?.makeFirstResponder(webView)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated, let target = navigationAction.request.url {
                NSWorkspace.shared.open(target)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}

struct ArtifactThumbnail: View {
    let url: URL?
    var width: CGFloat = 320

    @State private var image: NSImage?

    private var height: CGFloat { width * 9 / 16 }

    var body: some View {
        ZStack {
            Theme.surfaceRaised
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fill)
                    .frame(width: width, height: height, alignment: .top)
                    .transition(.opacity)
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .allowsHitTesting(false)
        .springAnimation(value: image != nil)
        .task(id: url) {
            guard let url else { return }
            if let hit = ArtifactSnapshotter.shared.cached(url) {
                image = hit
                return
            }
            image = await ArtifactSnapshotter.shared.snapshot(url, width: width)
        }
    }
}

struct ArtifactCard: View {
    let ref: ArtifactRef

    var body: some View {
        if BlockKind.isBlockKind(ref.kind) {
            BlockCard(ref: ref)
        } else {
            ArtifactPageCard(ref: ref)
        }
    }
}

struct ArtifactPageCard: View {
    @Environment(AppModel.self) private var model
    let ref: ArtifactRef

    @State private var hovering = false

    var body: some View {
        Button {
            ArtifactCenter.shared.open(ref, client: model.client)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                if ref.kind == "canvas" {
                    CanvasThumbnail(ref: ref)
                } else {
                    ArtifactThumbnail(url: ArtifactCenter.url(client: model.client, botID: ref.botID, id: ref.id, version: ref.version))
                }
                HStack(spacing: Spacing.s) {
                    Image(systemName: ArtifactKindInfo.symbol(ref.kind))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(ref.title)
                            .font(TypeScale.rowTitle)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Text(ArtifactKindInfo.subtitle(kind: ref.kind, version: ref.version))
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .opacity(hovering ? 1 : 0)
                }
                .padding(.horizontal, Spacing.s)
                .padding(.top, Spacing.s + 2)
                .padding(.bottom, Spacing.xs + 2)
            }
            .padding(Spacing.xs)
            .frame(width: 328, alignment: .leading)
            .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .scaleEffect(hovering ? 1.01 : 1)
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help("Abrir \(ref.title)")
        .padding(.leading, 20 + Spacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ArtifactViewerLayer: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    private var center: ArtifactCenter { .shared }

    var body: some View {
        ZStack {
            if let ref = center.current, center.isBlock {
                BlockDock(ref: ref)
                    .transition(Motion.panel(reduceMotion: reduceMotion))
            } else if let ref = center.current, let url = center.currentURL {
                GeometryReader { geometry in
                    let presenting = center.presenting
                    ZStack {
                        (presenting ? Color.black : Theme.scrim)
                            .ignoresSafeArea()
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if !presenting {
                                    center.close()
                                }
                            }

                        ArtifactViewer(ref: ref, url: url, presenting: presenting)
                            .frame(
                                width: presenting ? geometry.size.width : min(geometry.size.width * 0.92, geometry.size.width - 48),
                                height: presenting ? geometry.size.height : min(geometry.size.height * 0.92, geometry.size.height - 48)
                            )
                            .background(presenting ? Color.black : Theme.inspectorBackground)
                            .clipShape(RoundedRectangle(cornerRadius: presenting ? 0 : 24, style: .continuous))
                            .softElevation(lifted: !presenting)

                        Button("Fechar") {
                            center.escape()
                        }
                        .keyboardShortcut(.cancelAction)
                        .opacity(0)
                        .frame(width: 0, height: 0)
                        .accessibilityHidden(true)

                        Button("Apresentar") {
                            center.togglePresenting()
                        }
                        .keyboardShortcut("f", modifiers: [.command, .shift])
                        .opacity(0)
                        .frame(width: 0, height: 0)
                        .accessibilityHidden(true)
                    }
                    .frame(width: geometry.size.width, height: geometry.size.height)
                }
                .modifier(ModalTransition())
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: center.current?.id)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: center.presenting)
    }
}

struct ArtifactViewer: View {
    let ref: ArtifactRef
    let url: URL
    let presenting: Bool

    private var center: ArtifactCenter { .shared }

    var body: some View {
        VStack(spacing: 0) {
            if !presenting {
                header
                    .transition(.opacity)
            }
            Group {
                if let canvas = center.canvas, ref.kind == "canvas" {
                    CanvasEditorView(editor: canvas)
                        .id(canvas.ref.id)
                } else {
                    ArtifactWebView(url: url, focusToken: center.focusToken)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: presenting ? 0 : Radius.large, style: .continuous))
            .padding(.horizontal, presenting ? 0 : Spacing.l)
            .padding(.bottom, presenting ? 0 : Spacing.l)
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: ArtifactKindInfo.symbol(ref.kind))
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 32, height: 32)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(ref.title)
                    .font(TypeScale.panelTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(center.status ?? caption)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .contentTransition(.opacity)
                    .springAnimation(value: center.status)
            }
            Spacer(minLength: Spacing.m)
            if center.versions.count > 1 {
                versionMenu
            }
            if ref.kind != "canvas" {
                actionButton(kind: "browser", systemImage: "safari", help: "Abrir no navegador") {
                    Task { await center.openInBrowser() }
                }
                actionButton(kind: "pdf", systemImage: "arrow.down.doc", help: "Exportar PDF") {
                    Task { await center.exportPDF() }
                }
                RoundIconButton(systemImage: "play.rectangle", help: "Apresentar em tela cheia (⇧⌘F)") {
                    center.togglePresenting()
                }
            }
            moreMenu
            RoundIconButton(systemImage: "xmark", help: "Fechar (esc)") {
                center.close()
            }
        }
        .padding(.horizontal, Spacing.l)
        .frame(height: Metrics.headerHeight + Spacing.s)
    }

    private var caption: String {
        let base = ArtifactKindInfo.label(ref.kind)
        if ref.kind == "canvas" {
            return "\(base) · duplo clique cria uma caixa, Tab cria uma filha"
        }
        return ref.kind == "slides" ? "\(base) · use ← → para navegar" : base
    }

    private var versionMenu: some View {
        Menu {
            ForEach(center.versions.reversed(), id: \.n) { version in
                Button {
                    center.select(version: version.n)
                } label: {
                    if version.n == center.selectedVersion {
                        Label("Versão \(version.n)", systemImage: "checkmark")
                    } else {
                        Text("Versão \(version.n)")
                    }
                }
            }
        } label: {
            Text("v\(center.selectedVersion)")
                .font(TypeScale.captionStrong)
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.visible)
        .fixedSize()
        .padding(.horizontal, Spacing.m)
        .frame(height: 32)
        .background(Theme.surface, in: Capsule())
        .clickable()
        .help("Escolher versão")
    }

    private var moreMenu: some View {
        Menu {
            if ref.kind == "canvas" {
                Button("Exportar PNG") {
                    center.exportCanvas(pdf: false)
                }
                Button("Exportar PDF") {
                    center.exportCanvas(pdf: true)
                }
                Button("Copiar como Mermaid") {
                    center.copyMermaid()
                }
                Divider()
            }
            Button("Copiar link desta versão") {
                center.copyLink()
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 32, height: 32)
                .background(Theme.surface, in: Circle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .clickable()
        .help("Mais")
    }

    @ViewBuilder
    private func actionButton(kind: String, systemImage: String, help: String, action: @escaping () -> Void) -> some View {
        if center.busy == kind {
            ProgressView()
                .controlSize(.small)
                .frame(width: 32, height: 32)
        } else {
            RoundIconButton(systemImage: systemImage, help: help, action: action)
                .disabled(center.busy != nil)
        }
    }
}

struct LibrarySection: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    private var center: ArtifactCenter { .shared }

    var body: some View {
        let items = center.libraries[bot.id] ?? []
        VStack(alignment: .leading, spacing: Spacing.s) {
            SectionCaption(title: "Artefatos")
            if items.isEmpty {
                Text("Quando \(bot.name) montar uma apresentação, um dashboard, uma página ou um canvas, ele aparece aqui.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, Spacing.xs)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: Spacing.xxs) {
                    ForEach(items) { item in
                        LibraryRow(item: item) {
                            ArtifactCenter.shared.open(item.ref(botID: bot.id), client: model.client)
                        }
                    }
                }
            }
        }
        .task(id: "\(bot.id)#\(center.revision)") {
            await center.loadLibrary(botID: bot.id, client: model.client)
        }
    }
}

struct LibraryRow: View {
    let item: ArtifactSummary
    let open: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: Spacing.m) {
                Image(systemName: ArtifactKindInfo.symbol(item.kind))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 36, height: 36)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(item.title)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(Spacing.s)
            .background(hovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }

    private var subtitle: String {
        let base = ArtifactKindInfo.subtitle(kind: item.kind, version: item.version)
        guard let date = item.updatedDate else { return base }
        return "\(base) · \(date.formatted(.dateTime.day().month(.abbreviated).hour().minute()))"
    }
}
