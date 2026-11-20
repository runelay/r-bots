import SwiftUI

struct BubbleMeta: Equatable {
    var isFirst = true
    var isLast = true
    var lastDate: Date?
}

enum BubbleSide: Equatable {
    case user
    case bot(String?)
}

@MainActor
enum BubbleGrouping {
    static func side(of entry: TranscriptEntry, in store: ConversationStore) -> BubbleSide? {
        switch entry.kind {
        case .user:
            return store.userMessages[entry.id]?.fromBotID == nil ? .user : nil
        case .text:
            guard let part = store.textParts[entry.id], part.phase == .reply else { return nil }
            return .bot(part.botID)
        default:
            return nil
        }
    }

    static func compute(_ store: ConversationStore) -> [String: BubbleMeta] {
        var result: [String: BubbleMeta] = [:]
        var previous: (id: String, side: BubbleSide, date: Date?)?
        for entry in store.entries where TranscriptItem.isVisible(entry, in: store) {
            guard let side = side(of: entry, in: store) else {
                previous = nil
                continue
            }
            let date = store.entryDates[entry.id]
            var meta = BubbleMeta(isFirst: true, isLast: true, lastDate: date)
            if let previous, previous.side == side {
                let close: Bool
                if let date, let earlier = previous.date {
                    close = date.timeIntervalSince(earlier) < 120
                } else {
                    close = true
                }
                if close {
                    meta.isFirst = false
                    result[previous.id]?.isLast = false
                }
            }
            result[entry.id] = meta
            previous = (entry.id, side, date)
        }
        return result
    }
}

enum TranscriptItem: Identifiable {
    case day(String, String)
    case entry(TranscriptEntry)
    case delegation(String, [String])
    case delegateCard(String, [String])
    case tools(String, [String])
    case caption(String, String)

    var id: String {
        switch self {
        case .day(let id, _): id
        case .entry(let entry): entry.id
        case .delegation(let id, _): "group-\(id)"
        case .delegateCard(let id, _): "delegate-\(id)"
        case .tools(let id, _): "tools-\(id)"
        case .caption(let id, _): id
        }
    }

    @MainActor
    static func build(from store: ConversationStore, now: Date) -> [TranscriptItem] {
        let calendar = Calendar.current
        var items: [TranscriptItem] = []
        var lastDay: Date?
        var group: [String] = []
        var tools: [String] = []
        var toolsTurn: String?

        func flushTools() {
            if tools.count == 1, let only = store.entries.first(where: { $0.id == tools[0] }) {
                items.append(.entry(only))
            } else if let first = tools.first {
                items.append(.tools(first, tools))
            }
            tools = []
            toolsTurn = nil
        }

        func flush() {
            flushTools()
            if let first = group.first {
                items.append(.delegation(first, group))
            }
            group = []
        }

        let visible = store.entries.filter { isVisible($0, in: store) }
        var delegatesByTurn: [String: [String]] = [:]
        for entry in visible where entry.kind == .toolCall {
            guard let call = store.toolCalls[entry.id], call.delegation != nil else { continue }
            delegatesByTurn[call.turnID ?? entry.id, default: []].append(entry.id)
        }
        var summarized: Set<String> = []
        for (index, entry) in visible.enumerated() {
            if store.bot.isGroup, entry.kind == .text, let part = store.textParts[entry.id], part.phase == .reply,
               !summarized.contains(entry.id) {
                var replies = 0
                var speakers: Set<String> = []
                for later in visible[index...] {
                    if later.kind == .user {
                        break
                    }
                    if later.kind == .text, let reply = store.textParts[later.id], reply.phase == .reply {
                        replies += 1
                        speakers.insert(reply.botID ?? "")
                        summarized.insert(later.id)
                    }
                }
                if speakers.count >= 2 {
                    flush()
                    items.append(.caption("summary-\(entry.id)", "\(replies) mensagens com \(speakers.count) agentes"))
                }
            }
            if let date = store.entryDates[entry.id] {
                let day = calendar.startOfDay(for: date)
                if day != lastDay {
                    flush()
                    items.append(.day("day-\(Int(day.timeIntervalSince1970))", ShortStamp.dayLabel(for: date, now: now)))
                    lastDay = day
                }
            }
            if entry.kind == .toolCall, let call = store.toolCalls[entry.id], call.delegation != nil {
                let siblings = delegatesByTurn[call.turnID ?? entry.id] ?? [entry.id]
                if siblings.first == entry.id {
                    flush()
                    items.append(.delegateCard(entry.id, siblings))
                }
                continue
            }
            if entry.kind == .toolCall, let call = store.toolCalls[entry.id],
               call.isDelegation || call.ownerCallID != nil || call.viaAgent != nil {
                flushTools()
                group.append(entry.id)
                continue
            }
            if entry.kind == .toolCall, let call = store.toolCalls[entry.id] {
                if group.isEmpty == false {
                    flush()
                }
                if !tools.isEmpty && toolsTurn != call.turnID {
                    flushTools()
                }
                tools.append(entry.id)
                toolsTurn = call.turnID
                continue
            }
            flush()
            items.append(.entry(entry))
        }
        flush()
        return items
    }

