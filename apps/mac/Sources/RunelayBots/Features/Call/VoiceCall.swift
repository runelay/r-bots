import AppKit
import AVFoundation
import Foundation
import Observation
import OSLog

enum CallPhase: Equatable {
    case idle
    case connecting
    case listening
    case userSpeaking
    case thinking
    case botSpeaking
}

enum CallPreferenceKeys {
    static let captions = "voiceCallCaptions"
    static let pushToTalk = "voiceCallPushToTalk"
}

@MainActor
@Observable
final class VoiceCall {
    static let shared = VoiceCall()
    static let levelCount = 14

    private(set) var phase: CallPhase = .idle
    private(set) var botID: String?
    private(set) var isMuted = false
    private(set) var userCaption = ""
    private(set) var botCaption = ""
    private(set) var levels: [CGFloat] = Array(repeating: 0, count: VoiceCall.levelCount)
    private(set) var levelsAreBot = false
    private(set) var startedAt: Date?
    private(set) var failure: String?
    private(set) var botWorking = false
    private(set) var lastLatency: String?
    private(set) var notice: String?
    private(set) var quietMicrophone: String?
    private(set) var isTalking = false
    var settingsOpen = false
    var pushToTalk: Bool = UserDefaults.standard.bool(forKey: CallPreferenceKeys.pushToTalk) {
        didSet {
            UserDefaults.standard.set(pushToTalk, forKey: CallPreferenceKeys.pushToTalk)
            isTalking = false
            applyTalkMode()
            CallDebug.log("apertar para falar: \(pushToTalk ? "ligado" : "desligado")")
        }
    }
    var captionsVisible: Bool = UserDefaults.standard.object(forKey: CallPreferenceKeys.captions) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(captionsVisible, forKey: CallPreferenceKeys.captions)
        }
    }

    @ObservationIgnored private weak var store: ConversationStore?
    @ObservationIgnored private var api: VoiceCallClient?
    @ObservationIgnored private var callID: String?
    @ObservationIgnored private var audio: CallAudio?
    @ObservationIgnored private var scribe: ScribeSocket?
    @ObservationIgnored private var speech: SpeechSocket?
    @ObservationIgnored private var voice = BotVoiceSettings.fallback
    @ObservationIgnored private var sttRate: Double = 16_000
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var liveSpeech: Set<String> = []
    @ObservationIgnored private var audibleSpeech: Set<String> = []
    @ObservationIgnored private var reconnecting = false
    @ObservationIgnored private var committedAt: Date?
    @ObservationIgnored private var lastVoiceAt: Date?
    @ObservationIgnored private var probeSpeech: String?
    @ObservationIgnored private var levelTick = 0
    @ObservationIgnored private var monitorTask: Task<Void, Never>?
    @ObservationIgnored private var silentSeconds = 0
    @ObservationIgnored private var scribeWaitSeconds = 0
    @ObservationIgnored private var audioFallbackUsed = false
    @ObservationIgnored private var quietChecks = 0
    @ObservationIgnored private var quietPeak: Float = 0
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var reconnectAttempts = 0
    @ObservationIgnored private let turns = TurnTaker()
    @ObservationIgnored private var keyMonitor: Any?
    @ObservationIgnored private var hangupSpeech: String?
    @ObservationIgnored private var hangupTask: Task<Void, Never>?
    @ObservationIgnored private let logger = Logger(subsystem: "runelay.bots", category: "voice-call")

    private init() {
        turns.onLog = { line in
            CallDebug.log(line)
        }
        turns.onTurn = { [weak self] text, interrupted in
            self?.deliver(text, interrupted: interrupted)
        }
        turns.onBargeIn = { [weak self] in
            self?.bargeIn()
        }
    }

    var isActive: Bool { phase != .idle }

    func isActive(for botID: String) -> Bool {
        phase != .idle && self.botID == botID
    }

    var isBotAudible: Bool {
        phase == .botSpeaking
    }

    func toggle(bot: Bot, store: ConversationStore, client: BotsClient) {
        if isActive(for: bot.id) {
            hangUp()
        } else {
            start(bot: bot, store: store, client: client)
        }
    }

    func start(bot: Bot, store: ConversationStore, client: BotsClient) {
        if isActive {
            hangUp()
        }
        VoiceInput.shared.releaseForCall()
        self.store = store
        api = VoiceCallClient(client: client)
        botID = bot.id
        phase = .connecting
        failure = nil
        isMuted = false
        userCaption = ""
        botCaption = ""
        lastLatency = nil
        notice = nil
        quietMicrophone = nil
        quietChecks = 0
        quietPeak = 0
        silentSeconds = 0
        scribeWaitSeconds = 0
        audioFallbackUsed = false
        if let lost = Microphones.takeMissing() {
            showBriefly(Microphones.lostNotice(lost))
        }
        reconnectAttempts = 0
        turns.reset()
        isTalking = false
        installTalkShortcut()
        startedAt = Date()
        CallDebug.log("chamada iniciando com \(bot.id)")
        startTask = Task { [weak self] in
            await self?.connect()
        }
    }

    func hangUp() {
        guard phase != .idle else { return }
        let api = api
        let botID = botID
        let callID = callID
        teardown()
        if let api, let botID, let callID {
            Task {
                await api.end(botID: botID, callID: callID)
            }
        }
    }

    func toggleMute() {
        isMuted.toggle()
        audio?.setMuted(isMuted)
        if isMuted {
            userCaption = ""
            if phase == .userSpeaking {
                phase = .listening
            }
        }
    }

    func dismissFailure() {
        failure = nil
    }

    func voiceChanged(botID: String) {
        guard isActive(for: botID) else { return }
        speech?.close()
        speech = nil
        scribe?.close()
        scribe = nil
        Task { [weak self] in
            await self?.reconnectSockets(types: ["stt", "tts"])
        }
    }

    private func connect() async {
        CallDebug.log("permissão: captura=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) gravação=\(Self.recordPermissionLabel)")
        guard await microphoneAllowed() else {
            CallDebug.log("microfone negado: \(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")
            fail(CallNotice.blocked)
            return
        }
        guard let api, let botID, phase == .connecting else { return }
        do {
            let ticket = try await api.start(botID: botID)
            guard phase == .connecting, self.botID == botID else {
                await api.end(botID: botID, callID: ticket.callID)
                return
            }
            callID = ticket.callID
            CallDebug.log("chamada aberta \(ticket.callID) stt=\(ticket.credentials.stt != nil) tts=\(ticket.credentials.tts != nil) rate=\(ticket.credentials.stt?.sampleRate ?? 0)")
            voice = ticket.credentials.voice
            sttRate = ticket.credentials.stt?.sampleRate ?? 16_000
            listen(api: api, botID: botID, callID: ticket.callID)
            await VoiceInput.shared.waitUntilIdle()
            do {
                try startAudio(playbackRate: ticket.credentials.tts?.sampleRate ?? 24_000)
            } catch {
                logger.error("call audio failed: \(String(describing: error), privacy: .public)")
                CallDebug.log("áudio falhou: \(error)")
                fail("Não consegui usar o microfone. Tenta de novo.")
                return
            }
            attach(ticket.credentials)
            phase = .listening
            startMonitor()
        } catch {
            CallDebug.log("abrir chamada falhou: \(error)")
            fail(Self.humanMessage(error))
        }
    }

    private static func humanMessage(_ error: Error) -> String {
        if let client = error as? BotsClient.ClientError, case .http(let status, let message) = client {
            if status == 503 {
                return "O chat de voz não está configurado no servidor."
            }
            if let message, !message.isEmpty, !message.contains("Error"), !message.contains("error") {
                return message
            }
            return "O servidor não abriu a chamada. Tenta de novo."
        }
        if error is URLError {
            return "Não consegui falar com o servidor. Confere a conexão e tenta de novo."
        }
        return "Não consegui começar a chamada. Tenta de novo."
    }

    private static var recordPermissionLabel: String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: "liberada"
        case .denied: "negada"
        case .undetermined: "não decidida"
        @unknown default: "desconhecida"
        }
    }

    private static var microphoneBlocked: Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) != .authorized || AVAudioApplication.shared.recordPermission == .denied
    }

    func openMicrophoneSettings() {
        guard let url = VoicePermission.microphone.settingsURL else { return }
        NSWorkspace.shared.open(url)
    }

    private func microphoneAllowed() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        default:
            return false
        }
    }

    private func startAudio(playbackRate: Double) throws {
        let audio = try CallAudio(captureRate: sttRate, playbackRate: playbackRate)
        audio.onChunk = { [weak self] chunk in
            Task { @MainActor in
                self?.scribe?.send(audio: chunk)
            }
        }
        audio.onInputLevel = { [weak self] level in
            Task { @MainActor in
                self?.receiveInput(level)
            }
        }
        audio.onOutputLevel = { [weak self] level in
            Task { @MainActor in
                self?.receiveOutput(level)
            }
        }
        audio.onPlaybackIdle = { [weak self] in
            Task { @MainActor in
                self?.playbackIdle()
            }
        }
        audio.onEvent = { line in
            CallDebug.log(line)
        }
        audio.onVoiceFrame = { [weak self] frame in
            Task { @MainActor in
                self?.turns.voiceFrame(frame)
            }
        }
        audio.setPlaybackGate(turns.playbackLevel)
        try audio.start()
        self.audio = audio
        applyTalkMode()
        CallDebug.log("áudio pronto, eco cancelado: \(audio.echoCancelled)")
    }

    private func attach(_ credentials: VoiceCredentials) {
        if let stt = credentials.stt {
            let scribe = ScribeSocket(url: stt.url, sampleRate: stt.sampleRate)
            scribe.onPartial = { [weak self] text in
                Task { @MainActor in
                    self?.partial(text)
                }
            }
            scribe.onCommitted = { [weak self] text in
                Task { @MainActor in
                    self?.committed(text)
                }
            }
            scribe.onStarted = { [weak self] in
                Task { @MainActor in
                    CallDebug.log("scribe: sessão aberta")
                    self?.scribeWaitSeconds = 0
                    self?.reconnectAttempts = 0
                    if self?.notice == CallNotice.reconnecting {
                        self?.notice = nil
                    }
                }
            }
            scribe.onClose = { [weak self] reason in
                Task { @MainActor in
                    CallDebug.log("scribe fechou: \(reason)")
                    self?.socketClosed()
                }
            }
            scribe.open()
            self.scribe = scribe
        }
        if let tts = credentials.tts {
            voice = credentials.voice
            let speech = SpeechSocket(url: tts.url, speed: credentials.voice.speed)
            let audio = audio
            speech.onAudio = { _, data in
                audio?.play(pcm16: data)
            }
            speech.onFirstAudio = { [weak self] id in
                Task { @MainActor in
                    self?.firstAudio(id)
                }
            }
            speech.onClose = { [weak self] in
                Task { @MainActor in
                    CallDebug.log("tts fechou")
                    self?.socketClosed()
                }
            }
            speech.open()
            self.speech = speech
        }
    }

    private func socketClosed() {
        guard phase != .idle else { return }
        var types: [String] = []
        if scribe?.isOpen != true {
            scribe = nil
            types.append("stt")
        }
        if speech?.isOpen != true {
            speech = nil
            types.append("tts")
        }
        guard !types.isEmpty else { return }
        if types.contains("stt") {
            notice = CallNotice.reconnecting
        }
        Task { [weak self] in
            await self?.reconnectSockets(types: types)
        }
    }

    private func reconnectSockets(types: [String]) async {
        guard !reconnecting, let api, let botID, let callID, phase != .idle else { return }
        reconnecting = true
        defer { reconnecting = false }
        reconnectAttempts += 1
        if reconnectAttempts > 1 {
            try? await Task.sleep(for: .milliseconds(min(400 * reconnectAttempts, 2_000)))
        }
        guard reconnectAttempts <= 5 else {
            fail("A chamada caiu. Tenta ligar de novo.")
            return
        }
        do {
            let credentials = try await api.credentials(botID: botID, callID: callID, types: types)
            guard phase != .idle, self.callID == callID else { return }
            CallDebug.log("reconectando \(types.joined(separator: ","))")
            attach(credentials)
        } catch {
            CallDebug.log("reconectar falhou: \(error)")
            fail("A chamada caiu. Tenta ligar de novo.")
        }
    }

    private func listen(api: VoiceCallClient, botID: String, callID: String) {
        eventsTask?.cancel()
        eventsTask = Task { [weak self] in
            for await event in api.events(botID: botID, callID: callID) {
                guard let self, self.callID == callID else { return }
                self.handle(event)
            }
            guard let self, self.callID == callID, self.phase != .idle else { return }
            self.fail("A chamada foi encerrada pelo servidor.")
        }
    }

    private func handle(_ event: CallEvent) {
        switch event {
        case .ready:
            break
        case .speechStarted(let id, let kind, _):
            liveSpeech.insert(id)
            botCaption = ""
            if kind == "ack", committedAt != nil {
                probeSpeech = id
            }
            if speech?.isOpen != true {
                Task { [weak self] in
                    await self?.reconnectSockets(types: ["tts"])
                    self?.speech?.begin(id)
                }
            } else {
                speech?.begin(id)
            }
        case .speechDelta(let id, let text):
            guard liveSpeech.contains(id) else { return }
            botCaption += text
            turns.botSaid(id: id, text: botCaption)
            speech?.append(id, text: text)
        case .speechDone(let id, let text):
            guard liveSpeech.contains(id) else { return }
            botCaption = text
            turns.botSaid(id: id, text: text)
            speech?.finish(id)
            liveSpeech.remove(id)
        case .speechCancelled(let id):
            liveSpeech.remove(id)
            speech?.cancel(id)
            if id == hangupSpeech {
                hangUp()
                return
            }
            if audio?.isPlaying != true, phase == .botSpeaking {
                phase = .listening
            }
        case .botState(let state):
            botWorking = state == "working"
            turns.awaitingAnswer = state == "awaiting"
            if state == "working", phase == .listening {
                phase = .thinking
            } else if state == "idle", phase == .thinking {
                phase = .listening
            }
        case .approvalAsked, .approvalSettled:
            break
        case .hangup(let id):
            CallDebug.log("despedida por voz: encerrando depois de \(id)")
            hangupSpeech = id
            turns.reset()
            hangupTask?.cancel()
            hangupTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(7))
                guard !Task.isCancelled, self?.hangupSpeech == id else { return }
                self?.hangUp()
            }
        case .ended:
            if phase != .idle {
                teardown()
            }
        }
    }

    private func partial(_ text: String) {
        guard phase != .idle, !isMuted else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let botAudible = phase == .botSpeaking || audio?.isPlaying == true
        if botAudible, audio?.echoCancelled != true {
            return
        }
        syncTurns()
        guard turns.partial(trimmed) else { return }
        userCaption = trimmed
        if phase != .userSpeaking {
            CallDebug.log("ouvindo: \(trimmed)")
            phase = .userSpeaking
        }
        if notice == CallNotice.deaf {
            notice = nil
        }
    }

    private func committed(_ text: String) {
        guard phase != .idle, !isMuted else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            if phase == .userSpeaking, !turns.isHolding {
                phase = .listening
            }
            return
        }
        CallDebug.log("fala fechada: \(trimmed)")
        syncTurns()
        turns.committed(trimmed)
        if !turns.isHolding, phase == .userSpeaking {
            phase = audio?.isPlaying == true ? .botSpeaking : botWorking ? .thinking : .listening
        }
    }

    private func deliver(_ trimmed: String, interrupted: Bool) {
        guard phase != .idle, !isMuted, hangupSpeech == nil else { return }
        userCaption = trimmed
        committedAt = Date()
        if phase != .botSpeaking {
            phase = .thinking
        }
        guard let api, let botID, let callID else { return }
        let store = store
        Task { [weak self] in
            do {
                let outcome = try await api.utterance(botID: botID, callID: callID, text: trimmed, interrupted: interrupted)
                CallDebug.log("fala entregue: \(outcome)")
                if case .answer(let interactionID, let optionID) = outcome {
                    store?.respond(approvalID: interactionID, optionID: optionID)
                }
            } catch {
                CallDebug.log("fala não entregue: \(error)")
                self?.notice = "Não consegui mandar o que você falou. Fala de novo."
                if self?.phase == .thinking {
                    self?.phase = .listening
                }
            }
        }
    }

    var handlesTalkShortcut: Bool {
        phase != .idle && pushToTalk
    }

    func beginTalk() {
        guard phase != .idle, pushToTalk, !isTalking else { return }
        isTalking = true
        turns.talkPressed()
        audio?.setTalkOpen(true)
        CallDebug.log("apertou para falar")
        if phase == .botSpeaking || audio?.isPlaying == true {
            bargeIn()
        }
    }

    func endTalk() {
        guard isTalking else { return }
        isTalking = false
        audio?.setTalkOpen(!pushToTalk)
        turns.talkReleased()
        CallDebug.log("soltou para falar")
    }

    private func applyTalkMode() {
        turns.pushToTalk = pushToTalk
        audio?.setVoiceGate(enabled: !pushToTalk)
        audio?.setTalkOpen(!pushToTalk || isTalking)
    }

    private func installTalkShortcut() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self else { return event }
            return self.handleTalkShortcut(event)
        }
    }

    private func handleTalkShortcut(_ event: NSEvent) -> NSEvent? {
        guard event.keyCode == 49, handlesTalkShortcut else { return event }
        if event.type == .keyDown {
            let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
            guard modifiers == .option || isTalking else { return event }
            if !event.isARepeat {
                beginTalk()
            }
            return nil
        }
        guard isTalking else { return event }
        endTalk()
        return nil
    }

    private func removeTalkShortcut() {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
        }
        keyMonitor = nil
    }

    private func syncTurns() {
        turns.botAudible = phase == .botSpeaking || audio?.isPlaying == true
        turns.botBusy = botWorking || !liveSpeech.isEmpty
    }

    private func bargeIn() {
        guard hangupSpeech == nil else { return }
        audio?.stopPlayback()
        speech?.cancelAll()
        liveSpeech.removeAll()
        audibleSpeech.removeAll()
        botCaption = ""
        if phase == .botSpeaking {
            phase = .userSpeaking
        }
        syncTurns()
        guard let api, let botID, let callID else { return }
        Task {
            await api.interrupt(botID: botID, callID: callID)
        }
    }

    private func firstAudio(_ id: String) {
        guard phase != .idle else { return }
        audibleSpeech.insert(id)
        phase = .botSpeaking
        guard probeSpeech == id, let committedAt else { return }
        probeSpeech = nil
        self.committedAt = nil
        let now = Date()
        let fromCommit = Int(now.timeIntervalSince(committedAt) * 1000)
        let fromVoice = lastVoiceAt.map { Int(now.timeIntervalSince($0) * 1000) }
        let line = "fim da fala → primeiro som: \(fromVoice.map { "\($0) ms" } ?? "?") · commit → primeiro som: \(fromCommit) ms"
        lastLatency = line
        logger.info("\(line, privacy: .public)")
        Self.appendLatency(line)
    }

    private func playbackIdle() {
        guard phase == .botSpeaking else { return }
        if speech?.hasActiveContext == true || !liveSpeech.isEmpty {
            return
        }
        audibleSpeech.removeAll()
        if hangupSpeech != nil {
            hangUp()
            return
        }
        phase = .listening
        syncTurns()
    }

    private func receiveInput(_ level: Float) {
        guard phase != .idle else { return }
        if level > 0.45, !isMuted, audio?.isPlaying != true {
            lastVoiceAt = Date()
        }
        if !isMuted {
            syncTurns()
            turns.level(level)
        }
        guard phase != .botSpeaking else { return }
        push(CGFloat(level), bot: false)
    }

    private func receiveOutput(_ level: Float) {
        guard phase == .botSpeaking else { return }
        push(CGFloat(level), bot: true)
    }

    private func push(_ level: CGFloat, bot: Bool) {
        levelTick += 1
        guard levelTick % 2 == 0 else { return }
        var next = levels
        next.removeFirst()
        next.append(level)
        levels = next
        if levelsAreBot != bot {
            levelsAreBot = bot
        }
    }

    private func fail(_ message: String) {
        let api = api
        let botID = botID
        let callID = callID
        teardown()
        failure = message
        if let api, let botID, let callID {
            Task {
                await api.end(botID: botID, callID: callID)
            }
        }
    }

    func microphoneChanged() {
        quietMicrophone = nil
        quietChecks = 0
        quietPeak = 0
        silentSeconds = 0
        guard phase != .idle, let audio else { return }
        CallDebug.log("trocando microfone para \(Microphones.activeName())")
        do {
            try audio.restart(voiceProcessing: !audioFallbackUsed)
        } catch {
            CallDebug.log("troca de microfone falhou: \(error)")
        }
    }

    func openMicrophonePicker() {
        settingsOpen = true
    }

    private func showBriefly(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled, self?.notice == message else { return }
            self?.notice = nil
        }
    }

    private func checkQuiet(_ peak: Float) {
        if quietMicrophone != nil, peak >= Microphones.quietPeak * 2 {
            quietMicrophone = nil
        }
        guard quietChecks < 3 else { return }
        guard !isMuted, phase == .listening || phase == .userSpeaking, !pushToTalk || isTalking, audio?.isPlaying != true else { return }
        quietChecks += 1
        quietPeak = max(quietPeak, peak)
        guard quietChecks == 3, quietPeak < Microphones.quietPeak else { return }
        let name = Microphones.activeName()
        CallDebug.log("microfone quase mudo: \(name) pico=\(String(format: "%.5f", quietPeak)) em 3 s")
        quietMicrophone = name
        settingsOpen = true
    }

    private func startMonitor() {
        monitorTask?.cancel()
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, self.phase != .idle else { return }
                self.inspectAudio()
            }
        }
    }

    private func inspectAudio() {
        guard let audio else { return }
        let stats = audio.takeStats()
        let scribeReady = scribe?.hasStarted == true
        CallDebug.log("buffers=\(stats.buffers) chunks=\(stats.chunks) pico=\(String(format: "%.5f", stats.peak)) engine=\(stats.engineRunning) vp=\(stats.echoCancelled) formato=\(stats.inputFormat) scribe=\(scribeReady) fase=\(phase)")
        if scribeReady || scribe == nil {
            scribeWaitSeconds = 0
        } else {
            scribeWaitSeconds += 1
            if scribeWaitSeconds >= 5 {
                scribeWaitSeconds = 0
                CallDebug.log("scribe não abriu em 5 s, reconectando")
                scribe?.close()
                scribe = nil
                notice = CallNotice.reconnecting
                Task { [weak self] in
                    await self?.reconnectSockets(types: ["stt"])
                }
            }
        }
        if let lost = Microphones.takeMissing() {
            CallDebug.log("microfone sumiu: \(lost), voltando ao padrão")
            showBriefly(Microphones.lostNotice(lost))
            microphoneChanged()
            return
        }
        checkQuiet(stats.peak)
        guard !isMuted else {
            silentSeconds = 0
            return
        }
        let deaf = stats.buffers == 0 || stats.peak < 0.000_001 || !stats.engineRunning
        if deaf {
            silentSeconds += 1
        } else {
            silentSeconds = 0
            if notice == CallNotice.deaf {
                notice = nil
            }
        }
        if silentSeconds == 2, !audioFallbackUsed {
            audioFallbackUsed = true
            CallDebug.log("microfone mudo com vp=\(stats.echoCancelled), reiniciando sem voice processing")
            do {
                try audio.restart(voiceProcessing: false)
            } catch {
                CallDebug.log("reinício do áudio falhou: \(error)")
            }
        } else if silentSeconds >= 4 {
            if Self.microphoneBlocked {
                CallDebug.log("permissão: captura=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) gravação=\(Self.recordPermissionLabel)")
                fail(CallNotice.blocked)
                return
            }
            notice = CallNotice.deaf
        }
    }

    private func teardown() {
        hangupTask?.cancel()
        hangupTask = nil
        hangupSpeech = nil
        monitorTask?.cancel()
        monitorTask = nil
        notice = nil
        noticeTask?.cancel()
        noticeTask = nil
        quietMicrophone = nil
        settingsOpen = false
        startTask?.cancel()
        startTask = nil
        eventsTask?.cancel()
        eventsTask = nil
        audio?.stop()
        audio = nil
        scribe?.close()
        scribe = nil
        speech?.close()
        speech = nil
        liveSpeech.removeAll()
        audibleSpeech.removeAll()
        callID = nil
        turns.reset()
        isTalking = false
        removeTalkShortcut()
        probeSpeech = nil
        committedAt = nil
        phase = .idle
        botWorking = false
        userCaption = ""
        botCaption = ""
        startedAt = nil
        isMuted = false
        levels = Array(repeating: 0, count: Self.levelCount)
    }

    private static func appendLatency(_ line: String) {
        CallDebug.log(line)
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("runelay bots", isDirectory: true)
        guard let folder else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("voice-latency.log")
        let entry = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data(entry.utf8))
            try? handle.close()
        } else {
            try? Data(entry.utf8).write(to: file)
        }
    }
}

