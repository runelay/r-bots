import Foundation

struct TurnTiming: Sendable {
    var commitHold: Duration = .milliseconds(1_200)
    var partialHold: Duration = .milliseconds(2_400)
    var echoWindow: TimeInterval = 2
    var bargeInSustain: TimeInterval = 0.6
    var speechLevel: Float = 0.45
    var playbackLevel: Float = 0.62
    var levelGap: TimeInterval = 0.18
    var minimumBargeInWords = 3
    var minimumTurnWords = 3
    var minimumVoiceSeconds: Double = 0.15
    var weakVoiceSeconds: Double = 0.4
    var weakSnr: Float = 20
    var pushToTalkHold: Duration = .milliseconds(250)
}

@MainActor
final class TurnTaker {
    private static let fillers: Set<String> = [
        "ta", "tah", "uhum", "uhm", "hum", "hm", "ahn", "ah", "aham", "ok", "okay", "certo", "sei", "entendi", "beleza", "e", "eh", "oi", "hmm", "mhm", "anham", "ham",
    ]

    var onTurn: ((String, Bool) -> Void)?
    var onBargeIn: (() -> Void)?
    var onLog: ((String) -> Void)?

    var botAudible = false {
        didSet {
            if oldValue, !botAudible {
                lastAudibleAt = Date()
            }
            if botAudible != oldValue {
                loudSince = nil
            }
        }
    }
    var botBusy = false
    var awaitingAnswer = false

    private let timing: TurnTiming
    private var pieces: [String] = []
    private var carry: [String] = []
    private var flushTask: Task<Void, Never>?
    private var generation = 0
    private var lastPartial = ""
    private var loudSince: Date?
    private var lastLoudAt: Date?
    private var lastAudibleAt: Date?
    private var spoken: [(id: String, text: String, at: Date)] = []
    private var bargedIn = false
    private var voiceSeconds: Double = 0
    private var voicedDuringHold: Double = 0
    private var voiceEnergy: Double = 0
    private var calibrated = false
    private var released = false
    var pushToTalk = false

    init(timing: TurnTiming = TurnTiming()) {
        self.timing = timing
    }

    var isHolding: Bool {
        !pieces.isEmpty
    }

    var playbackLevel: Float {
        timing.playbackLevel
    }

    var currentThreshold: Float {
        botAudible ? timing.playbackLevel : timing.speechLevel
    }

    func reset() {
        flushTask?.cancel()
        flushTask = nil
        generation += 1
        pieces.removeAll()
        carry.removeAll()
        lastPartial = ""
        loudSince = nil
        lastLoudAt = nil
        bargedIn = false
        voiceSeconds = 0
        voiceEnergy = 0
        calibrated = false
        released = false
        botAudible = false
        botBusy = false
        awaitingAnswer = false
    }

    func botSaid(id: String, text: String) {
        let now = Date()
        if let index = spoken.firstIndex(where: { $0.id == id }) {
            spoken[index] = (id, text, now)
        } else {
            spoken.append((id, text, now))
        }
        spoken.removeAll { now.timeIntervalSince($0.at) > 60 }
    }

    func level(_ value: Float, at now: Date = Date()) {
        if value >= currentThreshold {
            if let lastLoudAt, now.timeIntervalSince(lastLoudAt) > timing.levelGap {
                loudSince = now
            } else if loudSince == nil {
                loudSince = now
            }
            lastLoudAt = now
        } else if let lastLoudAt, now.timeIntervalSince(lastLoudAt) > timing.levelGap {
            loudSince = nil
            self.lastLoudAt = nil
        }
        considerBargeIn(now: now)
    }

    func voiceFrame(_ frame: VoiceFrame) {
        calibrated = frame.calibrated || pushToTalk
        guard frame.open, frame.voiced || pushToTalk else { return }
        voiceSeconds += frame.seconds
        voiceEnergy += Double(frame.snr) * frame.seconds
        guard frame.voiced, isHolding, !(pushToTalk && released) else { return }
        voicedDuringHold += frame.seconds
        if voicedDuringHold >= 0.1 {
            voicedDuringHold = 0
            schedule(timing.partialHold)
        }
    }

    func talkReleased() {
        released = true
        if isHolding {
            schedule(timing.pushToTalkHold)
        }
    }

    func talkPressed() {
        released = false
    }

    func partial(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if isEcho(trimmed) {
            return false
        }
        lastPartial = trimmed
        if isHolding {
            schedule(timing.partialHold)
        }
        considerBargeIn(now: Date())
        return true
    }

