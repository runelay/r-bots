import SwiftUI

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("Ajustes")
                    .font(TypeScale.pageTitle)
                    .tracking(Metrics.pageTitleTracking)
                    .foregroundStyle(Theme.textPrimary)
                    .padding(.horizontal, Spacing.m)
                    .padding(.bottom, Spacing.l)
                ForEach(SettingsSection.allCases) { section in
                    SettingsNavRow(section: section, isSelected: model.settingsSection == section) {
                        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                            model.settingsSection = section
                        }
                        if section == .bots {
                            Task {
                                await model.loadArchived()
                                await model.loadExtraBots()
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .padding(.top, Spacing.xl)
            .frame(width: 236)
            .frame(maxHeight: .infinity)
            .background(Theme.sidebarBackground)

            VStack(spacing: 0) {
                HStack {
                    Spacer(minLength: 0)
                    RoundIconButton(systemImage: "xmark", help: "Fechar ajustes (Esc)") {
                        model.closeSettings()
                    }
                }
                .padding(.horizontal, Spacing.xl)
                .padding(.top, Spacing.l)
                .frame(height: 52)

                ScrollView {
                    PageContainer(maxWidth: 860) {
                        VStack(alignment: .leading, spacing: Spacing.xl) {
                            Text(model.settingsSection.title)
                                .font(TypeScale.pageTitle)
                                .tracking(Metrics.pageTitleTracking)
                                .foregroundStyle(Theme.textPrimary)
                            switch model.settingsSection {
                            case .server: ServerSettings()
                            case .appearance: AppearanceSettings()
                            case .notifications: NotificationSettings()
                            case .bots: BotsSettings()
                            case .computer: ComputerSettings()
                            case .shortcuts: ShortcutsSettings()
                            case .about: AboutSettings()
                            }
                        }
                        .id(model.settingsSection)
                        .transition(.opacity)
                    }
                    .padding(.bottom, Spacing.xxl)
                }
                .scrollEdgesHidden()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
        }
        .background {
            Button("Fechar") {
                model.closeSettings()
            }
            .keyboardShortcut(.cancelAction)
            .opacity(0)
            .accessibilityHidden(true)
        }
        .springAnimation(value: model.settingsSection)
    }
}

struct PageContainer<Content: View>: View {
    var maxWidth: CGFloat = Metrics.pageWidth
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: maxWidth, alignment: .leading)
            .padding(.horizontal, Spacing.xxl + Spacing.xs)
            .frame(maxWidth: .infinity, alignment: .center)
    }
}

struct SettingsNavRow: View {
    let section: SettingsSection
    let isSelected: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(spacing: Spacing.m) {
                Image(systemName: section.systemImage)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isSelected ? Theme.brandText : Theme.textSecondary)
                    .frame(width: 18)
                Text(section.title)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 38)
            .background(isSelected ? Theme.selection : (isHovering ? Theme.hover : Theme.sidebarBackground), in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct SettingsGroup<Content: View>: View {
    let caption: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Text(caption)
                .font(TypeScale.sectionCaption)
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, Spacing.xs)
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        }
    }
}

struct SettingsRow<Trailing: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: Spacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                if let detail {
                    Text(detail)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Spacing.m)
            trailing
        }
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.m)
        .frame(minHeight: 52)
    }
}

