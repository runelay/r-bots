import AppKit
import SwiftUI

struct SettingsUndoStep: Equatable, Sendable {
    let method: String
    let path: String
    let body: JSONValue?
}

struct SettingsChange: Equatable, Identifiable {
    enum UndoState: Equatable {
        case available
        case running
        case done
        case failed(String)
    }

    let id: String
    let area: String
    let areas: [String]
    let text: String
    let targetID: String
    let targetName: String
    let thumbnailKind: String?
    let thumbnailID: String?
    let undo: [SettingsUndoStep]
    let actionLabel: String?
    let actionURL: URL?
    let otherBot: Bool

    init?(id: String, _ data: JSONValue) {
        guard let text = data["text"]?.stringValue, let area = data["area"]?.stringValue else { return nil }
        self.id = id
        self.area = area
        let areas = data["areas"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.areas = areas.isEmpty ? [area] : areas
        self.text = text
        targetID = data["target"]?["id"]?.stringValue ?? ""
        targetName = data["target"]?["name"]?.stringValue ?? ""
        thumbnailKind = data["thumbnail"]?["kind"]?.stringValue
        thumbnailID = data["thumbnail"]?["id"]?.stringValue
        undo = (data["undo"]?.arrayValue ?? []).compactMap { step in
            guard let method = step["method"]?.stringValue, let path = step["path"]?.stringValue else { return nil }
            return SettingsUndoStep(method: method, path: path, body: step["body"])
        }
        actionLabel = data["action"]?["label"]?.stringValue
        actionURL = data["action"]?["url"]?.stringValue.flatMap(URL.init(string:))
        otherBot = data["otherBot"]?.boolValue ?? false
    }
}

extension BotsClient {
    func runUndo(_ step: SettingsUndoStep) async throws {
        var urlRequest = try request(path: step.path)
        urlRequest.httpMethod = step.method
        if let body = step.body {
            urlRequest.httpBody = try JSONEncoder().encode(body)
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        AuthStore.reportUnauthorized(response)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ClientError.http(status, (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue)
        }
    }
}

struct SettingsChangeLine: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    let change: SettingsChange
    let store: ConversationStore

    @State private var appeared = false

    private var undoState: SettingsChange.UndoState {
        store.settingsUndo[change.id] ?? .available
    }

    var body: some View {
        HStack(spacing: Spacing.s) {
            thumbnail
            Text(change.text)
                .font(TypeScale.captionStrong)
                .foregroundStyle(undoState == .done ? Theme.textTertiary : Theme.textSecondary)
                .strikethrough(undoState == .done, color: Theme.textTertiary)
                .lineLimit(2)
                .truncationMode(.tail)
            if let label = change.actionLabel, let url = change.actionURL {
                Button(label) {
                    NSWorkspace.shared.open(url)
                }
                .buttonStyle(.brandPrimary)
                .controlSize(.small)
            }
            undoControl
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.xs)
        .background(Theme.surface, in: Capsule(style: .continuous))
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xxs)
        .scaleEffect(appeared || reduceMotion ? 1 : 0.96)
        .opacity(appeared ? 1 : 0)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: undoState)
        .onAppear {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                appeared = true
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var thumbnail: some View {
        switch change.thumbnailKind {
        case "bot":
            if let id = change.thumbnailID, let bot = model.bot(id: id) {
                BotCharacter(bot: bot, mood: .idle, size: 18)
            } else {
                symbol("person.crop.circle")
            }
        case "provider":
            ProviderLogo(provider: change.thumbnailID ?? "", size: 14)
        case "connector":
            ConnectorLogo(name: change.targetID, icon: change.thumbnailID, size: 14)
        case "integration":
            symbol("key.horizontal.fill")
        default:
            symbol(Self.symbol(for: change.area))
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.textSecondary)
            .frame(width: 16, height: 16)
    }

    @ViewBuilder
    private var undoControl: some View {
        if !change.undo.isEmpty {
            switch undoState {
            case .available:
                Button("Desfazer", action: runUndo)
                    .buttonStyle(.plain)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.brandText)
                    .help("Volta como estava antes desta mudança")
            case .running:
                ProgressView().controlSize(.mini)
            case .done:
                Text("Desfeito")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            case .failed(let message):
                Button("Tentar de novo", action: runUndo)
                    .buttonStyle(.plain)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.danger)
                    .help(message)
            }
        }
    }

    private func runUndo() {
        let steps = change.undo
        let client = model.client
        store.settingsUndo[change.id] = .running
        Task { @MainActor in
            do {
                for step in steps {
                    try await client.runUndo(step)
                }
                store.settingsUndo[change.id] = .done
                model.applySettingsAreas(change.areas)
            } catch {
                store.settingsUndo[change.id] = .failed(error.localizedDescription)
            }
        }
    }

    static let lineTools: Set<String> = [
        "bot_update", "bot_archive", "section_update", "schedule_update", "schedule_run", "server_profile_save",
        "server_profile_delete", "repo_remove", "vault_update_meta", "account_update", "integration_setup",
        "connector_connect", "preferences_set",
    ]

    static func symbol(for area: String) -> String {
        switch area {
        case "schedules": "clock"
        case "sections": "sidebar.left"
        case "servers": "play.rectangle"
        case "repos": "folder"
        case "vault": "lock"
        case "accounts": "person.2"
        case "connectors": "link"
        case "preferences": "bell"
        default: "gearshape"
        }
    }
}
