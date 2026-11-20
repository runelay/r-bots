import AppKit
import SwiftUI
import WebKit

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
        if ServerStore.isServerKind(ref.kind) {
            ServerCard(ref: ref)
        } else if BlockKind.isBlockKind(ref.kind) {
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
            if let ref = center.current, !center.isBlock, center.presenting, let url = center.currentURL {
                ZStack {
                    Color.black
                        .ignoresSafeArea()
                    ArtifactSurface(ref: ref, url: url, presenting: true)
                    Button("Sair da apresentação") {
                        center.togglePresenting()
                    }
                    .keyboardShortcut(.cancelAction)
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
                    Button("Apresentar") {
                        center.togglePresenting()
                    }
                    .keyboardShortcut("p", modifiers: [.command, .option])
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
                }
                .transition(.opacity)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: center.presenting)
    }
}

struct ArtifactSurface: View {
    let ref: ArtifactRef
    let url: URL
    let presenting: Bool

    private var center: ArtifactCenter { .shared }

    var body: some View {
        Group {
            if let canvas = center.canvas, ref.kind == "canvas" {
                CanvasEditorView(editor: canvas)
                    .id(canvas.ref.id)
            } else {
                ArtifactWebView(url: url, focusToken: center.focusToken)
            }
        }
        .background(presenting ? Color.black : Theme.background)
    }
}

struct ArtifactPanel: View {
    let ref: ArtifactRef

    private var center: ArtifactCenter { .shared }

    var body: some View {
        VStack(spacing: 0) {
            ArtifactPanelHeader(ref: ref)
                .zIndex(1)
            if let url = center.currentURL {
                ArtifactSurface(ref: ref, url: url, presenting: false)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Color.clear
            }
        }
    }
}

struct ArtifactPanelHeader: View {
    @Environment(AppModel.self) private var model
    let ref: ArtifactRef

    private var center: ArtifactCenter { .shared }
    private var presentation: BlockPresentation { .shared }

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Text(center.current?.title ?? ref.title)
                .font(TypeScale.rowSubtitle.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(center.current?.title ?? ref.title)
            if center.versions.count > 1 {
                versionMenu
            }
            Spacer(minLength: Spacing.m)
            if let status = center.status {
                Text(status)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.trailing, Spacing.xs)
                    .transition(.opacity)
            }
            if ref.kind != "canvas" {
                exportMenu
                    .padding(.trailing, Spacing.xs)
                BlockHeaderButton(systemImage: "play.rectangle", help: ref.kind == "slides" ? "Apresentar  ⌥⌘P" : "Ver em tela cheia  ⌥⌘P") {
                    center.togglePresenting()
                }
                .background {
                    Button("Apresentar") {
                        center.togglePresenting()
                    }
                    .keyboardShortcut("p", modifiers: [.command, .option])
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
                }
            }
            BlockHeaderButton(
                systemImage: presentation.fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                help: presentation.fullScreen ? "Voltar ao painel  ⇧⌘F" : "Tela cheia  ⇧⌘F",
                isActive: presentation.fullScreen
            ) {
                presentation.toggleFullScreen()
            }
            moreMenu
            BlockHeaderButton(systemImage: "xmark", help: "Fechar") {
                presentation.close()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 44)
        .springAnimation(value: center.status)
    }

    private var versionMenu: some View {
        GlassSelect(
            options: center.versions.reversed().map { GlassSelectOption("Versão \($0.n)", value: $0.n) },
            selection: Binding(
                get: { center.selectedVersion },
                set: { center.select(version: $0) }
            ),
            title: "v\(center.selectedVersion)",
            help: "Escolher versão",
            edge: .leading,
            minWidth: 160
        )
        .fixedSize()
    }

    private var exportMenu: some View {
        GlassMenuButton(edge: .trailing, help: "Exportar", items: {
            [
                GlassMenuItem("PDF", systemImage: "arrow.down.doc") {
                    Task { await center.exportPDF() }
                },
                GlassMenuItem("Abrir no navegador", systemImage: "safari") {
                    Task { await center.openInBrowser() }
                },
            ]
        }) { _ in
            HStack(spacing: Spacing.xs) {
                if center.busy != nil {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "arrow.down.to.line")
                        .font(.system(size: 11, weight: .semibold))
                }
                Text("Exportar")
                    .font(TypeScale.captionStrong)
                    .lineLimit(1)
                    .fixedSize()
            }
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, Spacing.m)
            .frame(height: 28)
            .glassSurface(Capsule(), interactive: true)
        }
        .fixedSize()
        .disabled(center.busy != nil)
        .blockTooltip("Baixar como arquivo")
    }

    private var moreMenu: some View {
        GlassMenuButton(edge: .trailing, help: "Mais", items: { moreItems }) { isOpen in
            BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen)
        }
        .fixedSize()
        .blockTooltip("Mais")
    }

    private var moreItems: [GlassMenuItem] {
        var items: [GlassMenuItem] = []
        if ref.kind == "canvas" {
            items += [
                GlassMenuItem("Exportar PNG", systemImage: "photo") { center.exportCanvas(pdf: false) },
                GlassMenuItem("Exportar PDF", systemImage: "doc.richtext") { center.exportCanvas(pdf: true) },
                GlassMenuItem("Copiar como Mermaid", systemImage: "chevron.left.forwardslash.chevron.right") { center.copyMermaid() },
            ]
        }
        items.append(GlassMenuItem("Copiar link desta versão", systemImage: "link", startsSection: !items.isEmpty) { center.copyLink() })
        if let botID = center.current?.botID {
            let client = model.client
            items.append(GlassMenuItem("Todos os arquivos", systemImage: "square.stack") {
                ArtifactCenter.shared.openFiles(botID: botID, client: client)
            })
        }
        return items
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
