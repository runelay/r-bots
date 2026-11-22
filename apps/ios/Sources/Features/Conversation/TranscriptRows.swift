import SwiftUI
import UIKit

enum BubbleShape {
    static func make(meta: BubbleMeta, trailing: Bool) -> UnevenRoundedRectangle {
        let big: CGFloat = 20
        let small: CGFloat = 6
        let top = meta.isFirst ? big : small
        let bottom = meta.isLast ? big : small
        if trailing {
            return UnevenRoundedRectangle(topLeadingRadius: big, bottomLeadingRadius: big, bottomTrailingRadius: bottom, topTrailingRadius: top, style: .continuous)
        }
        return UnevenRoundedRectangle(topLeadingRadius: top, bottomLeadingRadius: bottom, bottomTrailingRadius: big, topTrailingRadius: big, style: .continuous)
    }
}

struct TranscriptItemView: View {
    @Environment(AppModel.self) private var model
    let item: TranscriptItem
    let store: ConversationStore
    let bubbles: [String: BubbleMeta]

    var body: some View {
        switch item {
        case .day(_, let label), .caption(_, let label):
            DaySeparator(label: label)
        case .delegation(_, let callIDs), .tools(_, let callIDs):
            let calls = callIDs.compactMap { store.toolCalls[$0] }.filter { !$0.isQuestionTool }
            if calls.count == 1, let only = calls.first {
                ToolLine(call: only)
            } else if !calls.isEmpty {
                ToolGroupRow(calls: calls)
            }
        case .delegateCard(_, let callIDs):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ForEach(callIDs.compactMap { store.toolCalls[$0] }) { call in
                    DelegateLine(call: call)
                }
            }
        case .entry(let entry):
            EntryView(entry: entry, store: store, meta: bubbles[entry.id] ?? BubbleMeta())
        }
    }
}

struct EntryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openAttachment) private var openAttachment
    let entry: TranscriptEntry
    let store: ConversationStore
    let meta: BubbleMeta

    var body: some View {
        switch entry.kind {
        case .user:
            if let message = store.userMessages[entry.id] {
                if let fromBotID = message.fromBotID {
                    DelegatedRequest(message: message, from: model.bot(id: fromBotID))
                } else {
                    UserBubble(message: message, meta: meta, date: store.entryDates[entry.id], client: store.clientValue, open: openAttachment) {
                        store.retry(messageID: message.id)
                    }
                }
            }
        case .text:
            if let part = store.textParts[entry.id] {
                switch part.phase {
                case .reply:
                    ReplyBubble(
                        part: part,
                        bot: part.botID.flatMap { model.bot(id: $0) } ?? store.bot,
                        meta: meta,
                        live: part.isStreaming ? store.liveText : nil
                    )
                case .narration:
                    Text(MarkdownCache.attributed(part.text))
                        .font(TypeScale.narration)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Spacing.xs)
                }
            }
        case .toolCall:
            if let call = store.toolCalls[entry.id], !call.isQuestionTool {
                ToolLine(call: call)
            }
        case .approval:
            if let approval = store.approvals[entry.id] {
                if approval.isQuestion {
                    QuestionOutcomeLine(approval: approval)
                } else if let form = approval.secretForm {
                    SecretFormCard(approval: approval, form: form, bot: store.bot) { optionID in
                        store.respond(approvalID: approval.id, optionID: optionID)
                    }
                } else {
                    ApprovalCardView(
                        approval: approval,
                        call: approval.callID.flatMap { store.toolCalls[$0] },
                        bot: store.bot
                    ) { optionID in
                        store.respond(approvalID: approval.id, optionID: optionID)
                    }
                }
            }
        case .notice(let notice):
            NoticeLine(notice: notice)
        case .schedule(let name):
            SystemLine(symbol: "clock", text: tr("Rotina: %@", name))
        case .update(let text):
            SystemLine(symbol: "info.circle", text: text)
        case .route(let text, _):
            SystemLine(symbol: "arrow.triangle.branch", text: text)
        case .handoff(let from, let to, _):
            SystemLine(symbol: "arrow.right", text: tr("%@ passou para %@", from, to))
        case .memory(let titles):
            SystemLine(symbol: "brain", text: titles.count == 1 ? tr("Guardou na memória: %@", titles[0]) : tr("Guardou %lld memórias", titles.count))
        case .voiceCall(_, let seconds):
            SystemLine(symbol: "phone", text: tr("Chamada de voz · %@", Self.duration(seconds)))
        case .artifact(let ref):
            ArtifactLine(ref: ref)
        case .file(let ref):
            HStack(alignment: .bottom, spacing: Spacing.s) {
                BotAvatar(bot: store.bot, mood: .idle, size: 24)
                MessageAttachments(attachments: [ref], client: store.clientValue, open: openAttachment)
                Spacer(minLength: 0)
            }
        case .contextHandoff(let handoff):
            SystemLine(symbol: "arrow.left.arrow.right", text: tr("Continuou em %@", handoff.toModel ?? handoff.toAccount))
        case .settingsChange(let id):
            if let change = store.settingsChanges[id] {
                SystemLine(symbol: "slider.horizontal.3", text: change.text)
            }
        case .pullRequest(let event):
            SystemLine(symbol: "arrow.triangle.pull", text: "Pull request #\(event.number)")
        case .codeLine(_, let text):
            SystemLine(symbol: "chevron.left.forwardslash.chevron.right", text: text)
        case .codeEdit, .codeBulk:
            EmptyView()
        }
    }

    private static func duration(_ seconds: Int) -> String {
        seconds < 60 ? "\(seconds) s" : "\(seconds / 60) min"
    }
}

