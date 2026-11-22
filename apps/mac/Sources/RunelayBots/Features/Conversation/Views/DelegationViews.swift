import SwiftUI

struct DelegationLine: View {
    @Environment(AppModel.self) private var model
    let calls: [ToolCall]

    @State private var isExpanded = false
    @State private var isHovering = false

    var body: some View {
        Group {
            if calls.count == 1, let call = calls.first {
                DelegateRow(call: call)
            } else if !calls.isEmpty {
                VStack(spacing: Spacing.xs) {
                    summary
                    if isExpanded {
                        VStack(spacing: Spacing.xs) {
                            ForEach(calls) { call in
                                DelegateRow(call: call)
                            }
                        }
                        .transition(.opacity.combined(with: .offset(y: -4)))
                    }
                }
                .springAnimation(value: isExpanded)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xs)
    }

    private var bots: [Bot] {
        var seen: Set<String> = []
        return calls.compactMap { call in
            let id = call.delegation?.botID ?? call.name
            guard seen.insert(id).inserted else { return nil }
            return model.bot(id: id)
        }
    }

    private var needsYou: Bool {
        calls.contains { DelegateRow.state(of: $0, model: model) == .awaiting }
    }

    private var working: Bool {
        calls.contains { DelegateRow.state(of: $0, model: model).isActive }
    }

    private var summary: some View {
        let count = Set(calls.map { $0.delegation?.botID ?? $0.name }).count
        let tint = needsYou ? Theme.attention : (isHovering ? Theme.textSecondary : Theme.textTertiary)
        return Button {
            isExpanded.toggle()
        } label: {
            HStack(spacing: Spacing.xs) {
                Text(calls.count == 1 ? "1 mensagem com" : "\(calls.count) mensagens com")
                HStack(spacing: -4) {
                    ForEach(bots.prefix(4)) { bot in
                        BotCharacter(bot: bot, mood: .idle, size: 14)
                            .padding(1)
                            .background(Theme.background, in: Circle())
                    }
                }
                Text(count == 1 ? "1 bot" : "\(count) bots")
                if needsYou {
                    Text("· precisa de você")
                } else if working {
                    WorkingDots()
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .font(needsYou ? TypeScale.captionStrong : TypeScale.caption)
            .foregroundStyle(tint)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: needsYou)
    }
}

struct DelegateRow: View {
    @Environment(AppModel.self) private var model
    let call: ToolCall

    @State private var isHovering = false

    static func state(of call: ToolCall, model: AppModel) -> DelegationState {
        let link = call.delegation ?? DelegationLink(botID: call.name)
        if link.state.isActive, model.status(for: link.botID) == .awaitingApproval {
            return .awaiting
        }
        return link.state
    }

    private var botID: String {
        call.delegation?.botID ?? call.name
    }

    private var bot: Bot? {
        model.bot(id: botID)
    }

    private var name: String {
        bot?.name ?? botID
    }

    var body: some View {
        let state = Self.state(of: call, model: model)
        Button {
            model.openConversation(botID, sessionID: call.delegation?.sessionID)
        } label: {
            HStack(spacing: Spacing.xs) {
                switch state {
                case .completed:
                    Text("Mensagem de")
                    avatar(.idle)
                    Text(name)
                case .starting, .working:
                    avatar(.thinking)
                    Text("\(name) está trabalhando")
                    WorkingDots()
                case .queued:
                    avatar(.waiting)
                    Text("\(name) vai pegar isso depois da tarefa atual")
                case .awaiting:
                    avatar(.waiting)
                    Text("\(name) precisa de você")
                case .failed:
                    avatar(.error)
                    Text("\(name) não terminou")
                case .cancelled:
                    avatar(.idle)
                    Text("Pedido para \(name) cancelado")
                }
            }
            .font(state == .awaiting ? TypeScale.captionStrong : TypeScale.caption)
            .foregroundStyle(tint(state))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { isHovering = $0 }
        .help(help(state))
        .springAnimation(value: state)
        .springAnimation(value: isHovering)
        .accessibilityHint("Abre a conversa de \(name)")
    }

    @ViewBuilder
    private func avatar(_ mood: CharacterMood) -> some View {
        if let bot {
            BotCharacter(bot: bot, mood: mood, size: 14)
        }
    }

    private func tint(_ state: DelegationState) -> Color {
        if state == .awaiting {
            return Theme.attention
        }
        return isHovering ? Theme.textSecondary : Theme.textTertiary
    }

    private func help(_ state: DelegationState) -> String {
        if state == .failed, let error = call.delegation?.error ?? call.errorMessage {
            return error
        }
        return tr("Abrir a conversa de %@", name)
    }
}

struct WorkingDots: View {
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || !AppActivity.shared.isLive)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .frame(width: 3, height: 3)
                        .opacity(reduceMotion ? 0.6 : 0.3 + 0.7 * max(0, sin((time * 4) - Double(index) * 0.9)))
                }
            }
        }
        .frame(width: 13, height: 6)
        .accessibilityHidden(true)
    }
}

struct DelegatedRequestBubble: View {
    @Environment(\.conversationFontSize) private var fontSize
    let message: UserMessage
    let from: Bot?
    let date: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                if let from {
                    BotCharacter(bot: from, mood: .idle, size: 14)
                }
                Text("\(from?.name ?? message.fromName ?? tr("Outro bot")) pediu")
                BubbleTime(date: date)
            }
            .font(TypeScale.caption)
            .foregroundStyle(Theme.textTertiary)
            MarkdownView(text: message.text, fontSize: fontSize)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                .frame(maxWidth: BubbleShape.maxWidth, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
