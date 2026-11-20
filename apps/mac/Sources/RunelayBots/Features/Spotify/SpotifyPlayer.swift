import AppKit
import Observation

@MainActor
@Observable
final class SpotifyPlayer {
    static let shared = SpotifyPlayer()
    nonisolated static let bundleIdentifier = "com.spotify.client"

    enum Phase: Equatable {
        case unavailable
        case closed
        case denied
        case idle
        case track
    }

    struct Track: Equatable {
        let id: String
        let name: String
        let artist: String
        let album: String
        let artworkURL: URL?
        let duration: TimeInterval
    }

    private(set) var phase: Phase = .unavailable
    private(set) var track: Track?
    private(set) var artwork: NSImage?
    private(set) var artworkKey: String?
    private(set) var isPlaying = false
    private(set) var position: TimeInterval = 0
    private(set) var positionStamp = Date()

    @ObservationIgnored private let runner = SpotifyScriptRunner()
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var lastCommandAt = Date.distantPast
    @ObservationIgnored private var artworkTask: Task<Void, Never>?

    private init() {}

    func start() {
        guard loop == nil else { return }
        let distributed = DistributedNotificationCenter.default()
        observers.append(distributed.addObserver(forName: .init("com.spotify.client.PlaybackStateChanged"), object: nil, queue: .main) { note in
            let state = note.userInfo?["Player State"] as? String
            MainActor.assumeIsolated {
                SpotifyPlayer.shared.applyNotification(state: state)
            }
        })
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            observers.append(workspace.addObserver(forName: name, object: nil, queue: .main) { note in
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                guard app?.bundleIdentifier == SpotifyPlayer.bundleIdentifier else { return }
                Task { @MainActor in
                    await SpotifyPlayer.shared.refresh()
                }
            })
        }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                if AppActivity.shared.isLive {
                    await self?.refresh()
                }
                try? await Task.sleep(for: .seconds(1.5))
            }
        }
    }

    func elapsed(at date: Date) -> TimeInterval {
        guard let track, track.duration > 0 else { return 0 }
        let value = isPlaying ? position + date.timeIntervalSince(positionStamp) : position
        return min(max(value, 0), track.duration)
    }

    func togglePlayback() {
        if isPlaying || phase == .track {
            position = elapsed(at: Date())
            positionStamp = Date()
            isPlaying.toggle()
        }
        send("playpause")
    }

    func nextTrack() {
        send("next track")
    }

    func previousTrack() {
        send("previous track")
    }

    func openSpotify() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleIdentifier) else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in
            Task { @MainActor in
                await SpotifyPlayer.shared.refresh()
            }
        }
    }

    func openAutomationSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") else { return }
        NSWorkspace.shared.open(url)
    }

    func refresh() async {
        guard isRunning else {
            setPhase(isInstalled ? .closed : .unavailable)
            isPlaying = false
            track = nil
            return
        }
        let started = Date()
        let outcome = await runner.run(SpotifyScriptRunner.statusScript)
        guard started >= lastCommandAt else { return }
        switch outcome {
        case .denied:
            setPhase(.denied)
        case .failed:
            if phase == .unavailable || phase == .closed { setPhase(.idle) }
        case .output(let text):
            apply(text, at: started)
        }
    }

    private var isRunning: Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == Self.bundleIdentifier }
    }

    private var isInstalled: Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleIdentifier) != nil
    }

    private func send(_ command: String) {
        guard phase != .denied, isRunning else { return }
        lastCommandAt = Date()
        Task {
            let outcome = await runner.run("tell application id \"\(Self.bundleIdentifier)\" to \(command)")
            if outcome == .denied {
                setPhase(.denied)
                return
            }
            try? await Task.sleep(for: .milliseconds(150))
            await refresh()
        }
    }

    private func applyNotification(state: String?) {
        guard let state else { return }
        switch state.lowercased() {
        case "playing":
            if !isPlaying {
                positionStamp = Date()
                isPlaying = true
            }
        case "paused", "stopped":
            if isPlaying {
                position = elapsed(at: Date())
                positionStamp = Date()
                isPlaying = false
            }
        default:
            break
        }
        Task { await refresh() }
    }

    private func apply(_ text: String, at date: Date) {
        let fields = text.components(separatedBy: "\u{1E}")
        let state = fields.first?.lowercased() ?? ""
        isPlaying = state == "playing"
        guard fields.count >= 8, !fields[1].isEmpty else {
            setPhase(track == nil ? .idle : .track)
            return
        }
        let next = Track(
            id: fields[1],
            name: fields[2],
            artist: fields[3],
            album: fields[4],
            artworkURL: URL(string: fields[5]),
            duration: (Double(fields[6]) ?? 0) / 1000
        )
        position = (Double(fields[7]) ?? 0) / 1000
        positionStamp = date
        if next != track {
            track = next
            loadArtwork(for: next)
        }
        setPhase(.track)
    }

    private func setPhase(_ value: Phase) {
        if phase != value {
            phase = value
        }
    }

    private func loadArtwork(for track: Track) {
        artworkTask?.cancel()
        guard let url = track.artworkURL else {
            artwork = nil
            artworkKey = track.id
            return
        }
        artworkTask = Task {
            guard let (data, _) = try? await URLSession.shared.data(from: url), !Task.isCancelled else { return }
            guard let image = NSImage(data: data) else { return }
            artwork = image
            artworkKey = track.id
        }
    }
}

actor SpotifyScriptRunner {
    enum Outcome: Sendable, Equatable {
        case output(String)
        case denied
        case failed
    }

    static let statusScript = """
    on txt(v)
        try
            if v is missing value then return ""
            return v as text
        on error
            return ""
        end try
    end txt
    set trackId to ""
    set trackName to ""
    set trackArtist to ""
    set trackAlbum to ""
    set trackArtwork to ""
    set trackDuration to 0
    set playerPosition to 0
    tell application id "com.spotify.client"
        set playerState to player state as text
        try
            set playerPosition to player position
        end try
        try
            set currentTrack to current track
            set trackId to id of currentTrack
            set trackName to name of currentTrack
            set trackArtist to artist of currentTrack
            set trackAlbum to album of currentTrack
            set trackArtwork to artwork url of currentTrack
            set trackDuration to duration of currentTrack
        end try
    end tell
    set sep to character id 30
    return playerState & sep & my txt(trackId) & sep & my txt(trackName) & sep & my txt(trackArtist) & sep & my txt(trackAlbum) & sep & my txt(trackArtwork) & sep & my txt(trackDuration) & sep & ((round (playerPosition * 1000)) as text)
    """

    func run(_ source: String) async -> Outcome {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-"]
            let input = Pipe()
            let output = Pipe()
            let failure = Pipe()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = failure
            process.terminationHandler = { finished in
                let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                let problem = String(decoding: failure.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                if finished.terminationStatus == 0 {
                    continuation.resume(returning: .output(text.trimmingCharacters(in: .newlines)))
                } else if problem.contains("-1743") || problem.contains("-1744") {
                    continuation.resume(returning: .denied)
                } else {
                    BlocksLog.logger.error("spotify script failed: \(problem, privacy: .public)")
                    continuation.resume(returning: .failed)
                }
            }
            do {
                try process.run()
                input.fileHandleForWriting.write(Data(source.utf8))
                try? input.fileHandleForWriting.close()
            } catch {
                continuation.resume(returning: .failed)
            }
        }
    }
}
