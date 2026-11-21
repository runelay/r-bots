import SwiftUI

struct ComposerView: View {
    let store: ConversationStore
    let bot: Bot
    let focusToken: Int
    var mentionables: [Bot] = []
    @State private var isFocused = false
    @State private var focusRequest = 0
    @State private var composerHeight = ComposerTextView.minimumHeight
    @Environment(\.appReduceMotion) private var reduceMotion
    @Environment(AppModel.self) private var model
    @State private var slashSelection = 0
    @State private var dismissedSlashDraft: String?
    private let voice = VoiceInput.shared
    private let skillCatalog = SkillCatalog.shared

    private var composerActions: [GlassMenuItem] {
        var items: [GlassMenuItem] = []
        if !bot.isGroup {
            items.append(
                GlassMenuItem("Trabalhar num repositório…", systemImage: "arrow.triangle.branch") {
                    model.activeSheet = .repoPicker(bot.id)
                })
            if store.codeState?.workspace != nil {
                items.append(
                    GlassMenuItem("Ver mudanças", systemImage: "plusminus") {
                        store.changesWorkspaceID = nil
                        model.activeSheet = .changes(bot.id)
                    })
            }
            items.append(
                GlassMenuItem("Anexar arquivo…", systemImage: "paperclip", startsSection: true) {
                    AttachmentPicker.choose(for: store)
                })
        }
        items.append(
            GlassMenuItem("Perfil de \(bot.name)", id: "profile", systemImage: "person.crop.circle", startsSection: !items.isEmpty) {
                store.onOpenProfile?()
            })
        items.append(
            GlassMenuItem("Limpar campo", systemImage: "eraser", isEnabled: !(store.draft.isEmpty && store.composerAttachments.isEmpty)) {
                store.clearDraft()
            })
        return items
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: Spacing.s) {
            GlassMenuButton(help: "Mais ações", items: { composerActions }) { _ in
                ComposerIcon(systemName: "plus")
            }

            ComposerTextView(
                store: store,
                draft: store.draft,
                tokens: store.draftTokens,
                uploadStates: store.composerAttachments.map(\.state),
                height: $composerHeight,
                focusRequest: focusRequest,
                placeholder: placeholder,
                onFocusChange: { focused in isFocused = focused },
                onPasteAttachments: pasteAttachments,
                onCommand: handle
            )
            .frame(height: composerHeight)
            .overlay(alignment: .topLeading) {
                if store.draft.isEmpty && !placeholder.isEmpty {
                    Text(placeholder)
                        .font(TypeScale.body)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .padding(.vertical, ComposerTextView.verticalInset)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .leading) {
                if isListening && store.draft.isEmpty {
                    listeningIndicator
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }

            if isListening && !store.draft.isEmpty && !reduceMotion {
                VoiceWaveform(voice: voice, barCount: 8, height: 14)
                    .transition(.opacity)
            }

            if store.canStop && !store.canSend && !isListening {
                Button {
                    store.cancelTurn()
                } label: {
                    ComposerIcon(systemName: "stop.fill", size: 12, weight: .semibold, color: Theme.textPrimary)
                }
                .buttonStyle(PressableButtonStyle())
                .help("Parar este turno")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }

            if isListening {
                VoiceStopButton {
                    voice.stop()
                }
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            } else {
                Button {
                    voice.toggle(for: store)
                } label: {
                    ComposerIcon(systemName: "mic")
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(voice.phase != .idle || VoiceCall.shared.isActive(for: bot.id))
                .help("Ditar (ou segure ⌥Espaço)")
                .accessibilityLabel("Ditar")
                .transition(.scale(scale: 0.6).combined(with: .opacity))

                if store.canSend {
                    Button {
                        send()
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Theme.onAccent)
                            .frame(width: 34, height: 34)
                            .background(Theme.brandAccent, in: Circle())
                    }
                    .buttonStyle(PressableButtonStyle())
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("Enviar (⌘↩)")
                    .accessibilityLabel("Enviar")
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                } else if !bot.isGroup && !bot.isPending {
                    CallStartButton(store: store, bot: bot)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            }
        }
        .padding(.leading, Spacing.s)
        .padding(.trailing, Spacing.s)
        .padding(.vertical, Spacing.s)
        .glassPane(RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: ComposerHeightKey.self, value: proxy.size.height)
            }
        }
        .offset(y: isFocused && !reduceMotion ? -1 : 0)
        .springAnimation(value: isFocused)
        .springAnimation(value: store.canSend)
        .springAnimation(value: store.canStop)
        .springAnimation(value: isListening)
        .overlay(alignment: .top) {
            if voice.showsNotice(for: store) {
                VoiceNoticeLine(voice: voice)
                    .alignmentGuide(.top) { dimensions in dimensions[.bottom] + Spacing.s }
                    .transition(.opacity.combined(with: .offset(y: 6)))
            }
        }
        .springAnimation(value: voice.showsNotice(for: store))
        .overlay(alignment: .topLeading) {
            if !suggestions.isEmpty {
                MentionList(members: suggestions) { member in
                    insertMention(member)
                }
                .alignmentGuide(.top) { dimensions in dimensions[.bottom] + Spacing.s }
                .padding(.leading, Spacing.xl)
                .transition(.opacity.combined(with: .offset(y: 6)))
            }
        }
        .springAnimation(value: suggestions.map(\.id))
        .overlay(alignment: .topLeading) {
            if slashQuery != nil {
                SlashMenu(
                    commands: slashCommands,
                    skills: skillCatalog.results,
                    isLoading: skillCatalog.isLoading,
                    failed: skillCatalog.failed,
                    unavailable: skillCatalog.unavailable,
                    selection: slashSelection,
                    hover: { index in slashSelection = index },
                    select: { item in chooseSlash(item) },
                    retry: { skillCatalog.retry(client: model.client) }
                )
                .frame(maxWidth: 520, alignment: .leading)
                .padding(.bottom, Spacing.s)
                .frame(height: 0, alignment: .bottomLeading)
                .transition(
                    reduceMotion
                        ? .opacity
                        : .asymmetric(
                            insertion: .opacity
                                .combined(with: .scale(scale: 0.86, anchor: .bottomLeading))
                                .combined(with: .offset(y: 6)),
                            removal: .opacity.combined(with: .scale(scale: 0.96, anchor: .bottomLeading))
                        )
                )
            }
        }
        .animation(reduceMotion ? Motion.reduced : .spring(response: 0.32, dampingFraction: 0.78), value: slashQuery != nil)
        .onChange(of: slashQuery) {
            slashSelection = 0
            if let query = slashQuery {
                skillCatalog.search(query, client: model.client)
            } else {
                skillCatalog.close()
            }
        }
        .onAppear {
            focus()
            voice.focusedStore = store
            skillCatalog.prefetch(client: model.client)
        }
        .onDisappear {
            voice.release(store)
        }
        .onChange(of: isFocused) {
            if isFocused {
                voice.focusedStore = store
            }
        }
        .onChange(of: focusToken) {
            focus()
        }
    }

