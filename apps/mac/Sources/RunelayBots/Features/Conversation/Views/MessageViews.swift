import AppKit
import SwiftUI

enum BubbleShape {
    static func make(meta: BubbleMeta, trailing: Bool) -> UnevenRoundedRectangle {
        let big: CGFloat = 18
        let small: CGFloat = 6
        let topSide = meta.isFirst ? big : small
        let bottomSide = meta.isLast ? big : small
        if trailing {
            return UnevenRoundedRectangle(
                topLeadingRadius: big,
                bottomLeadingRadius: big,
                bottomTrailingRadius: bottomSide,
                topTrailingRadius: topSide,
                style: .continuous
            )
        }
        return UnevenRoundedRectangle(
            topLeadingRadius: topSide,
            bottomLeadingRadius: bottomSide,
            bottomTrailingRadius: big,
            topTrailingRadius: big,
            style: .continuous
        )
    }

    static let maxWidth = Metrics.transcriptWidth * 0.72
}

struct BubbleTime: View {
    let date: Date?

    var body: some View {
        if let date {
            Text(date.formatted(date: .omitted, time: .shortened))
                .font(TypeScale.caption)
                .monospacedDigit()
                .foregroundStyle(Theme.textTertiary)
        }
    }
}

struct UserBubble: View {
    @Environment(\.conversationFontSize) private var fontSize
    let message: UserMessage
    let meta: BubbleMeta
    var showsAvatar = false
    var fold: MessageFoldRef? = nil
    var reactions: [MessageReaction] = []
    var me: String? = nil
    var canReact = false
    var isHovered = false
    var onHover: (Bool) -> Void = { _ in }
    var react: (String) -> Void = { _ in }
    let retry: () -> Void
    @Environment(\.transcriptToggle) private var transcriptToggle
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var pickerOpen = false

    private var avatarInset: CGFloat { showsAvatar ? 20 + Spacing.s : 0 }

    private var expanded: Bool {
        fold.map { MessageFolds.shared.isExpanded($0.key) } ?? false
    }

