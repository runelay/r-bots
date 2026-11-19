import SwiftUI

struct CallOverlay: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let bot: Bot
    private let call = VoiceCall.shared

    var body: some View {
        VStack(spacing: Spacing.s) {
            if call.isActive(for: bot.id) {
                CallBar(bot: bot)
                    .transition(transition)
                if call.captionsVisible || call.notice != nil || call.quietMicrophone != nil {
                    CallCaptions()
                        .transition(.opacity)
                }
            } else if let failure = call.failure {
                CallFailure(message: failure)
                    .transition(transition)
            }
        }
        .padding(.top, Spacing.s)
        .padding(.horizontal, Spacing.xl)
        .frame(maxWidth: 440)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: call.isActive(for: bot.id))
        .animation(Motion.animation(reduceMotion: reduceMotion), value: call.captionsVisible)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: call.failure)
    }

    private var transition: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -12)).combined(with: .scale(scale: 0.96, anchor: .top))
    }
}

struct CallBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let bot: Bot
    private let call = VoiceCall.shared

    var body: some View {
        @Bindable var call = call
        HStack(spacing: Spacing.s) {
            BotCharacter(bot: bot, mood: mood, size: 22)
                .padding(.leading, Spacing.xs)
            CallDots(levels: call.levels, isBot: call.levelsAreBot && call.phase == .botSpeaking, isIdle: call.phase == .connecting)
                .frame(width: 92, height: 20)
                .clipped()
            CallClock(startedAt: call.startedAt, connecting: call.phase == .connecting)
                .fixedSize()
                .padding(.trailing, Spacing.s)
            CallIconButton(systemImage: "gearshape", help: "Voz, idioma e microfone", isActive: call.settingsOpen) {
                call.settingsOpen.toggle()
            }
            .popover(isPresented: $call.settingsOpen, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: Spacing.m) {
                    VoiceSettingsForm(botID: bot.id)
                    MicrophonePicker { _ in
                        call.microphoneChanged()
                    }
                    PushToTalkToggle()
                }
                .padding(Spacing.l)
                .frame(width: 300)
            }
            CallIconButton(systemImage: call.captionsVisible ? "captions.bubble.fill" : "captions.bubble", help: call.captionsVisible ? "Esconder legendas" : "Mostrar legendas", isActive: call.captionsVisible) {
                call.captionsVisible.toggle()
            }
            if call.pushToTalk {
                HoldToTalkButton()
            } else {
                CallIconButton(systemImage: call.isMuted ? "mic.slash.fill" : "mic", help: call.isMuted ? "Ativar microfone" : "Silenciar microfone", isActive: call.isMuted) {
                    call.toggleMute()
                }
            }
            Button {
                call.hangUp()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.onAccent)
                    .frame(width: 28, height: 28)
                    .background(Theme.danger, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Desligar")
            .accessibilityLabel("Desligar")
        }
        .padding(Spacing.xs + 1)
        .fixedSize()
        .glassSurface(Capsule(), fallback: Theme.surface)
        .softElevation()
        .help(call.lastLatency ?? "")
        .springAnimation(value: call.isMuted)
        .springAnimation(value: call.settingsOpen)
    }

    private var mood: CharacterMood {
        switch call.phase {
        case .botSpeaking: .speaking
        case .thinking, .connecting: .thinking
        default: call.botWorking ? .thinking : .idle
        }
    }
}

struct PushToTalkToggle: View {
    private let call = VoiceCall.shared

    var body: some View {
        @Bindable var call = call
        Toggle(isOn: $call.pushToTalk) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Apertar para falar")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                Text("Só ouve enquanto você segura ⌥Espaço ou o microfone. Bom para lugar barulhento.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
    }
}

struct HoldToTalkButton: View {
    private let call = VoiceCall.shared

    var body: some View {
        Image(systemName: call.isTalking ? "mic.fill" : "mic")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(call.isTalking ? Theme.onAccent : Theme.textSecondary)
            .frame(width: 28, height: 28)
            .background(call.isTalking ? Theme.brandAccent : Theme.hover, in: Circle())
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        call.beginTalk()
                    }
                    .onEnded { _ in
                        call.endTalk()
                    }
            )
            .springAnimation(value: call.isTalking)
            .help("Segure para falar (ou ⌥Espaço)")
            .accessibilityLabel("Segure para falar")
            .accessibilityAddTraits(.isButton)
    }
}

