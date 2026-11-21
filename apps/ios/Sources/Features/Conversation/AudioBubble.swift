import AVFoundation
import Observation
import SwiftUI

@MainActor
@Observable
final class AudioPlayback: NSObject, AVAudioPlayerDelegate {
    static let shared = AudioPlayback()

    private(set) var currentID: String?
    private(set) var loadingID: String?
    private(set) var isPlaying = false
    private(set) var progress: Double = 0
    private(set) var elapsed: Double = 0
    private(set) var failedID: String?

    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var ticker: Task<Void, Never>?

    func toggle(_ ref: AttachmentRef, client: BotsClient) {
        if currentID == ref.id, let player {
            if player.isPlaying {
                player.pause()
                isPlaying = false
                ticker?.cancel()
            } else {
                activate()
                player.play()
                isPlaying = true
                tick()
            }
            return
        }
        stop()
        guard let remote = client.absoluteURL(ref.url) else { return }
        loadingID = ref.id
        failedID = nil
        Task {
            defer { if loadingID == ref.id { loadingID = nil } }
            guard let file = try? await AttachmentFileCache.shared.localFile(for: ref, remote: remote),
                let player = try? AVAudioPlayer(contentsOf: file)
            else {
                failedID = ref.id
                return
            }
            guard loadingID == ref.id else { return }
            activate()
            player.delegate = self
            player.prepareToPlay()
            player.play()
            self.player = player
            currentID = ref.id
            isPlaying = true
            tick()
        }
    }

    func dismissFailure() {
        failedID = nil
    }

    func seek(_ fraction: Double) {
        guard let player else { return }
        player.currentTime = player.duration * min(max(fraction, 0), 1)
        progress = fraction
        elapsed = player.currentTime
    }

    func stop() {
        ticker?.cancel()
        player?.stop()
        player = nil
        currentID = nil
        isPlaying = false
        progress = 0
        elapsed = 0
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.stop()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func activate() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    private func tick() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let player = self.player else { return }
                self.elapsed = player.currentTime
                self.progress = player.duration > 0 ? player.currentTime / player.duration : 0
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }
}

struct AudioBubble: View {
    let ref: AttachmentRef
    let client: BotsClient
    var fromUser = false
    private let playback = AudioPlayback.shared

    private var isCurrent: Bool { playback.currentID == ref.id }
    private var ink: Color { fromUser ? Theme.onAccent : Theme.textPrimary }
    private var faint: Color { fromUser ? Theme.onAccent.opacity(0.4) : Theme.textTertiary.opacity(0.6) }

    private var levels: [CGFloat] {
        let source = ref.waveform.isEmpty ? Array(repeating: 0.25, count: 40) : ref.waveform
        return source.map { CGFloat($0) }
    }

    var body: some View {
        HStack(spacing: Spacing.m) {
            Button {
                playback.toggle(ref, client: client)
            } label: {
                Group {
                    if playback.loadingID == ref.id {
                        ProgressView()
                            .controlSize(.small)
                            .tint(fromUser ? Theme.userBubble : Theme.onAccent)
                    } else {
                        Image(systemName: isCurrent && playback.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(fromUser ? Theme.userBubble : Theme.background)
                            .contentTransition(.symbolEffect(.replace))
                    }
                }
                .frame(width: 36, height: 36)
                .background(ink, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isCurrent && playback.isPlaying ? "Pausar áudio" : "Tocar áudio")
            VStack(alignment: .leading, spacing: 4) {
                GeometryReader { geometry in
                    let progress = isCurrent ? playback.progress : 0
                    ZStack(alignment: .leading) {
                        Waveform(levels: levels, color: faint)
                        Waveform(levels: levels, color: ink)
                            .mask(alignment: .leading) {
                                Rectangle().frame(width: geometry.size.width * progress)
                            }
                    }
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0).onEnded { value in
                            guard isCurrent else { return }
                            playback.seek(value.location.x / max(geometry.size.width, 1))
                        }
                    )
                }
                .frame(height: 22)
                .clipped()
                Text(timeLabel)
                    .font(TypeScale.caption)
                    .monospacedDigit()
                    .foregroundStyle(fromUser ? Theme.onAccent.opacity(0.8) : Theme.textTertiary)
            }
        }
        .padding(.leading, Spacing.s + 2)
        .padding(.trailing, Spacing.m + 2)
        .padding(.vertical, Spacing.s + 2)
        .frame(width: 240)
        .background(fromUser ? Theme.userBubble : Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .alert("Não deu para tocar o áudio.", isPresented: Binding(get: { playback.failedID == ref.id }, set: { if !$0 { playback.dismissFailure() } })) {
            Button("OK", role: .cancel) {}
        }
    }

    private var timeLabel: String {
        let total = ref.duration ?? 0
        if isCurrent {
            return "\(AttachmentFormat.clock(playback.elapsed)) / \(AttachmentFormat.clock(total))"
        }
        return AttachmentFormat.clock(total)
    }
}