struct DaySeparator: View {
    let label: String

    var body: some View {
        Text(label)
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textTertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.xs)
    }
}

struct SystemLine: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 18)
            Text(text)
                .lineLimit(2)
        }
        .font(TypeScale.caption)
        .foregroundStyle(Theme.textTertiary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Spacing.xs)
    }
}

struct NoticeLine: View {
    let notice: TranscriptNotice

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Image(systemName: notice.tone == .error ? "exclamationmark.circle.fill" : "info.circle")
                .font(.system(size: 12, weight: .semibold))
            VStack(alignment: .leading, spacing: 2) {
                Text(notice.text)
                    .font(TypeScale.captionStrong)
                if let detail = notice.detail, !detail.isEmpty {
                    Text(detail)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(3)
                }
            }
        }
        .foregroundStyle(notice.tone == .error ? Theme.danger : Theme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Spacing.xs)
    }
}

struct UserBubble: View {
    let message: UserMessage
    let meta: BubbleMeta
    let date: Date?
    let client: BotsClient
    let open: (AttachmentRef) -> Void
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: Spacing.xs) {
            if !message.attachments.isEmpty {
                MessageAttachments(attachments: message.attachments, client: client, trailing: true, open: open)
                    .opacity(message.state == .sending ? 0.75 : 1)
            }
            if !Self.visible(message.text).isEmpty {
                MarkdownView(text: Self.visible(message.text))
                    .foregroundStyle(Theme.onAccent)
                    .tint(Theme.onAccent)
                    .environment(\.markdownOnAccent, true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.userBubble, in: BubbleShape.make(meta: meta, trailing: true))
                    .opacity(message.state == .sending ? 0.75 : 1)
                    .contextMenu {
                        Button("Copiar", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = message.text
                        }
                    }
            }
            footer
        }
        .padding(.leading, 48)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    static func visible(_ text: String) -> String {
        text.replacingOccurrences(of: #"\[arquivo: [^\]]*\]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private var footer: some View {
        switch message.state {
        case .failed(let reason):
            Button(action: retry) {
                Label("Não enviou · tentar de novo", systemImage: "arrow.clockwise")
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.danger)
            }
            .accessibilityHint(reason)
        case .queued:
            Text("Na fila")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        case .sending:
            Text("Enviando…")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        case .sent:
            if meta.isLast, let date {
                Text(date.formatted(date: .omitted, time: .shortened))
                    .font(TypeScale.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
            }
        }
    }
}

