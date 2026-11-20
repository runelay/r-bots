import AppKit
import Observation
import SwiftUI

struct TestRunInfo: Identifiable, Equatable, Sendable {
    struct Step: Identifiable, Equatable, Sendable {
        let index: Int
        let name: String
        let status: String
        let durationMs: Int?
        let error: String?
        var id: Int { index }
    }

    let id: String
    let kind: String
    let title: String
    let target: String
    let status: String
    let attempt: Int
    let durationMs: Int?
    let steps: [Step]
    let error: String?
    let screenshot: Bool
    let artifacts: [String]

    init?(_ value: JSONValue?) {
        guard let value, let id = value["id"]?.stringValue else { return nil }
        self.id = id
        kind = value["kind"]?.stringValue ?? "maestro"
        title = value["title"]?.stringValue ?? "teste"
        target = value["target"]?.stringValue ?? ""
        status = value["status"]?.stringValue ?? "running"
        attempt = value["attempt"]?.intValue ?? 1
        durationMs = value["durationMs"]?.intValue
        steps = (value["steps"]?.arrayValue ?? []).enumerated().map { index, item in
            Step(index: index, name: item["name"]?.stringValue ?? "passo", status: item["status"]?.stringValue ?? "passed", durationMs: item["durationMs"]?.intValue, error: item["error"]?.stringValue)
        }
        error = value["error"]?.stringValue
        screenshot = value["screenshot"]?.boolValue ?? false
        artifacts = value["artifacts"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    var running: Bool { status == "running" }
    var passedCount: Int { steps.filter { $0.status == "passed" }.count }
    var screenshotName: String { kind == "maestro" ? "screenshot.jpg" : "screenshot.png" }

    var headline: String {
        switch status {
        case "running": "Rodando"
        case "passed": "Passou"
        case "failed": "Falhou"
        default: "Não rodou"
        }
    }

    var durationText: String? {
        guard let durationMs else { return nil }
        let seconds = Double(durationMs) / 1000
        return seconds < 60 ? String(format: "%.1f s", seconds) : "\(Int(seconds) / 60) min \(Int(seconds) % 60) s"
    }
}

@MainActor
@Observable
final class TestStore {
    static let shared = TestStore()
    static let panelKind = "test"

    private(set) var runs: [String: TestRunInfo] = [:]
    private(set) var images: [String: NSImage] = [:]
    private(set) var logs: [String: String] = [:]
    private(set) var busy: Set<String> = []

    @ObservationIgnored private var loadedImages: Set<String> = []

    private init() {}

    func apply(_ value: JSONValue?) {
        guard let run = TestRunInfo(value) else { return }
        let previous = runs[run.id]
        runs[run.id] = run
        if previous?.attempt != run.attempt || previous?.status != run.status {
            loadedImages.remove(imageKey(run))
            logs[run.id] = nil
        }
    }

    private func imageKey(_ run: TestRunInfo) -> String {
        "\(run.id)#\(run.attempt)#\(run.status)"
    }

    func file(_ run: TestRunInfo, _ name: String, client: BotsClient) async -> Data? {
        guard let request = try? client.request(path: "/tests/\(run.id)/files/\(name)") else { return nil }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        return data
    }

    func loadImage(_ run: TestRunInfo, client: BotsClient) async {
        guard run.screenshot, !run.running, loadedImages.insert(imageKey(run)).inserted else { return }
        if let data = await file(run, run.screenshotName, client: client), let image = NSImage(data: data) {
            images[run.id] = image
        }
    }

    func loadLog(_ run: TestRunInfo, client: BotsClient) async {
        guard !run.running, logs[run.id] == nil else { return }
        if let data = await file(run, "log.txt", client: client) {
            logs[run.id] = String(decoding: data, as: UTF8.self)
        }
    }

    func rerun(_ run: TestRunInfo, client: BotsClient) {
        busy.insert(run.id)
        Task {
            if var request = try? client.request(path: "/tests/\(run.id)/rerun") {
                request.httpMethod = "POST"
                if let (data, _) = try? await URLSession.shared.data(for: request),
                   let json = try? JSONDecoder().decode(JSONValue.self, from: data) {
                    apply(json["run"])
                }
            }
            busy.remove(run.id)
        }
    }

    func openArtifact(_ run: TestRunInfo, _ name: String, client: BotsClient) {
        Task {
            guard let data = await file(run, name, client: client) else { return }
            let url = FileManager.default.temporaryDirectory.appending(path: "\(run.id)-\(name)")
            try? data.write(to: url)
            NSWorkspace.shared.open(url)
        }
    }

    func openPanel(_ run: TestRunInfo, botID: String, client: BotsClient) {
        ArtifactCenter.shared.open(ArtifactRef(botID: botID, id: run.id, title: run.title, kind: Self.panelKind, version: 1), client: client)
    }
}

struct TestStatusIcon: View {
    let status: String
    var size: CGFloat = 12

    var body: some View {
        Group {
            switch status {
            case "passed":
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
            case "failed":
                Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.danger)
            case "skipped":
                Image(systemName: "minus.circle").foregroundStyle(Theme.textTertiary)
            case "running":
                ProgressView().controlSize(.mini)
            default:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
            }
        }
        .font(.system(size: size, weight: .semibold))
        .frame(width: size + 4, height: size + 4)
        .transition(.scale.combined(with: .opacity))
    }
}

struct TestResultCard: View {
    @Environment(AppModel.self) private var model
    let ref: ArtifactRef

