import SwiftUI

struct SpotifyMiniPlayer: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    private let player = SpotifyPlayer.shared

    var body: some View {
        content
            .padding(.horizontal, Spacing.l)
            .padding(.top, player.phase == .unavailable ? 0 : Spacing.s)
            .animation(Motion.animation(reduceMotion: reduceMotion), value: player.phase)
    }

    @ViewBuilder
    private var content: some View {
        switch player.phase {
        case .unavailable:
            EmptyView()
        case .closed:
            SpotifySlimRow(title: "Abrir Spotify", systemImage: nil) {
                player.openSpotify()
            }
            .transition(Motion.insertion(reduceMotion: reduceMotion))
        case .denied:
            SpotifySlimRow(title: "Permitir controle do Spotify", systemImage: "lock") {
                player.openAutomationSettings()
            }
            .transition(Motion.insertion(reduceMotion: reduceMotion))
        case .idle, .track:
            SpotifyNowPlayingCard(player: player)
                .transition(Motion.insertion(reduceMotion: reduceMotion))
        }
    }
}

private struct SpotifyNowPlayingCard: View {
    let player: SpotifyPlayer

    var body: some View {
        VStack(spacing: Spacing.s) {
            HStack(spacing: Spacing.s + Spacing.xxs) {
                Button {
                    player.openSpotify()
                } label: {
                    HStack(spacing: Spacing.s + Spacing.xxs) {
                        SpotifyArtwork(image: player.artwork, key: player.artworkKey)
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Text(player.track?.name ?? "Nada tocando")
                                .font(TypeScale.captionStrong)
                                .foregroundStyle(Theme.textPrimary)
                            if let artist = player.track?.artist, !artist.isEmpty {
                                Text(artist)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .lineLimit(1)
                        .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle())
                .help("Abrir o Spotify")

                HStack(spacing: Spacing.xxs) {
                    SpotifyControlButton(systemImage: "backward.fill", help: "Anterior") {
                        player.previousTrack()
                    }
                    SpotifyPlayButton(isPlaying: player.isPlaying) {
                        player.togglePlayback()
                    }
                    SpotifyControlButton(systemImage: "forward.fill", help: "Próxima") {
                        player.nextTrack()
                    }
                }
            }
            if player.track != nil {
                SpotifyProgressBar(player: player)
            }
        }
        .padding(Spacing.s)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }
}

private struct SpotifyArtwork: View {
    let image: NSImage?
    let key: String?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Theme.surfaceRaised)
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .id(key)
                    .transition(.opacity)
            } else {
                SpotifyMark(size: 16)
            }
        }
        .frame(width: 40, height: 40)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .animation(Motion.crossFade, value: key)
    }
}

private struct SpotifyProgressBar: View {
    let player: SpotifyPlayer

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.25, paused: !player.isPlaying)) { context in
            let duration = player.track?.duration ?? 0
            let fraction = duration > 0 ? player.elapsed(at: context.date) / duration : 0
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.selection)
                    Capsule()
                        .fill(Theme.spotify)
                        .frame(width: proxy.size.width * fraction)
                }
            }
            .frame(height: 3)
        }
        .padding(.horizontal, Spacing.xxs)
        .accessibilityHidden(true)
    }
}

private struct SpotifyPlayButton: View {
    let isPlaying: Bool
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Theme.onAccent)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 30, height: 30)
                .background(Theme.textPrimary, in: Circle())
                .scaleEffect(isHovering ? 1.06 : 1)
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isPlaying)
        .help(isPlaying ? "Pausar" : "Tocar")
        .accessibilityLabel(isPlaying ? "Pausar" : "Tocar")
    }
}

private struct SpotifyControlButton: View {
    let systemImage: String
    let help: String
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 24, height: 24)
                .background(isHovering ? Theme.hover : .clear, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

private struct SpotifySlimRow: View {
    let title: String
    let systemImage: String?
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.s) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 16, height: 16)
                } else {
                    SpotifyMark(size: 16)
                }
                Text(title)
                    .font(TypeScale.captionStrong)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textSecondary)
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, Spacing.s)
            .background(isHovering ? Theme.surface : .clear, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
    }
}

private struct SpotifyMark: View {
    let size: CGFloat

    var body: some View {
        Canvas { context, canvasSize in
            let rect = CGRect(origin: .zero, size: canvasSize)
            context.fill(Path(ellipseIn: rect), with: .color(Theme.spotify))
            let width = canvasSize.width
            let arcs: [(y: CGFloat, span: CGFloat, bend: CGFloat, line: CGFloat)] = [
                (0.36, 0.56, 0.10, 0.11),
                (0.53, 0.48, 0.08, 0.09),
                (0.68, 0.40, 0.06, 0.075),
            ]
            for arc in arcs {
                let start = CGPoint(x: width * (0.5 - arc.span / 2), y: width * arc.y)
                let end = CGPoint(x: width * (0.5 + arc.span / 2) + width * 0.02, y: width * (arc.y + 0.02))
                let control = CGPoint(x: width * 0.5, y: width * (arc.y - arc.bend))
                var path = Path()
                path.move(to: start)
                path.addQuadCurve(to: end, control: control)
                context.stroke(path, with: .color(Theme.spotifyMark), style: StrokeStyle(lineWidth: width * arc.line, lineCap: .round))
            }
        }
        .frame(width: size, height: size)
    }
}