struct CallIconButton: View {
    let systemImage: String
    let help: String
    var isActive = false
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isActive || isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 28, height: 28)
                .background(isActive ? Theme.selection : isHovering ? Theme.hover : .clear, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct CallDots: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let levels: [CGFloat]
    let isBot: Bool
    let isIdle: Bool

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                let value = reduceMotion || isIdle ? 0 : level
                Capsule(style: .continuous)
                    .fill(isBot ? Theme.brandAccent : Theme.textSecondary)
                    .frame(width: 3.5, height: 3.5 + 14 * value)
                    .opacity(0.4 + 0.6 * Double(max(value, isBot ? 0.35 : 0)))
            }
        }
        .frame(maxHeight: .infinity)
        .animation(reduceMotion ? nil : .linear(duration: 0.08), value: levels)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: isBot)
        .accessibilityHidden(true)
    }
}

struct CallClock: View {
    let startedAt: Date?
    let connecting: Bool

    var body: some View {
        if connecting || startedAt == nil {
            Text("Conectando…")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        } else if let startedAt {
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                Text(CallDuration.format(Int(context.date.timeIntervalSince(startedAt))))
                    .font(TypeScale.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
            }
        }
    }
}

enum CallDuration {
    static func format(_ seconds: Int) -> String {
        let value = max(seconds, 0)
        return String(format: "%02d:%02d", value / 60, value % 60)
    }
}

struct CallNoticeLine: View {
    let message: String

    var body: some View {
        HStack(spacing: Spacing.xs) {
            if message == CallNotice.reconnecting {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Image(systemName: "mic.badge.xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.danger)
            }
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.xs + 2)
        .glassSurface(Capsule(), fallback: Theme.surface)
        .allowsHitTesting(false)
        .accessibilityLabel(message)
    }
}

struct CallQuietMicrophoneLine: View {
    let name: String

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: "mic.badge.xmark")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.danger)
            Text("Não estou te ouvindo pelo \(name)")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
            Text("·")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
            Button("Trocar") {
                VoiceCall.shared.openMicrophonePicker()
            }
            .buttonStyle(.plain)
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.brandText)
            .clickable()
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.xs + 2)
        .glassSurface(Capsule(), fallback: Theme.surface)
        .accessibilityElement(children: .combine)
    }
}

struct CallCaptions: View {
    private let call = VoiceCall.shared

    var body: some View {
        let showsBot = call.phase == .botSpeaking && !call.botCaption.isEmpty
        let text = showsBot ? call.botCaption : call.userCaption
        if let quiet = call.quietMicrophone {
            CallQuietMicrophoneLine(name: quiet)
                .transition(.opacity)
        } else if let notice = call.notice {
            CallNoticeLine(message: notice)
                .transition(.opacity)
        } else if !text.isEmpty {
            Text(text)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(showsBot ? Theme.textPrimary : Theme.textSecondary)
                .lineLimit(2)
                .truncationMode(.head)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.xs + 2)
                .glassSurface(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous), fallback: Theme.surface)
                .contentTransition(.opacity)
                .allowsHitTesting(false)
                .accessibilityLabel(showsBot ? "Bot: \(text)" : "Você: \(text)")
        }
    }
}

struct CallFailure: View {
    let message: String

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(Theme.danger)
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
            if message == CallNotice.blocked {
                Button("Abrir Ajustes") {
                    VoiceCall.shared.openMicrophoneSettings()
                }
                .buttonStyle(.link)
                .font(TypeScale.captionStrong)
                .clickable()
            }
            Button("Fechar") {
                VoiceCall.shared.dismissFailure()
            }
            .buttonStyle(.link)
            .font(TypeScale.caption)
            .clickable()
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.s)
        .glassSurface(Capsule(), fallback: Theme.surface)
    }
}