struct ChoicePills<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let title: (Option) -> String

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            ForEach(options) { option in
                let isSelected = option == selection
                Button {
                    selection = option
                } label: {
                    Text(title(option))
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .padding(.horizontal, Spacing.m)
                        .frame(height: 28)
                        .background(isSelected ? Theme.surfaceRaised : Theme.surface, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .clickable()
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .springAnimation(value: selection)
    }
}

struct ServerSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage(ServerConfig.storageKey) private var serverURL = ServerConfig.defaultURL
    @State private var appliedURL: String = UserDefaults.standard.string(forKey: ServerConfig.storageKey) ?? ServerConfig.defaultURL
    @State private var busy: ServerAction?
    @State private var feedback: String?

    private enum ServerAction {
        case connect
        case test
    }

    private var isOffline: Bool {
        if case .offline = model.connection { return true }
        return false
    }

    private var canConnect: Bool {
        busy == nil && (serverURL != appliedURL || isOffline)
    }

    private func run(_ action: ServerAction) {
        busy = action
        feedback = nil
        if action == .connect {
            model.serverURLChanged()
            appliedURL = serverURL
        }
        Task {
            let started = Date()
            await model.checkConnection()
            let elapsed = Date().timeIntervalSince(started)
            if elapsed < 0.45 {
                try? await Task.sleep(for: .milliseconds(Int((0.45 - elapsed) * 1000)))
            }
            busy = nil
            switch model.connection {
            case .online(let count):
                let latency = model.lastLatencyMs.map { " em \($0) ms" } ?? ""
                feedback = action == .connect ? "Conectado, \(count) bots" : "Respondeu\(latency)"
            case .offline(let message):
                feedback = "Sem resposta: \(message)"
            default:
                feedback = nil
            }
            try? await Task.sleep(for: .seconds(4))
            feedback = nil
        }
    }

    private func actionLabel(_ title: String, for action: ServerAction) -> some View {
        HStack(spacing: Spacing.xs + 2) {
            if busy == action {
                ProgressView()
                    .controlSize(.small)
            }
            Text(title)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            SettingsGroup(caption: "Endereço") {
                VStack(alignment: .leading, spacing: Spacing.m) {
                    TextField("Servidor", text: $serverURL, prompt: Text(ServerConfig.defaultURL))
                        .textFieldStyle(.plain)
                        .font(TypeScale.body)
                        .autocorrectionDisabled()
                        .padding(.horizontal, Spacing.m)
                        .padding(.vertical, Spacing.s + 2)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                        .onSubmit {
                            run(.connect)
                        }
                    HStack(spacing: Spacing.s) {
                        if let feedback, busy == nil {
                            Text(feedback)
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(isOffline ? Theme.danger : Theme.textSecondary)
                                .transition(.opacity)
                        } else {
                            ConnectionStatusLine(status: model.connection)
                        }
                        Spacer(minLength: Spacing.s)
                        if serverURL != ServerConfig.defaultURL {
                            Button("Usar o padrão") {
                                serverURL = ServerConfig.defaultURL
                                run(.connect)
                            }
                            .buttonStyle(.brandSecondary)
                            .transition(.opacity)
                        }
                        if canConnect || busy == .connect {
                            Button {
                                run(.connect)
                            } label: {
                                actionLabel(isOffline && serverURL == appliedURL ? "Reconectar" : "Conectar", for: .connect)
                            }
                            .buttonStyle(.brandPrimary)
                            .disabled(busy != nil)
                            .transition(.opacity)
                        }
                    }
                    .springAnimation(value: canConnect)
                    .springAnimation(value: feedback)
                    .springAnimation(value: serverURL == ServerConfig.defaultURL)
                }
                .padding(Spacing.l)
            }

            SettingsGroup(caption: "Conexão") {
                SettingsRow(title: "Motor", detail: nil) {
                    Text(model.meta.engineLabel ?? (model.metaLoaded ? "Não informado" : "Indisponível"))
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                }
                SettingsRow(title: "Modelo", detail: nil) {
                    Text(model.meta.model.map(ModelNames.pretty) ?? "Indisponível")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                }
                SettingsRow(title: "Este Mac", detail: nil) {
                    MacLinkStatus(state: RunnerConnection.shared.state)
                }
                SettingsRow(title: "Latência", detail: "Tempo da última leitura da lista de bots.") {
                    Text(model.lastLatencyMs.map { "\($0) ms" } ?? "–")
                        .font(TypeScale.counter)
                        .foregroundStyle(Theme.textSecondary)
                        .contentTransition(.numericText())
                }
                HStack {
                    Spacer(minLength: 0)
                    Button {
                        run(.test)
                    } label: {
                        actionLabel("Testar conexão", for: .test)
                    }
                    .buttonStyle(.brandSecondary)
                    .disabled(busy != nil)
                }
                .padding(.horizontal, Spacing.l)
                .padding(.bottom, Spacing.l)
            }
        }
    }
}

struct AppearanceSettings: View {
    @AppStorage(PreferenceKeys.appearance) private var appearance = AppearancePreference.system.rawValue
    @AppStorage(PreferenceKeys.motion) private var motion = MotionPreference.system.rawValue
    @AppStorage(PreferenceKeys.textSize) private var textSize = ConversationTextSize.regular.rawValue

