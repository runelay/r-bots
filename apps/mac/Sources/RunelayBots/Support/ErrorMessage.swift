import Foundation

enum ErrorMessage {
    static func describe(_ error: any Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost:
                return tr("Sem conexão com a internet.")
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return tr("Não achei o servidor. Confira o endereço nos Ajustes.")
            case .timedOut:
                return tr("O servidor demorou demais para responder.")
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot:
                return tr("A conexão segura com o servidor falhou.")
            case .badURL, .unsupportedURL:
                return tr("O endereço do servidor não parece válido.")
            case .cancelled:
                return tr("Cancelado.")
            default:
                return urlError.localizedDescription
            }
        }
        if let localized = error as? any LocalizedError, let description = localized.errorDescription {
            return description
        }
        if error is DecodingError {
            return tr("O servidor mandou dados num formato inesperado.")
        }
        return error.localizedDescription
    }
}
