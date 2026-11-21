import QuickLook
import SwiftUI
import UIKit

@MainActor
final class AuthImageCache {
    static let shared = AuthImageCache()
    private var images: [URL: UIImage] = [:]

    func image(for url: URL) -> UIImage? { images[url] }

    func load(_ url: URL) async -> UIImage? {
        if let cached = images[url] { return cached }
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        AuthStore.authorize(&request)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let image = UIImage(data: data)
        else { return nil }
        images[url] = image
        return image
    }
}

struct AuthImage: View {
    let url: URL?
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Theme.surface
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .transition(.opacity)
            } else {
                ProgressView()
                    .controlSize(.mini)
            }
        }
        .task(id: url) {
            guard let url else { return }
            if let cached = AuthImageCache.shared.image(for: url) {
                image = cached
                return
            }
            let loaded = await AuthImageCache.shared.load(url)
            withAnimation(Motion.reduced) { image = loaded }
        }
    }
}

struct AttachmentPreviewer: ViewModifier {
    @Binding var opening: AttachmentRef?
    @State private var localURL: URL?
    @State private var failed = false
    let client: BotsClient

    func body(content: Content) -> some View {
        content
            .quickLookPreview($localURL)
            .task(id: opening?.id) {
                guard let ref = opening, let remote = client.absoluteURL(ref.url) else { return }
                if let file = try? await AttachmentFileCache.shared.localFile(for: ref, remote: remote) {
                    localURL = file
                } else {
                    failed = true
                }
                opening = nil
            }
            .alert("Não deu para abrir o arquivo.", isPresented: $failed) {
                Button("OK", role: .cancel) {}
            }
    }
}

struct MessageAttachments: View {
    let attachments: [AttachmentRef]
    let client: BotsClient
    var trailing = false
    let open: (AttachmentRef) -> Void

    var body: some View {
        let images = attachments.filter { $0.kind == .image || $0.kind == .video }
        let others = attachments.filter { $0.kind != .image && $0.kind != .video }
        VStack(alignment: trailing ? .trailing : .leading, spacing: Spacing.xs) {
            if !images.isEmpty {
                imageGrid(images)
            }
            ForEach(others) { ref in
                if ref.kind == .audio {
                    AudioBubble(ref: ref, client: client, fromUser: trailing)
                } else {
                    Button {
                        open(ref)
                    } label: {
                        FileCard(ref: ref)
                    }
                    .buttonStyle(RowButtonStyle())
                }
            }
        }
    }

    private func imageGrid(_ images: [AttachmentRef]) -> some View {
        let columns = images.count == 1 ? 1 : 2
        let side: CGFloat = images.count == 1 ? 240 : 118
        return LazyVGrid(columns: Array(repeating: GridItem(.fixed(side), spacing: 4), count: columns), spacing: 4) {
            ForEach(images) { ref in
                Button {
                    open(ref)
                } label: {
                    AuthImage(url: client.absoluteURL(ref.thumbURL ?? ref.url))
                        .frame(width: side, height: images.count == 1 ? side / max(ref.aspectRatio, 0.6) : side)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                        .overlay {
                            if ref.kind == .video {
                                Image(systemName: "play.fill")
                                    .font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .frame(width: 44, height: 44)
                                    .glassEffect(.regular, in: Circle())
                            }
                        }
                }
                .buttonStyle(RowButtonStyle())
            }
        }
        .fixedSize()
    }
}

struct FileCard: View {
    let ref: AttachmentRef

    private var symbol: String {
        switch ref.kind {
        case .audio: "waveform"
        case .video: "play.rectangle"
        case .image: "photo"
        case .file: ref.mime.contains("pdf") ? "doc.richtext" : "doc"
        }
    }

    var body: some View {
        HStack(spacing: Spacing.m) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.brandText)
                .frame(width: 36, height: 36)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(ref.kind == .audio ? "Mensagem de áudio" : ref.name)
                    .font(BrandFonts.sans(14, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(ref.kind == .audio ? AttachmentFormat.clock(ref.duration ?? 0) : ref.sizeLabel)
                    .font(TypeScale.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
            }
            if ref.kind == .audio, !ref.waveform.isEmpty {
                Waveform(levels: ref.waveform.map { CGFloat($0) }, color: Theme.textTertiary)
                    .frame(width: 72, height: 20)
            }
        }
        .padding(.leading, Spacing.s)
        .padding(.trailing, Spacing.m)
        .padding(.vertical, Spacing.s)
        .frame(maxWidth: 280, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

struct Waveform: View {
    let levels: [CGFloat]
    var color: Color = Theme.textSecondary

    var body: some View {
        GeometryReader { geometry in
            let count = max(levels.count, 1)
            let spacing: CGFloat = 2
            let width = max((geometry.size.width - spacing * CGFloat(count - 1)) / CGFloat(count), 1)
            HStack(alignment: .center, spacing: spacing) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule()
                        .fill(color)
                        .frame(width: width, height: max(geometry.size.height * min(max(level, 0.08), 1), 2))
                }
            }
            .frame(maxHeight: .infinity)
        }
    }
}

struct ComposerChip: View {
    let attachment: ComposerAttachment
    let client: BotsClient
    let remove: () -> Void
    let retry: () -> Void

    var body: some View {
        HStack(spacing: Spacing.s) {
            leading
                .frame(width: 32, height: 32)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.kind == .audio ? "Áudio" : attachment.name)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(status)
                    .font(TypeScale.caption)
                    .foregroundStyle(attachment.isFailed ? Theme.danger : Theme.textTertiary)
                    .lineLimit(1)
            }
            .frame(maxWidth: 120, alignment: .leading)
            Button(action: attachment.isFailed ? retry : remove) {
                Image(systemName: attachment.isFailed ? "arrow.clockwise" : "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 22, height: 22)
                    .background(Theme.surfaceRaised, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(attachment.isFailed ? "Tentar de novo" : "Remover anexo")
        }
        .padding(Spacing.xs + 2)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium + 2, style: .continuous))
    }

    private var status: String {
        switch attachment.state {
        case .uploading(let progress): progress > 0 ? "Enviando \(Int(progress * 100))%" : "Enviando…"
        case .ready: attachment.sizeLabel
        case .failed: "Falhou · tocar para repetir"
        }
    }

    @ViewBuilder
    private var leading: some View {
        if attachment.kind == .image, let ref = attachment.ref {
            AuthImage(url: client.absoluteURL(ref.thumbURL ?? ref.url))
        } else if attachment.kind == .image, let image = UIImage(contentsOfFile: attachment.fileURL.path) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            Image(systemName: attachment.kind == .audio ? "waveform" : (attachment.kind == .video ? "play.rectangle" : "doc"))
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.brandText)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.surfaceRaised)
        }
    }
}
