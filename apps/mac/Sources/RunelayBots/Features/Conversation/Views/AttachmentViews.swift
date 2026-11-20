import AVFoundation
import AVKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct ComposerAttachmentStrip: View {
    let store: ConversationStore
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .center, spacing: Spacing.s) {
                ForEach(store.composerAttachments) { attachment in
                    ComposerAttachmentChip(attachment: attachment) {
                        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                            store.removeAttachment(attachment)
                        }
                    } retry: {
                        store.retryUpload(attachment)
                    }
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.85).combined(with: .opacity))
                }
            }
            .padding(.horizontal, Spacing.m)
        }
        .frame(height: ComposerAttachmentChip.height)
        .springAnimation(value: store.composerAttachments.map(\.id))
    }
}

struct ComposerAttachmentChip: View {
    static let height: CGFloat = 44
    let attachment: ComposerAttachment
    let remove: () -> Void
    let retry: () -> Void
    @State private var hovering = false

    var body: some View {
        content
            .overlay {
                if case .uploading(let fraction) = attachment.state {
                    UploadRing(fraction: fraction)
                        .transition(.opacity)
                } else if attachment.isFailed {
                    failedOverlay
                        .transition(.opacity)
                }
            }
            .overlay(alignment: .topTrailing) {
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 16, height: 16)
                        .background(.black.opacity(0.55), in: Circle())
                }
                .buttonStyle(PressableButtonStyle())
                .padding(3)
                .opacity(hovering || attachment.isFailed ? 1 : 0.8)
                .help("Remover")
                .accessibilityLabel("Remover \(attachment.name)")
            }
            .onHover { hovering = $0 }
            .springAnimation(value: attachment.state)
            .help(attachment.name)
    }

    @ViewBuilder
    private var content: some View {
        switch attachment.kind {
        case .image:
            thumbnail(attachment.preview)
        case .video:
            thumbnail(attachment.preview)
                .overlay(alignment: .bottomLeading) {
                    HStack(spacing: 2) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 7, weight: .bold))
                        if let duration = attachment.duration {
                            Text(AttachmentFormat.clock(duration))
                                .font(TypeScale.caption.monospacedDigit())
                        }
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(.black.opacity(0.55), in: Capsule())
                    .padding(3)
                }
        case .audio:
            HStack(spacing: Spacing.s) {
                Image(systemName: "waveform")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.brandText)
                WaveformBars(levels: attachment.waveform, progress: 0, barCount: 18, height: 18)
                    .frame(width: 72)
                Text(attachment.duration.map(AttachmentFormat.clock) ?? "--:--")
                    .font(TypeScale.caption.monospacedDigit())
                    .foregroundStyle(Theme.textSecondary)
            }
            .padding(.leading, Spacing.m)
            .padding(.trailing, Spacing.m + 18)
            .frame(height: Self.height)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        case .file:
            HStack(spacing: Spacing.s) {
                if let icon = attachment.preview {
                    Image(nsImage: icon)
                        .resizable()
                        .frame(width: 24, height: 24)
                } else {
                    Image(systemName: "doc")
                        .font(.system(size: 18))
                        .foregroundStyle(Theme.textSecondary)
                }
                Text(attachment.name)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 150, alignment: .leading)
            }
            .padding(.leading, Spacing.s + 2)
            .padding(.trailing, Spacing.m + 18)
            .frame(height: Self.height)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
    }

    private func thumbnail(_ image: NSImage?) -> some View {
        ZStack {
            Theme.surfaceRaised
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(width: Self.height, height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }

    private var failedOverlay: some View {
        Button(action: retry) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.background.opacity(0.8), in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .help("Não foi. Clique para tentar de novo.")
    }
}

struct UploadRing: View {
    let fraction: Double

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                .fill(Theme.background.opacity(0.45))
            Circle()
                .stroke(Theme.textTertiary.opacity(0.35), lineWidth: 2.5)
                .frame(width: 18, height: 18)
            Circle()
                .trim(from: 0, to: max(0.04, fraction))
                .stroke(Theme.brandAccent, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .frame(width: 18, height: 18)
                .animation(Motion.spring, value: fraction)
        }
        .allowsHitTesting(false)
        .accessibilityLabel("Enviando, \(Int(fraction * 100))%")
    }
}

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
    @State private var previewURL: URL?
    @State private var previewItems: [URL] = []
    @State private var opening: String?
    @State private var saving: String?

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: Spacing.s) {
            let images = attachments.filter { $0.kind == .image }
            if !images.isEmpty {
                ImageGrid(images: images, trailing: trailing, opening: opening) { ref in
                    open(ref, among: images)
                }
            }
            ForEach(attachments.filter { $0.kind == .video }) { ref in
                InlineVideo(ref: ref)
            }
            ForEach(attachments.filter { $0.kind == .audio }) { ref in
                AudioAttachmentPlayer(ref: ref)
            }
            ForEach(attachments.filter { $0.kind == .file }) { ref in
                FileAttachmentCard(ref: ref, loading: opening == ref.id || saving == ref.id, open: {
                    open(ref, among: [ref])
                }, save: {
                    save(ref)
                })
            }
        }
        .frame(maxWidth: BubbleShape.maxWidth, alignment: trailing ? .trailing : .leading)
        .quickLookPreview($previewURL, in: previewItems)
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
                model.showNotice("Não consegui abrir \(ref.name).")
                return
            }
            previewItems = urls
            previewURL = selected
        }
    }

    private func save(_ ref: AttachmentRef) {
        guard saving == nil else { return }
        let client = model.client
        saving = ref.id
        Task {
            defer { saving = nil }
            guard let local = await localFile(ref, client: client) else {
                model.showNotice("Não consegui baixar \(ref.name).")
                return
            }
            do {
                let saved = try DownloadsFolder.copy(local, as: ref.name)
                DownloadsFolder.reveal(saved)
            } catch {
                BlocksLog.failure("save attachment to Downloads", error)
                model.showNotice("Não consegui salvar \(ref.name) em Downloads.")
            }
        }
    }

    private func localFile(_ ref: AttachmentRef, client: BotsClient) async -> URL? {
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
        .help(ref.name)
        .accessibilityLabel("Imagem \(ref.name)")
    }
}

struct InlineVideo: View {
    @Environment(AppModel.self) private var model
    let ref: AttachmentRef
    @State private var player: AVPlayer?

    var body: some View {
        let width: CGFloat = min(320, 220 * max(1, ref.aspectRatio))
        let height = width / min(2.2, max(0.5, ref.aspectRatio))
        ZStack {
            if let player {
                VideoPlayer(player: player)
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
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
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
                    guard let url = AttachmentPasteboard.writeTemporary(png, name: "Imagem.png") else { return }
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
        panel.prompt = "Anexar"
        panel.message = "Escolha imagens, vídeos, áudios ou arquivos"
        panel.begin { response in
            guard response == .OK else { return }
            let urls = panel.urls
            Task { @MainActor in
                store.attachFiles(urls)
            }
        }
    }
}
