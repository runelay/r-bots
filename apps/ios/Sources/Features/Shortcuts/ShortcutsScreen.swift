import SwiftUI

enum ShortcutDestination: String, CaseIterable, Identifiable, Hashable {
    case git
    case linear
    case agenda
    case notes
    case routines
    case connectors
    case usage

    var id: String { rawValue }

    var title: String {
        switch self {
        case .git: "GitHub"
        case .linear: "Linear"
        case .agenda: "Agenda"
        case .notes: tr("Notas e planilhas")
        case .routines: tr("Rotinas")
        case .connectors: tr("Conectores")
        case .usage: tr("Uso")
        }
    }

    var symbol: String {
        switch self {
        case .git: "arrow.triangle.pull"
        case .linear: "circle.dashed"
        case .agenda: "calendar.badge.clock"
        case .notes: "doc.on.doc"
        case .routines: "list.bullet"
        case .connectors: "safari"
        case .usage: "gauge.with.dots.needle.33percent"
        }
    }

    var logo: String? {
        switch self {
        case .git: "logo-github"
        case .linear: "logo-linear"
        case .agenda: "logo-googlecalendar"
        default: nil
        }
    }

    var tint: Color {
        switch self {
        case .git: Theme.textPrimary
        case .linear: Color.brand(light: 0x5E6AD2, dark: 0x8A93F0)
        case .agenda: Theme.accent("blue")
        case .notes: Theme.attention
        case .routines: Theme.brandText
        case .connectors: Theme.accent("teal")
        case .usage: Theme.textSecondary
        }
    }
}

