import AppKit
import SwiftUI

@MainActor
@Observable
final class VersionsStore {
    enum LoadState: Equatable {
        case loading
        case loaded
        case unavailable
        case failed(String)
    }

    enum PendingAction: Equatable {
        case update
        case rollback
    }

    enum ServerUpdatePhase: Equatable {
        case requesting
        case waiting(String?)
        case restarting
        case succeeded(String)
        case failed(String)

        var isActive: Bool {
            switch self {
            case .requesting, .waiting, .restarting: true
            case .succeeded, .failed: false
            }
        }
    }

    var serverState: LoadState = .loading
    var server: ServerVersionInfo?
    var cliState: LoadState = .loading
    var clis: [CliVersion] = []
    var pending: [String: PendingAction] = [:]
    var errors: [String: String] = [:]
    var serverPhase: ServerUpdatePhase?
    var serverTurnsRunning: Int?

    var isUpdating: Bool {
        pending.values.contains(.update) || clis.contains(where: \.updating)
    }

    var updateCount: Int {
        let serverCount = serverState == .loaded && server?.updateAvailable == true ? 1 : 0
        let cliCount = cliState == .loaded ? clis.filter(\.updateAvailable).count : 0
        return serverCount + cliCount
    }

    func watch(model: AppModel) async {
        while !Task.isCancelled {
            await load(model: model)
            try? await Task.sleep(for: .seconds(6 * 60 * 60))
        }
    }

    func load(model: AppModel) async {
        async let serverLoad: Void = loadServer(model: model)
        async let cliLoad: Void = refreshClis(model: model)
        _ = await (serverLoad, cliLoad)
    }

    func loadServer(model: AppModel) async {
        do {
            if let info = try await model.client.serverVersion() {
                server = info
                serverState = .loaded
                if let update = info.update, update.isInProgress, serverPhase?.isActive != true {
                    serverPhase = .waiting(update.step)
                    Task { await followServerUpdate(model: model) }
                }
            } else {
                server = nil
                serverState = .unavailable
            }
        } catch {
            if server == nil { serverState = .failed(ErrorMessage.describe(error)) }
        }
    }

    func refreshClis(model: AppModel) async {
        do {
            if let list = try await model.client.providerVersions() {
                clis = list.map { item in
                    var item = item
                    if pending[item.id] == .update { item.updating = true }
                    return item
                }
                cliState = .loaded
            } else {
                clis = []
                cliState = .unavailable
            }
        } catch {
            if clis.isEmpty { cliState = .failed(ErrorMessage.describe(error)) }
        }
    }

    func updateServer(model: AppModel, force: Bool = false) async {
        guard serverPhase?.isActive != true else { return }
        serverPhase = .requesting
        serverTurnsRunning = nil
        do {
            switch try await model.client.requestServerUpdate(force: force) {
            case .turnsRunning(let count):
                serverPhase = nil
                serverTurnsRunning = count
                return
            case .queued:
                serverPhase = .waiting(nil)
            }
        } catch {
            serverPhase = .failed(ErrorMessage.describe(error))
            return
        }
        await followServerUpdate(model: model)
    }

    private func followServerUpdate(model: AppModel) async {
        let deadline = Date.now.addingTimeInterval(4 * 60)
        while Date.now < deadline {
            try? await Task.sleep(for: .seconds(2))
            do {
                guard let info = try await model.client.serverVersion() else {
                    serverPhase = .restarting
                    continue
                }
                server = info
                serverState = .loaded
                guard let update = info.update else { continue }
                if update.isInProgress {
                    serverPhase = .waiting(update.step)
                } else if update.succeeded {
                    serverPhase = .succeeded(update.to ?? info.current)
                    return
                } else if update.failed {
                    serverPhase = .failed(update.message ?? "A atualização não deu certo.")
                    return
                }
            } catch {
                serverPhase = .restarting
            }
        }
        serverPhase = .failed("O servidor não voltou em 4 minutos. Veja rbots status no servidor.")
    }

