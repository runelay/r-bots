import AVFoundation
import AVKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct WaveformBars: View {
    let levels: [Double]
    let progress: Double
    var barCount = 32
    var height: CGFloat = 24

    var body: some View {
        GeometryReader { geometry in
            let values = sampled
            let spacing: CGFloat = 2
            let width = max(1.5, (geometry.size.width - spacing * CGFloat(values.count - 1)) / CGFloat(values.count))
            HStack(alignment: .center, spacing: spacing) {
                ForEach(values.indices, id: \.self) { index in
                    Capsule()
                        .fill(Double(index) / Double(values.count) < progress ? Theme.brandAccent : Theme.textTertiary.opacity(0.55))
                        .frame(width: width, height: max(3, CGFloat(values[index]) * height))
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: height)
    }

    private var sampled: [Double] {
        guard !levels.isEmpty else { return Array(repeating: 0.25, count: barCount) }
        return (0..<barCount).map { index in
            let start = index * levels.count / barCount
            let end = max(start + 1, (index + 1) * levels.count / barCount)
            let slice = levels[start..<min(end, levels.count)]
            return max(0.12, slice.max() ?? 0)
        }
    }
}

struct MessageAttachments: View {
    @Environment(AppModel.self) private var model
    let attachments: [AttachmentRef]
    let trailing: Bool
    @State private var opening: String?
    @State private var saving: String?

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: Spacing.s) {
            let images = attachments.filter { $0.kind == .image }
            if !images.isEmpty {
                ImageGrid(
                    images: images,
                    trailing: trailing,
                    opening: opening,
                    open: { ref in open(ref, among: images) },
                    copy: { ref in copy(ref) },
                    save: { ref in save(ref) },
                    openExternally: { ref in openExternally(ref) }
                )
            }
            ForEach(attachments.filter { $0.kind == .video }) { ref in
                InlineVideo(ref: ref, saving: saving == ref.id) {
                    save(ref)
                }
            }
            ForEach(attachments.filter { $0.kind == .audio }) { ref in
                AudioAttachmentPlayer(ref: ref)
            }
            ForEach(attachments.filter { $0.kind == .file }) { ref in
                FileAttachmentCard(
                    ref: ref, loading: opening == ref.id || saving == ref.id,
                    open: {
                        open(ref, among: [ref])
                    },
                    save: {
                        save(ref)
                    })
            }
        }
        .frame(maxWidth: BubbleShape.maxWidth, alignment: trailing ? .trailing : .leading)
    }

    private func copy(_ ref: AttachmentRef) {
        let client = model.client
        Task {
            guard let local = await localFile(ref, client: client) else {
                model.showNotice(tr("Não consegui baixar %@.", ref.name))
                return
            }
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            var objects: [NSPasteboardWriting] = []
            if let image = NSImage(contentsOf: local) {
                objects.append(image)
            }
            objects.append(local as NSURL)
            pasteboard.writeObjects(objects)
            model.showNotice(tr("Imagem copiada."))
        }
    }

    private func openExternally(_ ref: AttachmentRef) {
        let client = model.client
        Task {
            guard let local = await localFile(ref, client: client) else {
                model.showNotice(tr("Não consegui abrir %@.", ref.name))
                return
            }
            NSWorkspace.shared.open(local)
        }
    }

    private func open(_ ref: AttachmentRef, among group: [AttachmentRef]) {
        let client = model.client
        opening = ref.id
        Task {
            var urls: [URL] = []
            var selected: URL?
            for item in group {
                guard let local = await localFile(item, client: client) else { continue }
                urls.append(local)
                if item.id == ref.id {
                    selected = local
                }
            }
            opening = nil
            guard let selected else {
                model.showNotice(tr("Não consegui abrir %@.", ref.name))
                return
            }
            QuickLookPanel.shared.show(urls, selected: selected)
        }
    }

    private func save(_ ref: AttachmentRef) {
        guard saving == nil else { return }
        let client = model.client
        saving = ref.id
        Task {
            defer { saving = nil }
            guard let local = await localFile(ref, client: client) else {
                model.showNotice(tr("Não consegui baixar %@.", ref.name))
                return
            }
            do {
                let saved = try DownloadsFolder.copy(local, as: ref.name)
                DownloadsFolder.reveal(saved)
            } catch {
                BlocksLog.failure("save attachment to Downloads", error)
                model.showNotice(tr("Não consegui salvar %@ em Downloads.", ref.name))
            }
        }
    }

    private func localFile(_ ref: AttachmentRef, client: BotsClient) async -> URL? {
        await AttachmentOpening.localFile(ref, client: client)
    }
}

enum AttachmentOpening {
    @MainActor
    static func localFile(_ ref: AttachmentRef, client: BotsClient) async -> URL? {
        guard let remote = client.absoluteURL(ref.url) else {
            BlocksLog.logger.error("attachment \(ref.id, privacy: .public) has no usable URL")
            return nil
        }
        do {
            return try await AttachmentFileCache.shared.localFile(for: ref, remote: remote)
        } catch {
            BlocksLog.failure("attachment download \(remote.path)", error)
            return nil
        }
    }
}

