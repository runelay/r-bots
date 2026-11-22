import AppKit
import SwiftUI

struct WebPagePanel: View {
    let ref: ArtifactRef

    @State private var navigator = WebNavigator()

    private var store: WebPageStore { .shared }
    private var presentation: BlockPresentation { .shared }
    private var pageURL: URL? { navigator.url ?? store.url }

    private var title: String {
        if let title = navigator.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            return title
        }
        return WebPageStore.host(of: pageURL)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .zIndex(1)
            WebPageAddressBar(navigator: navigator, url: pageURL)
            if let url = store.url {
                ArtifactWebView(url: url, browsing: true, navigator: navigator)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Color.clear
            }
        }
        .background {
            Button("Recarregar") {
                navigator.reload()
            }
            .keyboardShortcut("r", modifiers: .command)
            .opacity(0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .onChange(of: store.reloadRequest) { _, _ in
            if let url = store.url {
                navigator.load(url)
            }
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: "globe")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 18)
            Text(title)
                .font(TypeScale.rowSubtitle.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(title)
            Spacer(minLength: Spacing.m)
            BlockHeaderButton(systemImage: "safari", help: tr("Abrir no navegador")) {
                if let pageURL {
                    NSWorkspace.shared.open(pageURL)
                }
            }
            BlockHeaderButton(
                systemImage: presentation.fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                help: presentation.fullScreen ? tr("Voltar ao painel  ⇧⌘F") : tr("Tela cheia  ⇧⌘F"),
                isActive: presentation.fullScreen
            ) {
                presentation.toggleFullScreen()
            }
            BlockHeaderButton(systemImage: "xmark", help: tr("Fechar")) {
                presentation.close()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 44)
    }
}

struct WebPageAddressBar: View {
    let navigator: WebNavigator
    let url: URL?

    private var display: String {
        guard let url else { return "" }
        return url.absoluteString.removingPercentEncoding ?? url.absoluteString
    }

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            navButton("chevron.left", help: tr("Voltar"), enabled: navigator.canGoBack) { navigator.goBack() }
            navButton("chevron.right", help: tr("Avançar"), enabled: navigator.canGoForward) { navigator.goForward() }
            BlockHeaderButton(systemImage: "arrow.clockwise", help: tr("Recarregar  ⌘R"), tipEdge: .leading) {
                navigator.reload()
            }
            field
                .padding(.leading, Spacing.xs)
        }
        .padding(.horizontal, Spacing.m)
        .padding(.bottom, Spacing.s)
        .overlay(alignment: .bottomLeading) {
            GeometryReader { proxy in
                Capsule()
                    .fill(Theme.brandAccent)
                    .frame(width: proxy.size.width * max(0.05, navigator.progress), height: 2)
                    .opacity(navigator.isLoading ? 1 : 0)
                    .animation(Motion.spring, value: navigator.progress)
                    .animation(Motion.spring, value: navigator.isLoading)
            }
            .frame(height: 2)
        }
    }

    private var field: some View {
        HStack(spacing: Spacing.xs) {
            Text(verbatim: display)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(display)
                .accessibilityLabel("Endereço da página")
            Button(action: copy) {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .blockTooltip(tr("Copiar endereço"), edge: .trailing)
            .accessibilityLabel("Copiar endereço")
        }
        .padding(.leading, Spacing.m)
        .padding(.trailing, Spacing.xs)
        .frame(height: 28)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .contextMenu {
            Button("Copiar endereço", action: copy)
            Button("Abrir no navegador") {
                if let url {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    private func navButton(_ systemImage: String, help: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        BlockHeaderButton(systemImage: systemImage, help: help, tipEdge: .leading, action: action)
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.35)
            .springAnimation(value: enabled)
    }

    private func copy() {
        guard let url else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
}
