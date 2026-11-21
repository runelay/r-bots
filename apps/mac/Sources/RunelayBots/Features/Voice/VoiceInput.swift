#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif
import AVFoundation
import Observation
import Speech
import SwiftUI

enum VoicePreferenceKeys {
    static let autoSend = "voiceAutoSend"
}

enum VoicePhase: Equatable {
    case idle
    case preparing
    case listening
    case finishing
}

enum VoicePermission: Equatable {
    case microphone
    case speech

    var message: String {
        switch self {
        case .microphone: "O microfone está bloqueado para o r/bots."
        case .speech: "O reconhecimento de fala está bloqueado para o r/bots."
        }
    }

    var settingsURL: URL? {
        #if os(iOS)
        return URL(string: UIApplication.openSettingsURLString)
        #else
        switch self {
        case .microphone: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        case .speech: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
        }
        #endif
    }
}

@MainActor
@Observable
final class VoiceInput {
    static let shared = VoiceInput()
    static let levelCount = 160
    static let silenceInterval: TimeInterval = 1.2

    private(set) var phase: VoicePhase = .idle
    private(set) var levels: [CGFloat] = Array(repeating: 0, count: VoiceInput.levelCount)
    private(set) var listeningSince: Date?
    private(set) var deniedPermission: VoicePermission?
    private(set) var failure: String?
    private(set) var quietMicrophone: String?
    private(set) var noticeOwner: ObjectIdentifier?
    private(set) weak var activeStore: ConversationStore?

    @ObservationIgnored weak var focusedStore: ConversationStore?
    @ObservationIgnored private var session: VoiceSession?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var textTask: Task<Void, Never>?
    @ObservationIgnored private var levelTask: Task<Void, Never>?
    @ObservationIgnored private var silenceTask: Task<Void, Never>?
    @ObservationIgnored private var baseDraft = ""
    @ObservationIgnored private var transcript = ""
    @ObservationIgnored private var lastActivity = Date()
    @ObservationIgnored private var keyMonitor: Any?
    @ObservationIgnored private var isHoldingShortcut = false
    @ObservationIgnored private let locale = Locale(identifier: "pt-BR")

    private init() {
        #if os(macOS)
        installShortcut()
        #endif
    }

    func isActive(for store: ConversationStore) -> Bool {
        activeStore === store && (phase == .preparing || phase == .listening)
    }

    func isBusy(for store: ConversationStore) -> Bool {
        activeStore === store && phase != .idle
    }

    func toggle(for store: ConversationStore) {
        if isActive(for: store) {
            stop()
        } else {
            start(for: store)
        }
    }

    func start(for store: ConversationStore) {
        guard phase == .idle, !VoiceCall.shared.isActive else { return }
        activeStore = store
        focusedStore = store
        baseDraft = store.draft
        transcript = ""
        deniedPermission = nil
        failure = nil
        quietMicrophone = nil
        noticeOwner = ObjectIdentifier(store)
        phase = .preparing
        startTask = Task { [weak self] in
            await self?.begin()
        }
    }

    func stop(send: Bool = false) {
        switch phase {
        case .idle, .finishing:
            return
        case .preparing:
            startTask?.cancel()
            session?.cancel()
            teardown()
        case .listening:
            phase = .finishing
            silenceTask?.cancel()
            let session = session
            Task { [weak self] in
                await session?.finish()
                self?.complete(send: send)
            }
        }
    }

    func release(_ store: ConversationStore) {
        if focusedStore === store {
            focusedStore = nil
        }
        guard activeStore === store, phase != .idle else { return }
        startTask?.cancel()
        session?.cancel()
        teardown()
    }

    func releaseForCall() {
        guard phase != .idle else { return }
        startTask?.cancel()
        session?.cancel()
        teardown()
    }

    func waitUntilIdle() async {
        for _ in 0..<20 where phase != .idle {
            try? await Task.sleep(for: .milliseconds(50))
        }
        try? await Task.sleep(for: .milliseconds(120))
    }

    func dismissNotice() {
        deniedPermission = nil
        failure = nil
        quietMicrophone = nil
        noticeOwner = nil
    }

    func switchMicrophone() {
        quietMicrophone = nil
        failure = nil
        guard let store = activeStore, phase == .listening else { return }
        stop()
        Task { [weak self] in
            await self?.waitUntilIdle()
            self?.start(for: store)
        }
    }

    func showsNotice(for store: ConversationStore) -> Bool {
        noticeOwner == ObjectIdentifier(store) && (deniedPermission != nil || failure != nil)
    }