    private func setExpanded(_ open: Bool) {
        guard let fold else { return }
        transcriptToggle(fold.row, !open)
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            MessageFolds.shared.set(fold.key, expanded: open)
        }
    }

    var body: some View {
        let segments = InlineTokens.segments(in: message.text, attachments: message.attachments, skills: message.skills)
        let inlineFiles = Set(
            (segments ?? []).compactMap { segment -> String? in
                if case .file(let ref) = segment { return ref.id }
                return nil
            })
        let inlineSkills = Set(
            (segments ?? []).compactMap { segment -> String? in
                if case .skill(let skill) = segment { return skill.slug }
                return nil
            })
        let looseSkills = message.skills.filter { !inlineSkills.contains($0.slug) }
        let looseAttachments = message.attachments.filter { $0.kind != .file || !inlineFiles.contains($0.id) }
        VStack(alignment: .trailing, spacing: Spacing.xs) {
            if !looseSkills.isEmpty {
                SkillChipRow(skills: looseSkills, compact: true)
                    .opacity(message.state == .sending ? 0.8 : 1)
                    .padding(.trailing, avatarInset)
            }
            if !looseAttachments.isEmpty {
                MessageAttachments(attachments: looseAttachments, trailing: true)
                    .opacity(message.state == .sending ? 0.8 : 1)
                    .padding(.trailing, avatarInset)
            }
            if segments != nil || (!message.isSkillOnly && !message.text.isEmpty) {
                HStack(alignment: .bottom, spacing: Spacing.s) {
                    Spacer(minLength: 0)
                    if canReact {
                        ReactionPickerButton(edge: .trailing, isOpen: $pickerOpen, showsMore: false, pick: react)
                            .opacity(isHovered || pickerOpen ? 1 : 0)
                            .allowsHitTesting(isHovered || pickerOpen)
                    }
                    Group {
                        if let segments {
                            InlineTokenText(segments: segments, fontSize: fontSize, ink: Theme.onAccent)
                        } else {
                            FoldedMarkdown(
                                text: message.text,
                                plan: fold == nil ? nil : MessageFolding.plan(message.text, keepsTail: true),
                                expanded: expanded,
                                fontSize: fontSize,
                                bubble: Theme.userBubble
                            ) {
                                setExpanded(true)
                            }
                        }
                    }
                    .foregroundStyle(Theme.onAccent)
                    .environment(\.markdownInk, Theme.onAccent)
                    .environment(\.markdownOnAccent, true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.userBubble, in: BubbleShape.make(meta: meta, trailing: true))
                    .frame(maxWidth: BubbleShape.maxWidth, alignment: .trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .opacity(message.state == .sending ? 0.8 : 1)
                    if showsAvatar {
                        Group {
                            if meta.isLast {
                                UserAvatar(size: 20)
                            } else {
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(width: 20, height: 20)
                    }
                }
            }
            if fold != nil, segments == nil, !message.isSkillOnly, MessageFolding.plan(message.text, keepsTail: true) != nil {
                FoldToggle(expanded: expanded) {
                    setExpanded(!expanded)
                }
                .padding(.trailing, avatarInset + Spacing.xs)
            }
            if !reactions.isEmpty {
                ReactionBar(reactions: reactions, me: me, trailing: true, toggle: react)
                    .padding(.trailing, avatarInset)
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
            if message.state == .queued {
                Label("na fila", systemImage: "clock")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .transition(.opacity)
            } else if case .failed(let reason) = message.state {
                HStack(spacing: Spacing.xs) {
                    Image(systemName: "exclamationmark.circle.fill")
                    Text("Não enviada. \(reason)")
                        .lineLimit(2)
                    Button("Tentar de novo", action: retry)
                        .buttonStyle(.link)
                        .clickable()
                }
                .font(TypeScale.caption)
                .foregroundStyle(Theme.danger)
                .transition(.opacity)
            } else if meta.isLast || message.isVoice {
                HStack(spacing: Spacing.xs) {
                    if message.isVoice {
                        VoiceMark()
                    }
                    if meta.isLast {
                        BubbleTime(date: meta.lastDate)
                    }
                }
                .padding(.trailing, Spacing.xs + avatarInset)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .contentShape(Rectangle())
        .onHover { hovering in
            onHover(hovering)
        }
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .springAnimation(value: message.state)
        .springAnimation(value: reactions.isEmpty)
    }
}

struct ReplyCard: View {
    @Environment(\.conversationFontSize) private var fontSize
    let part: TextPart
    let bot: Bot
    var showsSpeakerName = false
    let meta: BubbleMeta
    var accountLabel: String? = nil
    var isHovered = false
    var live: LiveTextBuffer? = nil
    var onHover: (Bool) -> Void = { _ in }
    var fold: MessageFoldRef? = nil
    var reactions: [MessageReaction] = []
    var me: String? = nil
    var react: (String) -> Void = { _ in }
    let regenerate: () -> Void

    @State private var copied = false
    @State private var pickerOpen = false
    @Environment(\.transcriptToggle) private var transcriptToggle
    @Environment(\.appReduceMotion) private var reduceMotion

    private var expanded: Bool {
        fold.map { MessageFolds.shared.isExpanded($0.key) } ?? false
    }

    private func setExpanded(_ open: Bool) {
        guard let fold else { return }
        transcriptToggle(fold.row, !open)
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            MessageFolds.shared.set(fold.key, expanded: open)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if showsSpeakerName && meta.isFirst {
                Text(bot.name)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.accent(bot.accent))
                    .padding(.leading, 20 + Spacing.s + Spacing.xs)
            }
            HStack(alignment: .bottom, spacing: Spacing.s) {
                Group {
                    if meta.isLast {
                        BotCharacter(bot: bot, mood: part.isStreaming ? .speaking : .idle, size: 20)
                    } else {
                        Spacer(minLength: 0)
                    }
                }
                .frame(width: 20, height: 20)

                Group {
                    if let live {
                        LiveBubbleBody(live: live, id: part.id, fallback: part.text, fontSize: fontSize, folds: fold != nil, expanded: expanded) {
                            setExpanded(true)
                        }
                    } else {
                        BubbleBody(text: part.text, fontSize: fontSize, folds: fold != nil, expanded: expanded) {
                            setExpanded(true)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: BubbleShape.make(meta: meta, trailing: false))
                .overlay(alignment: .bottomTrailing) {
                    HStack(spacing: 0) {
                        ReactionPickerButton(edge: .leading, isOpen: $pickerOpen, pick: react)
                        HoverAction(systemImage: copied ? "checkmark" : "doc.on.doc", help: tr("Copiar")) {
                            copy()
                        }
                        HoverAction(systemImage: "arrow.clockwise", help: tr("Pedir de novo")) {
                            regenerate()
                        }
                    }
                    .alignmentGuide(.trailing) { $0[.leading] - Spacing.xs }
                    .opacity((isHovered || pickerOpen) && !part.isStreaming ? 1 : 0)
                    .allowsHitTesting((isHovered || pickerOpen) && !part.isStreaming)
                }
                .frame(maxWidth: BubbleShape.maxWidth, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 0)
            }
            if fold != nil, MessageFolding.plan(part.text, keepsTail: false) != nil {
                FoldToggle(expanded: expanded) {
                    setExpanded(!expanded)
                }
                .padding(.leading, 20 + Spacing.s + Spacing.xs)
            }
            if !reactions.isEmpty {
                ReactionBar(reactions: reactions, me: me, trailing: false, toggle: react)
                    .padding(.leading, 20 + Spacing.s + Spacing.xs)
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
            if meta.isLast {
                HStack(spacing: Spacing.xs) {
                    if part.isVoice {
                        VoiceMark()
                    }
                    BubbleTime(date: meta.lastDate)
                    if let accountLabel, let account = part.account {
                        Text("·")
                            .foregroundStyle(Theme.textTertiary)
                        ProviderLogo(provider: ModelNames.provider(account), size: 11)
                        Text(accountLabel)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                    }
                }
                .padding(.leading, 20 + Spacing.s + Spacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hovering in
            onHover(hovering)
        }
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .springAnimation(value: copied)
        .springAnimation(value: reactions.isEmpty)
    }

    private func copy() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(part.text, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.4))
            copied = false
        }
    }
}

struct LiveBubbleBody: View {
    let live: LiveTextBuffer
    let id: String
    let fallback: String
    let fontSize: CGFloat
    var folds = false
    var expanded = false
    var expand: () -> Void = {}

    var body: some View {
        BubbleBody(text: live.texts[id] ?? fallback, fontSize: fontSize, folds: folds, expanded: expanded, expand: expand)
    }
}

struct BubbleBody: View {
    let text: String
    let fontSize: CGFloat
    var folds = false
    var expanded = false
    var expand: () -> Void = {}

    var body: some View {
        FoldedMarkdown(
            text: text,
            plan: folds ? MessageFolding.plan(text, keepsTail: false) : nil,
            expanded: expanded,
            fontSize: fontSize,
            bubble: Theme.surface,
            expand: expand
        )
        .foregroundStyle(Theme.textPrimary)
    }
}

struct HoverAction: View {
    let systemImage: String
    let help: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textTertiary)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 26, height: 26)
                .background(isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct NarrationLine: View {
    @Environment(\.conversationFontSize) private var fontSize
    let text: String

    var body: some View {
        MarkdownView(text: text, fontSize: fontSize - 1.5, lineSpacing: 3)
            .foregroundStyle(Theme.textTertiary)
            .environment(\.markdownInk, Theme.textTertiary)
            .padding(.horizontal, Spacing.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NoticeRow: View {
    let notice: TranscriptNotice
    var onAction: ((FallbackOffer) -> Void)? = nil
    @State private var showsDetail = false
    @State private var acted = false

    var body: some View {
        VStack(spacing: Spacing.xs) {
            HStack(spacing: Spacing.s) {
                Image(systemName: notice.tone == .error ? "exclamationmark.circle" : "info.circle")
                    .foregroundStyle(notice.tone == .error ? Theme.danger : Theme.textTertiary)
                Text(notice.text)
                    .foregroundStyle(Theme.textSecondary)
                if let action = notice.action, let onAction, !acted {
                    Button(action.label) {
                        acted = true
                        onAction(action)
                    }
                    .buttonStyle(.link)
                    .foregroundStyle(Theme.brandAccent)
                    .clickable()
                }
                if notice.detail != nil {
                    Button(showsDetail ? "Ocultar detalhes" : "Detalhes") {
                        showsDetail.toggle()
                    }
                    .buttonStyle(.link)
                    .foregroundStyle(Theme.textTertiary)
                    .clickable()
                }
            }
            .font(TypeScale.caption)
            .help(notice.detail ?? notice.text)

            if showsDetail, let detail = notice.detail {
                Text(detail)
                    .font(TypeScale.monoInline)
                    .foregroundStyle(Theme.textTertiary)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, Spacing.s)
        .springAnimation(value: showsDetail)
    }
}

struct ThinkingCharacter: View {
    let bot: Bot
    let mood: CharacterMood
    var queuePosition: Int? = nil

    var body: some View {
        HStack(spacing: Spacing.s) {
            BotCharacter(bot: bot, mood: queuePosition != nil && mood != .waiting ? .idle : mood == .waiting ? .waiting : .thinking, size: 20)
            Text(label)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .contentTransition(.opacity)
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 24, alignment: .leading)
        .springAnimation(value: label)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(bot.name): \(label)")
    }

    private var label: String {
        if let queuePosition, mood != .waiting {
            return queuePosition <= 1 ? tr("na fila, é o próximo") : tr("na fila · %lldº", queuePosition)
        }
        return switch mood {
        case .speaking: tr("escrevendo…")
        case .waiting: tr("Aguardando sua resposta")
        default: tr("pensando…")
        }
    }
}

struct ViaAgentTag: View {
    let bot: Bot

    var body: some View {
        HStack(spacing: Spacing.xs) {
            BotCharacter(bot: bot, mood: .idle, size: 14)
            Text("via \(bot.name)")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct TranscriptSkeleton: View {
    private static let solo = BubbleMeta()
    private static let first = BubbleMeta(isFirst: true, isLast: false)
    private static let last = BubbleMeta(isFirst: false, isLast: true)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            userBubble(width: 260, height: 40)
            botBubble(width: 420, height: 88, meta: Self.first, avatar: false)
                .padding(.top, 14)
            botBubble(width: 300, height: 40, meta: Self.last, avatar: true)
                .padding(.top, 4)
            userBubble(width: 180, height: 40)
                .padding(.top, 14)
            botBubble(width: 360, height: 64, meta: Self.solo, avatar: true)
                .padding(.top, 14)
        }
        .frame(maxWidth: Metrics.transcriptWidth, alignment: .leading)
        .padding(.horizontal, Spacing.xxl)
        .padding(.bottom, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .accessibilityLabel("Carregando conversa")
    }

    private func userBubble(width: CGFloat, height: CGFloat) -> some View {
        HStack {
            Spacer(minLength: 0)
            BubbleShape.make(meta: Self.solo, trailing: true)
                .fill(Theme.surfaceRaised)
                .frame(width: width, height: height)
        }
    }

    private func botBubble(width: CGFloat, height: CGFloat, meta: BubbleMeta, avatar: Bool) -> some View {
        HStack(alignment: .bottom, spacing: Spacing.s) {
            Circle()
                .fill(avatar ? Theme.surfaceRaised : Color.clear)
                .frame(width: 20, height: 20)
            BubbleShape.make(meta: meta, trailing: false)
                .fill(Theme.surface)
                .frame(width: width, height: height)
            Spacer(minLength: 0)
        }
    }
}

struct TranscriptLoadingLayer: View {
    let loading: Bool
    @State private var armed = false

    var body: some View {
        ZStack {
            if loading && armed {
                TranscriptSkeleton()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: loading && armed)
        .allowsHitTesting(loading && armed)
        .task {
            guard loading else { return }
            try? await Task.sleep(for: .milliseconds(150))
            armed = true
        }
    }
}

struct OlderMessagesRow: View {
    let loading: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            ZStack {
                if loading {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Text("Ver mensagens anteriores")
                        .font(TypeScale.caption)
                        .foregroundStyle(hovering ? Theme.textSecondary : Theme.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .disabled(loading)
        .onHover { hovering = $0 }
        .accessibilityLabel(loading ? "Carregando mensagens anteriores" : "Ver mensagens anteriores")
    }
}

struct ConversationEmptyState: View {
    let bot: Bot
    let mood: CharacterMood

    var body: some View {
        VStack(spacing: Spacing.m) {
            BotCharacter(bot: bot, mood: mood, size: 96)
                .padding(.bottom, Spacing.xs)
            Text("Fale com \(bot.name)")
                .font(TypeScale.pageTitle)
                .tracking(Metrics.pageTitleTracking)
                .foregroundStyle(Theme.textPrimary)
            Text(bot.role)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.bottom, Spacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
    }
}

struct ErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.danger)
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
            Spacer(minLength: Spacing.s)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 22, height: 22)
                    .background(Theme.surfaceRaised, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Fechar")
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.s)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }
}

struct ConnectionBanner: View {
    let connection: StreamConnection

    var body: some View {
        if connection == .reconnecting {
            Label("Reconectando ao servidor…", systemImage: "arrow.triangle.2.circlepath")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .symbolEffect(.rotate, options: .repeating)
                .transition(.opacity)
        }
    }
}