struct ReplyBubble: View {
    let part: TextPart
    let bot: Bot
    let meta: BubbleMeta
    var live: LiveTextBuffer?

    private var text: String {
        live?.current(part.id) ?? part.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .bottom, spacing: Spacing.s) {
                Group {
                    if meta.isLast {
                        BotAvatar(bot: bot, mood: part.isStreaming ? .speaking : .idle, size: 24)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 24, height: 24)
                MarkdownView(text: text)
                    .foregroundStyle(Theme.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.surface, in: BubbleShape.make(meta: meta, trailing: false))
                    .contextMenu {
                        Button("Copiar", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = part.text
                        }
                    }
                Spacer(minLength: 24)
            }
            if meta.isLast, !part.isStreaming, let date = meta.lastDate {
                Text(date.formatted(date: .omitted, time: .shortened))
                    .font(TypeScale.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.leading, 24 + Spacing.s + Spacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct DelegatedRequest: View {
    let message: UserMessage
    let from: Bot?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                if let from {
                    BotAvatar(bot: from, mood: .idle, size: 16)
                }
                Text("\(from?.name ?? message.fromName ?? tr("Outro bot")) pediu")
            }
            .font(TypeScale.caption)
            .foregroundStyle(Theme.textTertiary)
            MarkdownView(text: message.text, fontSize: 15)
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large + 4, style: .continuous))
        }
        .padding(.trailing, 48)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ToolLine: View {
    let call: ToolCall
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var phrase: ActionPhrase { ActionPhrase(call: call) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Button {
                withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: Spacing.s) {
                    Image(systemName: phrase.symbol)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textTertiary)
                        .frame(width: 18)
                    Text(phrase.text)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: Spacing.s)
                    ToolStatusMark(status: call.status)
                }
                .padding(.horizontal, Spacing.xs)
                .frame(minHeight: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                ReadableResult(call: call)
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, Spacing.s + 2)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                    .padding(.leading, 26)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
    }
}

struct ToolStatusMark: View {
    let status: ToolCallStatus

    var body: some View {
        Group {
            switch status {
            case .requested, .running:
                ProgressView()
                    .controlSize(.mini)
            case .failed:
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.danger)
            case .rejected:
                Text("não permitido")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            case .interrupted:
                Text("interrompido")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            case .completed, .other:
                EmptyView()
            }
        }
        .accessibilityLabel(status.label)
    }
}

struct ToolGroupRow: View {
    @Environment(AppModel.self) private var model
    let calls: [ToolCall]
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var running: Bool { calls.contains { $0.status.isActive } }
    private var failed: Int { calls.filter { $0.status == .failed }.count }

    private var via: Bot? {
        calls.lazy.compactMap { $0.viaAgent }.first.flatMap { model.bot(id: $0) }
    }

    private var title: String {
        let noun = Set(calls.map(\.groupNoun)).count == 1 ? calls[0].groupNoun : tr("ações")
        let base = "\(calls.count) \(noun)"
        if let via { return "\(via.name) · \(base)" }
        return base
    }

    var body: some View {
        if let last = calls.last {
            VStack(alignment: .leading, spacing: 2) {
                Button {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(spacing: Spacing.s) {
                        Group {
                            if let via {
                                BotAvatar(bot: via, mood: running ? .thinking : .idle, size: 18)
                            } else {
                                Image(systemName: "square.stack.3d.up")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(Theme.textTertiary)
                            }
                        }
                        .frame(width: 18)
                        Text(title)
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                            .layoutPriority(1)
                        if !expanded {
                            Text(ActionPhrase(call: last).plain)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: Spacing.s)
                        if running {
                            ProgressView()
                                .controlSize(.mini)
                        } else if failed > 0 {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.danger)
                        }
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .padding(.horizontal, Spacing.xs)
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if expanded {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(calls) { call in
                            ToolLine(call: call)
                        }
                    }
                    .padding(.leading, Spacing.l)
                    .transition(.opacity.combined(with: .offset(y: -4)))
                }
            }
        }
    }
}

