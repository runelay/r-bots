import AuthenticationServices
import LocalAuthentication
import SwiftUI
import UserNotifications

struct CatalogItem: Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let auth: String
    let tokenURL: URL?
    let installed: Bool
    let sourceName: String?
    let status: String?
    let toolCount: Int?

    init?(_ json: JSONValue, toolCounts: [String: Int]) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        name = json["name"]?.stringValue ?? id
        description = json["description"]?.stringValue ?? ""
        auth = json["auth"]?.stringValue ?? "none"
        tokenURL = json["tokenUrl"]?.stringValue.flatMap(URL.init(string:))
        installed = json["installed"]?.boolValue ?? false
        sourceName = json["sourceName"]?.stringValue
        status = json["status"]?.stringValue
        toolCount = sourceName.flatMap { toolCounts[$0] }
    }

    var statusLabel: String {
        guard installed else { return "Disponível" }
        switch status {
        case "ok": return toolCount.map { "Conectado · \($0) ferramentas" } ?? "Conectado"
        case "needs_auth": return "Precisa reconectar"
        case "error": return "Com erro"
        default: return "Instalado"
        }
    }
}

struct CatalogSection: Identifiable {
    let id: String
    let title: String
    let items: [CatalogItem]
}

struct ConnectorsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[CatalogSection]> = .loading
    @State private var query = ""
    @State private var selected: CatalogItem?

    var body: some View {
        LoadingState(state: state, retry: { Task { await load() } }) { sections in
            List {
                ForEach(sections) { section in
                    Section(section.title) {
                        ForEach(section.items) { item in
                            Button {
                                selected = item
                            } label: {
                                HStack(spacing: Spacing.m) {
                                    InitialBadge(text: item.name)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.name)
                                            .font(BrandFonts.sans(15, weight: .medium))
                                            .foregroundStyle(Theme.textPrimary)
                                        Text(item.installed ? item.statusLabel : item.description)
                                            .font(TypeScale.caption)
                                            .foregroundStyle(item.status == "needs_auth" ? Theme.attention : Theme.textSecondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                    if item.installed {
                                        StatusDot(ok: item.status == "ok", warning: item.status == "needs_auth")
                                    }
                                }
                            }
                        }
                    }
                    .settingsRow()
                }
            }
            .settingsList()
            .refreshable { await load() }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Conectores")
        .searchable(text: $query, prompt: "Buscar conector")
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            await load()
        }
        .sheet(item: $selected) { item in
            ConnectorDetail(item: item) {
                Task { await load() }
            }
            .environment(model)
        }
    }

    private func load() async {
        let client = model.client
        do {
            let path = query.isEmpty ? "/connectors/catalog" : "/connectors/catalog?query=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            async let catalog = client.call(path)
            let installed = (try? await client.connectors()) ?? []
            let counts = Dictionary(installed.compactMap { connector in connector.toolCount.map { (connector.name, $0) } }, uniquingKeysWith: { first, _ in first })
            let json = try await catalog
            var sections: [CatalogSection] = []
            let featured = (json["featured"]?.arrayValue ?? []).compactMap { CatalogItem($0, toolCounts: counts) }
            if !featured.isEmpty {
                sections.append(CatalogSection(id: "featured", title: "Destaque", items: featured))
            }
            for section in json["sections"]?.arrayValue ?? [] {
                let items = (section["items"]?.arrayValue ?? []).compactMap { CatalogItem($0, toolCounts: counts) }
                guard !items.isEmpty else { continue }
                sections.append(CatalogSection(id: section["id"]?.stringValue ?? UUID().uuidString, title: section["title"]?.stringValue ?? "", items: items))
            }
            state = .loaded(sections)
        } catch {
            state = .failed(ErrorMessage.describe(error))
        }
    }
}