enum CallNotice {
    static let reconnecting = "Reconectando…"
    static let deaf = "Não estou te ouvindo, confira o microfone."
    static let blocked = "O microfone está bloqueado para o r/bots."
}

enum CallDebug {
    private static let logger = Logger(subsystem: "runelay.bots", category: "voice-call")
    private static let queue = DispatchQueue(label: "runelay.bots.voice-debug")

    static func log(_ line: String) {
        logger.info("\(line, privacy: .public)")
        let entry = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        queue.async {
            let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
                .appendingPathComponent("runelay bots", isDirectory: true)
            guard let folder else { return }
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("voice-debug.log")
            if let attributes = try? FileManager.default.attributesOfItem(atPath: file.path), let size = attributes[.size] as? Int, size > 2_000_000 {
                try? FileManager.default.removeItem(at: file)
            }
            if let handle = try? FileHandle(forWritingTo: file) {
                handle.seekToEndOfFile()
                handle.write(Data(entry.utf8))
                try? handle.close()
            } else {
                try? Data(entry.utf8).write(to: file)
            }
        }
    }
}

@MainActor
@Observable
final class VoicePreviewPlayer {
    static let shared = VoicePreviewPlayer()

    private(set) var playingID: String?
    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var observer: NSObjectProtocol?

    func toggle(_ voice: VoiceOption) {
        if playingID == voice.id {
            stop()
            return
        }
        stop()
        guard let url = voice.previewURL else { return }
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        observer = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.stop()
            }
        }
        self.player = player
        playingID = voice.id
        player.play()
    }

    func stop() {
        player?.pause()
        player = nil
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        observer = nil
        playingID = nil
    }
}