    func update(_ cli: CliVersion, model: AppModel) async {
        guard pending[cli.id] == nil else { return }
        pending[cli.id] = .update
        errors[cli.id] = nil
        setUpdating(cli.id, true)
        do {
            try await model.client.updateProvider(cli.provider)
        } catch {
            errors[cli.id] = ErrorMessage.describe(error)
        }
        pending[cli.id] = nil
        await refreshClis(model: model)
    }

    func rollback(_ cli: CliVersion, model: AppModel) async {
        guard pending[cli.id] == nil else { return }
        pending[cli.id] = .rollback
        errors[cli.id] = nil
        do {
            replace(try await model.client.rollbackProvider(cli.provider))
        } catch {
            errors[cli.id] = ErrorMessage.describe(error)
        }
        pending[cli.id] = nil
    }

    private func setUpdating(_ id: String, _ value: Bool) {
        guard let index = clis.firstIndex(where: { $0.id == id }) else { return }
        clis[index].updating = value
    }

    private func replace(_ item: CliVersion) {
        if let index = clis.firstIndex(where: { $0.id == item.id }) {
            clis[index] = item
        }
    }
}

struct VersionsSettings: View {
    @Environment(AppModel.self) private var model
    private var store: VersionsStore { model.versions }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            if store.serverState == .unavailable && store.cliState == .unavailable {
                EmptyStateView(
                    systemImage: "arrow.down.circle", title: "Este servidor ainda não mostra versões", description: "Depois de atualizar o servidor, as versões e as atualizações aparecem aqui.")
            } else {
                serverSection
                cliSection
            }
        }
        .springAnimation(value: store.server)
        .springAnimation(value: store.clis)
        .springAnimation(value: store.serverState)
        .springAnimation(value: store.cliState)
        .task(id: model.settingsRevision) {
            await store.load(model: model)
        }
        .task(id: store.isUpdating) {
            guard store.isUpdating else { return }
            while !Task.isCancelled, store.isUpdating {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                await store.refreshClis(model: model)
            }
        }
    }

    @ViewBuilder
    private var serverSection: some View {
        switch store.serverState {
        case .loading:
            VersionsPlaceholder(rows: 1)
        case .unavailable:
            EmptyView()
        case .failed(let message):
            SettingsGroup(caption: "r/bots") {
                SettingsRow(title: "Não deu para ver a versão", icon: SettingsIcon("exclamationmark.triangle.fill", SettingsTint.amber), detail: message) {
                    EmptyView()
                }
            }
        case .loaded:
            if let info = store.server {
                ServerVersionGroup(info: info, store: store)
            }
        }
    }

    @ViewBuilder
    private var cliSection: some View {
        switch store.cliState {
        case .loading:
            VersionsPlaceholder(rows: 2)
        case .unavailable:
            EmptyView()
        case .failed(let message):
            SettingsGroup(caption: "CLIs dos bots") {
                SettingsRow(title: "Não deu para ver os CLIs", icon: SettingsIcon("exclamationmark.triangle.fill", SettingsTint.amber), detail: message) {
                    EmptyView()
                }
            }
        case .loaded:
            SettingsGroup(caption: "CLIs dos bots") {
                ForEach(store.clis) { cli in
                    CliVersionRow(cli: cli, store: store)
                }
            }
        }
    }
}

private struct VersionsPlaceholder: View {
    let rows: Int

    var body: some View {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(Theme.surface)
            .frame(height: CGFloat(rows) * 44 + 28)
    }
}

private struct ServerVersionGroup: View {
    @Environment(AppModel.self) private var model
    let info: ServerVersionInfo
    let store: VersionsStore
    @State private var copied = false

    private var phase: VersionsStore.ServerUpdatePhase? { store.serverPhase }

    private var showsUpdater: Bool {
        if phase?.isActive == true { return true }
        if case .failed = phase { return info.updateAvailable }
        return info.updateAvailable && info.canUpdateFromApp
    }

    private var showsCommand: Bool {
        guard info.updateAvailable, phase?.isActive != true else { return false }
        if case .failed = phase { return true }
        return !info.canUpdateFromApp
    }