    private func focus() {
        focusRequest &+= 1
    }

    private func handle(_ command: ComposerCommand) -> Bool {
        switch command {
        case .submit:
            if slashQuery != nil {
                if slashItems.indices.contains(slashSelection) {
                    chooseSlash(slashItems[slashSelection])
                }
                return true
            }
            send()
            return true
        case .moveUp:
            guard !slashItems.isEmpty else { return false }
            slashSelection = max(0, slashSelection - 1)
            return true
        case .moveDown:
            guard !slashItems.isEmpty else { return false }
            slashSelection = min(slashItems.count - 1, slashSelection + 1)
            return true
        case .tab:
            if slashQuery != nil {
                if slashItems.indices.contains(slashSelection) {
                    chooseSlash(slashItems[slashSelection])
                }
                return true
            }
            guard let first = suggestions.first else { return false }
            insertMention(first)
            return true
        case .escape:
            if slashQuery != nil {
                dismissedSlashDraft = store.draft
                return true
            }
            if isListening {
                voice.stop()
                return true
            }
            guard !store.draft.isEmpty else { return false }
            store.clearDraft()
            return true
        }
    }

    private func pasteAttachments(from pasteboard: NSPasteboard) -> Bool {
        guard !bot.isGroup else { return false }
        let files = AttachmentPasteboard.fileURLs(from: pasteboard)
        if !files.isEmpty {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                store.attachFiles(files)
            }
            return true
        }
        if AttachmentPasteboard.hasImage(pasteboard), let image = AttachmentPasteboard.imageFile(from: pasteboard) {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                store.attachFiles([image], ownsFiles: true)
            }
            return true
        }
        return false
    }

    private var isListening: Bool {
        voice.isActive(for: store)
    }

    private var placeholder: String {
        if isListening {
            return ""
        }
        if store.isWaitingForUploads {
            return "Enviando os anexos…"
        }
        return store.hasOpenQuestion ? "Digite sua resposta" : "Mensagem para \(bot.name)"
    }

    @ViewBuilder
    private var listeningIndicator: some View {
        if voice.phase == .preparing {
            Text("Preparando a voz…")
                .font(TypeScale.body)
                .foregroundStyle(Theme.textTertiary)
        } else {
            HStack(spacing: Spacing.m) {
                VoiceWaveform(voice: voice, height: 20)
                VoiceElapsed(since: voice.listeningSince)
            }
        }
    }

    private var slashQuery: String? {
        guard !isListening, store.draft != dismissedSlashDraft else { return nil }
        let draft = store.draft
        let start = draft.lastIndex(where: { $0 == " " || $0 == "\n" }).map { draft.index(after: $0) } ?? draft.startIndex
        let token = draft[start...]
        guard token.hasPrefix("/") else { return nil }
        return String(token.dropFirst()).lowercased()
    }

    private var slashCommands: [SlashCommand] {
        guard let query = slashQuery else { return [] }
        let target = bot
        let all =
            [
                SlashCommand(id: "limpar", title: "/limpar", subtitle: "Começar a conversa do zero (⌘K)", systemImage: "eraser") {
                    if model.canClearConversation(target) {
                        model.clearConversation(target)
                    } else if target.isGroup {
                        model.showNotice("Conversa de grupo não dá para limpar.")
                    } else {
                        model.showNotice("Essa conversa já está limpa.")
                    }
                },
                SlashCommand(id: "novo-bot", title: "/novo-bot", subtitle: "Criar um bot novo", systemImage: "person.badge.plus") {
                    model.openEditor(for: nil)
                },
                SlashCommand(id: "repo", title: "/repo", subtitle: "Trabalhar num repositório", systemImage: "arrow.triangle.branch") {
                    if !target.isGroup {
                        model.activeSheet = .repoPicker(target.id)
                    }
                },
            ]
            + (target.isGroup
                ? []
                : [
                    SlashCommand(id: "side", title: "/side", subtitle: "Conversa secundária ao lado, com o contexto desta", systemImage: "rectangle.split.2x1") {
                        openSide(text: store.draft.trimmingCharacters(in: .whitespacesAndNewlines))
                    }
                ])
        return all.filter { query.isEmpty || $0.id.contains(query) || $0.subtitle.lowercased().contains(query) }
    }

    private var slashItems: [SlashItem] {
        guard slashQuery != nil else { return [] }
        return slashCommands.map(SlashItem.command) + skillCatalog.results.map(SlashItem.skill)
    }

    private var slashRange: NSRange {
        let draft = store.draft
        let start = draft.lastIndex(where: { $0 == " " || $0 == "\n" }).map { draft.index(after: $0) } ?? draft.startIndex
        return NSRange(start..<draft.endIndex, in: draft)
    }

    private func chooseSlash(_ item: SlashItem) {
        let range = slashRange
        dismissedSlashDraft = nil
        switch item {
        case .command(let command):
            store.insertTokens([], replacing: range)
            command.action()
        case .skill(let skill):
            store.insertTokens([.skill(skill)], replacing: range)
            focus()
        }
    }

    private func openSide(text: String) {
        model.openSide(from: store, text: text)
        store.clearDraft()
        focus()
    }

    private var mentionQuery: String? {
        guard !mentionables.isEmpty else { return nil }
        let last = store.draft.split(separator: " ", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        guard last.hasPrefix("@") else { return nil }
        return String(last.dropFirst()).lowercased()
    }

    private var suggestions: [Bot] {
        guard let query = mentionQuery else { return [] }
        return mentionables.filter { query.isEmpty || $0.name.lowercased().hasPrefix(query) || $0.id.hasPrefix(query) }
    }

    private func insertMention(_ member: Bot) {
        var parts = store.draft.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        if !parts.isEmpty {
            parts.removeLast()
        }
        parts.append("@\(member.name) ")
        store.draft = parts.joined(separator: " ")
        focus()
    }

    private func send() {
        if isListening {
            voice.stop(send: true)
            return
        }
        if !bot.isGroup, let text = SideThread.command(in: store.draft) {
            openSide(text: text)
            return
        }
        guard store.canSend, !voice.isBusy(for: store) else { return }
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            store.send()
        }
        focus()
    }
}

struct MentionList: View {
    let members: [Bot]
    let select: (Bot) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(members) { member in
                Button {
                    select(member)
                } label: {
                    HStack(spacing: Spacing.s) {
                        BotCharacter(bot: member, mood: .idle, size: 20)
                        Text(member.name)
                            .font(TypeScale.rowTitle)
                            .foregroundStyle(Theme.textPrimary)
                        if !member.role.isEmpty {
                            Text(member.role)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Spacing.s)
                    .frame(height: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .clickable()
            }
        }
        .padding(Spacing.xs + 2)
        .frame(width: 260)
        .glassMenuSurface()
    }
}

struct ComposerHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct ComposerIcon: View {
    let systemName: String
    var size: CGFloat = 14
    var weight: Font.Weight = .medium
    var color: Color = Theme.textSecondary
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size, weight: weight))
            .foregroundStyle(hovering && isEnabled ? Theme.textPrimary : color)
            .frame(width: 34, height: 34)
            .background(hovering && isEnabled ? Theme.hover : .clear, in: Circle())
            .contentShape(Circle())
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}