    func openSettings(for permission: VoicePermission) {
        guard let url = permission.settingsURL else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }

    private func begin() async {
        guard await ensurePermissions() else {
            teardown()
            return
        }
        guard phase == .preparing, !Task.isCancelled else { return }
        if let lost = Microphones.takeMissing() {
            failure = Microphones.lostNotice(lost)
        }
        #if os(iOS)
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try audio.setActive(true)
        } catch {
            teardown()
            failure = "Não deu para ouvir o microfone agora."
            return
        }
        #endif
        let session = VoiceSession(locale: locale)
        self.session = session
        textTask = Task { [weak self] in
            for await text in session.texts {
                self?.receive(text)
            }
        }
        levelTask = Task { [weak self] in
            for await level in session.levels {
                self?.push(level)
            }
        }
        do {
            try await session.start()
        } catch {
            guard self.session === session else { return }
            session.cancel()
            teardown()
            failure = "Não deu para ouvir o microfone agora."
            return
        }
        guard phase == .preparing, self.session === session else {
            session.cancel()
            return
        }
        phase = .listening
        listeningSince = Date()
        lastActivity = Date()
        watchSilence()
    }

    private func ensurePermissions() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else {
                deniedPermission = .microphone
                return false
            }
        default:
            deniedPermission = .microphone
            return false
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .notDetermined:
            guard await Self.requestSpeechAuthorization() == .authorized else {
                deniedPermission = .speech
                return false
            }
            return true
        default:
            deniedPermission = .speech
            return false
        }
    }

    nonisolated private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private func receive(_ text: String) {
        guard phase != .idle, let store = activeStore else { return }
        if text != transcript {
            transcript = text
            lastActivity = Date()
        }
        store.draft = TranscriptJoiner.join(baseDraft, transcript)
    }

    private func push(_ level: Float) {
        guard phase == .listening else { return }
        var next = levels
        next.removeFirst()
        next.append(CGFloat(level))
        levels = next
        if level > 0.45 {
            lastActivity = Date()
        }
    }

    private func watchSilence() {
        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            var checkedQuiet = false
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(150))
                guard let self, self.phase == .listening else { return }
                if !checkedQuiet, let since = self.listeningSince, Date().timeIntervalSince(since) >= 3 {
                    checkedQuiet = true
                    if let session = self.session, session.peak < Microphones.quietPeak {
                        self.quietMicrophone = Microphones.activeName()
                        self.failure = "Não estou te ouvindo pelo \(self.quietMicrophone ?? "microfone")."
                    }
                }
                guard UserDefaults.standard.bool(forKey: VoicePreferenceKeys.autoSend) else { continue }
                let hasSpeech = !self.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if hasSpeech, Date().timeIntervalSince(self.lastActivity) >= Self.silenceInterval {
                    self.stop(send: true)
                    return
                }
            }
        }
    }

    private func complete(send: Bool) {
        guard phase == .finishing else { return }
        let store = activeStore
        teardown()
        guard let store else { return }
        store.draft = store.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard send, store.canSend else { return }
        withAnimation(Motion.animation(reduceMotion: prefersReducedMotion)) {
            store.send()
        }
    }

    private func teardown() {
        startTask = nil
        textTask?.cancel()
        levelTask?.cancel()
        silenceTask?.cancel()
        textTask = nil
        levelTask = nil
        silenceTask = nil
        session = nil
        activeStore = nil
        transcript = ""
        baseDraft = ""
        levels = Array(repeating: 0, count: Self.levelCount)
        listeningSince = nil
        phase = .idle
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private var prefersReducedMotion: Bool {
        Self.systemReducesMotion
            || UserDefaults.standard.string(forKey: PreferenceKeys.motion) == MotionPreference.reduced.rawValue
    }

    private static var systemReducesMotion: Bool {
        #if os(macOS)
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #else
        UIAccessibility.isReduceMotionEnabled
        #endif
    }

    #if os(macOS)
    private func installShortcut() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self else { return event }
            return self.handleShortcut(event)
        }
    }

    private func handleShortcut(_ event: NSEvent) -> NSEvent? {
        guard event.keyCode == 49, !VoiceCall.shared.handlesTalkShortcut else { return event }
        switch event.type {
        case .keyDown:
            if isHoldingShortcut {
                return nil
            }
            let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
            guard modifiers == .option, !event.isARepeat, let store = focusedStore else { return event }
            isHoldingShortcut = true
            start(for: store)
            return nil
        case .keyUp:
            guard isHoldingShortcut else { return event }
            isHoldingShortcut = false
            stop()
            return nil
        default:
            return event
        }
    }
    #endif
}
