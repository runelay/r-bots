import Foundation

enum ErrorMessage {
    static func describe(_ error: any Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost:
                return "Sem conexão com a internet."
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return "Não achei o servidor. Confira o endereço nos Ajustes."
            case .timedOut:
                return "O servidor demorou demais para responder."
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot:
                return "A conexão segura com o servidor falhou."
            case .badURL, .unsupportedURL:
                return "O endereço do servidor não parece válido."
            case .cancelled:
                return "Cancelado."
            default:
                return urlError.localizedDescription
            }
        }
        if let localized = error as? any LocalizedError, let description = localized.errorDescription {
            return description
        }
        if error is DecodingError {
            return "O servidor mandou dados num formato inesperado."
        }
        return error.localizedDescription
    }
}
