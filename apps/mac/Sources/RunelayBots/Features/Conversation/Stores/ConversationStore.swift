import Foundation
import Observation

enum ConversationPhase: Equatable {
    case idle
    case working
    case awaitingInput
    case failed
}

enum StreamConnection: Equatable {
    case idle
    case connecting
    case live
    case reconnecting
    case ended
    case unavailable(String)
}

@MainActor
@Observable
final class ConversationStore {
    let bot: Bot
    private let client: BotsClient

    private(set) var sessionId: String?
    var draft = ""
    var draftTokens: [ComposerToken] = []
    private(set) var attachmentPool: [UUID: ComposerAttachment] = [:]
    #if os(macOS)
    @ObservationIgnored weak var composerEditor: ComposerEditor?
    #endif
    @ObservationIgnored private var sendWhenReady = false

    private(set) var entries: [TranscriptEntry] = [] {
        didSet {
            transcriptRevision &+= 1
            if historySettled && !quietEntries {
                entryMotion &+= 1
            }
        }
    }
    private(set) var entryMotion = 0
    @ObservationIgnored private var quietEntries = false
    @ObservationIgnored private var recentLines: [[StreamFact]] = []
    @ObservationIgnored private var lineCursor: Int?
    @ObservationIgnored private var restoredCursor: Int?
    @ObservationIgnored private var catchUpBuffer: [StreamRecord]?
    @ObservationIgnored private var catchUpTarget: Int?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    private(set) var userMessages: [String: UserMessage] = [:] { didSet { transcriptRevision &+= 1 } }
    private(set) var reactions: [String: [MessageReaction]] = [:]
    @ObservationIgnored private var reactionWrites: [String: Int] = [:]
    private(set) var textParts: [String: TextPart] = [:] { didSet { transcriptRevision &+= 1 } }
    private(set) var toolCalls: [String: ToolCall] = [:] { didSet { transcriptRevision &+= 1 } }
    private(set) var callOrder: [String] = []
    private(set) var approvals: [String: Approval] = [:] { didSet { transcriptRevision &+= 1 } }
    private(set) var codeEdits: [String: CodeEdit] = [:] { didSet { transcriptRevision &+= 1 } }
    private(set) var codeBulks: [String: CodeBulk] = [:] { didSet { transcriptRevision &+= 1 } }
    private(set) var codeState: CodeState?
    var changesWorkspaceID: String?
    private(set) var revertedTurns: Set<String> = [] { didSet { transcriptRevision &+= 1 } }
    private(set) var queuePosition: Int?
    let liveText = LiveTextBuffer()
    @ObservationIgnored private var transcriptRevision = 0
    @ObservationIgnored private var transcriptCache: (revision: Int, day: Date, value: TranscriptSnapshot)?
    private(set) var checkpointTurns: Set<String> = []
    private(set) var entryTurns: [String: String] = [:]
    @ObservationIgnored private var currentFactTurn: String?
    @ObservationIgnored private var codeRefreshTask: Task<Void, Never>?

    private(set) var phase: ConversationPhase = .idle
    private(set) var tokens = 0
    private(set) var connection: StreamConnection = .idle
    private(set) var isSuspended = false
    private(set) var isCreating = false
    private(set) var lastError: String?

    @ObservationIgnored var onOpenProfile: (@MainActor () -> Void)?
    @ObservationIgnored var onLiveReply: (@MainActor () -> Void)?
    @ObservationIgnored private var scheduleDeliveries: [String: String] = [:]
    @ObservationIgnored private var currentLineDate: Date?
    @ObservationIgnored private var currentAccount: String?
    private(set) var entryDates: [String: Date] = [:] { didSet { transcriptRevision &+= 1 } }
    private(set) var historySettled: Bool
    private(set) var hasOlder = false
    private(set) var isLoadingOlder = false
    var scrollMemory: TranscriptScrollMemory?
    @ObservationIgnored private var olderCursor: Int?
    @ObservationIgnored var onNeedsAttention: (@MainActor () -> Void)?
    @ObservationIgnored var onBotUpdated: (@MainActor () -> Void)?
    @ObservationIgnored var onSettingsChanged: (@MainActor ([String]) -> Void)?
    @ObservationIgnored private var pendingLiveReply = false
    @ObservationIgnored private var turnIsSchedule = false
    @ObservationIgnored var onNotify: (@MainActor (StoreNotification) -> Void)?
    @ObservationIgnored var onDelegation: (@MainActor (String, String?) -> Void)?
    @ObservationIgnored var createSession: (@MainActor @Sendable (String, [String], [String]) async throws -> String)?
    nonisolated static let deliveryDeadline: Double = 30
    @ObservationIgnored private var progressStopShown: Set<String> = []
    private(set) var lastTurnEndedAt: Date?
    private(set) var voiceRatings: [String: String] = [:]
    private(set) var settingsChanges: [String: SettingsChange] = [:] { didSet { transcriptRevision &+= 1 } }
    var settingsUndo: [String: SettingsChange.UndoState] = [:]
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var seenFacts: Set<String> = []

    init(bot: Bot, client: BotsClient, sessionId: String?, settled: Bool = false) {
        self.bot = bot
        self.client = client
        self.sessionId = sessionId
        historySettled = settled || sessionId == nil
        if let sessionId, !settled, let cached = TranscriptCache.shared.read(server: client.baseURL, sessionID: sessionId) {
            restore(cached)
        }
    }

    var isRestored: Bool {
        restoredCursor != nil
    }

    private func restore(_ cached: CachedTranscript) {
        for facts in cached.lines {
            apply(.facts(facts))
        }
        mergeReactions(cached.reactions, covering: MessageReaction.targets(in: cached.lines))
        recentLines = cached.lines
        lineCursor = cached.total
        restoredCursor = cached.total
        olderCursor = cached.start > 0 ? cached.start : nil
        hasOlder = cached.start > 0
        historySettled = true
    }

    private func remember(_ lines: [[StreamFact]], total: Int? = nil) {
        guard let sessionId else { return }
        recentLines.append(contentsOf: lines)
        if recentLines.count > TranscriptCache.pageSize {
            recentLines.removeFirst(recentLines.count - TranscriptCache.pageSize)
        }
        lineCursor = total ?? (lineCursor ?? 0) + lines.count
        guard let cursor = lineCursor else { return }
        let snapshot = CachedTranscript(lines: recentLines, total: cursor, reactions: reactions.values.flatMap { $0 })
        let server = client.baseURL
        saveTask?.cancel()
        saveTask = Task(priority: .utility) {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            TranscriptCache.shared.write(snapshot, server: server, sessionID: sessionId)
        }
    }

    private func receive(_ record: StreamRecord) {
        if var buffer = catchUpBuffer {
            buffer.append(record)
            catchUpBuffer = buffer
            if case .facts = record, let target = catchUpTarget,
               (lineCursor ?? 0) + buffer.reduce(0, { $0 + (Self.isFacts($1) ? 1 : 0) }) >= target {
                flushCatchUp()
            }
            return
        }
        apply(record)
        if case .facts(let facts) = record {
            remember([facts])
        }
    }

    private static func isFacts(_ record: StreamRecord) -> Bool {
        if case .facts = record { return true }
        return false
    }

    private func flushCatchUp() {
        guard let buffer = catchUpBuffer else { return }
        catchUpBuffer = nil
        catchUpTarget = nil
        quietEntries = true
        var lines: [[StreamFact]] = []
        for record in buffer {
            apply(record)
            if case .facts(let facts) = record {
                lines.append(facts)
            }
        }
        quietEntries = false
        if !lines.isEmpty {
            remember(lines)
        }
    }

    func transcriptSnapshot(now: Date) -> TranscriptSnapshot {
        _ = entries
        _ = userMessages
        _ = textParts
        _ = toolCalls
        _ = approvals
        _ = codeEdits
        _ = codeBulks
        _ = revertedTurns
        _ = entryDates
        let day = Calendar.current.startOfDay(for: now)
        if let cache = transcriptCache, cache.revision == transcriptRevision, cache.day == day {
            return cache.value
        }
        let value = TranscriptSnapshot(items: TranscriptItem.build(from: self, now: now), bubbles: BubbleGrouping.compute(self))
        transcriptCache = (transcriptRevision, day, value)
        return value
    }

    var botStatus: BotStatus {
        if isSuspended { return .idle }
        return switch phase {
        case .idle: .idle
        case .working: .working
        case .awaitingInput: .awaitingApproval
        case .failed: .error
        }
    }

    var composerAttachments: [ComposerAttachment] {
        var seen = Set<UUID>()
        return draftTokens.compactMap { token in
            guard case .file(let id) = token, seen.insert(id).inserted else { return nil }
            return attachmentPool[id]
        }
    }

    var attachedSkills: [SkillSummary] {
        var seen = Set<String>()
        let skills: [SkillSummary] = draftTokens.compactMap { token in
            guard case .skill(let skill) = token, seen.insert(skill.slug).inserted else { return nil }
            return skill
        }
        return Array(skills.prefix(5))
    }