struct ConnectorDetail: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthentication
    let item: CatalogItem
    let changed: () -> Void

    @State private var token = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirmsRemove = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: Spacing.s) {
                        HStack(spacing: Spacing.m) {
                            InitialBadge(text: item.name, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name)
                                    .font(BrandFonts.sans(20, weight: .semibold))
                                Text(item.statusLabel)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        if !item.description.isEmpty {
                            Text(item.description)
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .padding(.vertical, Spacing.xs)
                }
                .listRowBackground(Color.clear)
                if !item.installed, item.auth == "api_key" {
                    Section {
                        SecureField("Chave de API", text: $token)
                        if let url = item.tokenURL {
                            Link("Onde criar a chave", destination: url)
                        }
                    }
                    .settingsRow()
                }
                Section {
                    if item.installed {
                        Button("Reconectar") { reconnect() }
                            .disabled(busy)
                        Button("Remover", role: .destructive) { confirmsRemove = true }
                            .disabled(busy)
                    } else {
                        Button("Instalar") { install() }
                            .disabled(busy || (item.auth == "api_key" && token.isEmpty))
                    }
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Theme.danger)
                    } else if item.installed {
                        Text("Remover tira a conexão de todos os bots do time.")
                    }
                }
                .settingsRow()
            }
            .settingsList()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("OK") { dismiss() }
                    }
                }
            }
            .confirmationDialog("Remover \(item.name)?", isPresented: $confirmsRemove, titleVisibility: .visible) {
                Button("Remover", role: .destructive) { remove() }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.background)
    }

    private func install() {
        run {
            let body: JSONValue = token.isEmpty ? .object([:]) : .object(["token": .string(token)])
            let result = try await model.client.call("/connectors/\(BotsClient.escape(path: item.id))/install", method: "POST", body: body)
            if let url = result["authorizationUrl"]?.stringValue.flatMap(URL.init(string:)) {
                await authorize(url)
            }
        }
    }

    private func reconnect() {
        guard let source = item.sourceName else { return }
        run {
            let result = try await model.client.call("/connectors/\(BotsClient.escape(path: source))/reconnect", method: "POST", body: .object([:]))
            if let url = result["authorizationUrl"]?.stringValue.flatMap(URL.init(string:)) {
                await authorize(url)
            }
        }
    }

    private func remove() {
        guard let source = item.sourceName else { return }
        run {
            _ = try await model.client.call("/connectors/\(BotsClient.escape(path: source))", method: "DELETE")
        }
    }

    private func authorize(_ url: URL) async {
        _ = try? await webAuthentication.authenticate(using: url, callback: .customScheme("rbots"), additionalHeaderFields: [:])
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do {
                try await action()
                busy = false
                changed()
                dismiss()
            } catch {
                busy = false
                self.error = ErrorMessage.describe(error)
            }
        }
    }
}

struct RoutinesScreen: View {
    @Environment(AppModel.self) private var model
    @State private var running: Set<String> = []
    @State private var error: String?

    private var rows: [(bot: Bot, schedule: BotSchedule)] {
        model.visibleBots.flatMap { bot in bot.schedules.map { (bot, $0) } }
    }

    var body: some View {
        List {
            if rows.isEmpty {
                ContentUnavailableView("Nenhuma rotina", systemImage: "clock", description: Text("Peça para um bot criar uma rotina na conversa."))
                    .listRowBackground(Color.clear)
            }
            ForEach(rows, id: \.schedule.id) { row in
                HStack(spacing: Spacing.m) {
                    BotAvatar(bot: row.bot, mood: .idle, size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.schedule.name)
                            .font(BrandFonts.sans(15, weight: .medium))
                        Text("\(row.bot.name) · \(CronSchedule.describe(row.schedule.cron))")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    let key = row.bot.id + row.schedule.name
                    Button {
                        run(row.bot, row.schedule.name, key: key)
                    } label: {
                        if running.contains(key) {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Rodar")
                        }
                    }
                    .buttonStyle(SoftButtonStyle())
                    .disabled(running.contains(key))
                }
                .settingsRow()
            }
            if let error {
                Text(error).foregroundStyle(Theme.danger).listRowBackground(Color.clear)
            }
        }
        .settingsList()
        .navigationTitle("Rotinas")
        .refreshable { await model.refresh() }
    }

    private func run(_ bot: Bot, _ name: String, key: String) {
        running.insert(key)
        Task {
            defer { running.remove(key) }
            do {
                _ = try await model.client.runSchedule(botID: bot.id, name: name)
            } catch {
                self.error = ErrorMessage.describe(error)
            }
        }
    }
}

struct UsageScreen: View {
    @Environment(AppModel.self) private var model
    @State private var limits: Loadable<JSONValue> = .loading
    @State private var summary: JSONValue?
    @State private var range = "24h"

