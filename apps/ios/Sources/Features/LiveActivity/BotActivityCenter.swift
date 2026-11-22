import ActivityKit
import Foundation

// Liga, atualiza e encerra a Live Activity (ilha + tela bloqueada) de cada conversa em que um bot trabalha.
// Sem push da Apple: as atualizações saem do app, então a ilha acompanha enquanto o app está aberto ou
// logo depois de sair dele. Os botões da ilha acordam o app e respondem direto no servidor.
@MainActor
final class BotActivityCenter {
    static let shared = BotActivityCenter()
    static let enabledKey = "liveActivities.enabled"

    static var enabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    private weak var model: AppModel?
    private var activities: [String: Activity<BotActivityAttributes>] = [:]
    private var states: [String: BotActivityAttributes.ContentState] = [:]
    private var answering: [String: (interactionID: String, label: String)] = [:]
    private var loop: Task<Void, Never>?

    private init() {}

    func installHandler() {
        BotActivityBridge.handler = { answer in
            await BotActivityCenter.shared.answer(answer)
        }
    }

    func attach(_ model: AppModel) {
        self.model = model
        for activity in Activity<BotActivityAttributes>.activities {
            let id = activity.attributes.sessionID
            if activities[id] == nil {
                activities[id] = activity
                states[id] = activity.content.state
            }
        }
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func detach() {
        loop?.cancel()
        loop = nil
        model = nil
        let ids = activities.values.map(\.id)
        activities = [:]
        states = [:]
        answering = [:]
        Task {
            for id in ids {
                await Self.end(id, nil, dismiss: .immediate)
            }
        }
    }

    private func tick() async {
        guard let model else { return }
        guard Self.enabled, ActivityAuthorizationInfo().areActivitiesEnabled else {
            for id in Array(activities.keys) {
                await finish(id, store: nil, dismiss: .immediate)
            }
            return
        }
        let live = model.liveSessions()
        let liveIDs = Set(live.map(\.sessionID))
        for item in live {
            let store = model.watch(bot: item.bot, sessionID: item.sessionID)
            let state = content(for: store, sessionID: item.sessionID, serverStatus: item.status)
            await show(state, bot: item.bot, sessionID: item.sessionID)
        }
        for id in activities.keys where !liveIDs.contains(id) {
            await finish(id, store: model.watchedStore(id), dismiss: .after(.now.addingTimeInterval(15 * 60)))
            model.unwatch(sessionID: id)
        }
    }

    private func content(
        for store: ConversationStore,
        sessionID: String,
        serverStatus: BotStatus
    ) -> BotActivityAttributes.ContentState {
        let startedAt = states[sessionID]?.startedAt ?? .now
        let pending = store.entries
            .filter { $0.kind == .approval }
            .compactMap { store.approvals[$0.id] }
            .last { $0.isOpen }
        if let approval = pending {
            if let sent = answering[sessionID], sent.interactionID == approval.id {
                return .init(phase: approval.isQuestion ? .question : .approval, headline: headline(approval, store: store), startedAt: startedAt, answering: sent.label)
            }
            return approvalState(approval, store: store, startedAt: startedAt)
        }
        answering[sessionID] = nil
        if serverStatus == .awaitingApproval {
            return .init(phase: .approval, headline: "Tem um pedido esperando sua resposta.", startedAt: startedAt)
        }
        let running = store.orderedToolCalls.last { $0.status == .running || $0.status == .requested }
        let headline = running.map { ActionPhrase(call: $0).plain } ?? "Pensando…"
        return .init(phase: .working, headline: Self.clip(headline), startedAt: startedAt)
    }

    private func approvalState(_ approval: Approval, store: ConversationStore, startedAt: Date) -> BotActivityAttributes.ContentState {
        var state = BotActivityAttributes.ContentState(
            phase: approval.isQuestion ? .question : .approval,
            headline: headline(approval, store: store),
            startedAt: startedAt,
            interactionID: approval.id
        )
        let needsApp = approval.secretForm != nil || approval.integrationForm != nil || approval.signInURL != nil
        if needsApp { return state }
        if approval.isQuestion, !approval.questions.isEmpty {
            guard approval.questions.count == 1, let question = approval.questions.first, !question.multiSelect,
                (1...3).contains(question.choices.count)
            else { return state }
            state.questionID = question.id
            state.choices = question.choices.map { .init(id: $0.id, label: Self.clip($0.label, 22)) }
            return state
        }
        let options = approval.options.filter { $0.id != "approve_always" }
        guard (1...3).contains(options.count) else { return state }
        let ordered = options.sorted { lhs, _ in lhs.id == "deny" }
        state.choices = ordered.map { .init(id: $0.id, label: Self.clip($0.label, 22)) }
        return state
    }

    private func headline(_ approval: Approval, store: ConversationStore) -> String {
        if approval.isQuestion {
            return Self.clip(approval.questions.first?.title ?? approval.title)
        }
        let call = approval.callID.flatMap { store.toolCalls[$0] }
        let phrase = ActionPhrase(approval: approval, call: call).plain
        return Self.clip(phrase.isEmpty ? approval.title : phrase)
    }

    private func show(_ state: BotActivityAttributes.ContentState, bot: Bot, sessionID: String) async {
        if let activity = activities[sessionID] {
            guard states[sessionID] != state else { return }
            states[sessionID] = state
            await Self.update(activity.id, ActivityContent(state: state, staleDate: nil))
            return
        }
        let attributes = BotActivityAttributes(
            botID: bot.id,
            botName: bot.name,
            accent: bot.accent,
            sessionID: sessionID,
            basePath: bot.sessionBasePath
        )
        do {
            activities[sessionID] = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil))
            states[sessionID] = state
        } catch {
            // Sem permissão, limite de atividades ou app em segundo plano: tenta de novo no próximo ciclo.
        }
    }

    private func finish(_ sessionID: String, store: ConversationStore?, dismiss: ActivityUIDismissalPolicy) async {
        guard let activity = activities.removeValue(forKey: sessionID) else { return }
        let previous = states.removeValue(forKey: sessionID)
        answering[sessionID] = nil
        let failed = store?.phase == .failed
        let reply = store?.preview.map { Self.clip($0, 120) }
        let state = BotActivityAttributes.ContentState(
            phase: failed ? .failed : .done,
            headline: failed ? (store?.lastError ?? "O turno falhou.") : (reply ?? "Terminou o que você pediu."),
            startedAt: previous?.startedAt ?? .now
        )
        await Self.end(activity.id, ActivityContent(state: state, staleDate: nil), dismiss: dismiss)
    }

    private func answer(_ answer: BotActivityAnswer) async {
        let label =
            states[answer.sessionID]?.choices.first { $0.id == answer.optionID }?.label ?? answer.optionID
        answering[answer.sessionID] = (answer.interactionID, "Enviando: \(label)…")
        if let activity = activity(for: answer.sessionID) {
            var state = states[answer.sessionID] ?? activity.content.state
            state.answering = "Enviando: \(label)…"
            states[answer.sessionID] = state
            await Self.update(activity.id, ActivityContent(state: state, staleDate: nil))
        }
        let client = BotsClient(baseURL: ServerConfig.currentURL())
        do {
            if let questionID = answer.questionID {
                try await client.answerQuestions(
                    basePath: answer.basePath,
                    sessionId: answer.sessionID,
                    interactionId: answer.interactionID,
                    answers: [QuestionAnswerDraft(questionID: questionID, optionIDs: [answer.optionID])]
                )
            } else {
                try await client.answer(
                    basePath: answer.basePath,
                    sessionId: answer.sessionID,
                    interactionId: answer.interactionID,
                    optionId: answer.optionID
                )
            }
            if let activity = activity(for: answer.sessionID) {
                let state = BotActivityAttributes.ContentState(
                    phase: .working,
                    headline: "Respondido: \(label)",
                    startedAt: states[answer.sessionID]?.startedAt ?? activity.content.state.startedAt
                )
                states[answer.sessionID] = state
                await Self.update(activity.id, ActivityContent(state: state, staleDate: nil))
            }
        } catch {
            answering[answer.sessionID] = nil
            if let activity = activity(for: answer.sessionID) {
                var state = states[answer.sessionID] ?? activity.content.state
                state.answering = nil
                state.headline = "Não consegui enviar. Toque para abrir."
                states[answer.sessionID] = state
                await Self.update(activity.id, ActivityContent(state: state, staleDate: nil))
            }
        }
    }

    // Acordado só pelo botão da ilha, o app ainda não tem o mapa em memória: procura na lista do sistema.
    private func activity(for sessionID: String) -> Activity<BotActivityAttributes>? {
        activities[sessionID] ?? Activity<BotActivityAttributes>.activities.first { $0.attributes.sessionID == sessionID }
    }

    // Activity não é Sendable: a atualização acha a activity pelo id fora do MainActor.
    private nonisolated static func update(_ id: String, _ content: ActivityContent<BotActivityAttributes.ContentState>) async {
        guard let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.update(content)
    }

    private nonisolated static func end(
        _ id: String,
        _ content: ActivityContent<BotActivityAttributes.ContentState>?,
        dismiss: ActivityUIDismissalPolicy
    ) async {
        guard let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.end(content, dismissalPolicy: dismiss)
    }

    private static func clip(_ text: String, _ limit: Int = 90) -> String {
        let line = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return line.count > limit ? String(line.prefix(limit - 1)) + "…" : line
    }
}