    private var confirmTurns: Binding<Bool> {
        Binding(
            get: { store.serverTurnsRunning != nil },
            set: { if !$0 { store.serverTurnsRunning = nil } }
        )
    }

    var body: some View {
        SettingsGroup(caption: "r/bots") {
            SettingsRow(title: "Servidor", icon: SettingsIcon("server.rack", SettingsTint.blue), detail: detail) {
                HStack(spacing: Spacing.s) {
                    SettingsValue(text: info.isDevelopment ? "Desenvolvimento" : info.current)
                    if info.updateAvailable, let latest = info.latest {
                        SettingsPill(text: "\(latest) disponível", color: Theme.brandAccent)
                    } else if !info.isDevelopment, info.latest != nil {
                        SettingsPill(text: "Em dia", color: Theme.success)
                    }
                }
            }
            if info.updateAvailable, let latest = info.latest {
                SettingsRow(title: "Novidades da \(latest)", icon: SettingsIcon("sparkles", SettingsTint.purple), detail: published) {
                    if let link = info.releaseLink {
                        Link(destination: link) {
                            Label("Ver notas", systemImage: "arrow.up.right")
                        }
                        .buttonStyle(SettingsButtonStyle(kind: .plain))
                    }
                }
            }
            if showsUpdater {
                updaterRow
                    .transition(.opacity)
            }
            if showsCommand {
                SettingsRow(
                    title: "Como atualizar", icon: SettingsIcon("terminal.fill", SettingsTint.slate), detail: "Rode no servidor. Ele guarda um backup antes e volta sozinho se a versão nova não subir."
                ) {
                    commandChip
                }
                .transition(.opacity)
            }
        }
        .springAnimation(value: phase)
    }