    var body: some View {
        LoadingState(state: limits, retry: { Task { await load() } }) { value in
            List {
                Section {
                    Picker("Período", selection: $range) {
                        Text("24 h").tag("24h")
                        Text("7 dias").tag("7d")
                        Text("30 dias").tag("30d")
                    }
                    .pickerStyle(.segmented)
                    if let totals = summary?["totals"] {
                        HStack {
                            metric("Custo", String(format: "US$ %.2f", totals["costUsd"]?.doubleValue ?? 0))
                            metric("Pedidos", "\(totals["requests"]?.intValue ?? 0)")
                            metric("Sessões", "\(totals["sessions"]?.intValue ?? 0)")
                        }
                        .padding(.vertical, Spacing.xs)
                    }
                }
                .settingsRow()
                ForEach(Array((value["accounts"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, account in
                    Section {
                        if let error = account["error"]?.stringValue {
                            Text(error).foregroundStyle(Theme.danger)
                        }
                        ForEach(Array((account["windows"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, window in
                            UsageWindowRow(window: window)
                        }
                    } header: {
                        Text([account["label"]?.stringValue, account["email"]?.stringValue].compactMap { $0 }.joined(separator: " · "))
                    }
                    .settingsRow()
                }
            }
            .settingsList()
            .refreshable { await load() }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Uso e limites")
        .task(id: range) { await load() }
    }

    private func metric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(BrandFonts.sans(18, weight: .semibold))
                .monospacedDigit()
            Text(title)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func load() async {
        let client = model.client
        async let summaryValue = try? client.call("/usage/summary?range=\(range)")
        do {
            limits = .loaded(try await client.call("/usage/limits"))
        } catch {
            limits = .failed(ErrorMessage.describe(error))
        }
        summary = await summaryValue
    }
}

struct UsageWindowRow: View {
    let window: JSONValue

    var body: some View {
        let used = Double(window["usedPercent"]?.intValue ?? 0)
        VStack(alignment: .leading, spacing: Spacing.xs + 2) {
            HStack {
                Text(window["label"]?.stringValue ?? "")
                    .font(BrandFonts.sans(15, weight: .medium))
                Spacer()
                Text("\(Int(used))%")
                    .font(TypeScale.counter)
                    .foregroundStyle(used >= 90 ? Theme.danger : Theme.textSecondary)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.surfaceRaised)
                    Capsule()
                        .fill(used >= 90 ? Theme.danger : (used >= 70 ? Theme.attention : Theme.brandAccent))
                        .frame(width: geometry.size.width * min(used, 100) / 100)
                }
            }
            .frame(height: 6)
            if let resets = RelativeText.date(window["resetsAt"]?.stringValue) {
                Text("Renova \(resets)")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.vertical, Spacing.xs)
    }
}

struct AccountsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            ForEach(model.accounts) { account in
                HStack(spacing: Spacing.m) {
                    InitialBadge(text: account.label)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: Spacing.s) {
                            Text(account.name.isEmpty ? account.label : account.name)
                                .font(BrandFonts.sans(15, weight: .medium))
                            if account.isDefault {
                                Text("Padrão")
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.brandText)
                            }
                        }
                        Text([account.email, account.plan, account.models.isEmpty ? nil : "\(account.models.count) modelos"].compactMap { $0 }.joined(separator: " · "))
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    StatusDot(ok: account.status == "ready", warning: account.status != "ready" && account.status != "error")
                }
                .settingsRow()
            }
        }
        .settingsList()
        .navigationTitle("Contas de IA")
        .task { await model.loadAccounts() }
        .refreshable { await model.loadAccounts() }
    }
}

struct IntegrationsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[JSONValue]> = .loading

    var body: some View {
        LoadingState(state: state, retry: { Task { await load() } }) { items in
            List {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    let connected = item["status"]?.stringValue == "connected"
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        HStack {
                            Text(item["name"]?.stringValue ?? "")
                                .font(BrandFonts.sans(15, weight: .medium))
                            Spacer()
                            StatusDot(ok: connected, warning: !connected)
                            Text(connected ? "Ligada" : "Desligada")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textSecondary)
                        }
                        Text(item["description"]?.stringValue ?? "")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                        if !connected, let fallback = item["fallback"]?.stringValue {
                            Text(fallback)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                        }
                    }
                    .padding(.vertical, Spacing.xs)
                    .settingsRow()
                }
                Section {
                } footer: {
                    Text("As chaves das integrações são configuradas pelo app do Mac.")
                }
            }
            .settingsList()
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Integrações")
        .task { await load() }
    }

    private func load() async {
        do {
            state = .loaded(try await model.client.call("/integrations")["integrations"]?.arrayValue ?? [])
        } catch {
            state = .failed(ErrorMessage.describe(error))
        }
    }
}

struct VaultScreen: View {
    @Environment(AppModel.self) private var model
    @State private var unlocked = false
    @State private var state: Loadable<[JSONValue]> = .loading
    @State private var failure: String?

