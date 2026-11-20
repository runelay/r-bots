import Foundation

extension BotsClient {
    func boardRequest<T: Decodable>(
        _ path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: [String: JSONValue]? = nil,
        timeout: TimeInterval = 45,
        as type: T.Type
    ) async throws -> T {
        var urlRequest = try request(path: path, query: query)
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = timeout
        if let body {
            urlRequest.httpBody = try JSONEncoder().encode(JSONValue.object(body))
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if method != "GET" {
            urlRequest.httpBody = Data("{}".utf8)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        AuthStore.reportUnauthorized(response)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw ClientError.http(http.statusCode, json?["error"]?.stringValue)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func pathPart(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}

enum BoardDates {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return fractional.date(from: text) ?? plain.date(from: text)
    }

    static func relative(_ text: String?) -> String {
        guard let date = parse(text) else { return "" }
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return "agora" }
        if seconds < 3600 { return "há \(Int(seconds / 60)) min" }
        if seconds < 86_400 { return "há \(Int(seconds / 3600)) h" }
        let days = Int(seconds / 86_400)
        if days == 1 { return "ontem" }
        if days < 30 { return "há \(days) dias" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}