    @MainActor
    static func isVisible(_ entry: TranscriptEntry, in store: ConversationStore) -> Bool {
        if store.isReverted(entry.id) {
            return false
        }
        switch entry.kind {
        case .user:
            return store.userMessages[entry.id] != nil
        case .text:
            guard let part = store.textParts[entry.id] else { return false }
            return !part.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .toolCall:
            guard let call = store.toolCalls[entry.id] else { return false }
            if call.name == "request_secret" { return false }
            return !((call.name.hasPrefix("artifact_") || call.name == "canvas_create" || call.name == "canvas_update" || call.name == "send_file") && call.status == .completed)
        case .approval:
            return store.approvals[entry.id] != nil
        case .notice(let notice):
            return !notice.text.isEmpty
        case .schedule, .update, .route, .handoff, .memory, .voiceCall, .artifact, .codeLine, .file, .pullRequest, .contextHandoff:
            return true
        case .codeEdit(let editID):
            return store.codeEdits[editID] != nil
        case .codeBulk(let bulkID):
            return store.codeBulks[bulkID] != nil
        }
    }
}

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Bindable var store: ConversationStore
    let bot: Bot
    let focusToken: Int
    @Environment(\.appReduceMotion) private var reduceMotion
    @Environment(\.conversationFontSize) private var conversationFontSize
    @State private var hoveredItemID: String?
    @State private var isDropTargeted = false
    @State private var showsJumpButton = false
    @State private var unseenCount = 0
    @State private var lastEntryID: String?
    @State private var userScrolled = false
    @State private var footerHeight: CGFloat = 0
    @State private var scroll = TranscriptScrollController()

    private static let fadeHeight: CGFloat = 40

    private var topInset: CGFloat {
        store.codeState?.workspace != nil && !bot.isGroup ? 40 : 0
    }

    var body: some View {
        transcript
            .safeAreaInset(edge: .bottom, spacing: 0) {
                footer
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.height
                    } action: { height in
                        footerHeight = height
                    }
            }
            .overlay(alignment: .top) {
                if let workspace = store.codeState?.workspace, !bot.isGroup {
                    CodeStrip(store: store, workspace: workspace, running: store.phase == .working) {
                        model.activeSheet = .changes(bot.id)
                    }
                    .transition(.opacity.combined(with: .offset(y: -6)))
                }
            }
        .springAnimation(value: store.codeState?.workspace?.id)
        .background(Theme.background)
        .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted) { providers in
            guard !bot.isGroup else { return false }
            return AttachmentDrop.handle(providers, store: store)
        }
        .overlay {
            if isDropTargeted && !bot.isGroup {
                AttachmentDropOverlay()
                    .transition(.opacity)
            }
        }
        .springAnimation(value: isDropTargeted)
        .overlay(alignment: .top) {
            CallOverlay(bot: bot)
        }
    }

    private var transcript: some View {
        let snapshot = store.transcriptSnapshot(now: Date())
        let list = TranscriptScrollView(
            controller: scroll,
            insets: NSEdgeInsets(top: topInset, left: 0, bottom: footerHeight, right: 0),
            rows: transcriptRows(items: snapshot.items, bubbles: snapshot.bubbles),
            animatesAppends: store.historySettled && !store.isLoadingOlder,
            reduceMotion: reduceMotion,
            onZone: { zone in
                let away = zone == .away
                if away != showsJumpButton {
                    showsJumpButton = away
                }
                if zone == .atEnd, unseenCount != 0 {
                    unseenCount = 0
                }
            },
            onNearTop: {
                loadOlderIfNeeded()
            },
            onUserScroll: {
                if !userScrolled {
                    userScrolled = true
                }
                if hoveredItemID != nil {
                    hoveredItemID = nil
                }
            }
        )
        return Color.clear
            .background {
                list
                    .overlay(alignment: .top) {
                        transcriptFade
                    }
                    .ignoresSafeArea(.container, edges: .bottom)
            }
            .overlay(alignment: .bottom) {
            if showsJumpButton && userScrolled && store.historySettled {
                JumpToBottomButton(count: unseenCount, accent: Theme.accent(bot.accent)) {
                    jumpToEnd()
                }
                .padding(.bottom, (Self.fadeHeight - 32) / 2)
                .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .springAnimation(value: showsJumpButton)
        .onChange(of: store.entryMotion) {
            let previous = lastEntryID
            lastEntryID = store.entries.last?.id
            guard store.historySettled, !store.isLoadingOlder else { return }
            guard previous != lastEntryID else { return }
            guard !scroll.isPinned else { return }
            let sentByMe = store.entries.last.map { $0.kind == .user && store.userMessages[$0.id]?.fromBotID == nil } ?? false
            if sentByMe {
                jumpToEnd()
                return
            }
            let added = previous.flatMap { id in store.entries.lastIndex { $0.id == id } }.map { store.entries.count - 1 - $0 } ?? 1
            unseenCount += max(1, added)
        }
        .onChange(of: store.historySettled) {
            lastEntryID = store.entries.last?.id
            fillIfShort()
            reportShown()
        }
        .onChange(of: store.isLoadingOlder) {
            if !store.isLoadingOlder {
                fillIfShort()
            }
        }
        .onAppear {
            lastEntryID = store.entries.last?.id
            if let memory = store.scrollMemory {
                userScrolled = true
                scroll.restore(memory)
            }
            if store.historySettled {
                fillIfShort()
                reportShown()
            }
        }
        .onDisappear {
            store.scrollMemory = scroll.isPinned ? nil : scroll.memory
        }
        .overlay {
            TranscriptLoadingLayer(loading: store.isLoadingHistory)
        }
        .overlay {
            if !store.isLoadingHistory && store.entries.isEmpty && !store.showsThinking {
                ConversationEmptyState(bot: bot, mood: store.mood)
            }
        }
    }

    private func transcriptRows(items: [TranscriptItem], bubbles: [String: BubbleMeta]) -> [TranscriptListRow] {
        var rows: [TranscriptListRow] = []
        if store.hasOlder {
            rows.append(row("transcript-older", OlderMessagesRow(loading: store.isLoadingOlder) {
                loadOlderIfNeeded(force: true)
            }))
        }
        for item in items {
            rows.append(row(item.id, itemView(item, bubbles: bubbles).padding(.top, topSpacing(for: item, bubbles: bubbles))))
        }
        if store.showsThinking, store.mood != .waiting {
            rows.append(row("transcript-thinking", ThinkingCharacter(bot: bot, mood: store.mood, queuePosition: store.queuePosition)
                .padding(.top, 14)))
        }
        rows.append(row("transcript-end", Color.clear.frame(height: Self.fadeHeight)))
        return rows
    }

    private func row(_ id: String, _ content: some View) -> TranscriptListRow {
        TranscriptListRow(
            id: id,
            content: AnyView(
                content
                    .frame(maxWidth: Metrics.transcriptWidth, alignment: .leading)
                    .padding(.horizontal, Spacing.xxl)
                    .frame(maxWidth: .infinity)
                    .environment(model)
                    .environment(\.appReduceMotion, reduceMotion)
                    .environment(\.conversationFontSize, conversationFontSize)
                    .environment(\.transcriptToggle, { row, collapsing in
                        scroll.noteToggle(row: row, collapsing: collapsing)
                    })
            )
        )
    }

    @ViewBuilder
    private func itemView(_ item: TranscriptItem, bubbles: [String: BubbleMeta]) -> some View {
        switch item {
        case .day(_, let label):
            DaySeparator(label: label)
        case .delegation(_, let callIDs):
            DelegationSummary(store: store, callIDs: callIDs)
        case .delegateCard(_, let callIDs):
            DelegationLine(calls: callIDs.compactMap { store.toolCalls[$0] })
        case .caption(_, let text):
            DaySeparator(label: text)
        case .tools(_, let callIDs):
            ToolGroupRow(calls: callIDs.compactMap { store.toolCalls[$0] })
        case .entry(let entry):
            TranscriptRow(
                entry: entry,
                store: store,
                bubble: bubbles[entry.id],
                isHovered: hoveredItemID == entry.id
            ) { id in
                if let id {
                    hoveredItemID = id
                } else if hoveredItemID == entry.id {
                    hoveredItemID = nil
                }
            }
            .equatable()
        }
    }

    private func loadOlderIfNeeded(force: Bool = false) {
        guard force || userScrolled, store.historySettled, store.hasOlder, !store.isLoadingOlder else { return }
        store.loadOlder()
    }

    private func jumpToEnd() {
        unseenCount = 0
        scroll.scrollToEnd(animated: !reduceMotion)
    }

    private func reportShown() {
        guard store.historySettled else { return }
        OpenTiming.shown(store.sessionId, source: store.isRestored ? "cache" : "network")
    }

    private var transcriptFade: some View {
        LinearGradient(colors: [Theme.background, Theme.background.opacity(0)], startPoint: .top, endPoint: .bottom)
            .frame(height: topInset + Spacing.l + Spacing.s)
            .allowsHitTesting(false)
    }

    private func fillIfShort() {
        guard store.historySettled, store.hasOlder, !store.isLoadingOlder,
              store.entries.count < 20 || store.transcriptSnapshot(now: Date()).items.isEmpty else { return }
        store.loadOlder()
    }

    private func topSpacing(for item: TranscriptItem, bubbles: [String: BubbleMeta]) -> CGFloat {
        if case .entry(let entry) = item, let meta = bubbles[entry.id], !meta.isFirst {
            return 4
        }
        return 14
    }

    private var footer: some View {
        VStack(spacing: Spacing.s) {
            if let error = store.lastError {
                ErrorBanner(message: error) {
                    store.dismissError()
                }
                .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
            ConnectionBanner(connection: store.connection)
            if store.openApprovalIDs.count >= 2 {
                HStack(spacing: Spacing.s) {
                    Text("\(store.openApprovalIDs.count) pedidos esperando você")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textSecondary)
                    Spacer(minLength: 0)
                    Button("Agora não para todos") { store.respondAll(optionID: "deny") }
                        .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                    Button("Permitir todos") { store.respondAll(optionID: "approve") }
                        .buttonStyle(SmallPillButtonStyle(kind: .primary))
                }
                .padding(.horizontal, Spacing.m)
                .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
            if let question = store.openQuestion {
                QuestionCard(approval: question, via: question.viaAgent.flatMap { model.bot(id: $0) }) { answers in
                    store.answerQuestion(id: question.id, answers: answers)
                }
                .id(question.id)
                .transition(Motion.insertion(reduceMotion: reduceMotion))
            } else {
                ComposerView(
                    store: store,
                    bot: bot,
                    focusToken: focusToken,
                    mentionables: bot.isGroup ? model.members(of: bot) : []
                )
                .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: Metrics.transcriptWidth + Spacing.l * 2)
        .padding(.horizontal, Spacing.xl)
        .padding(.bottom, Spacing.xl)
        .padding(.top, Spacing.xs)
        .frame(maxWidth: .infinity)
        .springAnimation(value: store.lastError)
        .springAnimation(value: store.connection)
        .springAnimation(value: store.openApprovalIDs.count)
        .springAnimation(value: store.openQuestion?.id)
    }
}

struct JumpToBottomButton: View {
    let count: Int
    let accent: Color
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(hovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 32, height: 32)
                .glassSurface(Circle(), interactive: true, fallback: hovering ? Theme.surfaceRaised : Theme.surface)
                .contentShape(Circle())
                .overlay(alignment: .topTrailing) {
                    if count > 0 {
                        Text(count > 99 ? "99+" : "\(count)")
                            .font(TypeScale.counter)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 16, minHeight: 16)
                            .background(accent, in: Capsule())
                            .offset(x: 6, y: -4)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { hovering = $0 }
        .keyboardShortcut(.downArrow, modifiers: .command)
        .help(count > 0 ? "\(count) nova\(count == 1 ? "" : "s") · ir para o fim (⌘↓)" : "Ir para o fim (⌘↓)")
        .accessibilityLabel(count > 0 ? "Ir para o fim, \(count) mensagens novas" : "Ir para o fim")
        .springAnimation(value: count)
    }
}

struct DaySeparator: View {
    let label: String

    var body: some View {
        Text(label)
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textTertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.s)
            .accessibilityAddTraits(.isHeader)
    }
}

struct ScheduleLine: View {
    let title: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Image(systemName: "clock")
                .font(.system(size: 11, weight: .semibold))
            Text(title.isEmpty ? "Rotina" : "Rotina · \(title)")
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .help(title)
        .font(TypeScale.captionStrong)
        .foregroundStyle(Theme.brandText)
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.xs + 1)
        .background(Theme.surface, in: Capsule())
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xs)
    }
}