    func attachment(_ id: UUID) -> ComposerAttachment? {
        attachmentPool[id]
    }

    var canSend: Bool {
        !isCreating
            && (!ComposerToken.stripped(draft).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachedSkills.isEmpty || !composerAttachments.isEmpty)
            && !composerAttachments.contains(where: \.isFailed)
    }

    var isWaitingForUploads: Bool {
        sendWhenReady && composerAttachments.contains(where: \.isUploading)
    }

    func attachFiles(_ urls: [URL], ownsFiles: Bool = false) {
        var tokens: [ComposerToken] = []
        for url in urls.prefix(max(0, 10 - composerAttachments.count)) {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else { continue }
            let attachment = ComposerAttachment(fileURL: url, ownsFile: ownsFiles)
            attachmentPool[attachment.id] = attachment
            upload(attachment)
            tokens.append(.file(attachment.id))
        }
        insertTokens(tokens)
    }

    func insertTokens(_ tokens: [ComposerToken], replacing range: NSRange? = nil) {
        var slugs = Set(attachedSkills.map(\.slug))
        let accepted = tokens.filter { token in
            guard case .skill(let skill) = token else { return true }
            guard slugs.count < 5, slugs.insert(skill.slug).inserted else { return false }
            return true
        }
        guard !accepted.isEmpty || range != nil else { return }
        #if os(macOS)
        if let composerEditor {
            composerEditor.insert(accepted, replacing: range)
            return
        }
        #endif
        let text = draft as NSString
        let target = range.map { NSIntersectionRange($0, NSRange(location: 0, length: text.length)) } ?? NSRange(location: text.length, length: 0)
        let head = text.substring(to: target.location)
        let tail = text.substring(from: target.location + target.length)
        let removed = ComposerToken.glyphCount(in: text.substring(with: target))
        let index = ComposerToken.glyphCount(in: head)
        var insertion = String(repeating: ComposerToken.glyphString, count: accepted.count)
        if !accepted.isEmpty {
            if let last = head.unicodeScalars.last, !CharacterSet.whitespacesAndNewlines.contains(last) {
                insertion = " " + insertion
            }
            if tail.unicodeScalars.first.map({ !CharacterSet.whitespacesAndNewlines.contains($0) }) ?? true {
                insertion += " "
            }
        }
        var tokensAfter = draftTokens
        let lower = min(index, tokensAfter.count)
        tokensAfter.replaceSubrange(lower..<min(lower + removed, tokensAfter.count), with: accepted)
        draftTokens = tokensAfter
        draft = head + insertion + tail
    }

    func updateDraft(_ text: String, tokens: [ComposerToken]) {
        if draft != text {
            draft = text
        }
        if draftTokens != tokens {
            draftTokens = tokens
        }
    }

    func adoptDraft(from other: ConversationStore) {
        attachmentPool.merge(other.attachmentPool) { current, _ in current }
        draftTokens = other.draftTokens
        draft = other.draft
    }

    func markedText(_ text: String, tokens: [ComposerToken]) -> String {
        var result = ""
        var tokens = tokens.makeIterator()
        for scalar in text.unicodeScalars {
            guard scalar == ComposerToken.glyph else {
                result.unicodeScalars.append(scalar)
                continue
            }
            switch tokens.next() {
            case .file(let id):
                if let attachment = attachmentPool[id] {
                    result += InlineMarker.file(attachment.ref?.name ?? attachment.name)
                }
            case .skill(let skill):
                result += InlineMarker.skill(skill.slug)
            case nil:
                break
            }
        }
        return result
    }

    func retryUpload(_ attachment: ComposerAttachment) {
        guard attachment.isFailed else { return }
        upload(attachment)
    }

    private func upload(_ attachment: ComposerAttachment) {
        attachment.state = .uploading(0)
        let client = client
        let botID = bot.id
        let fileURL = attachment.fileURL
        let name = attachment.name
        attachment.task = Task { [weak self, weak attachment] in
            do {
                let ref = try await client.uploadAttachment(botID: botID, fileURL: fileURL, name: name) { fraction in
                    Task { @MainActor in
                        guard let attachment, attachment.isUploading else { return }
                        attachment.state = .uploading(min(0.98, fraction))
                    }
                }
                guard let attachment, !Task.isCancelled else { return }
                attachment.state = .ready(ref)
                attachment.discardFile()
            } catch {
                guard let attachment, !Task.isCancelled else { return }
                attachment.state = .failed(ErrorMessage.describe(error))
                self?.sendWhenReady = false
            }
            self?.sendIfReady()
        }
    }

    private func sendIfReady() {
        guard sendWhenReady, !composerAttachments.contains(where: \.isUploading) else { return }
        sendWhenReady = false
        guard !composerAttachments.contains(where: \.isFailed) else { return }
        send()
    }

    var canStop: Bool {
        sessionId != nil && phase == .working
    }

    var isLoadingHistory: Bool {
        if case .unavailable = connection {
            return false
        }
        return !historySettled
    }

    var hasOpenQuestion: Bool {
        approvals.values.contains(where: \.isOpen)
    }

    var showsThinking: Bool {
        if phase == .awaitingInput {
            return true
        }
        guard phase == .working else { return false }
        if let last = entries.last, last.kind == .text, textParts[last.id]?.isStreaming == true {
            return false
        }
        return true
    }

    var isSpeaking: Bool {
        guard phase == .working, let last = entries.last, last.kind == .text else { return false }
        return textParts[last.id]?.isStreaming == true
    }

    var mood: CharacterMood {
        if isSuspended { return .idle }
        return switch phase {
        case .idle: .idle
        case .working: isSpeaking ? .speaking : .thinking
        case .awaitingInput: .waiting
        case .failed: .error
        }
    }

    var preview: String? {
        for entry in entries.reversed() where entry.kind == .text {
            if let part = textParts[entry.id], part.phase == .reply {
                let line = part.text
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !line.isEmpty {
                    return line
                }
            }
        }
        return nil
    }

    var lastActivity: ThreadActivity? {
        for entry in entries.reversed() {
            switch entry.kind {
            case .user:
                if let message = userMessages[entry.id] {
                    if message.fromBotID != nil {
                        return ThreadActivity(text: "\(message.fromName ?? "Outro bot") pediu: \(message.text)", isUser: false, date: entryDates[entry.id])
                    }
                    let shown = message.text.isEmpty ? (message.attachments.count == 1 ? "📎 \(message.attachments[0].name)" : "📎 \(message.attachments.count) anexos") : message.text
                    return ThreadActivity(text: shown, isUser: true, date: entryDates[entry.id])
                }
            case .text:
                if let part = textParts[entry.id], part.phase == .reply {
                    return ThreadActivity(text: part.text, isUser: false, date: entryDates[entry.id], speakerID: part.botID)
                }
            default:
                continue
            }
        }
        return nil
    }

    var orderedToolCalls: [ToolCall] {
        callOrder.compactMap { toolCalls[$0] }
    }

    func start() {
        guard streamTask == nil, let sessionId else { return }
        connection = .connecting
        Task { [weak self] in await self?.refreshCode() }
        let client = client
        let basePath = bot.sessionBasePath
        let stream = SessionStream(client: client, basePath: basePath, sessionId: sessionId)
        if let cursor = lineCursor {
            catchUpBuffer = []
            Task { [weak self] in
                let head = try? await client.events(basePath: basePath, sessionId: sessionId, before: nil, limit: 1)
                guard let self, self.catchUpBuffer != nil else { return }
                let buffered = self.catchUpBuffer?.reduce(0) { $0 + (Self.isFacts($1) ? 1 : 0) } ?? 0
                if let total = head?.total, total > cursor + buffered {
                    self.catchUpTarget = total
                    try? await Task.sleep(for: .seconds(4))
                }
                self.flushCatchUp()
            }
            streamTask = Task { [weak self] in
                for await record in stream.records(startingAt: cursor) {
                    guard let self else { return }
                    self.receive(record)
                }
            }
            return
        }
        streamTask = Task { [weak self] in
            var startIndex = 0
            let firstPage = try? await client.events(basePath: basePath, sessionId: sessionId, before: nil, limit: TranscriptCache.pageSize)
            if let page = firstPage {
                guard let self else { return }
                for facts in page.lines {
                    self.apply(.facts(facts))
                }
                if let snapshot = page.reactions {
                    self.mergeReactions(snapshot, covering: MessageReaction.targets(in: page.lines))
                }
                self.olderCursor = page.nextBefore
                self.hasOlder = (page.nextBefore ?? 0) > 0
                startIndex = page.total ?? 0
                self.recentLines = []
                self.remember(page.lines, total: startIndex)
                self.settleHistory()
            }
            for await record in stream.records(startingAt: startIndex) {
                guard let self else { return }
                self.receive(record)
            }
        }
    }