struct CallStartButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let store: ConversationStore
    let bot: Bot
    private let call = VoiceCall.shared

    var body: some View {
        let active = call.isActive(for: bot.id)
        Button {
            call.toggle(bot: bot, store: store, client: model.client)
        } label: {
            Image(systemName: "waveform")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.onAccent)
                .frame(width: 34, height: 34)
                .glassSurface(Circle(), interactive: true, tint: Theme.brandAccent, fallback: Theme.brandAccent)
                .modifier(SoftPulse(isEnabled: active && !reduceMotion))
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .help(active ? "Encerrar o chat de voz" : "Começar um chat de voz com \(bot.name)")
        .accessibilityLabel(active ? "Encerrar o chat de voz" : "Chat de voz")
    }
}

struct VoiceMark: View {
    var body: some View {
        Image(systemName: "waveform")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Theme.textTertiary)
            .help("Falado na chamada de voz")
            .accessibilityLabel("Por voz")
    }
}

struct VoiceCallLine: View {
    let seconds: Int
    let rating: String?
    let rate: (String?) -> Void

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "waveform")
                .font(.system(size: 11, weight: .semibold))
            Text("Chat de voz · \(CallDuration.format(seconds))")
                .monospacedDigit()
            RatingButton(systemImage: rating == "up" ? "hand.thumbsup.fill" : "hand.thumbsup", help: "Chamada boa", isOn: rating == "up") {
                rate(rating == "up" ? nil : "up")
            }
            RatingButton(systemImage: rating == "down" ? "hand.thumbsdown.fill" : "hand.thumbsdown", help: "Chamada ruim", isOn: rating == "down") {
                rate(rating == "down" ? nil : "down")
            }
        }
        .font(TypeScale.captionStrong)
        .foregroundStyle(Theme.textSecondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xs)
        .springAnimation(value: rating)
    }
}

struct RatingButton: View {
    let systemImage: String
    let help: String
    let isOn: Bool
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isOn ? Theme.brandText : isHovering ? Theme.textPrimary : Theme.textTertiary)
                .frame(width: 22, height: 22)
                .background(isHovering ? Theme.hover : .clear, in: Circle())
                .contentShape(Circle())
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct VoiceChatSection: View {
    let bot: Bot

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            SectionCaption(title: "Chat de voz")
            SoftCard {
                VoiceSettingsForm(botID: bot.id)
            }
        }
    }
}

struct VoiceSettingsForm: View {
    @Environment(AppModel.self) private var model
    let botID: String
    @State private var voices: [VoiceOption] = []
    @State private var settings: BotVoiceSettings?
    @State private var speed: Double = 1
    @State private var loadError: String?
    @State private var saveTask: Task<Void, Never>?
    private let preview = VoicePreviewPlayer.shared

    @State private var voicePickerOpen = false