struct RouteCaption: View {
    let text: String
    let symbol: String
    let tooltip: String?

    init(name: String, confidence: Double?) {
        text = "Jev escolheu \(name)"
        symbol = "arrow.triangle.branch"
        tooltip = confidence.map { "Confiança \(Int(($0 * 100).rounded()))%" } ?? "Escolhido pelo Jev"
    }

    init(text: String, symbol: String, tooltip: String?) {
        self.text = text
        self.symbol = symbol
        self.tooltip = tooltip
    }

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .semibold))
            Text(text)
        }
        .font(TypeScale.caption)
        .foregroundStyle(Theme.textTertiary)
        .frame(maxWidth: .infinity)
        .help(tooltip ?? text)
    }
}

struct MemoryLine: View {
    let titles: [String]
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Button {
                if titles.count > 1 {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: Spacing.xs + 1) {
                    Image(systemName: "brain")
                        .font(.system(size: 10, weight: .semibold))
                    Text(titles.count == 1 ? "Lembrei: \(titles[0])" : "Lembrei de \(titles.count) coisas")
                        .lineLimit(1)
                    if titles.count > 1 {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .bold))
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                }
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            if isExpanded {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(titles, id: \.self) { title in
                        Text("· \(title)")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .padding(.leading, Spacing.l)
                .transition(.opacity)
            }
        }
        .padding(.leading, 20 + Spacing.s + Spacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .springAnimation(value: isExpanded)
    }
}

