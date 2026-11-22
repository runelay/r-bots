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

    func boardImageRequest(_ source: String) throws -> URLRequest {
        guard let url = URL(string: source), url.scheme == "https" else { throw ClientError.invalidURL }
        let host = url.host?.lowercased() ?? ""
        var request: URLRequest
        if host == "github.com" || host.hasSuffix("githubusercontent.com") {
            request = try self.request(path: "/github/asset", query: [URLQueryItem(name: "url", value: source)])
        } else {
            request = URLRequest(url: url)
        }
        request.timeoutInterval = 45
        return request
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
        if seconds < 60 { return tr("agora") }
        if seconds < 3600 { return tr("há %lld min", Int(seconds / 60)) }
        if seconds < 86_400 { return tr("há %lld h", Int(seconds / 3600)) }
        let days = Int(seconds / 86_400)
        if days == 1 { return tr("ontem") }
        if days < 30 { return tr("há %lld dias", days) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}