    @State private var hovering = false

    private var store: TestStore { .shared }
    private var run: TestRunInfo? { store.runs[ref.id] }

    var body: some View {
        Group {
            if let run {
                card(run)
                    .task(id: "\(run.id)#\(run.attempt)#\(run.status)") {
                        await store.loadImage(run, client: model.client)
                    }
            }
        }
        .padding(.leading, 20 + Spacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func card(_ run: TestRunInfo) -> some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            VStack(alignment: .leading, spacing: Spacing.s) {
                HStack(spacing: Spacing.s) {
                    TestStatusIcon(status: run.status == "error" ? "error" : run.status, size: 14)
                    Text("\(run.headline) · \(run.title)")
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                    Spacer(minLength: Spacing.s)
                    if let duration = run.durationText {
                        Text(duration)
                            .font(TypeScale.caption.monospacedDigit())
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                Text(run.kind == "maestro" ? "Maestro · \(run.target)" : "Playwright · \(run.target)")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                VStack(alignment: .leading, spacing: Spacing.xxs + 1) {
                    ForEach(run.steps.prefix(8)) { step in
                        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                            TestStatusIcon(status: step.status, size: 10)
                            Text(step.name)
                                .font(TypeScale.caption)
                                .foregroundStyle(step.status == "failed" ? Theme.danger : Theme.textSecondary)
                                .lineLimit(1)
                        }
                    }
                    if run.steps.count > 8 {
                        Text("+ \(run.steps.count - 8) passos")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    if run.status != "passed", let error = run.error ?? run.steps.first(where: { $0.status == "failed" })?.error {
                        Text(error)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                    }
                }
                HStack(spacing: Spacing.s) {
                    ServerCardButton(title: store.busy.contains(run.id) || run.running ? "Rodando…" : "Rodar de novo", systemImage: "arrow.clockwise") {
                        store.rerun(run, client: model.client)
                    }
                    .disabled(run.running || store.busy.contains(run.id))
                    ServerCardButton(title: "Detalhes", systemImage: "text.alignleft") {
                        store.openPanel(run, botID: ref.botID, client: model.client)
                    }
                }
            }
            if let image = store.images[run.id] {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: run.kind == "maestro" ? 72 : 120, height: 150, alignment: .top)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                    .transition(.opacity)
                    .onTapGesture { store.openPanel(run, botID: ref.botID, client: model.client) }
                    .clickable()
            }
        }
        .padding(Spacing.m)
        .frame(width: 460, alignment: .leading)
        .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: run.status)
        .springAnimation(value: run.steps.count)
    }
}

struct TestPanel: View {
    @Environment(AppModel.self) private var model
    let ref: ArtifactRef

    private var store: TestStore { .shared }
    private var presentation: BlockPresentation { .shared }
    private var run: TestRunInfo? { store.runs[ref.id] }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Spacing.s) {
                if let run {
                    TestStatusIcon(status: run.status, size: 14)
                    Text("\(run.headline) · \(run.title)")
                        .font(TypeScale.rowSubtitle.weight(.medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                }
                Spacer(minLength: Spacing.m)
                if let run {
                    ForEach(run.artifacts.filter { $0 != "log.txt" && !$0.hasPrefix("screenshot") }, id: \.self) { name in
                        BlockHeaderButton(systemImage: name.hasPrefix("video") ? "play.rectangle" : "archivebox", help: name.hasPrefix("video") ? "Ver o vídeo" : "Baixar o trace") {
                            store.openArtifact(run, name, client: model.client)
                        }
                    }
                    BlockHeaderButton(systemImage: "arrow.clockwise", help: "Rodar de novo") {
                        store.rerun(run, client: model.client)
                    }
                }
                BlockHeaderButton(systemImage: "xmark", help: "Fechar") {
                    presentation.close()
                }
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 48)
            if let run {
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.l) {
                        if let image = store.images[run.id] {
                            Image(nsImage: image)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxHeight: 420)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                                .frame(maxWidth: .infinity)
                        }
                        VStack(alignment: .leading, spacing: Spacing.xs) {
                            ForEach(run.steps) { step in
                                HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                                    TestStatusIcon(status: step.status, size: 11)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(step.name)
                                            .font(TypeScale.rowSubtitle)
                                            .foregroundStyle(Theme.textPrimary)
                                        if let error = step.error {
                                            Text(error)
                                                .font(TypeScale.caption)
                                                .foregroundStyle(Theme.danger)
                                                .textSelection(.enabled)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                    if let duration = step.durationMs {
                                        Text(String(format: "%.1f s", Double(duration) / 1000))
                                            .font(TypeScale.caption.monospacedDigit())
                                            .foregroundStyle(Theme.textTertiary)
                                            .lineLimit(1)
                                            .fixedSize()
                                    }
                                }
                            }
                        }
                        if let log = store.logs[run.id], !log.isEmpty {
                            Text(log)
                                .font(TypeScale.mono)
                                .foregroundStyle(Theme.textSecondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(Spacing.l)
                }
                .scrollEdgesHidden()
                .task(id: "\(run.id)#\(run.attempt)#\(run.status)") {
                    await store.loadImage(run, client: model.client)
                    await store.loadLog(run, client: model.client)
                }
            } else {
                PanelEmptyState(systemImage: "checklist", title: "Teste não encontrado", message: "Ele pode ter sido apagado.")
                    .frame(maxHeight: .infinity)
            }
        }
    }
}