    func committed(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        lastPartial = ""
        guard !trimmed.isEmpty else { return }
        if isEcho(trimmed) {
            onLog?("eco descartado: \(trimmed)")
            resetEnergy()
            return
        }
        let words = Self.words(trimmed)
        let seconds = voiceSeconds
        let snr = seconds > 0 ? Float(voiceEnergy / seconds) : 0
        resetEnergy()
        if calibrated {
            let energy = String(format: "%.2f s de voz, %.0f dB acima do fundo", seconds, snr)
            if seconds < timing.minimumVoiceSeconds {
                onLog?("commit sem voz no canal descartado (\(energy)): \(trimmed)")
                return
            }
            if !pushToTalk, snr < timing.weakSnr {
                onLog?("commit com energia baixa descartado, voz distante (\(energy)): \(trimmed)")
                return
            }
            if !awaitingAnswer, words.count <= 3, seconds < timing.weakVoiceSeconds {
                onLog?("commit fraco descartado (\(energy)): \(trimmed)")
                return
            }
        }
        let botActive = botAudible || (botBusy && !bargedIn) || recentlyAudible
        if !isHolding, !awaitingAnswer, botActive, words.count < timing.minimumTurnWords {
            if words.allSatisfy({ Self.fillers.contains($0) }) {
                onLog?("backchannel ignorado: \(trimmed)")
            } else {
                carry.append(trimmed)
                onLog?("fragmento guardado para o próximo turno: \(trimmed)")
            }
            return
        }
        pieces.append(trimmed)
        voicedDuringHold = 0
        onLog?("pedaço \(pieces.count) do turno: \(trimmed)")
        schedule(pushToTalk && released ? timing.pushToTalkHold : awaitingAnswer && words.count <= 2 ? .milliseconds(500) : timing.commitHold)
    }

    private func resetEnergy() {
        voiceSeconds = 0
        voiceEnergy = 0
    }

    private var recentlyAudible: Bool {
        guard let lastAudibleAt else { return false }
        return Date().timeIntervalSince(lastAudibleAt) < timing.echoWindow
    }

    private func schedule(_ delay: Duration) {
        flushTask?.cancel()
        generation += 1
        let current = generation
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.flush(current)
        }
    }

    private func flush(_ current: Int) {
        guard current == generation, !pieces.isEmpty else { return }
        if !lastPartial.isEmpty {
            schedule(timing.partialHold)
            return
        }
        let text = (carry + pieces).joined(separator: " ")
        let count = pieces.count
        pieces.removeAll()
        carry.removeAll()
        flushTask = nil
        let interrupted = bargedIn
        bargedIn = false
        onLog?("turno fechado (\(count) pedaço\(count == 1 ? "" : "s")\(interrupted ? ", depois de interromper" : "")): \(text)")
        onTurn?(text, interrupted)
    }

    private func considerBargeIn(now: Date) {
        guard botAudible, !bargedIn, let loudSince else { return }
        guard now.timeIntervalSince(loudSince) >= timing.bargeInSustain else { return }
        guard !lastPartial.isEmpty, !isEcho(lastPartial) else { return }
        let words = Self.words(lastPartial)
        guard words.count >= timing.minimumBargeInWords, !words.allSatisfy({ Self.fillers.contains($0) }) else { return }
        bargedIn = true
        onLog?("interrupção: \(String(format: "%.2f", now.timeIntervalSince(loudSince))) s de fala, \"\(lastPartial)\"")
        onBargeIn?()
    }

    private func isEcho(_ text: String) -> Bool {
        guard botAudible || recentlyAudible else { return false }
        let heard = Self.words(text)
        guard !heard.isEmpty else { return false }
        let now = Date()
        let window = spoken.filter { now.timeIntervalSince($0.at) < 30 }
        guard !window.isEmpty else { return false }
        let said = window.flatMap { Self.words($0.text) }
        if heard.count < 3 {
            if heard.allSatisfy({ Self.fillers.contains($0) }) { return false }
            return heard.allSatisfy { said.contains($0) }
        }
        return Self.similarity(heard, said) >= 0.6
    }

    static func similarity(_ heard: [String], _ said: [String]) -> Double {
        let saidPairs = Set(zip(said, said.dropFirst()).map { "\($0) \($1)" })
        let heardPairs = zip(heard, heard.dropFirst()).map { "\($0) \($1)" }
        let saidWords = Set(said)
        let pairScore = heardPairs.isEmpty ? 0 : Double(heardPairs.filter { saidPairs.contains($0) }.count) / Double(heardPairs.count)
        let wordScore = Double(heard.filter { saidWords.contains($0) }.count) / Double(heard.count)
        return max(pairScore, wordScore * 0.85)
    }

    static func words(_ text: String) -> [String] {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "pt_BR"))
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }
}