struct SystemLine: View {
    let text: String

    var body: some View {
        if let link = SystemLink.parse(text) {
            SystemLinkLine(link: link, symbol: "gearshape")
        } else {
            HStack(spacing: Spacing.s) {
                Image(systemName: "gearshape")
                    .font(.system(size: 11, weight: .semibold))
                Text(text)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.xs)
        }
    }
}

struct TranscriptRow: View, Equatable {
    @Environment(AppModel.self) private var model
    let entry: TranscriptEntry
    let store: ConversationStore
    var bubble: BubbleMeta? = nil
    var isHovered = false
    var setHovered: (String?) -> Void = { _ in }

    nonisolated static func == (lhs: TranscriptRow, rhs: TranscriptRow) -> Bool {
        lhs.entry == rhs.entry && lhs.bubble == rhs.bubble && lhs.isHovered == rhs.isHovered && lhs.store === rhs.store
    }

    private func modelName(account: String, model modelID: String?) -> String {
        if let modelID, let label = model.account(id: account)?.models.first(where: { $0.id == modelID })?.label {
            return label
        }
        if let modelID {
            return ModelNames.pretty(modelID)
        }
        return ModelNames.providerName(account)
    }

    private var foldRef: MessageFoldRef {
        MessageFoldRef(key: "\(store.sessionId ?? store.bot.id)|\(entry.id)", row: entry.id)
    }