struct ImageGrid: View {
    @Environment(AppModel.self) private var model
    let images: [AttachmentRef]
    let trailing: Bool
    let opening: String?
    let open: (AttachmentRef) -> Void
    var copy: (AttachmentRef) -> Void = { _ in }
    var save: (AttachmentRef) -> Void = { _ in }
    var openExternally: (AttachmentRef) -> Void = { _ in }

    var body: some View {
        if images.count == 1, let ref = images.first {
            tile(ref)
                .frame(width: singleSize(ref).width, height: singleSize(ref).height)
        } else {
            let columns = images.count == 2 || images.count == 4 ? 2 : 3
            let side: CGFloat = columns == 2 ? 132 : 100
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(side), spacing: 4), count: columns), alignment: trailing ? .trailing : .leading, spacing: 4) {
                ForEach(images) { ref in
                    tile(ref)
                        .frame(width: side, height: side)
                }
            }
            .fixedSize()
        }
    }

    private func singleSize(_ ref: AttachmentRef) -> CGSize {
        let ratio = min(2.2, max(0.5, ref.aspectRatio))
        let maxSide: CGFloat = 280
        return ratio >= 1 ? CGSize(width: maxSide, height: maxSide / ratio) : CGSize(width: maxSide * ratio, height: maxSide)
    }

    private func tile(_ ref: AttachmentRef) -> some View {
        Button {
            open(ref)
        } label: {
            ZStack {
                Theme.surfaceRaised
                AsyncImage(url: model.client.absoluteURL(ref.thumbURL ?? ref.url), transaction: Transaction(animation: Motion.crossFade)) { phase in
                    if let image = phase.image {
                        image
                            .resizable()
                            .scaledToFill()
                            .transition(.opacity)
                    } else if phase.error != nil {
                        Image(systemName: "photo")
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                if opening == ref.id {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .contextMenu {
            Button("Copiar imagem") { copy(ref) }
            Button("Salvar em Downloads") { save(ref) }
            Button("Abrir no Pré-Visualização") { openExternally(ref) }
        }
        .help(ref.name)
        .accessibilityLabel("Imagem \(ref.name)")
    }
}

private struct PlayerSurface: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .floating
        view.videoGravity = .resizeAspect
        view.player = player
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
    }

    static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) {
        view.player?.pause()
        view.player = nil
    }
}

struct InlineVideo: View {
    @Environment(AppModel.self) private var model
    let ref: AttachmentRef
    var saving = false
    var save: (() -> Void)?
    @State private var player: AVPlayer?
    @State private var hovering = false

    var body: some View {
        let width: CGFloat = min(320, 220 * max(1, ref.aspectRatio))
        let height = width / min(2.2, max(0.5, ref.aspectRatio))
        ZStack {
            if let player {
                PlayerSurface(player: player)
                    .transition(.opacity)
            } else {
                Button {
                    guard let url = model.client.absoluteURL(ref.url) else { return }
                    let created = AVPlayer(url: url)
                    withAnimation(Motion.spring) {
                        player = created
                    }
                    created.play()
                } label: {
                    ZStack {
                        Theme.surfaceRaised
                        if let thumb = ref.thumbURL {
                            AsyncImage(url: model.client.absoluteURL(thumb)) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                Color.clear
                            }
                        }
                        Image(systemName: "play.fill")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 44, height: 44)
                            .background(.black.opacity(0.5), in: Circle())
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if let duration = ref.duration {
                            Text(AttachmentFormat.clock(duration))
                                .font(TypeScale.caption.monospacedDigit())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.black.opacity(0.55), in: Capsule())
                                .padding(6)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .clickable()
                .accessibilityLabel("Tocar vídeo \(ref.name)")
            }
        }
        .frame(width: width, height: height)
        .overlay(alignment: .topTrailing) {
            if let save, hovering || saving {
                Button(action: save) {
                    ZStack {
                        if saving {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        } else {
                            Image(systemName: "arrow.down.to.line")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(width: 28, height: 28)
                    .background(.black.opacity(0.55), in: Circle())
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .clickable()
                .disabled(saving)
                .help("Salvar em Downloads")
                .padding(6)
                .transition(.opacity)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .onHover { inside in
            withAnimation(Motion.spring) { hovering = inside }
        }
        .contextMenu {
            if let save {
                Button("Salvar em Downloads", action: save)
            }
        }
        .onDisappear {
            player?.pause()
        }
        .help(ref.name)
    }
}

@MainActor
@Observable
final class AudioPlaybackCenter {
    static let shared = AudioPlaybackCenter()
    private(set) var currentID: String?
    private(set) var isPlaying = false
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var observer: Any?
    @ObservationIgnored private var endObserver: NSObjectProtocol?

    func toggle(_ ref: AttachmentRef, url: URL) {
        if currentID == ref.id, let player {
            if isPlaying {
                player.pause()
                isPlaying = false
            } else {
                if duration > 0, position >= duration - 0.1 {
                    player.seek(to: .zero)
                }
                player.play()
                isPlaying = true
            }
            return
        }
        stop()
        let created = AVPlayer(url: url)
        player = created
        currentID = ref.id
        duration = ref.duration ?? 0
        position = 0
        observer = created.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                self?.position = time.seconds
                if let item = self?.player?.currentItem, item.duration.isNumeric {
                    self?.duration = item.duration.seconds
                }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: created.currentItem, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.isPlaying = false
                self?.position = self?.duration ?? 0
            }
        }
        created.play()
        isPlaying = true
    }

    func seek(_ ref: AttachmentRef, fraction: Double) {
        guard currentID == ref.id, let player, duration > 0 else { return }
        let target = duration * min(1, max(0, fraction))
        position = target
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
    }

    func stop() {
        player?.pause()
        if let observer {
            player?.removeTimeObserver(observer)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        observer = nil
        endObserver = nil
        player = nil
        currentID = nil
        isPlaying = false
        position = 0
    }
}

struct AudioAttachmentPlayer: View {
    @Environment(AppModel.self) private var model
    let ref: AttachmentRef
    private let center = AudioPlaybackCenter.shared

    var body: some View {
        let active = center.currentID == ref.id
        let total = active && center.duration > 0 ? center.duration : (ref.duration ?? 0)
        let progress = active && total > 0 ? center.position / total : 0
        HStack(spacing: Spacing.s) {
            Button {
                guard let url = model.client.absoluteURL(ref.url) else { return }
                center.toggle(ref, url: url)
            } label: {
                Image(systemName: active && center.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Theme.onAccent)
                    .frame(width: 30, height: 30)
                    .background(Theme.brandAccent, in: Circle())
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel(active && center.isPlaying ? "Pausar" : "Tocar áudio")
            WaveformBars(levels: ref.waveform, progress: progress, barCount: 36, height: 24)
                .frame(width: 150)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0).onEnded { value in
                        center.seek(ref, fraction: value.location.x / 150)
                    }
                )
                .clickable()
            Text(AttachmentFormat.clock(active && center.position > 0 ? center.position : total))
                .font(TypeScale.caption.monospacedDigit())
                .foregroundStyle(Theme.textSecondary)
                .frame(minWidth: 32, alignment: .trailing)
        }
        .padding(.leading, Spacing.xs + 2)
        .padding(.trailing, Spacing.m)
        .padding(.vertical, Spacing.xs + 2)
        .background(Theme.surface, in: Capsule())
        .help(ref.name)
    }
}

struct FileAttachmentCard: View {
    let ref: AttachmentRef
    let loading: Bool
    let open: () -> Void
    var save: (() -> Void)?
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: Spacing.m) {
                Image(nsImage: NSWorkspace.shared.icon(for: UTType(filenameExtension: (ref.name as NSString).pathExtension) ?? .data))
                    .resizable()
                    .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ref.name)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(ref.sizeLabel)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                Spacer(minLength: 0)
                if loading {
                    ProgressView()
                        .controlSize(.small)
                } else if let save {
                    Button(action: save) {
                        Image(systemName: "arrow.down.to.line")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(hovering ? Theme.textPrimary : Theme.textTertiary)
                            .frame(width: 26, height: 26)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .clickable()
                    .help("Salvar em Downloads")
                }
            }
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, Spacing.s + 2)
            .frame(width: 260)
            .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .help("Abrir \(ref.name)")
    }
}

struct AttachmentDropOverlay: View {
    var body: some View {
        ZStack {
            Theme.background.opacity(0.82)
            VStack(spacing: Spacing.s) {
                Image(systemName: "paperclip")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Theme.brandText)
                Text("Solte para anexar")
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                Text("Imagem, vídeo, áudio ou arquivo")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .allowsHitTesting(false)
    }
}

enum AttachmentDrop {
    @MainActor
    static func handle(_ providers: [NSItemProvider], store: ConversationStore) -> Bool {
        var handled = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                handled = true
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in
                        store.attachFiles([url])
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                handled = true
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    let png = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) ?? data
                    guard let url = AttachmentPasteboard.writeTemporary(png, name: tr("Imagem.png")) else { return }
                    Task { @MainActor in
                        store.attachFiles([url], ownsFiles: true)
                    }
                }
            }
        }
        return handled
    }
}

enum AttachmentPicker {
    @MainActor
    static func choose(for store: ConversationStore) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.prompt = tr("Anexar")
        panel.message = tr("Escolha imagens, vídeos, áudios ou arquivos")
        panel.begin { response in
            guard response == .OK else { return }
            let urls = panel.urls
            Task { @MainActor in
                store.attachFiles(urls)
            }
        }
    }
}