    var body: some View {
        SettingsGroup(caption: "Aparência do app") {
            SettingsRow(title: "Tema", detail: "Claro, escuro ou igual ao macOS.") {
                ChoicePills(
                    options: AppearancePreference.allCases,
                    selection: Binding(
                        get: { AppearancePreference(rawValue: appearance) ?? .system },
                        set: { appearance = $0.rawValue }
                    ),
                    title: \.title
                )
            }
            SettingsRow(title: "Reduzir movimento", detail: "Troca molas e ondas por transições curtas.") {
                ChoicePills(
                    options: MotionPreference.allCases,
                    selection: Binding(
                        get: { MotionPreference(rawValue: motion) ?? .system },
                        set: { motion = $0.rawValue }
                    ),
                    title: \.title
                )
            }
            SettingsRow(title: "Texto da conversa", detail: "Tamanho das mensagens e respostas.") {
                ChoicePills(
                    options: ConversationTextSize.allCases,
                    selection: Binding(
                        get: { ConversationTextSize(rawValue: textSize) ?? .regular },
                        set: { textSize = $0.rawValue }
                    ),
                    title: \.title
                )
            }
        }
    }
}

struct BotsSettings: View {
    @Environment(AppModel.self) private var model
    @State private var archiving: Bot?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            HStack {
                Spacer(minLength: 0)
                Button {
                    model.openEditor(for: nil)
                } label: {
                    Label("Novo bot", systemImage: "plus")
                }
                .buttonStyle(.brandPrimary)
            }

            SettingsGroup(caption: "No time") {
                ForEach(model.loadedBots) { bot in
                    SettingsBotRow(bot: bot) {
                        AutoApproveToggle(bot: bot, compact: true)
                        Button("Editar") {
                            model.openEditor(for: bot)
                        }
                        .buttonStyle(.brandSecondary)
                        .disabled(bot.isPending)
                        Button("Arquivar") {
                            archiving = bot
                        }
                        .buttonStyle(.plain)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.danger)
                        .clickable()
                        .disabled(bot.isPending)
                    }
                    .transition(.opacity)
                }
                if model.loadedBots.isEmpty {
                    Text("Nenhum bot no time.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(Spacing.l)
                }
            }
            .springAnimation(value: model.loadedBots.map(\.id))

            if case .loaded(let extra) = model.extraBots, !extra.isEmpty {
                SettingsGroup(caption: "Ocultos e excluídos") {
                    ForEach(extra) { bot in
                        SettingsBotRow(bot: bot, mood: .sleeping) {
                            if bot.isDeleted {
                                Button("Restaurar") {
                                    model.restoreDeleted(bot)
                                }
                                .buttonStyle(.brandPrimary)
                            } else {
                                Button("Mostrar") {
                                    model.showHidden(bot)
                                }
                                .buttonStyle(.brandSecondary)
                            }
                        }
                        .transition(.opacity)
                    }
                }
            }

            SettingsGroup(caption: "Arquivados") {
                switch model.archivedBots {
                case .idle, .loading:
                    SkeletonRow(width: 180)
                        .padding(.horizontal, Spacing.s)
                case .failed(let message):
                    Text(message)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(Spacing.l)
                case .loaded(let list):
                    if list.isEmpty {
                        Text("Nenhum bot arquivado.")
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textTertiary)
                            .padding(Spacing.l)
                    } else {
                        ForEach(list) { bot in
                            SettingsBotRow(bot: bot, mood: .sleeping) {
                                Button("Restaurar") {
                                    model.restore(bot)
                                }
                                .buttonStyle(.brandPrimary)
                            }
                            .transition(.opacity)
                        }
                    }
                }
            }
        }
        .confirmationDialog(
            "Arquivar \(archiving?.name ?? "bot")?",
            isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } })
        ) {
            Button("Arquivar", role: .destructive) {
                if let archiving {
                    model.archive(archiving)
                }
                archiving = nil
            }
            Button("Cancelar", role: .cancel) {
                archiving = nil
            }
        } message: {
            Text("Ele some da lista. Dá para restaurar aqui em Arquivados.")
        }
    }
}

struct SettingsBotRow<Actions: View>: View {
    let bot: Bot
    var mood: CharacterMood = .idle
    @ViewBuilder let actions: Actions

    var body: some View {
        HStack(spacing: Spacing.m) {
            BotCharacter(bot: bot, mood: mood, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                Text(bot.role.isEmpty ? "Sem função" : bot.role)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: Spacing.m)
            actions
        }
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.s + 2)
        .frame(minHeight: Metrics.rowHeight)
    }
}