struct ShortcutsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var github: JSONValue?
    @State private var githubFailed = false
    @State private var linear: JSONValue?
    @State private var linearError: String?
    @State private var connected: Int?

    private var bot: Bot? { model.visibleBots.first }

    var body: some View {
        List {
            Section {
                ForEach(ShortcutDestination.allCases) { destination in
                    NavigationLink {
                        destinationView(destination)
                    } label: {
                        ShortcutTile(destination: destination, summary: summary(destination))
                    }
                    .disabled((destination == .agenda || destination == .notes) && bot == nil)
                }
            } footer: {
                Text("Tudo o que você acompanha, a um toque.")
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Atalhos")
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func destinationView(_ destination: ShortcutDestination) -> some View {
        switch destination {
        case .git: GitHubScreen()
        case .linear: LinearScreen()
        case .agenda, .notes:
            if let bot { BotLibraryScreen(bot: bot) }
        case .routines: RoutinesScreen()
        case .connectors: ConnectorsScreen()
        case .usage: UsageScreen()
        }
    }

    private func summary(_ destination: ShortcutDestination) -> String {
        switch destination {
        case .git:
            if let counts = github?["counts"] {
                let review = counts["review"]?.intValue ?? 0
                let mine = counts["mine"]?.intValue ?? 0
                if review > 0 { return review == 1 ? tr("1 PR esperando sua revisão") : tr("%lld PRs esperando sua revisão", review) }
                if mine > 0 { return mine == 1 ? tr("1 PR seu aberto") : tr("%lld PRs seus abertos", mine) }
                return tr("Nenhum PR pendente")
            }
            return githubFailed ? tr("GitHub não conectado no servidor") : tr("Carregando…")
        case .linear:
            if let linear {
                let started = linear["started"]?.intValue ?? 0
                let more = linear["more"]?.boolValue ?? false
                if started == 0 { return tr("Nada em andamento com você") }
                return started == 1 && !more ? tr("1 issue em andamento") : tr("%lld%@ issues em andamento", started, more ? "+" : "")
            }
            if let linearError {
                return linearError.localizedCaseInsensitiveContains("conect") ? tr("Conecte o Linear em Conectores") : tr("Linear não conectado no servidor")
            }
            return tr("Carregando…")
        case .agenda:
            guard let bot else { return tr("Crie um bot para usar a agenda") }
            return tr("Semana com suas contas do Google · %@", bot.name)
        case .notes:
            guard let bot else { return tr("Crie um bot para guardar notas") }
            return tr("Arquivos de %@", bot.name)
        case .routines:
            let count = model.visibleBots.reduce(0) { $0 + $1.schedules.count }
            return count == 0 ? tr("Tarefas que seus bots fazem sozinhos") : (count == 1 ? tr("1 rotina ativa") : tr("%lld rotinas ativas", count))
        case .connectors:
            guard let connected else { return tr("Catálogo de contas e ferramentas") }
            return connected == 1 ? tr("1 conta conectada") : tr("%lld contas conectadas", connected)
        case .usage:
            return tr("Limites e consumo das contas de IA")
        }
    }

    private func load() async {
        let client = model.client
        async let gitValue = try? client.call("/github/summary")
        async let connectorList = try? client.connectors()
        do {
            linear = try await client.call("/linear/summary")
        } catch {
            linearError = ErrorMessage.describe(error)
        }
        github = await gitValue
        githubFailed = github == nil
        if let list = await connectorList {
            connected = list.filter { $0.status == "ok" }.count
        }
    }
}

struct ShortcutTile: View {
    let destination: ShortcutDestination
    let summary: String

    var body: some View {
        HStack(spacing: Spacing.m) {
            Group {
                if let logo = destination.logo {
                    Image(logo)
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 17, height: 17)
                } else {
                    Image(systemName: destination.symbol)
                        .font(.system(size: 15, weight: .medium))
                }
            }
            .foregroundStyle(destination.tint)
            .frame(width: 36, height: 36)
            .background(destination.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(destination.title)
                    .font(BrandFonts.sans(15, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                Text(summary)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
        }
        .padding(.vertical, 2)
        .animation(Motion.spring, value: summary)
        .accessibilityElement(children: .combine)
    }
}

struct GitHubScreen: View {
    @Environment(AppModel.self) private var model
    @State private var filter = "mine"
    @State private var state: Loadable<[JSONValue]> = .loading

    var body: some View {
        VStack(spacing: 0) {
            Picker("Filtro", selection: $filter) {
                Text("Meus").tag("mine")
                Text("Revisar").tag("review")
                Text("Menções").tag("mentions")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.s)
            LoadingState(state: state, retry: { Task { await load() } }) { items in
                List {
                    if items.isEmpty {
                        ContentUnavailableView("Nenhum PR", systemImage: "arrow.triangle.pull")
                            .listRowBackground(Color.clear)
                    }
                    ForEach(Array(items.enumerated()), id: \.offset) { _, pull in
                        ExternalLinkRow(url: pull["url"]?.stringValue.flatMap(URL.init(string:))) {
                            PullRow(pull: pull)
                        }
                        .settingsRow()
                    }
                }
                .settingsList()
                .refreshable { await load() }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("GitHub")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: filter) { await load() }
    }

    private func load() async {
        do {
            state = .loaded(try await model.client.call("/github/pulls?filter=\(filter)")["items"]?.arrayValue ?? [])
        } catch {
            state = .failed(ErrorMessage.describe(error))
        }
    }
}

struct PullRow: View {
    let pull: JSONValue

    private var ciColor: Color {
        switch pull["ci"]?.stringValue {
        case "success": Theme.success
        case "failure": Theme.danger
        case "pending": Theme.attention
        default: Theme.textTertiary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            Image(systemName: pull["draft"]?.boolValue == true ? "circle.dashed" : "arrow.triangle.pull")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.success)
                .frame(width: 20)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(pull["title"]?.stringValue ?? "")
                    .font(BrandFonts.sans(15, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                HStack(spacing: Spacing.xs) {
                    Text("\(pull["repo"]?.stringValue ?? "") #\(pull["number"]?.intValue ?? 0)")
                    if pull["ci"]?.stringValue != nil {
                        Circle().fill(ciColor).frame(width: 6, height: 6)
                    }
                }
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

struct LinearScreen: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[JSONValue]> = .loading

    var body: some View {
        LoadingState(state: state, retry: { Task { await load() } }) { issues in
            List {
                if issues.isEmpty {
                    ContentUnavailableView("Nada com você", systemImage: "circle.dashed")
                        .listRowBackground(Color.clear)
                }
                ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in
                    ExternalLinkRow(url: issue["url"]?.stringValue.flatMap(URL.init(string:))) {
                        HStack(alignment: .top, spacing: Spacing.m) {
                            Circle()
                                .strokeBorder(stateColor(issue["stateType"]?.stringValue), lineWidth: 2)
                                .frame(width: 14, height: 14)
                                .padding(.top, 3)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(issue["title"]?.stringValue ?? "")
                                    .font(BrandFonts.sans(15, weight: .medium))
                                    .foregroundStyle(Theme.textPrimary)
                                    .lineLimit(2)
                                Text("\(issue["id"]?.stringValue ?? "") · \(issue["state"]?.stringValue ?? "")")
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .settingsRow()
                }
            }
            .settingsList()
            .refreshable { await load() }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Linear")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func stateColor(_ type: String?) -> Color {
        switch type {
        case "started": Theme.attention
        case "completed": Theme.success
        case "canceled": Theme.textTertiary
        default: Theme.textSecondary
        }
    }

    private func load() async {
        do {
            let board = try await model.client.call("/linear/board?view=mine")
            let issues = (board["issues"]?.arrayValue ?? []).filter { $0["stateType"]?.stringValue == "started" }
            state = .loaded(issues)
        } catch {
            state = .failed(ErrorMessage.describe(error))
        }
    }
}

struct ExternalLinkRow<Label: View>: View {
    let url: URL?
    @ViewBuilder let label: Label

    var body: some View {
        if let url {
            Link(destination: url) { label }
        } else {
            label
        }
    }
}