    var body: some View {
        Group {
            if unlocked {
                LoadingState(state: state, retry: { Task { await load() } }) { secrets in
                    List {
                        if secrets.isEmpty {
                            ContentUnavailableView("Cofre vazio", systemImage: "lock", description: Text("Quando um bot pedir um segredo, ele fica guardado aqui."))
                                .listRowBackground(Color.clear)
                        }
                        ForEach(Array(secrets.enumerated()), id: \.offset) { _, secret in
                            HStack(spacing: Spacing.m) {
                                Image(systemName: "key")
                                    .foregroundStyle(Theme.textSecondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(secret["name"]?.stringValue ?? "")
                                        .font(BrandFonts.mono(14))
                                    Text("••••••••")
                                        .font(TypeScale.caption)
                                        .foregroundStyle(Theme.textTertiary)
                                }
                            }
                            .settingsRow()
                        }
                    }
                    .settingsList()
                }
            } else {
                VStack(spacing: Spacing.l) {
                    Image(systemName: "faceid")
                        .font(.system(size: 44, weight: .light))
                        .foregroundStyle(Theme.textSecondary)
                    Text("O cofre fica fechado até você confirmar que é você.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                    if let failure {
                        Text(failure).font(TypeScale.caption).foregroundStyle(Theme.danger)
                    }
                    Button("Abrir o cofre", action: unlock)
                        .buttonStyle(SoftButtonStyle(prominent: true))
                }
                .padding(Spacing.xxl)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Cofre")
        .onAppear(perform: unlock)
    }

    private func unlock() {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            unlocked = true
            Task { await load() }
            return
        }
        Task {
            do {
                try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Abrir o cofre do r/bots")
                unlocked = true
                await load()
            } catch {
                failure = "Não deu para confirmar."
            }
        }
    }

    private func load() async {
        do {
            state = .loaded(try await model.client.call("/vault/secrets")["secrets"]?.arrayValue ?? [])
        } catch {
            state = .failed(ErrorMessage.describe(error))
        }
    }
}

struct DevicesScreen: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[JSONValue]> = .loading

    var body: some View {
        LoadingState(state: state, retry: { Task { await load() } }) { devices in
            List {
                if devices.isEmpty {
                    ContentUnavailableView("Nenhum dispositivo", systemImage: "desktopcomputer", description: Text("O app do Mac aparece aqui quando se conecta ao servidor."))
                        .listRowBackground(Color.clear)
                }
                ForEach(Array(devices.enumerated()), id: \.offset) { _, device in
                    HStack(spacing: Spacing.m) {
                        Image(systemName: "desktopcomputer")
                            .foregroundStyle(Theme.textSecondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device["name"]?.stringValue ?? "Mac")
                                .font(BrandFonts.sans(15, weight: .medium))
                            Text(RelativeText.date(device["lastSeenAt"]?.stringValue).map { "Visto \($0)" } ?? "")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textSecondary)
                        }
                        Spacer()
                        StatusDot(ok: device["online"]?.boolValue ?? false, warning: true)
                    }
                    .settingsRow()
                }
            }
            .settingsList()
            .refreshable { await load() }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Dispositivos")
        .task { await load() }
    }

    private func load() async {
        do {
            state = .loaded(try await model.client.call("/devices")["devices"]?.arrayValue ?? [])
        } catch {
            state = .failed(ErrorMessage.describe(error))
        }
    }
}

enum ServerEditTarget: Identifiable {
    case new
    case existing(ServerProfile)

    var id: String {
        switch self {
        case .new: "new"
        case .existing(let profile): profile.id
        }
    }
}

struct ServersScreen: View {
    private let session = AuthSession.shared
    @State private var editing: ServerEditTarget?