struct ShortcutsSettings: View {
    private let shortcuts: [(String, String)] = [
        ("Escrever mensagem", "⌘N"),
        ("Enviar mensagem", "⌘↩"),
        ("Limpar o campo de mensagem", "Esc"),
        ("Novo bot", "⇧⌘N"),
        ("Mostrar ou ocultar o painel", "⌥⌘I"),
        ("Ajustes", "⌘,"),
        ("Fechar janela aberta por cima", "Esc"),
        ("Falar com o bot (segure)", "⌥Espaço")
    ]
    @AppStorage(VoicePreferenceKeys.autoSend) private var voiceAutoSend = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            SettingsGroup(caption: "Voz") {
                SettingsRow(title: "Enviar ao terminar de falar", detail: "Manda a mensagem sozinha depois de 1,2 s de silêncio.") {
                    Toggle("Enviar ao terminar de falar", isOn: $voiceAutoSend)
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .tint(Theme.brandAccent)
                        .clickable()
                }
                MicrophonePicker { _ in
                    VoiceCall.shared.microphoneChanged()
                }
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.s)
            }
            SettingsGroup(caption: "Teclado") {
                ForEach(shortcuts, id: \.0) { shortcut in
                    SettingsRow(title: shortcut.0, detail: nil) {
                        Text(shortcut.1)
                            .font(TypeScale.counter)
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, Spacing.s + 2)
                            .frame(height: 26)
                            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                    }
                }
            }
        }
    }
}

struct AboutSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            HStack(alignment: .center, spacing: Spacing.s + 2) {
                RunelayAppMark(size: 36)
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    RunelayWordmark(height: 26)
                    Text("bots")
                        .font(BrandFonts.sans(19, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            SettingsGroup(caption: "Versões") {
                SettingsRow(title: "App", detail: "runelay bots para Mac") {
                    Text(AppInfo.version)
                        .font(TypeScale.counter)
                        .foregroundStyle(Theme.textSecondary)
                }
                SettingsRow(title: "Servidor", detail: model.meta.engineLabel) {
                    Text(model.meta.version ?? "Não informado")
                        .font(TypeScale.counter)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            SettingsGroup(caption: "Servidor") {
                SettingsRow(title: ServerConfig.currentURL().host() ?? "Servidor", detail: ServerConfig.currentURL().absoluteString) {
                    Link(destination: ServerConfig.currentURL()) {
                        Label("Abrir no navegador", systemImage: "arrow.up.right")
                            .font(TypeScale.captionStrong)
                    }
                    .clickable()
                }
            }
        }
    }
}

struct ConnectionStatusLine: View {
    let status: ConnectionStatus

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "circle.fill")
                .font(.system(size: 8))
                .foregroundStyle(Theme.connection(status))
                .symbolEffect(.pulse, options: .repeating, isActive: status == .checking)
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
        }
        .springAnimation(value: status)
    }

    private var label: String {
        switch status {
        case .unknown: "Ainda não testado"
        case .checking: "Conectando…"
        case .online(let count): count == 1 ? "Conectado, 1 bot" : "Conectado, \(count) bots"
        case .offline(let message): "Sem conexão. \(message)"
        }
    }
}

struct NotificationSettings: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            if !Notifier.shared.isAvailable {
                Text("As notificações funcionam no app instalado (RunelayBots.app).")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
            }
            SettingsGroup(caption: "Avisar quando") {
                ForEach(NotificationPreference.allCases) { preference in
                    NotificationToggleRow(preference: preference)
                }
            }
            Text("O número no ícone do Dock mostra o total de mensagens não lidas.")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        }
    }
}

struct NotificationToggleRow: View {
    let preference: NotificationPreference
    @AppStorage private var isOn: Bool

    init(preference: NotificationPreference) {
        self.preference = preference
        _isOn = AppStorage(wrappedValue: true, preference.key)
    }

    var body: some View {
        SettingsRow(title: preference.title, detail: preference.detail) {
            Toggle(preference.title, isOn: $isOn)
                .toggleStyle(.switch)
                .labelsHidden()
                .tint(Theme.brandAccent)
                .clickable()
        }
    }
}

struct MacLinkStatus: View {
    let state: RunnerLinkState

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "circle.fill")
                .font(.system(size: 8))
                .foregroundStyle(color)
                .symbolEffect(.pulse, options: .repeating, isActive: state == .connecting)
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
        }
        .springAnimation(value: state)
    }

    private var label: String {
        switch state {
        case .connecting: "Conectando o Mac ao servidor…"
        case .connected: "Mac conectado ao servidor"
        case .offline(let message): message
        }
    }

    private var color: Color {
        switch state {
        case .connecting: Theme.textTertiary
        case .connected: Theme.success
        case .offline: Theme.warning
        }
    }
}
