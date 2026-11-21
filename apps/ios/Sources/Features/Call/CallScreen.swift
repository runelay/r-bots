import AVFoundation
import SwiftUI

enum CallAudioSession {
    static func activate() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            return true
        } catch {
            return false
        }
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

struct CallScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let bot: Bot
    let store: ConversationStore
    private let call = VoiceCall.shared
    @State private var hungUp = 0

    private var mood: CharacterMood {
        switch call.phase {
        case .botSpeaking: .speaking
        case .thinking, .connecting: .thinking
        case .idle: call.failure == nil ? .idle : .error
        case .listening, .userSpeaking: call.botWorking ? .thinking : .idle
        }
    }

    private var status: String {
        if let failure = call.failure { return failure }
        switch call.phase {
        case .idle: return "Chamada encerrada"
        case .connecting: return "Conectando…"
        case .listening: return call.isMuted ? "Microfone desligado" : "Ouvindo"
        case .userSpeaking: return "Ouvindo você"
        case .thinking: return "Pensando…"
        case .botSpeaking: return "Falando"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: Spacing.xxl)
            VStack(spacing: Spacing.l) {
                BotAvatar(bot: bot, mood: mood, size: 168)
                    .scaleEffect(call.phase == .botSpeaking && !reduceMotion ? 1.04 : 1)
                    .animation(Motion.spring, value: call.phase)
                VStack(spacing: Spacing.xs) {
                    Text(bot.name)
                        .font(BrandFonts.sans(28, weight: .semibold))
                        .tracking(-0.5)
                        .foregroundStyle(Theme.textPrimary)
                    HStack(spacing: Spacing.s) {
                        Text(status)
                            .foregroundStyle(call.failure == nil ? Theme.textSecondary : Theme.danger)
                        if let started = call.startedAt {
                            Text("·").foregroundStyle(Theme.textTertiary)
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                Text(AttachmentFormat.clock(context.date.timeIntervalSince(started)))
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.textTertiary)
                            }
                        }
                    }
                    .font(TypeScale.rowSubtitle)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)
                    .animation(Motion.spring, value: status)
                }
            }
            Waveform(levels: call.levels.suffix(28).map { $0 }, color: call.levelsAreBot ? Theme.brandText : Theme.textTertiary)
                .frame(width: 180, height: 32)
                .padding(.top, Spacing.xl)
                .opacity(call.phase == .idle ? 0 : 1)
            captions
                .padding(.top, Spacing.xl)
                .padding(.horizontal, Spacing.xl)
            Spacer(minLength: Spacing.xl)
            controls
                .padding(.bottom, Spacing.xl)
        }
        .frame(maxWidth: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .sensoryFeedback(.impact(weight: .medium), trigger: hungUp)
        .sensoryFeedback(.selection, trigger: call.isMuted)
        .task {
            guard !call.isActive(for: bot.id) else { return }
            guard CallAudioSession.activate() else { return }
            call.start(bot: bot, store: store, client: model.client)
        }
        .onChange(of: call.phase) { _, phase in
            if phase == .idle, call.failure == nil {
                CallAudioSession.deactivate()
                dismiss()
            }
        }
    }

    private var captions: some View {
        VStack(spacing: Spacing.s) {
            if !call.botCaption.isEmpty {
                Text(call.botCaption)
                    .font(BrandFonts.sans(17, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(4)
                    .transition(.opacity)
            }
            if !call.userCaption.isEmpty {
                Text(call.userCaption)
                    .font(BrandFonts.sans(15))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                    .transition(.opacity)
            }
        }
        .multilineTextAlignment(.center)
        .frame(minHeight: 96, alignment: .top)
        .animation(Motion.spring, value: call.botCaption)
    }

    private var controls: some View {
        HStack(spacing: 56) {
            VStack(spacing: Spacing.s) {
                Button {
                    call.toggleMute()
                } label: {
                    Image(systemName: call.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(call.isMuted ? Theme.onAccent : Theme.textPrimary)
                        .frame(width: 72, height: 72)
                        .background(call.isMuted ? Theme.textPrimary : Color.clear, in: Circle())
                        .glassEffect(.regular.interactive(), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(call.phase == .idle)
                .accessibilityLabel(call.isMuted ? "Ligar microfone" : "Desligar microfone")
                Text(call.isMuted ? "Mudo" : "Microfone")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
            VStack(spacing: Spacing.s) {
                Button {
                    hungUp += 1
                    if call.isActive {
                        call.hangUp()
                    }
                    CallAudioSession.deactivate()
                    dismiss()
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 72, height: 72)
                        .background(Theme.danger, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Encerrar")
                Text("Encerrar")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }
}