    func loadOlder() {
        guard hasOlder, !isLoadingOlder, let before = olderCursor, let sessionId else { return }
        isLoadingOlder = true
        let client = client
        let basePath = bot.sessionBasePath
        Task {
            defer { isLoadingOlder = false }
            let fetched = try? await client.events(basePath: basePath, sessionId: sessionId, before: before, limit: TranscriptCache.pageSize)
            guard let page = fetched else {
                hasOlder = false
                return
            }
            let older = ConversationStore(bot: bot, client: client, sessionId: nil)
            for facts in page.lines {
                older.apply(.facts(facts))
            }
            absorbOlder(older)
            if let snapshot = page.reactions {
                mergeReactions(snapshot, covering: MessageReaction.targets(in: page.lines))
            }
            olderCursor = page.nextBefore
            hasOlder = (page.nextBefore ?? 0) > 0
        }
    }

    private func absorbOlder(_ older: ConversationStore) {
        let existing = Set(entries.map(\.id))
        let fresh = older.entries.filter { !existing.contains($0.id) }
        guard !fresh.isEmpty else { return }
        quietEntries = true
        entries = fresh + entries
        quietEntries = false
        userMessages.merge(older.userMessages) { current, _ in current }
        textParts.merge(older.textParts) { current, _ in current }
        toolCalls.merge(older.toolCalls) { current, _ in current }
        approvals.merge(older.approvals) { current, _ in current }
        entryDates.merge(older.entryDates) { current, _ in current }
        codeEdits.merge(older.codeEdits) { current, _ in current }
        codeBulks.merge(older.codeBulks) { current, _ in current }
        entryTurns.merge(older.entryTurns) { current, _ in current }
        reactions.merge(older.reactions) { current, _ in current }
        checkpointTurns.formUnion(older.checkpointTurns)
        revertedTurns.formUnion(older.revertedTurns)
        let known = Set(callOrder)
        callOrder = older.callOrder.filter { !known.contains($0) } + callOrder
        seenFacts.formUnion(older.seenFacts)
    }

