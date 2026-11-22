import AppKit
import SwiftUI

enum PreviewAddress {
    static func location(of url: URL?) -> String {
        guard let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "/" }
        var path = components.percentEncodedPath
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        if parts.first == "preview", parts.count >= 3 {
            let rest = parts.dropFirst(3).joined(separator: "/")
            path = "/" + rest + (rest.isEmpty || !path.hasSuffix("/") ? "" : "/")
            let items = components.queryItems?.filter { $0.name != "t" } ?? []
            components.queryItems = items.isEmpty ? nil : items
        }
        var text = path.isEmpty ? "/" : path
        if let query = components.percentEncodedQuery, !query.isEmpty { text += "?" + query }
        if let fragment = components.percentEncodedFragment, !fragment.isEmpty { text += "#" + fragment }
        return text
    }

    static func host(port: Int) -> String {
        "localhost:\(port)"
    }

    static func display(_ location: String, port: Int) -> String {
        host(port: port) + (location.removingPercentEncoding ?? location)
    }

    static func shareable(_ location: String, port: Int) -> String {
        "http://" + host(port: port) + location
    }

    static func normalize(_ input: String) -> String? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        for scheme in ["http://", "https://"] where text.lowercased().hasPrefix(scheme) {
            text = String(text.dropFirst(scheme.count))
        }
        if !text.hasPrefix("/") {
            let end = text.firstIndex(where: { "/?#".contains($0) }) ?? text.endIndex
            let head = text[..<end].lowercased()
            if head.hasPrefix("localhost") || head.hasPrefix("127.0.0.1") || head.hasPrefix("0.0.0.0") || head.contains(":") {
                text = String(text[end...])
            }
        }
        if !text.hasPrefix("/") { text = "/" + text }
        if URL(string: text) != nil { return text }
        var allowed = CharacterSet.urlQueryAllowed
        allowed.insert("#")
        return text.addingPercentEncoding(withAllowedCharacters: allowed)
    }

    static func pageURL(_ location: String, base: URL) -> URL? {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.percentEncodedPath = ""
        components.percentEncodedQuery = nil
        components.percentEncodedFragment = nil
        guard let origin = components.url else { return nil }
        return URL(string: location, relativeTo: origin)?.absoluteURL
    }

    static func proxyURL(root: URL, location: String) -> URL? {
        guard var components = URLComponents(url: root, resolvingAgainstBaseURL: false),
            let target = URLComponents(string: location)
        else { return nil }
        var prefix = components.percentEncodedPath
        while prefix.hasSuffix("/") { prefix.removeLast() }
        components.percentEncodedPath = prefix + (target.percentEncodedPath.isEmpty ? "/" : target.percentEncodedPath)
        return components.url
    }
}

struct PreviewAddressBar: View {
    let navigator: WebNavigator
    let server: DevServerInfo
    let root: URL
    var focusRequest = 0
    let reload: () -> Void

    @State private var draft = ""
    @FocusState private var editing: Bool

    private var location: String { PreviewAddress.location(of: navigator.url) }
    private var display: String { PreviewAddress.display(location, port: server.port) }

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            navButton("chevron.left", help: tr("Voltar"), enabled: navigator.canGoBack) { navigator.goBack() }
            navButton("chevron.right", help: tr("Avançar"), enabled: navigator.canGoForward) { navigator.goForward() }
            BlockHeaderButton(systemImage: "arrow.clockwise", help: tr("Recarregar"), tipEdge: .leading) {
                if navigator.isAttached {
                    navigator.reload()
                } else {
                    reload()
                }
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
            TextField("", text: Binding(get: { editing ? draft : display }, set: { draft = $0 }))
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(editing ? Theme.textPrimary : Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .focused($editing)
                .onSubmit(submit)
                .onExitCommand {
                    draft = display
                    editing = false
                }
                .onChange(of: editing) { _, focused in
                    guard focused else { return }
                    draft = display
                    DispatchQueue.main.async {
                        NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
                    }
                }
                .accessibilityLabel("Endereço da prévia")
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
        .background(editing ? Theme.selection : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .contextMenu {
            Button("Copiar endereço", action: copy)
            Button("Abrir no navegador") {
                ServerStore.shared.openInBrowser(server, location: location)
            }
        }
        .springAnimation(value: editing)
        .onChange(of: focusRequest) { _, _ in
            editing = true
        }
    }

    private func navButton(_ systemImage: String, help: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        BlockHeaderButton(systemImage: systemImage, help: help, tipEdge: .leading, action: action)
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.35)
            .springAnimation(value: enabled)
    }

    private func submit() {
        defer { editing = false }
        guard let next = PreviewAddress.normalize(draft),
            let target = PreviewAddress.pageURL(next, base: navigator.url ?? root)
        else { return }
        navigator.load(target)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(PreviewAddress.shareable(location, port: server.port), forType: .string)
    }
}
