import AppKit
import SwiftUI

struct Integration: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let description: String
    let unlocks: String
    let fallback: String
    let keyUrl: String
    let needsUrl: Bool
    let status: String
    let configured: Bool
    let source: String?
    let last4: String
    let validatedAt: String?
    let url: String?
}

private struct IntegrationList: Decodable {
    let integrations: [Integration]
}

extension BotsClient {
    func integrations() async throws -> [Integration] {
        let (data, response) = try await URLSession.shared.data(for: try request(path: "/integrations"))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ClientError.http(status, Self.integrationMessage(data)) }
        return try JSONDecoder().decode(IntegrationList.self, from: data).integrations
    }

    func saveIntegration(id: String, key: String, url: String?) async throws -> Integration {
        var body: [String: JSONValue] = ["key": .string(key)]
        if let url, !url.isEmpty { body["url"] = .string(url) }
        return try await integrationMutation(id: id, method: "PUT", body: .object(body))
    }

    func removeIntegration(id: String) async throws -> Integration {
        try await integrationMutation(id: id, method: "DELETE", body: nil)
    }

    private func integrationMutation(id: String, method: String, body: JSONValue?) async throws -> Integration {
        var urlRequest = try request(path: "/integrations/\(id)")
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = 30
        if let body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ClientError.http(status, Self.integrationMessage(data)) }
        return try JSONDecoder().decode(Integration.self, from: data)
    }

    private static func integrationMessage(_ data: Data) -> String? {
        (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue
    }
}

@MainActor
@Observable
final class IntegrationsStore {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    var state: LoadState = .loading
    var items: [Integration] = []
    var expanded: String?
    var busy: String?
    var errors: [String: String] = [:]
    var invalid: Set<String> = []

    func load(model: AppModel) async {
        do {
            items = try await model.client.integrations()
            state = .loaded
        } catch {
            if items.isEmpty { state = .failed(ErrorMessage.describe(error)) }
        }
    }

    func save(_ item: Integration, key: String, url: String, model: AppModel) async -> Bool {
        busy = item.id
        errors[item.id] = nil
        defer { busy = nil }
        do {
            let saved = try await model.client.saveIntegration(id: item.id, key: key, url: item.needsUrl ? url : nil)
            replace(saved)
            invalid.remove(item.id)
            expanded = nil
            await model.refreshMeta()
            return true
        } catch {
            if case BotsClient.ClientError.http(422, _) = error { invalid.insert(item.id) }
            errors[item.id] = ErrorMessage.describe(error)
            return false
        }
    }

    func remove(_ item: Integration, model: AppModel) async {
        busy = item.id
        errors[item.id] = nil
        defer { busy = nil }
        do {
            replace(try await model.client.removeIntegration(id: item.id))
            invalid.remove(item.id)
            await model.refreshMeta()
        } catch {
            errors[item.id] = ErrorMessage.describe(error)
        }
    }

    private func replace(_ item: Integration) {
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        }
    }
}

struct IntegrationsSettings: View {
    @Environment(AppModel.self) private var model
    @State private var store = IntegrationsStore()

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            Text("Serviços opcionais. Os bots funcionam sem eles; cada chave liga uma parte a mais. A chave fica cifrada no servidor e nunca volta para o app.")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            switch store.state {
            case .loading:
                VStack(spacing: Spacing.s) {
                    ForEach(0..<3, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                            .fill(Theme.surface)
                            .frame(height: 64)
                    }
                }
            case .failed(let message):
                EmptyStateView(systemImage: "exclamationmark.triangle", title: "Não deu para carregar as integrações", description: message)
            case .loaded:
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    ForEach(store.items) { item in
                        IntegrationRow(item: item, store: store)
                    }
                }
                .padding(.horizontal, -Spacing.m)
            }
        }
        .task {
            await store.load(model: model)
        }
    }
}