    @ViewBuilder
    private var updaterRow: some View {
        let target = info.latest ?? "versão nova"
        switch phase {
        case .requesting, .waiting, .restarting:
            SettingsRow(title: "Atualizando para a \(target)", icon: SettingsIcon("arrow.down.circle.fill", SettingsTint.blue), detail: progressDetail) {
                HStack(spacing: Spacing.s) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Atualizando…")
                        .font(BrandFonts.sans(12, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        case .failed(let message):
            SettingsRow(title: "A atualização não deu certo", icon: SettingsIcon("exclamationmark.triangle.fill", SettingsTint.amber), detail: message) {
                if info.canUpdateFromApp {
                    updateButton(title: "Tentar de novo")
                }
            }
        case .succeeded, nil:
            SettingsRow(
                title: "Atualizar o servidor", icon: SettingsIcon("arrow.down.circle.fill", SettingsTint.blue), detail: "Guarda um backup antes e volta sozinho se a versão nova não subir."
            ) {
                updateButton(title: "Atualizar para \(target)")
            }
        }
    }

    private var progressDetail: String {
        switch phase {
        case .restarting: "Reiniciando o servidor…"
        case .waiting(let step?): step
        default: "Pedindo ao servidor…"
        }
    }

    private func updateButton(title: String) -> some View {
        Button {
            Task { await store.updateServer(model: model) }
        } label: {
            Text(title)
        }
        .buttonStyle(SettingsButtonStyle(kind: .primary))
        .glassPopup(isPresented: confirmTurns, edge: .trailing) {
            GlassConfirm(title: turnsTitle, message: "Os turnos em andamento são interrompidos.", confirmTitle: "Atualizar") {
                Task { await store.updateServer(model: model, force: true) }
            }
        }
    }

    private var turnsTitle: String {
        let count = store.serverTurnsRunning ?? 1
        return count == 1 ? "Há 1 turno rodando. Atualizar mesmo assim?" : "Há \(count) turnos rodando. Atualizar mesmo assim?"
    }

    private var detail: String? {
        var parts: [String] = []
        if case .succeeded(let version) = phase, !info.updateAvailable {
            parts.append("Atualizado para \(version)")
        } else if info.isDevelopment {
            parts.append("Rodando direto do código")
        } else if !info.updateAvailable, info.latest != nil {
            parts.append("Está na versão mais recente")
        }
        if info.isBeta { parts.append(parts.isEmpty ? "Canal beta" : "canal beta") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var published: String? {
        info.publishedDate.map { "Publicada em \($0.formatted(date: .long, time: .omitted))" }
    }

    private var commandChip: some View {
        HStack(spacing: Spacing.xs) {
            Text(info.command)
                .font(TypeScale.monoInline)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .textSelection(.enabled)
            Button(action: copy) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(copied ? Theme.success : Theme.textSecondary)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .clickable()
            .help(copied ? "Copiado" : "Copiar comando")
            .accessibilityLabel(copied ? "Copiado" : "Copiar comando")
        }
        .padding(.leading, Spacing.s)
        .padding(.trailing, Spacing.xxs)
        .frame(height: 26)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .springAnimation(value: copied)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.6))
            guard !Task.isCancelled else { return }
            copied = false
        }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(info.command, forType: .string)
        copied = true
    }
}

private struct CliVersionRow: View {
    @Environment(AppModel.self) private var model
    let cli: CliVersion
    let store: VersionsStore
    @State private var confirmRollback = false

    private var action: VersionsStore.PendingAction? {
        cli.updating ? .update : store.pending[cli.id]
    }

    private var requestError: String? { store.errors[cli.id] }

    var body: some View {
        HStack(spacing: Spacing.s + 2) {
            ProviderLogo(provider: cli.provider, size: 18)
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(cli.displayName)
                    .font(BrandFonts.sans(13, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                detailLine
            }
            Spacer(minLength: Spacing.m)
            trailing
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.xs + 2)
        .frame(minHeight: 44)
        .springAnimation(value: action)
        .springAnimation(value: requestError)
    }

    @ViewBuilder
    private var detailLine: some View {
        if let action {
            Text(action == .update ? "Instalando a versão nova. Os bots seguem funcionando." : "Voltando para a versão anterior.")
                .font(BrandFonts.sans(11.5))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .transition(.opacity)
        } else if let requestError {
            Text(requestError)
                .font(BrandFonts.sans(11.5))
                .foregroundStyle(Theme.danger)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
        } else if let lastError = cli.lastError {
            HStack(spacing: Spacing.xs) {
                Text("A última atualização não deu certo")
                    .font(BrandFonts.sans(11.5))
                    .foregroundStyle(Theme.danger)
                    .lineLimit(1)
                SettingsInfoButton(text: lastError)
            }
            .transition(.opacity)
        } else {
            Text(origin)
                .font(BrandFonts.sans(11.5))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .transition(.opacity)
        }
    }

    private var origin: String {
        guard cli.installed != nil else { return "Não encontrado neste servidor" }
        return cli.isManaged ? "Atualizado pelo app" : "Veio com o servidor"
    }

    private var trailing: some View {
        HStack(spacing: Spacing.s) {
            if let action {
                ProgressView()
                    .controlSize(.small)
                Text(action == .update ? "Atualizando…" : "Voltando…")
                    .font(BrandFonts.sans(12, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
            } else {
                if let installed = cli.installed {
                    SettingsValue(text: installed)
                }
                if cli.updateAvailable, let latest = cli.latest {
                    Text("→ \(latest)")
                        .font(BrandFonts.sans(12.5, weight: .medium))
                        .foregroundStyle(Theme.brandText)
                        .lineLimit(1)
                    Button {
                        Task { await store.update(cli, model: model) }
                    } label: {
                        Text("Atualizar")
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .primary))
                }
                if let previous = cli.previous {
                    Button {
                        confirmRollback = true
                    } label: {
                        Text("Voltar")
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .plain))
                    .help("Voltar para a \(previous)")
                    .glassPopup(isPresented: $confirmRollback, edge: .trailing) {
                        GlassConfirm(title: "Voltar o \(cli.displayName) para a \(previous)?", message: "O próximo pedido dos bots já usa essa versão.", confirmTitle: "Voltar") {
                            Task { await store.rollback(cli, model: model) }
                        }
                    }
                }
            }
        }
        .transition(.opacity)
    }
}