    private func settleHistory() {
        if !historySettled {
            historySettled = true
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func suspend() {
        guard !isSuspended else { return }
        isSuspended = true
        stop()
        flushCatchUp()
        dropStreamingParts()
        if connection != .ended {
            connection = .idle
        }
    }

    func resume() {
        guard isSuspended else { return }
        isSuspended = false
        start()
    }

    func clearDraft() {
        for attachment in attachmentPool.values {
            attachment.task?.cancel()
            attachment.discardFile()
        }
        attachmentPool = [:]
        draftTokens = []
        draft = ""
        sendWhenReady = false
    }

    func dismissError() {
        lastError = nil
    }

    func send() {
        let pending = composerAttachments
        let skills = attachedSkills
        let typed = markedText(draft, tokens: draftTokens).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty || !skills.isEmpty || !pending.isEmpty, !isCreating else { return }
        if pending.contains(where: \.isUploading) {
            sendWhenReady = true
            return
        }
        guard !pending.contains(where: \.isFailed) else { return }
        let attachments = pending.compactMap(\.ref)
        let kept = Set(pending.map(\.id))
        for attachment in attachmentPool.values where !kept.contains(attachment.id) {
            attachment.task?.cancel()
            attachment.discardFile()
        }
        attachmentPool = [:]
        draftTokens = []
        draft = ""
        sendWhenReady = false
        post(text: typed, skills: skills, attachments: attachments)
    }

    private func post(text: String, skills: [SkillSummary], attachments: [AttachmentRef]) {
        lastError = nil
        let message = UserMessage(id: "local-\(UUID().uuidString)", text: text, state: .sending, isConfirmed: false, skills: skills, attachments: attachments)
        userMessages[message.id] = message
        append(TranscriptEntry(id: message.id, kind: .user), date: Date())
        let queued = phase == .working || phase == .awaitingInput
        if !queued {
            phase = .working
        }
        deliver(messageID: message.id, text: text, skills: skills.map(\.slug), attachments: attachments.map(\.id), queued: queued)
    }

    func resendPrompt(before entryID: String) {
        guard !isCreating, let index = entries.firstIndex(where: { $0.id == entryID }) else { return }
        let previous = entries[..<index].last { $0.kind == .user }
        guard let previous, let message = userMessages[previous.id] else { return }
        post(text: message.text, skills: message.skills, attachments: message.attachments)
    }

    func retry(messageID: String) {
        guard let message = userMessages[messageID], case .failed = message.state else { return }
        userMessages[messageID]?.state = .sending
        lastError = nil
        let queued = phase == .working || phase == .awaitingInput
        if !queued {
            phase = .working
        }
        deliver(messageID: messageID, text: message.isSkillOnly ? "" : message.text, skills: message.skills.map(\.slug), attachments: message.attachments.map(\.id), queued: queued)
    }

    func respond(approvalID: String, optionID: String) {
        guard let approval = approvals[approvalID], approval.isOpen, let sessionId else { return }
        let previousPhase = phase
        approvals[approvalID]?.resolution = .answering(optionID)
        if phase == .awaitingInput, !approvals.values.contains(where: \.isOpen) {
            phase = .working
        }
        lastError = nil
        let client = client
        let basePath = bot.sessionBasePath
        Task {
            do {
                try await client.answer(
                    basePath: basePath,
                    sessionId: sessionId,
                    interactionId: approvalID,
                    optionId: optionID
                )
            } catch {
                guard approvals[approvalID]?.resolution == .answering(optionID) else { return }
                approvals[approvalID]?.resolution = .open
                phase = previousPhase
                lastError = ErrorMessage.describe(error)
            }
        }
    }

    func rateVoiceCall(_ callID: String, rating: String?) {
        let previous = voiceRatings[callID]
        voiceRatings[callID] = rating
        let client = VoiceCallClient(client: client)
        let botID = bot.id
        Task {
            do {
                try await client.rate(botID: botID, callID: callID, rating: rating)
            } catch {
                voiceRatings[callID] = previous
                lastError = "Não consegui salvar a avaliação da chamada."
            }
        }
    }

    func cancelTurn() {
        guard let sessionId, phase == .working else { return }
        let client = client
        let basePath = bot.sessionBasePath
        Task {
            do {
                try await client.cancel(basePath: basePath, sessionId: sessionId)
            } catch {
                lastError = ErrorMessage.describe(error)
            }
        }
    }

    private func deliver(messageID: String, text: String, skills: [String] = [], attachments: [String] = [], queued: Bool) {
        let client = client
        let basePath = bot.sessionBasePath
        let existing = sessionId
        if existing == nil {
            isCreating = true
        }
        let create = createSession
        Task {
            do {
                if let existing {
                    _ = try await Deadline.run(seconds: Self.deliveryDeadline) {
                        try await client.sendMessage(basePath: basePath, sessionId: existing, message: text, skills: skills, attachments: attachments)
                    }
                } else {
                    let newID = try await Deadline.run(seconds: Self.deliveryDeadline) {
                        if let create {
                            return try await create(text, skills, attachments)
                        }
                        return try await client.createSession(basePath: basePath, message: text, skills: skills, attachments: attachments)
                    }
                    sessionId = newID
                    isCreating = false
                    start()
                }
                if userMessages[messageID]?.state == .sending {
                    let stillBusy = phase == .working || phase == .awaitingInput
                    let confirmed = userMessages[messageID]?.isConfirmed == true
                    userMessages[messageID]?.state = queued && stillBusy && !confirmed ? .queued : .sent
                }
            } catch {
                isCreating = false
                let description = ErrorMessage.describe(error)
                userMessages[messageID]?.state = .failed(description)
                if phase == .working {
                    phase = .idle
                }
            }
        }
    }

    private func apply(_ record: StreamRecord) {
        switch record {
        case .connected:
            connection = .live
        case .reconnecting:
            connection = .reconnecting
            dropStreamingParts()
        case .ended:
            connection = .ended
            settleHistory()
            finishStreamingParts()
            if phase == .working || phase == .awaitingInput {
                phase = .idle
            }
        case .unavailable(let message):
            connection = .unavailable(message)
            settleHistory()
            appendNotice(TranscriptNotice(text: message, detail: nil, tone: .info))
        case .facts(let facts):
            if let at = facts.first?.at, let date = ISODate.parse(at) {
                currentLineDate = date
            }
            for fact in facts where seenFacts.insert(fact.key).inserted {
                applyFact(fact)
            }
            if !historySettled && connection == .live {
                settleHistory()
            }
        case .progress(let fact):
            applyProgress(fact)
        }
    }

    private func applyFact(_ fact: StreamFact) {
        let data = fact.data
        currentFactTurn = fact.scope?["turnId"]?.stringValue ?? data["turnId"]?.stringValue
        if fact.type.hasPrefix("code.") || fact.type == "turn.reverted" {
            applyCodeFact(fact)
            return
        }
        switch fact.type {
        case "model.started":
            if let account = data["account"]?.stringValue {
                currentAccount = account
            }
        case "turn.started":
            turnIsSchedule = false
            phase = .working
        case "turn.queued":
            queuePosition = isLiveLine ? data["position"]?.intValue : nil
        case "turn.dequeued":
            queuePosition = nil
        case "turn.paused":
            phase = .awaitingInput
        case "turn.settled":
            lastTurnEndedAt = Date()
            queuePosition = nil
            if codeState?.workspace != nil, isLiveLine {
                scheduleCodeRefresh()
            }
            if pendingLiveReply {
                pendingLiveReply = false
                if data["quiet"]?.boolValue != true {
                    onLiveReply?()
                    if let last = lastReplyPart {
                        onNotify?(.reply(text: last.text, speakerID: last.botID, schedule: turnIsSchedule))
                    }
                }
            }
            if data["outcome"]?.stringValue == "failed", isLiveLine {
                let notice = FriendlyError.notice(
                    code: data["error"]?["code"]?.stringValue,
                    message: Self.errorText(data),
                    fallback: "Algo deu errado neste turno."
                )
                onNotify?(.failed(notice.text))
            }
            finishStreamingParts()
            closeOpenApprovals()
            closeActiveDelegations(turnID: data["turnId"]?.stringValue)
            switch data["outcome"]?.stringValue ?? "" {
            case "failed":
                phase = .failed
                var notice = FriendlyError.notice(
                    code: data["error"]?["code"]?.stringValue,
                    message: Self.errorText(data),
                    fallback: "Algo deu errado neste turno."
                )
                if let suggest = data["error"]?["suggest"], let account = suggest["account"]?.stringValue {
                    notice.action = FallbackOffer(
                        label: "Continuar com \(suggest["label"]?.stringValue ?? ModelNames.providerName(account))",
                        account: account,
                        model: suggest["model"]?.stringValue
                    )
                }
                appendNotice(notice)
            case "cancelled":
                phase = .idle
                appendNotice(TranscriptNotice(text: "Turno interrompido.", detail: nil, tone: .info))
            default:
                phase = .idle
            }
        case "delivery.admitted":
            if Self.isScheduleDelivery(data), let deliveryID = data["deliveryId"]?.stringValue {
                scheduleDeliveries[deliveryID] = Self.scheduleID(data) ?? ""
            }
        case "reaction.added", "reaction.removed":
            if let reaction = MessageReaction(json: data) {
                setReaction(reaction, on: fact.type == "reaction.added")
            }
        case "delivery.consumed":
            applyConsumed(data, key: fact.key)
        case "content.completed":
            applyContent(data, key: fact.key)
        case "call.requested":
            applyCallRequested(data, key: fact.key, turnID: fact.scope?["turnId"]?.stringValue)
        case "call.started":
            if let callID = data["callId"]?.stringValue, toolCalls[callID]?.status == .requested {
                toolCalls[callID]?.status = .running
            }
        case "call.settled":
            applyCallSettled(data)
        case "delegation.updated":
            applyDelegationUpdated(data)
        case "interaction.opened":
            applyInteractionOpened(data, key: fact.key)
        case "interaction.settled":
            applyInteractionSettled(data)
        case "decision.made":
            applyDecision(data, turnID: fact.scope?["turnId"]?.stringValue)
        case "computer.action":
            if let callID = data["callId"]?.stringValue, let path = data["screenshotPath"]?.stringValue, toolCalls[callID] != nil {
                toolCalls[callID]?.screenshotPath = path
            }
        case "account.failover", "account.restored", "context.handoff":
            if let to = data["to"]?.stringValue ?? data["account"]?.stringValue {
                let handoff = ContextHandoff(
                    reason: data["reason"]?.stringValue ?? "Contexto passado",
                    fromAccount: data["from"]?.stringValue,
                    fromModel: data["fromModel"]?.stringValue,
                    toAccount: to,
                    toModel: data["toModel"]?.stringValue,
                    detail: data["line"]?.stringValue
                )
                append(TranscriptEntry(id: "account-\(fact.key)", kind: .contextHandoff(handoff)), date: currentLineDate)
            }
        case "handoff.requested":
            if let from = data["from"]?.stringValue, let to = data["to"]?.stringValue {
                append(
                    TranscriptEntry(id: "handoff-\(fact.key)", kind: .handoff(from, to, data["note"]?.stringValue)),
                    date: currentLineDate
                )
            }
        case "voice.call.ended":
            if let callID = data["callId"]?.stringValue {
                let id = "voicecall-\(callID)"
                if !entries.contains(where: { $0.id == id }) {
                    append(TranscriptEntry(id: id, kind: .voiceCall(callID, data["durationSecs"]?.intValue ?? 0)), date: currentLineDate)
                }
            }
        case "file.sent":
            if let ref = AttachmentRef(json: data["attachment"] ?? .null) {
                let id = "file-\(ref.id)"
                if !entries.contains(where: { $0.id == id }) {
                    append(TranscriptEntry(id: id, kind: .file(ref)), date: currentLineDate)
                }
            }
        case "artifact.created", "artifact.updated":
            if let artifactID = data["artifactId"]?.stringValue {
                let ref = ArtifactRef(
                    botID: data["botId"]?.stringValue ?? bot.id,
                    id: artifactID,
                    title: data["title"]?.stringValue ?? "Artefato",
                    kind: data["kind"]?.stringValue ?? "page",
                    version: data["version"]?.intValue ?? 1
                )
                let byUser = data["author"]?.stringValue == "user"
                if !byUser {
                    append(TranscriptEntry(id: "artifact-\(fact.key)", kind: .artifact(ref)), date: currentLineDate)
                }
                #if os(macOS)
                ArtifactCenter.shared.noteChange(ref, byUser: byUser)
                #endif
            }
        #if os(macOS)
        case "test.result":
            if let runID = data["id"]?.stringValue {
                TestStore.shared.apply(data)
                let id = "test-\(runID)"
                if !entries.contains(where: { $0.id == id }) {
                    let ref = ArtifactRef(botID: bot.id, id: runID, title: data["title"]?.stringValue ?? "Teste", kind: TestStore.panelKind, version: 1)
                    append(TranscriptEntry(id: id, kind: .artifact(ref)), date: currentLineDate)
                }
            }
        case "server.card":
            if let serverID = data["serverId"]?.stringValue {
                ServerStore.shared.applyLine(.object(["server": data["server"] ?? .null]))
                let ref = ArtifactRef(
                    botID: data["botId"]?.stringValue ?? bot.id,
                    id: serverID,
                    title: data["server"]?["name"]?.stringValue ?? "Servidor",
                    kind: ServerStore.panelKind,
                    version: 1
                )
                let id = "server-\(serverID)"
                if !entries.contains(where: { $0.id == id }) {
                    append(TranscriptEntry(id: id, kind: .artifact(ref)), date: currentLineDate)
                }
            }
        #endif
        case "block.created", "block.updated", "block.deleted":
            if let event = BlockEvent(type: fact.type, data: data, fallbackBotID: bot.id) {
                if event.author == .bot, event.action != "deleted" {
                    append(TranscriptEntry(id: "block-\(fact.key)", kind: .artifact(event.ref)), date: currentLineDate)
                }
                #if os(macOS)
                BlockCenter.shared.handle(event, client: client)
                #endif
            }
        case "voice.call.rated":
            if let callID = data["callId"]?.stringValue {
                voiceRatings[callID] = data["rating"]?.stringValue
            }
        case "memory.saved":
            var titles = data["titles"]?.arrayValue?.compactMap(\.stringValue) ?? []
            if titles.isEmpty, let title = data["title"]?.stringValue {
                titles = [title]
            }
            if !titles.isEmpty {
                append(TranscriptEntry(id: "memory-\(fact.key)", kind: .memory(titles)), date: currentLineDate)
            }
        case "bot.updated":
            let summary = data["summary"]?.stringValue
                ?? (data["fields"]?.arrayValue?.compactMap(\.stringValue).joined(separator: ", ")).map { "atualizou \($0)" }
                ?? "atualizou a própria configuração"
            append(TranscriptEntry(id: "update-\(fact.key)", kind: .update("\(bot.name): \(summary)")), date: currentLineDate)
            onBotUpdated?()
        case "settings.changed":
            let id = "settings-\(fact.key)"
            if let change = SettingsChange(id: id, data) {
                settingsChanges[id] = change
                append(TranscriptEntry(id: id, kind: .settingsChange(id)), date: currentLineDate)
                if historySettled {
                    onSettingsChanged?(change.areas)
                }
            }
        case "usage.recorded":
            tokens += Self.tokenCount(data)
        case "session.ended":
            finishStreamingParts()
            if data["outcome"]?.stringValue == "failed" {
                phase = .failed
                appendNotice(FriendlyError.notice(
                    code: data["error"]?["code"]?.stringValue,
                    message: Self.errorText(data),
                    fallback: "A conversa terminou com erro."
                ))
            } else if phase != .failed {
                phase = .idle
            }
        default:
            break
        }
    }

    var myUserID: String? {
        AuthSession.shared.user?.id
    }

    func reactionTarget(for entry: TranscriptEntry) -> String? {
        switch entry.kind {
        case .user:
            guard let message = userMessages[entry.id], message.fromBotID == nil else { return nil }
            return message.deliveryID
        case .text:
            guard let part = textParts[entry.id], part.phase == .reply, !part.isStreaming else { return nil }
            return part.id
        default:
            return nil
        }
    }

    func toggleReaction(target: String, emoji: String) {
        guard let sessionId else { return }
        let me = myUserID
        let previous = reactions[target] ?? []
        let mine = previous.first { $0.authorKind == .user && $0.emoji == emoji && (me == nil || $0.authorID == me) }
        let reaction = mine ?? MessageReaction(
            target: target,
            emoji: emoji,
            authorKind: .user,
            authorID: me ?? "local",
            at: ISO8601DateFormatter().string(from: Date())
        )
        let on = mine == nil
        setReaction(reaction, on: on)
        reactionWrites[target, default: 0] += 1
        let client = client
        let basePath = bot.sessionBasePath
        Task { [weak self] in
            do {
                try await client.setReaction(basePath: basePath, sessionId: sessionId, target: target, emoji: emoji, on: on)
                self?.finishReactionWrite(target: target, restore: nil)
            } catch {
                self?.finishReactionWrite(target: target, restore: previous)
            }
        }
    }

    private func finishReactionWrite(target: String, restore: [MessageReaction]?) {
        let left = (reactionWrites[target] ?? 1) - 1
        reactionWrites[target] = left > 0 ? left : nil
        if let restore {
            reactions[target] = restore.isEmpty ? nil : restore
            lastError = "Não deu para reagir agora. Tente de novo."
            persistReactions()
        }
    }

    private func setReaction(_ reaction: MessageReaction, on: Bool) {
        var list = reactions[reaction.target] ?? []
        let exists = list.contains { $0.identity == reaction.identity }
        if on, !exists {
            list.append(reaction)
        } else if !on, exists {
            list.removeAll { $0.identity == reaction.identity }
        } else {
            return
        }
        reactions[reaction.target] = list.isEmpty ? nil : list
        persistReactions()
    }

    private func mergeReactions(_ snapshot: [MessageReaction], covering targets: Set<String>) {
        var grouped: [String: [MessageReaction]] = [:]
        for reaction in snapshot {
            grouped[reaction.target, default: []].append(reaction)
        }
        var next = reactions
        for target in targets.union(grouped.keys) where reactionWrites[target] == nil {
            next[target] = grouped[target]
        }
        if next != reactions {
            reactions = next
        }
    }

    private func persistReactions() {
        guard historySettled, lineCursor != nil else { return }
        remember([])
    }

    private func applyProgress(_ fact: StreamFact) {
        guard fact.type == "content.delta" else { return }
        let data = fact.data
        guard let partID = data["partId"]?.stringValue,
              let delta = data["delta"]?.stringValue
        else { return }
        if data["kind"]?.stringValue == "reasoning" {
            return
        }
        if let part = textParts[partID] {
            guard part.isStreaming else { return }
            liveText.append(partID, delta: delta)
        } else {
            liveText.seed(partID, text: delta)
            textParts[partID] = TextPart(
                id: partID,
                text: delta,
                phase: .reply,
                isStreaming: true,
                account: currentAccount,
                botID: data["botId"]?.stringValue
            )
            append(TranscriptEntry(id: partID, kind: .text), date: currentLineDate ?? Date())
        }
    }

    private func applyConsumed(_ data: JSONValue, key: String) {
        let parts = data["parts"]?.arrayValue ?? []
        let texts = parts.compactMap { part -> String? in
            if let text = part["text"]?.stringValue {
                return text
            }
            if part["type"]?.stringValue == "text" || part["kind"]?.stringValue == "text" {
                return part["value"]?.stringValue
            }
            return part.stringValue
        }
        let text = texts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = AttachmentRef.list(in: data["attachments"])
        guard !text.isEmpty || !attachments.isEmpty else { return }

        if let pending = entries.first(where: { entry in
            guard entry.kind == .user, let message = userMessages[entry.id] else { return false }
            return !message.isConfirmed && message.text == text && message.attachments.map(\.id) == attachments.map(\.id)
        }) {
            if !attachments.isEmpty {
                userMessages[pending.id]?.attachments = attachments
            }
            userMessages[pending.id]?.isConfirmed = true
            userMessages[pending.id]?.state = .sent
            userMessages[pending.id]?.deliveryID = data["deliveryId"]?.stringValue
            let known = userMessages[pending.id]?.skills ?? []
            let confirmedSkills = Self.skills(in: data).map { skill in
                guard skill.description.isEmpty, let local = known.first(where: { $0.slug == skill.slug }) else { return skill }
                return SkillSummary(slug: skill.slug, name: skill.name, description: local.description)
            }
            if !confirmedSkills.isEmpty {
                userMessages[pending.id]?.skills = confirmedSkills
            }
            if data["voice"]?.boolValue == true {
                userMessages[pending.id]?.isVoice = true
            }
            return
        }

        let deliveryID = data["deliveryId"]?.stringValue ?? key
        let id = "delivery-\(deliveryID)"
        if scheduleDeliveries[deliveryID] != nil || Self.isScheduleDelivery(data) {
            turnIsSchedule = true
            guard !entries.contains(where: { $0.id == id }) else { return }
            let scheduleID = Self.scheduleID(data) ?? scheduleDeliveries[deliveryID].flatMap { $0.isEmpty ? nil : $0 }
            append(TranscriptEntry(id: id, kind: .schedule(scheduleLabel(scheduleID, text: text))), date: currentLineDate)
            return
        }
        guard userMessages[id] == nil else { return }
        userMessages[id] = UserMessage(id: id, text: text, state: .sent, isConfirmed: true, isVoice: data["voice"]?.boolValue == true, skills: Self.skills(in: data), attachments: attachments, deliveryID: data["deliveryId"]?.stringValue)
        if let from = data["from"]?["botId"]?.stringValue {
            userMessages[id]?.fromBotID = from
            userMessages[id]?.fromName = data["from"]?["name"]?.stringValue
        }
        append(TranscriptEntry(id: id, kind: .user), date: currentLineDate)
    }

    private static func skills(in data: JSONValue) -> [SkillSummary] {
        (data["skills"]?.arrayValue ?? []).compactMap { item in
            guard let slug = item["slug"]?.stringValue else { return nil }
            let name = item["name"]?.stringValue ?? slug
            return SkillSummary(slug: slug, name: name.isEmpty ? slug : name)
        }
    }

    private func applyContent(_ data: JSONValue, key: String) {
        let partID = data["partId"]?.stringValue ?? key
        let kind = data["kind"]?.stringValue ?? "text"
        let text: String
        switch kind {
        case "text":
            text = data["value"]?.stringValue ?? ""
        case "result":
            text = data["value"].map { $0.stringValue ?? ReadableResult.plainText($0) } ?? ""
        case "file":
            let name = data["value"]?["name"]?.stringValue ?? data["name"]?.stringValue ?? "arquivo"
            text = "Arquivo: \(name)"
        default:
            removeText(partID)
            return
        }
        let textPhase: TextPhase = data["phase"]?.stringValue == "narration" ? .narration : .reply
        guard !text.isEmpty else {
            removeText(partID)
            return
        }
        liveText.finish(partID)
        if textParts[partID] == nil {
            append(TranscriptEntry(id: partID, kind: .text), date: currentLineDate)
        }
        textParts[partID] = TextPart(
            id: partID,
            text: text,
            phase: textPhase,
            isStreaming: false,
            account: currentAccount ?? textParts[partID]?.account,
            botID: data["botId"]?.stringValue ?? textParts[partID]?.botID,
            isVoice: data["voice"]?.boolValue == true
        )
        if textPhase == .reply, connection == .live, let date = currentLineDate, Date().timeIntervalSince(date) < 120 {
            pendingLiveReply = true
        }
    }

    private func applyCallRequested(_ data: JSONValue, key: String, turnID: String? = nil) {
        let callID = data["callId"]?.stringValue ?? key
        guard toolCalls[callID] == nil else { return }
        let capability = data["capability"]
        if capability?["hidden"]?.boolValue == true {
            return
        }
        let kind = capability?["kind"]?.stringValue ?? "tool"
        if kind == "control" {
            return
        }
        let name = capability?["name"]?.stringValue
            ?? capability?.stringValue
            ?? data["name"]?.stringValue
            ?? data["toolName"]?.stringValue
            ?? "ferramenta"
        let label = capability?["label"]?.stringValue
        let ownerCall = data["owner"]?["callId"]?.stringValue
        let via = data["origin"]?["agent"]?.stringValue
            ?? ownerCall.flatMap { toolCalls[$0]?.name }
        toolCalls[callID] = ToolCall(
            id: callID,
            name: name,
            kind: kind,
            label: label,
            input: data["input"] ?? .null,
            status: .requested,
            output: nil,
            errorMessage: nil,
            viaAgent: via,
            ownerCallID: ownerCall,
            requestedAt: currentLineDate
        )
        toolCalls[callID]?.turnID = turnID
        if let target = data["delegation"]?["botId"]?.stringValue {
            toolCalls[callID]?.delegation = DelegationLink(botID: target)
            if isLiveLine {
                onDelegation?(target, nil)
            }
        }
        callOrder.append(callID)
        append(TranscriptEntry(id: callID, kind: .toolCall), date: currentLineDate)
    }

    private func applyDelegationUpdated(_ data: JSONValue) {
        guard let callID = data["callId"]?.stringValue, toolCalls[callID] != nil else { return }
        var link = toolCalls[callID]?.delegation ?? DelegationLink(botID: data["botId"]?.stringValue ?? "")
        if let session = data["sessionId"]?.stringValue {
            link.sessionID = session
        }
        if let state = data["status"]?.stringValue.flatMap(DelegationState.init(rawValue:)) {
            link.state = state
        }
        if let summary = data["summary"]?.stringValue {
            link.summary = summary
        }
        if let error = data["error"]?.stringValue {
            link.error = error
        }
        toolCalls[callID]?.delegation = link
        if link.state.isActive, historySettled, !link.botID.isEmpty {
            onDelegation?(link.botID, link.sessionID)
        }
    }

    private func applyCallSettled(_ data: JSONValue) {
        guard let callID = data["callId"]?.stringValue, var call = toolCalls[callID] else { return }
        call.status = ToolCallStatus(outcome: data["outcome"]?.stringValue)
        call.settledAt = currentLineDate
        if let output = data["output"], !output.isNull {
            call.output = output
        }
        if let message = Self.errorText(data) {
            call.errorMessage = message
        }
        if var link = call.delegation, link.state.isActive {
            link.state = call.status == .completed ? .completed : .failed
            if link.summary == nil, call.status == .completed {
                link.summary = call.output?.stringValue
            }
            call.delegation = link
        }
        if let label = data["label"]?.stringValue, !label.isEmpty {
            call.label = label
        }
        if call.status == .completed, ["create_bot", "create_group", "update_group", "archive_group"].contains(call.name) {
            onBotUpdated?()
        }
        toolCalls[callID] = call
    }

    private func applyInteractionOpened(_ data: JSONValue, key: String) {
        let id = data["interactionId"]?.stringValue ?? key
        guard approvals[id] == nil else { return }
        let request = data["request"] ?? data
        let kind = request["kind"]?.stringValue ?? "approval"
        let prompt = request["prompt"]?.stringValue ?? request["question"]?.stringValue ?? ""

        var options: [ApprovalOption] = (request["options"]?.arrayValue ?? []).compactMap { option in
            guard let optionID = option["id"]?.stringValue ?? option["optionId"]?.stringValue else { return nil }
            let label = option["label"]?.stringValue ?? optionID
            let isPrimary = optionID == "approve" || option["style"]?.stringValue == "primary"
            return ApprovalOption(
                id: optionID,
                label: Self.localizedOption(optionID, label: label),
                isPrimary: isPrimary,
                detail: option["description"]?.stringValue
            )
        }
        if options.isEmpty, kind == "approval" {
            options = [
                ApprovalOption(id: "approve", label: "Aprovar", isPrimary: true),
                ApprovalOption(id: "deny", label: "Negar", isPrimary: false)
            ]
        }

        let callID = data["subject"]?["callId"]?.stringValue
            ?? data["call"]?["callId"]?.stringValue
            ?? request["subject"]?["callId"]?.stringValue
            ?? data["callId"]?.stringValue
        let signInText = request["signIn"]?["url"]?.stringValue
        let signIn = signInText.flatMap { URL(string: $0) }

        approvals[id] = Approval(
            id: id,
            kind: kind,
            title: request["title"]?.stringValue ?? Self.defaultApprovalTitle(kind),
            prompt: prompt,
            options: options,
            callID: callID,
            signInURL: signIn,
            resolution: .open,
            viaAgent: data["origin"]?["agent"]?.stringValue
                ?? callID.flatMap { toolCalls[$0]?.viaAgent },
            target: Self.approvalTarget(request["target"]),
            previewImage: Self.previewImageData(request["previewImage"]?.stringValue),
            reason: request["reason"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
            grant: request["grant"]?.stringValue,
            secretForm: SecretFormRequest(request["secret"]),
            integrationForm: IntegrationFormRequest(request["integration"]),
            questions: kind == "question" ? Self.questionPrompts(request["questions"]) : []
        )
        append(TranscriptEntry(id: id, kind: .approval), date: currentLineDate)
        phase = .awaitingInput
        if historySettled {
            if kind != "question" {
                onNeedsAttention?()
            }
            if isLiveLine {
                onNotify?(kind == "question"
                    ? .question(id: id, title: prompt, sessionID: sessionId)
                    : .approval(id: id, prompt: prompt))
            }
        }
    }

    private static func questionPrompts(_ value: JSONValue?) -> [QuestionPrompt] {
        (value?.arrayValue ?? []).compactMap { item in
            guard let id = item["id"]?.stringValue, let title = item["title"]?.stringValue else { return nil }
            let choices: [QuestionChoice] = (item["options"]?.arrayValue ?? []).compactMap { option in
                guard let optionID = option["id"]?.stringValue, let label = option["label"]?.stringValue else { return nil }
                return QuestionChoice(
                    id: optionID,
                    label: label,
                    detail: option["description"]?.stringValue,
                    recommended: option["recommended"]?.boolValue ?? false
                )
            }
            guard !choices.isEmpty else { return nil }
            return QuestionPrompt(
                id: id,
                title: title,
                header: item["header"]?.stringValue,
                multiSelect: item["multiSelect"]?.boolValue ?? false,
                choices: choices
            )
        }
    }

    private static func approvalTarget(_ value: JSONValue?) -> ApprovalTarget? {
        guard let value, let role = value["role"]?.stringValue else { return nil }
        return ApprovalTarget(
            label: value["label"]?.stringValue ?? "",
            role: role,
            app: value["app"]?.stringValue,
            bundleID: value["bundleId"]?.stringValue,
            url: value["url"]?.stringValue
        )
    }

    private static func previewImageData(_ text: String?) -> Data? {
        guard let text, !text.isEmpty else { return nil }
        let payload = text.range(of: "base64,").map { String(text[$0.upperBound...]) } ?? text
        return Data(base64Encoded: payload)
    }

    private func applyInteractionSettled(_ data: JSONValue) {
        guard let id = data["interactionId"]?.stringValue, let approval = approvals[id] else { return }
        let optionID = data["response"]?["optionId"]?.stringValue
            ?? data["optionId"]?.stringValue
            ?? data["answer"]?["optionId"]?.stringValue
            ?? data["decision"]?.stringValue
        if data["outcome"]?.stringValue == "withdrawn", data["reason"]?.stringValue == "message" {
            approvals[id]?.resolution = .settled("Respondido por mensagem", .neutral)
            if phase == .awaitingInput, !approvals.values.contains(where: \.isOpen) {
                phase = .working
            }
            return
        }
        if data["outcome"]?.stringValue == "withdrawn" || data["outcome"]?.stringValue == "interrupted" {
            approvals[id]?.resolution = .settled("Cancelado", .neutral)
            return
        }
        if approval.isQuestion {
            approvals[id]?.resolution = data["outcome"]?.stringValue == "declined"
                ? .settled("Pulou · o bot decide", .neutral)
                : .settled(data["summary"]?.stringValue ?? "Respondido", .approved)
            return
        }
        if let optionID {
            let normalized: String
            switch optionID {
            case "approved": normalized = "approve"
            case "denied": normalized = "deny"
            default: normalized = optionID
            }
            let summary = approval.summary(for: normalized)
            approvals[id]?.resolution = .settled(summary.0, summary.1)
            return
        }
        if case .answering(let pending) = approval.resolution {
            let summary = approval.summary(for: pending)
            approvals[id]?.resolution = .settled(summary.0, summary.1)
            return
        }
        switch data["outcome"]?.stringValue ?? "" {
        case "accepted", "approved":
            approvals[id]?.resolution = .settled("Aprovado", .approved)
        case "declined", "denied", "rejected":
            approvals[id]?.resolution = .settled("Negado", .denied)
        case "expired":
            approvals[id]?.resolution = .settled("Expirou", .neutral)
        case "withdrawn", "interrupted", "abandoned":
            approvals[id]?.resolution = .settled("Cancelado", .neutral)
        default:
            approvals[id]?.resolution = .settled("Encerrado", .neutral)
        }
    }

    var isLiveLineValue: Bool { isLiveLine }

    var currentLineDateValue: Date? { currentLineDate }

    var clientValue: BotsClient { client }

    private var isLiveLine: Bool {
        guard connection == .live, let date = currentLineDate else { return false }
        return Date().timeIntervalSince(date) < 120
    }

    private var lastReplyPart: TextPart? {
        for entry in entries.reversed() where entry.kind == .text {
            if let part = textParts[entry.id], part.phase == .reply {
                return part
            }
        }
        return nil
    }

    private func applyDecision(_ data: JSONValue, turnID: String?) {
        let kind = data["kind"]?.stringValue ?? ""
        let outcome = data["outcome"]?.stringValue ?? ""
        if kind == "approval", outcome == "auto_approved", let callID = data["callId"]?.stringValue {
            var parts: [String] = []
            if let confidence = data["confidence"]?.doubleValue {
                parts.append("confiança \(Int((confidence * 100).rounded()))%")
            }
            if let latency = data["latencyMs"]?.intValue, latency > 0 {
                parts.append("\(latency) ms")
            }
            toolCalls[callID]?.decisionNote = "aprovado pelo Jev"
            toolCalls[callID]?.decisionDetail = parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
        if kind == "approval", outcome == "requested", let callID = data["callId"]?.stringValue {
            let reason = (data["reason"]?.stringValue ?? "Você pediu.").trimmingCharacters(in: CharacterSet(charactersIn: "."))
            toolCalls[callID]?.decisionNote = reason.prefix(1).lowercased() + reason.dropFirst()
            toolCalls[callID]?.decisionDetail = nil
        }
        if kind == "route" {
            let chosen = data["botId"]?.stringValue
                ?? data["choice"]?.stringValue
                ?? data["answer"]?["botId"]?.stringValue
                ?? data["answer"]?["choice"]?.stringValue
            if let chosen {
                append(
                    TranscriptEntry(id: "route-\(turnID ?? UUID().uuidString)-\(chosen)", kind: .route(chosen, data["confidence"]?.doubleValue)),
                    date: currentLineDate
                )
            }
            return
        }
        if kind == "progress", outcome == "stop" {
            let key = turnID ?? "turn"
            guard progressStopShown.insert(key).inserted else { return }
            append(
                TranscriptEntry(id: "progress-\(key)", kind: .update("Parei: não estava avançando")),
                date: currentLineDate
            )
        }
    }

    private func closeActiveDelegations(turnID: String?) {
        let stale = toolCalls.values.filter { call in
            guard let link = call.delegation, link.state.isActive else { return false }
            return turnID == nil || call.turnID == nil || call.turnID == turnID
        }
        guard !stale.isEmpty else { return }
        var next = toolCalls
        for call in stale {
            next[call.id]?.delegation?.state = .cancelled
        }
        toolCalls = next
    }

    private func closeOpenApprovals() {
        for (id, approval) in approvals where approval.isOpen {
            approvals[id]?.resolution = .settled("Encerrado", .neutral)
        }
    }

    private func finishStreamingParts() {
        let streaming = textParts.values.filter(\.isStreaming)
        guard !streaming.isEmpty else { return }
        var next = textParts
        for part in streaming {
            next[part.id]?.isStreaming = false
            if let live = liveText.current(part.id) {
                next[part.id]?.text = live
            }
            liveText.finish(part.id)
        }
        textParts = next
    }

    private func dropStreamingParts() {
        let streaming = textParts.values.filter(\.isStreaming).map(\.id)
        guard !streaming.isEmpty else { return }
        for id in streaming {
            textParts[id] = nil
            liveText.finish(id)
        }
        entries.removeAll { $0.kind == .text && streaming.contains($0.id) }
    }

    private func removeText(_ partID: String) {
        liveText.finish(partID)
        guard textParts[partID] != nil else { return }
        textParts[partID] = nil
        entries.removeAll { $0.id == partID }
    }

    private func appendNotice(_ notice: TranscriptNotice) {
        append(TranscriptEntry(id: "notice-\(UUID().uuidString)", kind: .notice(notice)), date: currentLineDate)
    }

    private func append(_ entry: TranscriptEntry, date: Date?) {
        entries.append(entry)
        if let currentFactTurn {
            entryTurns[entry.id] = currentFactTurn
        }
        if let date {
            entryDates[entry.id] = date
        }
    }

    private static func isScheduleDelivery(_ data: JSONValue) -> Bool {
        if data["scheduleId"] != nil {
            return true
        }
        guard let source = data["source"] else { return false }
        if source.stringValue == "schedule" {
            return true
        }
        if source["schedule"] != nil || source["scheduleId"] != nil {
            return true
        }
        if source["kind"]?.stringValue == "schedule" || source["type"]?.stringValue == "schedule" {
            return true
        }
        return source["channel"]?.stringValue?.contains("schedule") == true
    }

    private func scheduleLabel(_ scheduleID: String?, text: String) -> String {
        if let scheduleID {
            if let schedule = bot.schedules.first(where: { $0.name == scheduleID }),
               let description = schedule.description, !description.isEmpty {
                return Self.scheduleTitle(description)
            }
            return scheduleID
        }
        return Self.scheduleTitle(text)
    }

    private static func scheduleID(_ data: JSONValue) -> String? {
        data["scheduleId"]?.stringValue ?? data["source"]?["scheduleId"]?.stringValue
    }

    private static func scheduleTitle(_ text: String) -> String {
        let firstLine = text.split(separator: "\n").first.map(String.init) ?? text
        let sentence = firstLine.split(separator: ".").first.map(String.init) ?? firstLine
        let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > 48 ? String(trimmed.prefix(48)) + "…" : trimmed
    }

    private static func errorText(_ data: JSONValue) -> String? {
        data["error"]?["message"]?.stringValue ?? data["error"]?.stringValue
    }

    private static func tokenCount(_ data: JSONValue) -> Int {
        let usage = data["usage"] ?? data["tokens"] ?? data
        let input = usage["inputTokens"]?.intValue ?? 0
        let output = usage["outputTokens"]?.intValue ?? 0
        if input + output == 0, let total = usage["totalTokens"]?.intValue {
            return total
        }
        return input + output
    }

    private static func localizedOption(_ id: String, label: String) -> String {
        switch label.lowercased() {
        case "approve": "Aprovar"
        case "deny": "Negar"
        default: label
        }
    }

    private static func defaultApprovalTitle(_ kind: String) -> String {
        switch kind {
        case "approval": "Aprovação necessária"
        case "question": "Pergunta"
        case "sign-in": "Entrar para continuar"
        case "budget": "Limite de uso atingido"
        default: "Ação necessária"
        }
    }
}

extension ConversationStore {
    var openQuestion: Approval? {
        guard let entry = entries.last(where: { $0.kind == .approval && approvals[$0.id]?.isQuestion == true && approvals[$0.id]?.isOpen == true })
        else { return nil }
        return approvals[entry.id]
    }

    func answerQuestion(id: String, answers: [QuestionAnswerDraft]) {
        guard let approval = approvals[id], approval.isOpen, let sessionId else { return }
        let given = answers.filter { !$0.skipped && !$0.isEmpty }
        let pending = given.isEmpty ? "Pulou · o bot decide" : "Respondeu: " + given.map { draft in
            let question = approval.questions.first { $0.id == draft.questionID }
            let labels = draft.optionIDs.compactMap { optionID in question?.choices.first { $0.id == optionID }?.label }
            let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return (labels + (text.isEmpty ? [] : [text])).joined(separator: ", ")
        }.joined(separator: " · ")
        let previousPhase = phase
        approvals[id]?.resolution = .answering(pending)
        if phase == .awaitingInput, !approvals.values.contains(where: \.isOpen) {
            phase = .working
        }
        lastError = nil
        let client = clientValue
        let basePath = bot.sessionBasePath
        Task {
            do {
                try await client.answerQuestions(basePath: basePath, sessionId: sessionId, interactionId: id, answers: answers)
            } catch {
                guard approvals[id]?.resolution == .answering(pending) else { return }
                approvals[id]?.resolution = .open
                phase = previousPhase
                lastError = ErrorMessage.describe(error)
            }
        }
    }

    var openApprovalIDs: [String] {
        entries.filter { $0.kind == .approval && approvals[$0.id]?.isOpen == true && approvals[$0.id]?.kind == "approval" }.map(\.id)
    }

    func respondAll(optionID: String) {
        for id in openApprovalIDs {
            respond(approvalID: id, optionID: optionID)
        }
    }

    func isReverted(_ entryID: String) -> Bool {
        guard !revertedTurns.isEmpty else { return false }
        if let turn = entryTurns[entryID], revertedTurns.contains(turn) {
            return true
        }
        if let call = toolCalls[entryID], let turn = call.turnID, revertedTurns.contains(turn) {
            return true
        }
        return false
    }

    func turnID(of entryID: String) -> String? {
        entryTurns[entryID]
    }

    func canRewind(entryID: String) -> Bool {
        guard let turn = entryTurns[entryID], !revertedTurns.contains(turn), phase != .working, phase != .awaitingInput else { return false }
        return checkpointTurns.contains(turn) || codeState?.checkpoints.contains(where: { $0.turnID == turn }) == true
    }

    fileprivate func applyCodeFact(_ fact: StreamFact) {
        let data = fact.data
        switch fact.type {
        case "code.edit":
            if let key = data["key"]?.stringValue {
                let id = "edit-\(key)"
                if let edit = CodeEdit(data, id: id) {
                    entries.removeAll { $0.id == id }
                    if edit.hunks.isEmpty {
                        codeEdits[id] = nil
                    } else {
                        codeEdits[id] = edit
                        append(TranscriptEntry(id: id, kind: .codeEdit(id)), date: currentLineDateValue)
                    }
                }
            } else if let edit = CodeEdit(data, id: "edit-\(fact.key)") {
                codeEdits[edit.id] = edit
                append(TranscriptEntry(id: edit.id, kind: .codeEdit(edit.id)), date: currentLineDateValue)
            }
        case "code.bulk":
            let id = "bulk-\(data["key"]?.stringValue ?? fact.key)"
            let bulk = CodeBulk(
                id: id,
                files: data["files"]?.intValue ?? 0,
                added: data["added"]?.intValue ?? 0,
                removed: data["removed"]?.intValue ?? 0,
                paths: data["paths"]?.arrayValue?.compactMap(\.stringValue) ?? []
            )
            entries.removeAll { $0.id == id }
            codeBulks[id] = bulk
            append(TranscriptEntry(id: id, kind: .codeBulk(id)), date: currentLineDateValue)
        case "code.status":
            if isLiveLineValue, var state = codeState, let id = data["workspaceId"]?.stringValue {
                state.update(workspaceID: id) { workspace in
                    workspace.files = data["files"]?.intValue ?? workspace.files
                    workspace.added = data["added"]?.intValue ?? workspace.added
                    workspace.removed = data["removed"]?.intValue ?? workspace.removed
                }
                codeState = state
            }
        case "code.workspace":
            let repo = data["repoName"]?.stringValue ?? data["repo"]?.stringValue ?? "repositório"
            let branch = data["branch"]?.stringValue ?? ""
            switch data["action"]?.stringValue ?? "" {
            case "opened":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Abriu \(repo) na branch \(branch)", "arrow.triangle.branch")), date: currentLineDateValue)
            case "reopened":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Voltou a trabalhar em \(repo)", "arrow.triangle.branch")), date: currentLineDateValue)
            case "adopted":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Juntou \(repo) a esta conversa, na branch \(branch)", "square.stack.3d.up")), date: currentLineDateValue)
            case "closed":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Fechou \(repo). A branch \(branch) continua guardada", "folder")), date: currentLineDateValue)
            case "failed":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Não consegui abrir \(repo): \(data["error"]?.stringValue ?? "erro")", "exclamationmark.triangle")), date: currentLineDateValue)
            case "removed":
                let number = data["pr"]?["number"]?.intValue
                let status = data["pr"]?["status"]?.stringValue
                let text: String
                if let number, status == "merged" {
                    text = "PR #\(number) mergeado · repositório fechado"
                } else if let number, status == "closed" {
                    text = "PR #\(number) fechado · repositório fechado"
                } else {
                    text = "Repositório \(repo) fechado"
                }
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine(text, number != nil && status == "merged" ? "arrow.triangle.merge" : "folder")), date: currentLineDateValue)
            default:
                break
            }
        case "code.branch":
            if let branch = data["to"]?.stringValue, !branch.isEmpty {
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Trocou para a branch \(branch)", "arrow.triangle.branch")), date: currentLineDateValue)
            }
        case "code.install":
            switch data["status"]?.stringValue ?? "" {
            case "running":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Instalando as dependências em segundo plano", "shippingbox")), date: currentLineDateValue)
            case "done":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Dependências instaladas", "shippingbox")), date: currentLineDateValue)
            case "failed":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("A instalação das dependências falhou", "exclamationmark.triangle")), date: currentLineDateValue)
            default:
                break
            }
        case "code.devserver":
            let port = data["port"]?.intValue.map(String.init) ?? ""
            switch data["action"]?.stringValue ?? "" {
            case "started":
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("App no ar na porta \(port)", "play.circle")), date: currentLineDateValue)
            case "exited":
                let reason = data["reason"]?.stringValue.map { ": \($0)" } ?? ""
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("O app da porta \(port) parou\(reason)", "stop.circle")), date: currentLineDateValue)
            default:
                break
            }
        case "code.delivered":
            if let url = data["prUrl"]?.stringValue, !url.isEmpty {
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("PR aberto: \(url)", "arrow.up.forward.circle")), date: currentLineDateValue)
            } else if let commit = data["commit"]?.stringValue {
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Commit \(commit) na branch \(data["branch"]?.stringValue ?? "")", "checkmark.circle")), date: currentLineDateValue)
            }
        case "code.pr":
            if var state = codeState, let id = data["workspaceId"]?.stringValue, let pr = PullRequestInfo(data) {
                state.update(workspaceID: id) { $0.pr = pr }
                codeState = state
            }
        case "code.ci", "code.review":
            if let event = PullRequestEvent(type: fact.type, data: data) {
                append(TranscriptEntry(id: "pr-\(fact.key)", kind: .pullRequest(event)), date: currentLineDateValue)
                if event.kind == .ciFailed, isLiveLineValue {
                    onNotify?(.ciFailed(number: event.number, check: event.check ?? "check"))
                }
            }
        case "code.checkpoint":
            if let turn = data["turnId"]?.stringValue {
                checkpointTurns.insert(turn)
            }
        case "code.reverted":
            if let path = data["path"]?.stringValue {
                append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine("Desfez \((path as NSString).lastPathComponent)", "arrow.uturn.backward")), date: currentLineDateValue)
            }
        case "turn.reverted":
            let turns = data["turnIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
            revertedTurns.formUnion(turns)
            let files = data["files"]?.boolValue == true
            append(TranscriptEntry(id: "code-\(fact.key)", kind: .codeLine(files ? "Conversa e arquivos voltaram para antes desse pedido" : "Conversa voltou para antes desse pedido", "arrow.uturn.backward.circle")), date: currentLineDateValue)
        default:
            break
        }
        if isLiveLineValue {
            scheduleCodeRefresh()
        }
    }

    func scheduleCodeRefresh() {
        codeRefreshTask?.cancel()
        codeRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await self?.refreshCode()
        }
    }

    func refreshCode() async {
        guard !bot.isGroup else { return }
        guard let state = try? await clientValue.codeState(botID: bot.id, sessionID: sessionId) else { return }
        if codeState != state {
            codeState = state
        }
        checkpointTurns.formUnion(state.checkpoints.map(\.turnID))
    }

    func openRepository(_ repo: RepoInfo) async throws {
        let state = try await clientValue.openWorkspace(botID: bot.id, sessionID: sessionId, repo: repo.path, task: nil)
        codeState = state
    }

    func sendText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isCreating else { return }
        let message = UserMessage(id: "local-\(UUID().uuidString)", text: trimmed, state: .sending, isConfirmed: false)
        userMessages[message.id] = message
        append(TranscriptEntry(id: message.id, kind: .user), date: Date())
        let queued = phase == .working || phase == .awaitingInput
        if !queued {
            phase = .working
        }
        deliver(messageID: message.id, text: trimmed, queued: queued)
    }

    func finishRepository(workspaceID: String? = nil) async throws {
        try await clientValue.finishWorkspace(botID: bot.id, sessionID: sessionId, workspaceID: workspaceID)
        await refreshCode()
    }

    func reopenPullRequest(workspaceID: String? = nil) async throws {
        try await clientValue.reopenPullRequest(botID: bot.id, sessionID: sessionId, workspaceID: workspaceID)
        await refreshCode()
    }

    func refreshPullRequest(workspaceID: String? = nil) async {
        _ = try? await clientValue.pullRequest(botID: bot.id, sessionID: sessionId, workspaceID: workspaceID, refresh: true)
        await refreshCode()
    }

    func closeRepository(workspaceID: String? = nil) async throws {
        try await clientValue.closeWorkspace(botID: bot.id, sessionID: sessionId, workspaceID: workspaceID)
        await refreshCode()
    }

    func revertFile(_ path: String, workspaceID: String? = nil) async throws {
        try await clientValue.revertFile(botID: bot.id, sessionID: sessionId, workspaceID: workspaceID, path: path)
        await refreshCode()
    }

    var changesWorkspace: CodeWorkspace? {
        codeState?.workspace(id: changesWorkspaceID) ?? codeState?.workspace(id: nil)
    }

    func rewind(entryID: String) async throws {
        guard let turn = entryTurns[entryID] else { return }
        try await clientValue.rewind(botID: bot.id, sessionID: sessionId, turnID: turn)
        await refreshCode()
    }

    func rewind(turnID: String) async throws {
        try await clientValue.rewind(botID: bot.id, sessionID: sessionId, turnID: turnID)
        await refreshCode()
    }

    func firstUserText(turnID: String) -> String? {
        for entry in entries where entry.kind == .user && entryTurns[entry.id] == turnID {
            if let message = userMessages[entry.id] {
                return message.text
            }
        }
        return nil
    }
}