struct DelegateLine: View {
    @Environment(AppModel.self) private var model
    let call: ToolCall

    private var botID: String { call.delegation?.botID ?? call.name }

    private var state: DelegationState {
        let link = call.delegation ?? DelegationLink(botID: botID)
        if link.state.isActive, model.status(for: link.botID) == .awaitingApproval {
            return .awaiting
        }
        return link.state
    }

    var body: some View {
        let bot = model.bot(id: botID)
        let name = bot?.name ?? botID
        HStack(spacing: Spacing.s) {
            if let bot {
                BotAvatar(bot: bot, mood: mood, size: 18)
            }
            Text(text(name))
                .lineLimit(1)
        }
        .font(state == .awaiting ? TypeScale.captionStrong : TypeScale.caption)
        .foregroundStyle(state == .awaiting ? Theme.attention : Theme.textTertiary)
        .padding(.horizontal, Spacing.xs)
        .frame(minHeight: 28)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Motion.spring, value: state)
    }

    private var mood: CharacterMood {
        switch state {
        case .starting, .working: .thinking
        case .queued, .awaiting: .waiting
        case .failed: .error
        case .completed, .cancelled: .idle
        }
    }

    private func text(_ name: String) -> String {
        switch state {
        case .completed: tr("%@ respondeu", name)
        case .starting, .working: tr("%@ está trabalhando…", name)
        case .queued: tr("%@ vai pegar isso depois da tarefa atual", name)
        case .awaiting: tr("%@ precisa de você", name)
        case .failed: tr("%@ não terminou", name)
        case .cancelled: tr("Pedido para %@ cancelado", name)
        }
    }
}

struct ThinkingRow: View {
    let bot: Bot
    let mood: CharacterMood
    let queuePosition: Int?

    var body: some View {
        HStack(spacing: Spacing.s) {
            BotAvatar(bot: bot, mood: mood, size: 24)
            Text(queuePosition.map { tr("Na fila (%lldº)", $0) } ?? (mood == .waiting ? tr("Esperando você") : tr("Pensando…")))
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension ToolCall {
    var isQuestionTool: Bool { name == "ask_user" || name.hasSuffix("__ask_user") }
}

extension EnvironmentValues {
    @Entry var openAttachment: (AttachmentRef) -> Void = { _ in }
}

struct ArtifactLine: View {
    let ref: ArtifactRef
    @State private var open = false

    private var viewable: Bool { ["page", "slides", "dashboard", "canvas"].contains(ref.kind) }

    var body: some View {
        Button {
            open = true
        } label: {
            HStack(spacing: Spacing.m) {
                Image(systemName: ref.kind == "note" ? "doc.text" : (ref.kind == "sheet" ? "tablecells" : "doc.richtext"))
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.brandText)
                    .frame(width: 36, height: 36)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(ref.title)
                        .font(BrandFonts.sans(14, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text(ref.version > 1 ? "\(ArtifactKindText.label(ref.kind)) · v\(ref.version)" : ArtifactKindText.label(ref.kind))
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .padding(Spacing.s)
            .frame(maxWidth: 300, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        }
        .buttonStyle(RowButtonStyle())
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 24 + Spacing.s)
        .sheet(isPresented: $open) {
            NavigationStack {
                Group {
                    switch ref.kind {
                    case "note": NoteReader(botID: ref.botID, noteID: ref.id, title: ref.title)
                    case "sheet": SheetReader(botID: ref.botID, sheetID: ref.id, title: ref.title)
                    default: ArtifactViewer(title: ref.title, path: "/bots/\(ref.botID)/artifacts/\(ref.id)/v/\(ref.version).html")
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("OK") { open = false }
                    }
                }
            }
        }
    }
}