    var body: some View {
        let book = ServerConfig.book()
        List {
            Section {
                ForEach(book.profiles) { profile in
                    HStack(spacing: Spacing.m) {
                        Button {
                            Task { await session.switchServer(to: profile) }
                        } label: {
                            HStack(spacing: Spacing.m) {
                                ServerBadge(profile: profile, size: 29)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(profile.name)
                                        .foregroundStyle(Theme.textPrimary)
                                    Text(profile.address)
                                        .font(BrandFonts.mono(12))
                                        .foregroundStyle(Theme.textSecondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if profile.id == book.activeID {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Theme.brandText)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Button {
                            editing = .existing(profile)
                        } label: {
                            Image(systemName: "info.circle")
                                .font(.system(size: 18))
                                .foregroundStyle(Theme.brandText)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Editar \(profile.name)")
                    }
                    .swipeActions {
                        if profile.id != book.activeID {
                            Button("Remover", role: .destructive) { session.removeServer(profile) }
                        }
                        Button("Editar") { editing = .existing(profile) }
                    }
                    .contextMenu {
                        Button("Editar", systemImage: "pencil") { editing = .existing(profile) }
                        if profile.id != book.activeID {
                            Button("Remover", systemImage: "trash", role: .destructive) { session.removeServer(profile) }
                        }
                    }
                }
            } footer: {
                Text("Cada servidor guarda o próprio login neste iPhone. Trocar recarrega o app sem misturar bots e conversas.")
            }
            .settingsRow()
            Section {
                Button("Adicionar servidor", systemImage: "plus") { editing = .new }
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Servidores")
        .id(session.serverRevision)
        .sheet(item: $editing) { target in
            ServerProfileSheet(target: target)
        }
    }
}

struct ServerProfileSheet: View {
    @Environment(\.dismiss) private var dismiss
    private let session = AuthSession.shared
    let target: ServerEditTarget

    @State private var name: String
    @State private var address: String
    @State private var color: String
    @State private var symbol: String

    init(target: ServerEditTarget) {
        self.target = target
        switch target {
        case .existing(let profile):
            _name = State(initialValue: profile.name)
            _address = State(initialValue: profile.address)
            _color = State(initialValue: profile.color)
            _symbol = State(initialValue: profile.symbol)
        case .new:
            let style = AuthSession.nextStyle(in: ServerConfig.book())
            _name = State(initialValue: "")
            _address = State(initialValue: "")
            _color = State(initialValue: style.color)
            _symbol = State(initialValue: style.symbol)
        }
    }

    private var parsed: URL? { ServerConfig.parse(AuthSession.normalized(address)) }
    private var placeholder: String { parsed.map(AuthSession.defaultName(for:)) ?? "Local, VPS…" }
    private var preview: ServerProfile {
        ServerProfile(id: target.id, name: name, address: address, color: color, symbol: symbol)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Spacer()
                        ServerBadge(profile: preview, size: 64)
                        Spacer()
                    }
                    .padding(.vertical, Spacing.s)
                }
                .listRowBackground(Color.clear)
                Section("Nome") {
                    TextField(placeholder, text: $name)
                }
                .settingsRow()
                Section("Endereço") {
                    TextField("http://100.64.0.1:2000", text: $address)
                        .font(BrandFonts.mono(15))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .settingsRow()
                Section("Cor") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: Spacing.s) {
                        ForEach(ServerProfile.colors, id: \.self) { option in
                            Button {
                                color = option
                            } label: {
                                Circle()
                                    .fill(Theme.accent(option).gradient)
                                    .frame(width: 28, height: 28)
                                    .padding(3)
                                    .background(color == option ? Theme.surfaceRaised : Color.clear, in: Circle())
                                    .contentShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Theme.accentName(option))
                            .accessibilityAddTraits(color == option ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, Spacing.xs)
                }
                .settingsRow()
                Section("Ícone") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: Spacing.s) {
                        ForEach(ServerProfile.symbols, id: \.self) { option in
                            Button {
                                symbol = option
                            } label: {
                                Image(systemName: option)
                                    .font(.system(size: 16, weight: .medium))
                                    .foregroundStyle(symbol == option ? Theme.textPrimary : Theme.textTertiary)
                                    .frame(width: 34, height: 34)
                                    .background(symbol == option ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(symbol == option ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, Spacing.xs)
                }
                .settingsRow()
            }
            .settingsList()
            .navigationTitle(isNew ? "Novo servidor" : "Editar servidor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(isNew ? "Adicionar" : "Salvar") { save() }
                        .disabled(parsed == nil)
                }
            }
        }
        .presentationBackground(Theme.background)
    }

    private var isNew: Bool {
        if case .new = target { return true }
        return false
    }

    private func save() {
        switch target {
        case .new:
            guard parsed != nil else { return }
            dismiss()
            _ = session.addServer(name: name, address: address, color: color, symbol: symbol)
        case .existing(let original):
            var updated = original
            updated.name = name
            updated.address = address
            updated.color = color
            updated.symbol = symbol
            dismiss()
            Task { _ = await session.updateServer(updated) }
        }
    }
}

struct NotificationsScreen: View {
    @AppStorage(LocalNotifier.enabledKey) private var enabled = true
    @State private var status: UNAuthorizationStatus = .notDetermined

    var body: some View {
        List {
            Section {
                Toggle("Avisar quando um bot terminar ou precisar de você", isOn: $enabled)
            } footer: {
                Text(status == .denied ? "As notificações estão bloqueadas nos Ajustes do iPhone." : "Funciona enquanto o app está aberto ou foi para o fundo há pouco tempo.")
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Notificações")
        .task {
            status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
        .onChange(of: enabled) { _, on in
            if on { Task { await LocalNotifier.requestAuthorization() } }
        }
    }
}