private struct IntegrationRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let item: Integration
    let store: IntegrationsStore
    @State private var key = ""
    @State private var url = ""
    @State private var isHovering = false
    @State private var confirmRemove = false

    private var isOpen: Bool { store.expanded == item.id }
    private var isBusy: Bool { store.busy == item.id }

    private var status: (label: String, color: Color) {
        if store.invalid.contains(item.id) || item.status == "invalid" { return ("Chave inválida", Theme.danger) }
        if item.configured { return ("Conectado", Theme.success) }
        return ("Não configurado", Theme.textTertiary)
    }

    private var detail: String {
        if item.configured {
            let ending = item.last4.isEmpty ? "" : " · termina em \(item.last4)"
            let origin = item.source == "env" ? " · do arquivo do servidor" : ""
            return "\(item.unlocks)\(ending)\(origin)"
        }
        return item.id == "jev" ? "por TypeSafe · \(item.description)" : item.description
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                    store.expanded = isOpen ? nil : item.id
                }
            } label: {
                HStack(spacing: Spacing.m) {
                    IntegrationLogo(id: item.id, name: item.name)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: Spacing.s) {
                            Text(item.name)
                                .font(BrandFonts.sans(13, weight: .semibold))
                                .foregroundStyle(Theme.textPrimary)
                            HStack(spacing: Spacing.xs) {
                                Circle()
                                    .fill(status.color)
                                    .frame(width: 6, height: 6)
                                Text(status.label)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(isOpen ? 0 : -90))
                }
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.s + 2)
                .frame(minHeight: 64)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            .accessibilityValue(status.label)

            if isOpen {
                editor
                    .padding(.horizontal, Spacing.m)
                    .padding(.bottom, Spacing.m)
                    .transition(.opacity.combined(with: .offset(y: -6)))
            }
        }
        .background(isOpen ? Theme.surface : isHovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isOpen)
        .onAppear { url = item.url ?? "" }
        .alert("Remover a chave do \(item.name)?", isPresented: $confirmRemove) {
            Button("Remover", role: .destructive) {
                Task { await store.remove(item, model: model) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text(item.fallback)
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text(item.configured ? item.description : item.fallback)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if item.needsUrl {
                TextField("Endereço do MCP", text: $url, prompt: Text("https://seu-runelay/v1/mcp"))
                    .textFieldStyle(.plain)
                    .font(TypeScale.rowSubtitle)
                    .autocorrectionDisabled()
                    .padding(.horizontal, Spacing.m)
                    .frame(height: 36)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            }
            SecureField(item.configured ? "Nova chave" : "Chave", text: $key, prompt: Text(item.configured ? "Cole uma chave nova para trocar" : "Cole a chave aqui"))
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .padding(.horizontal, Spacing.m)
                .frame(height: 36)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .onSubmit(submit)
            if let error = store.errors[item.id] {
                Text(error)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            HStack(spacing: Spacing.s) {
                if let link = URL(string: item.keyUrl) {
                    Button("Onde pego a chave?") {
                        NSWorkspace.shared.open(link)
                    }
                    .buttonStyle(.plain)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.brandText)
                    .clickable()
                }
                Spacer(minLength: Spacing.m)
                if item.source == "app" {
                    Button("Remover") {
                        confirmRemove = true
                    }
                    .buttonStyle(.brandSecondary)
                    .disabled(isBusy)
                }
                Button(action: submit) {
                    HStack(spacing: Spacing.xs + 2) {
                        if isBusy {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(isBusy ? "Validando…" : "Validar e salvar")
                    }
                }
                .buttonStyle(.brandPrimary)
                .disabled(isBusy || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .springAnimation(value: store.errors[item.id])
    }

    private func submit() {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !isBusy else { return }
        Task {
            if await store.save(item, key: value, url: url.trimmingCharacters(in: .whitespacesAndNewlines), model: model) {
                key = ""
            }
        }
    }
}

struct IntegrationLogo: View {
    let id: String
    let name: String

    var body: some View {
        if let key = id == "runelay" ? "runelay" : id == "jev" ? "typesafe" : nil, let image = BrandAssets.connector(key) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fill)
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .accessibilityHidden(true)
        } else {
            CatalogConnectorIcon(name: name, icon: id == "elevenlabs" ? "elevenlabs" : nil, size: .medium)
        }
    }
}

struct IntegrationShortcut: View {
    @Environment(AppModel.self) private var model
    let message: String
    let action: String

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "key.horizontal")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Spacing.s)
            Button(action) {
                model.openIntegrations()
            }
            .buttonStyle(.plain)
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.brandText)
            .clickable()
        }
    }
}