    var body: some View {
        switch entry.kind {
        case .user:
            if let message = store.userMessages[entry.id], let fromBotID = message.fromBotID {
                DelegatedRequestBubble(message: message, from: model.bot(id: fromBotID), date: store.entryDates[entry.id])
            } else if let message = store.userMessages[entry.id] {
                UserBubble(message: message, meta: bubble ?? BubbleMeta(), showsAvatar: store.bot.isGroup, fold: foldRef) {
                    store.retry(messageID: message.id)
                }
                .contextMenu {
                    if store.canRewind(entryID: entry.id) {
                        Button("Desfazer este pedido (arquivos e conversa)", systemImage: "arrow.uturn.backward") {
                            CodeActions.rewind(store: store, entryID: entry.id)
                        }
                    }
                }
            }
        case .text:
            if let part = store.textParts[entry.id] {
                switch part.phase {
                case .reply:
                    ReplyCard(
                        part: part,
                        bot: part.botID.flatMap { model.bot(id: $0) } ?? store.bot,
                        showsSpeakerName: store.bot.isGroup,
                        meta: bubble ?? BubbleMeta(),
                        accountLabel: part.account.map { account in
                            model.account(id: account)?.label ?? ModelNames.providerName(account)
                        },
                        isHovered: isHovered,
                        live: part.isStreaming ? store.liveText : nil,
                        onHover: { hovering in
                            setHovered(hovering ? entry.id : nil)
                        },
                        fold: foldRef
                    ) {
                        store.resendPrompt(before: entry.id)
                    }
                case .narration:
                    NarrationLine(text: part.text)
                }
            }
        case .toolCall:
            if let call = store.toolCalls[entry.id] {
                ToolCallRow(call: call, via: call.viaAgent.flatMap { model.bot(id: $0) })
            }
        case .approval:
            if let approval = store.approvals[entry.id], approval.isQuestion {
                QuestionLine(approval: approval)
            } else if let approval = store.approvals[entry.id], let form = approval.secretForm {
                SecretFormCard(approval: approval, form: form, bot: store.bot) { optionID in
                    store.respond(approvalID: approval.id, optionID: optionID)
                }
            } else if let approval = store.approvals[entry.id] {
                ApprovalCard(
                    approval: approval,
                    call: approval.callID.flatMap { store.toolCalls[$0] },
                    accent: store.bot.accent,
                    via: approval.viaAgent.flatMap { model.bot(id: $0) },
                    bot: store.bot,
                    shortcutsEnabled: !model.computerMode
                        && store.draft.isEmpty
                        && store.entries.last(where: { $0.kind == .approval && store.approvals[$0.id]?.isOpen == true })?.id == approval.id
                ) { optionID in
                    store.respond(approvalID: approval.id, optionID: optionID)
                }
            }
        case .notice(let notice):
            NoticeRow(notice: notice) { action in
                model.useFallback(action, for: store.bot) {
                    store.resendPrompt(before: entry.id)
                }
            }
        case .schedule(let title):
            ScheduleLine(title: title)
        case .update(let text):
            SystemLine(text: text)
        case .route(let botID, let confidence):
            RouteCaption(name: model.bot(id: botID)?.name ?? botID, confidence: confidence)
        case .handoff(let from, let to, let note):
            RouteCaption(
                text: "\(model.bot(id: from)?.name ?? from) passou para \(model.bot(id: to)?.name ?? to)",
                symbol: "arrow.right.circle",
                tooltip: note
            )
        case .memory(let titles):
            MemoryLine(titles: titles)
        case .voiceCall(let callID, let seconds):
            VoiceCallLine(seconds: seconds, rating: store.voiceRatings[callID]) { rating in
                store.rateVoiceCall(callID, rating: rating)
            }
        case .artifact(let ref):
            ArtifactCard(ref: ref)
        case .codeEdit(let editID):
            if let edit = store.codeEdits[editID] {
                DiffCard(edit: edit)
            }
        case .codeBulk(let bulkID):
            if let bulk = store.codeBulks[bulkID] {
                CodeBulkLine(bulk: bulk)
            }
        case .codeLine(let text, let symbol):
            CodeSystemLine(text: text, symbol: symbol)
        case .contextHandoff(let handoff):
            ContextHandoffDivider(
                handoff: handoff,
                fromName: handoff.fromAccount.map { modelName(account: $0, model: handoff.fromModel) },
                toName: modelName(account: handoff.toAccount, model: handoff.toModel)
            )
        case .pullRequest(let event):
            PullRequestEventLine(event: event) { text in
                store.sendText(text)
            }
        case .file(let ref):
            MessageAttachments(attachments: [ref], trailing: false)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
