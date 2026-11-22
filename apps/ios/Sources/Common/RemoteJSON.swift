import Foundation
import SwiftUI

extension BotsClient {
    func call(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> JSONValue {
        var urlRequest = try request(path: path)
        urlRequest.httpMethod = method
        if let body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        AuthStore.reportUnauthorized(response)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(http.statusCode) else {
            throw ClientError.http(http.statusCode, json["error"]?.stringValue ?? json["error"]?["message"]?.stringValue)
        }
        return json
    }

    static func escape(path component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}

enum Loadable<Value> {
    case loading
    case loaded(Value)
    case failed(String)
}

struct LoadingState<Value, Content: View>: View {
    let state: Loadable<Value>
    let retry: () -> Void
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        switch state {
        case .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("Não carregou", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Tentar de novo", action: retry)
                    .buttonStyle(SoftButtonStyle())
            }
        case .loaded(let value):
            content(value)
        }
    }
}

extension View {
    func settingsList() -> some View {
        self
            .font(BrandFonts.sans(16))
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
    }

    func settingsRow() -> some View {
        listRowBackground(Theme.surface)
    }
}

struct StatusDot: View {
    let ok: Bool
    var warning = false

    var body: some View {
        Circle()
            .fill(ok ? Theme.success : (warning ? Theme.attention : Theme.danger))
            .frame(width: 8, height: 8)
    }
}

struct InitialBadge: View {
    let text: String
    var size: CGFloat = 32

    var body: some View {
        Text(String(text.prefix(1)).uppercased())
            .font(BrandFonts.sans(size * 0.45, weight: .semibold))
            .foregroundStyle(Theme.textSecondary)
            .frame(width: size, height: size)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
    }
}

enum RelativeText {
    static func date(_ iso: String?) -> String? {
        guard let iso, let date = ISODate.parse(iso) else { return nil }
        return date.formatted(.relative(presentation: .named).locale(LanguageStore.shared.locale))
    }
}