    private static let speeds: [Double] = [0.8, 0.9, 1.0, 1.1, 1.2]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            settingRow("Voz") {
                Button {
                    voicePickerOpen.toggle()
                } label: {
                    SettingPill(text: voiceSummary, isOpen: voicePickerOpen)
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(settings == nil)
                .popover(isPresented: $voicePickerOpen, arrowEdge: .bottom) {
                    voicePicker
                }
            }
            settingRow("Idioma") {
                Menu {
                    ForEach(BotVoiceSettings.languages, id: \.id) { language in
                        Button {
                            save { $0.language = language.id }
                        } label: {
                            if settings?.language == language.id {
                                Label(language.label, systemImage: "checkmark")
                            } else {
                                Text(language.label)
                            }
                        }
                    }
                } label: {
                    SettingPill(text: languageLabel, isOpen: false)
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .clickable()
                .disabled(settings == nil)
            }
            if let loadError {
                Text(loadError)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
        .task(id: botID) {
            await load()
        }
        .onDisappear {
            preview.stop()
        }
    }

    private func settingRow<Control: View>(_ title: String, @ViewBuilder control: () -> Control) -> some View {
        HStack(spacing: Spacing.m) {
            Text(title)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
            Spacer(minLength: Spacing.s)
            control()
        }
        .frame(minHeight: 34)
    }

    private var voiceSummary: String {
        let name = voices.first { $0.voiceId == settings?.voiceId }?.shortName ?? (settings == nil ? "…" : "Voz")
        return "\(name) \(speed.formatted(.number.precision(.fractionLength(1))))×"
    }

    private var languageLabel: String {
        BotVoiceSettings.languages.first { $0.id == settings?.language }?.label ?? "Português"
    }

    private var voicePicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            if voices.isEmpty {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(voices) { voice in
                            VoiceRow(
                                voice: voice,
                                isSelected: settings?.voiceId == voice.voiceId,
                                isPlaying: preview.playingID == voice.voiceId,
                                select: { choose(voice) },
                                play: { preview.toggle(voice) }
                            )
                        }
                    }
                    .padding(Spacing.xs)
                }
                .frame(height: min(CGFloat(voices.count) * 48 + Spacing.s, 288))
                .scrollEdgesHidden()
            }
            HStack(spacing: Spacing.xxs) {
                Text("Velocidade")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .fixedSize()
                Spacer(minLength: Spacing.s)
                ForEach(Self.speeds, id: \.self) { value in
                    let isOn = abs(speed - value) < 0.01
                    Button {
                        speed = value
                        save { $0.speed = value }
                    } label: {
                        Text(value.formatted(.number.precision(.fractionLength(1))) + "×")
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .fixedSize()
                            .foregroundStyle(isOn ? Theme.textPrimary : Theme.textSecondary)
                            .padding(.horizontal, Spacing.s)
                            .frame(height: 24)
                            .background(isOn ? Theme.selection : .clear, in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .clickable()
                }
            }
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, Spacing.s)
        }
        .frame(width: 340)
        .springAnimation(value: speed)
    }

    private func load() async {
        let api = VoiceCallClient(client: model.client)
        loadError = nil
        do {
            async let list = api.voices()
            async let current = api.voiceSettings(botID: botID)
            let (fetched, value) = try await (list, current)
            voices = fetched
            settings = value
            speed = value.speed
        } catch {
            loadError = "Não consegui carregar as vozes. Tenta de novo."
        }
    }

    private func choose(_ voice: VoiceOption) {
        save { $0.voiceId = voice.voiceId }
    }

    private func save(_ change: (inout BotVoiceSettings) -> Void) {
        guard var next = settings else { return }
        let previous = next
        change(&next)
        guard next != previous else { return }
        settings = next
        let api = VoiceCallClient(client: model.client)
        let botID = botID
        saveTask?.cancel()
        saveTask = Task {
            do {
                let saved = try await api.updateVoice(botID: botID, settings: next)
                guard !Task.isCancelled else { return }
                settings = saved
                VoiceCall.shared.voiceChanged(botID: botID)
            } catch {
                guard !Task.isCancelled else { return }
                settings = previous
                speed = previous.speed
                loadError = "Não consegui salvar a voz. Tenta de novo."
            }
        }
    }
}

struct SettingPill: View {
    let text: String
    let isOpen: Bool
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Text(text)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
                .rotationEffect(.degrees(isOpen ? 180 : 0))
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 30)
        .background(isOpen || isHovering ? Theme.surfaceRaised : Theme.hover, in: Capsule())
        .contentShape(Capsule())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isOpen)
    }
}

struct VoiceRow: View {
    let voice: VoiceOption
    let isSelected: Bool
    let isPlaying: Bool
    let select: () -> Void
    let play: () -> Void
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: Spacing.s) {
            Button(action: play) {
                Image(systemName: isPlaying ? "stop.fill" : "play.fill")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(isPlaying ? Theme.onAccent : Theme.textSecondary)
                    .frame(width: 24, height: 24)
                    .background(isPlaying ? Theme.brandAccent : Theme.surfaceRaised, in: Circle())
                    .contentShape(Circle())
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(voice.previewURL == nil)
            .help(isPlaying ? "Parar a prévia" : "Ouvir a prévia")
            Button(action: select) {
                HStack(spacing: Spacing.s) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(voice.shortName)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        if !voice.subtitle.isEmpty {
                            Text(voice.subtitle)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Theme.brandText)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
        }
        .padding(.horizontal, Spacing.s)
        .padding(.vertical, Spacing.xs)
        .background(isSelected ? Theme.selection : isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .springAnimation(value: isSelected)
        .springAnimation(value: isPlaying)
    }
}
