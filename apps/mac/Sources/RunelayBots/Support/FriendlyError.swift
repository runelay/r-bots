import Foundation

enum FriendlyError {
    static func notice(code: String?, message: String?, fallback: String) -> TranscriptNotice {
        let raw = [code, message]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ": ")
        let detail = raw.isEmpty ? nil : raw
        let haystack = raw.lowercased()

        if code == "ACCOUNT_LIMIT", let message, !message.isEmpty {
            return TranscriptNotice(text: message, detail: nil, tone: .error)
        }

        if haystack.contains("api_key") || haystack.contains("api key") || haystack.contains("credential")
            || haystack.contains("unauthorized") || haystack.contains("authentication")
        {
            return TranscriptNotice(text: tr("O servidor ainda não tem acesso ao modelo."), detail: detail, tone: .error)
        }
        if haystack.contains("rate limit") || haystack.contains("rate_limit") || haystack.contains("429")
            || haystack.contains("overloaded")
        {
            return TranscriptNotice(text: tr("O modelo está ocupado agora. Tente de novo em instantes."), detail: detail, tone: .error)
        }
        if haystack.contains("context") && (haystack.contains("window") || haystack.contains("length")) {
            return TranscriptNotice(text: tr("A conversa ficou longa demais para o modelo."), detail: detail, tone: .error)
        }
        if haystack.contains("content-filter") || haystack.contains("content_filter") || haystack.contains("policy") {
            return TranscriptNotice(text: tr("O modelo recusou este pedido."), detail: detail, tone: .error)
        }
        if haystack.contains("timeout") || haystack.contains("timed out") {
            return TranscriptNotice(text: tr("O modelo demorou demais para responder."), detail: detail, tone: .error)
        }
        if haystack.contains("model_call_failed") {
            return TranscriptNotice(text: tr("Não consegui falar com o modelo."), detail: detail, tone: .error)
        }
        if let message, !message.isEmpty, LanguageStore.shared.language == .english || !looksEnglish(message) {
            return TranscriptNotice(text: message, detail: code, tone: .error)
        }
        return TranscriptNotice(text: fallback, detail: detail, tone: .error)
    }

    private static func looksEnglish(_ text: String) -> Bool {
        let lowered = " " + text.lowercased() + " "
        let markers = [" the ", " set ", " in ", " is ", " was ", " not ", " failed", " error", " server ", " please "]
        return markers.contains { lowered.contains($0) }
    }
}
