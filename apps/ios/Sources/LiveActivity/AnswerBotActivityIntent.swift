import AppIntents
import Foundation

struct BotActivityAnswer: Sendable {
    let botID: String
    let sessionID: String
    let basePath: String
    let interactionID: String
    let optionID: String
    let questionID: String?
}

// O app registra o handler ao abrir. Um LiveActivityIntent roda no processo do app (que o sistema acorda
// em segundo plano); na extensão de widgets o handler fica nil e o perform nunca é chamado lá.
enum BotActivityBridge {
    typealias Handler = @MainActor @Sendable (BotActivityAnswer) async -> Void
    @MainActor static var handler: Handler?
}

struct AnswerBotActivityIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Responder ao bot"
    static let openAppWhenRun = false
    static let isDiscoverable = false

    @Parameter(title: "Bot") var botID: String
    @Parameter(title: "Conversa") var sessionID: String
    @Parameter(title: "Caminho") var basePath: String
    @Parameter(title: "Pedido") var interactionID: String
    @Parameter(title: "Opção") var optionID: String
    @Parameter(title: "Pergunta") var questionID: String?

    init() {}

    init(attributes: BotActivityAttributes, interactionID: String, optionID: String, questionID: String?) {
        self.botID = attributes.botID
        self.sessionID = attributes.sessionID
        self.basePath = attributes.basePath
        self.interactionID = interactionID
        self.optionID = optionID
        self.questionID = questionID
    }

    func perform() async throws -> some IntentResult {
        let answer = BotActivityAnswer(
            botID: botID,
            sessionID: sessionID,
            basePath: basePath,
            interactionID: interactionID,
            optionID: optionID,
            questionID: questionID
        )
        if let handler = await MainActor.run(body: { BotActivityBridge.handler }) {
            await handler(answer)
        }
        return .result()
    }
}
