import SwiftUI

extension ServerProfileStatus {
    var color: Color {
        switch self {
        case .checking: Theme.textTertiary
        case .connected: Theme.success
        case .signedOut, .needsOwner: Theme.warning
        case .offline: Theme.danger
        }
    }
}

extension ServerProfile {
    var host: String {
        guard let url else { return address }
        let port = url.port.map { ":\($0)" } ?? ""
        return (url.host() ?? address) + port
    }

    var tile: SettingsIcon {
        SettingsIcon(symbol, Theme.accent(color))
    }
}

struct ServerSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigator.self) private var navigator
    private let profiles = ServerProfiles.shared
    @State private var testing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            SettingsGroup(caption: "Perfis") {
                ForEach(profiles.profiles) { profile in
                    ServerProfileRow(profile: profile)
                }
                SettingsLinkRow(title: "Adicionar servidor…", icon: SettingsIcon("plus", SettingsTint.green)) {
                    navigator.push(.addProfile)
                }
            }
            .springAnimation(value: profiles.profiles)

            SettingsGroup(caption: "Conexão de \(profiles.active.name)") {
                Button {
                    test()
                } label: {
                    HStack(spacing: 4) {
                        if testing {
                            ProgressView()
                                .controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                        Text("Testar")
                    }
                }
                .buttonStyle(SettingsButtonStyle(kind: .plain))
                .disabled(testing)
            } content: {
                SettingsRow(title: "Servidor", icon: SettingsIcon("dot.radiowaves.left.and.right", SettingsTint.green)) {
                    ConnectionPill(status: model.connection)
                }
                SettingsRow(title: "Este Mac", icon: SettingsIcon("laptopcomputer", SettingsTint.graphite)) {
                    MacLinkStatus(state: RunnerConnection.shared.state)
                }
                SettingsRow(title: "Motor", icon: SettingsIcon("cpu", SettingsTint.purple)) {
                    SettingsValue(text: model.meta.engineLabel ?? placeholder)
                }
                SettingsRow(title: "Modelo padrão", icon: SettingsIcon("sparkles", SettingsTint.orange)) {
                    SettingsValue(text: model.meta.model.map(ModelNames.pretty) ?? placeholder)
                }
                SettingsRow(title: "Latência", icon: SettingsIcon("speedometer", SettingsTint.teal), info: "Tempo da última leitura da lista de bots.") {
                    SettingsValue(text: model.lastLatencyMs.map { "\($0) ms" } ?? "–")
                }
            }
        }
        .task {
            profiles.reload()
            profiles.refreshStatuses()
            if !model.metaLoaded {
                await model.refreshMeta()
            }
        }
    }

    private var placeholder: String {
        switch model.connection {
        case .offline: "Sem conexão"
        case .checking, .unknown: "Carregando…"
        case .online: model.metaLoaded ? "Não informado" : "Carregando…"
        }
    }

    private func test() {
        testing = true
        Task {
            await model.checkConnection()
            profiles.refreshStatuses()
            testing = false
        }
    }
}

private struct ConnectionPill: View {
    let status: ConnectionStatus

    var body: some View {
        SettingsPill(text: label, color: Theme.connection(status), pulsing: status == .checking)
            .help(help)
    }

    private var label: String {
        switch status {
        case .unknown: "Não testado"
        case .checking: "Conectando"
        case .online(let count): count == 1 ? "Conectado · 1 bot" : "Conectado · \(count) bots"
        case .offline: "Sem conexão"
        }
    }

    private var help: String {
        if case .offline(let message) = status { return message }
        return label
    }
}

struct ServerProfileRow: View {
    let profile: ServerProfile
    @Environment(SettingsNavigator.self) private var navigator
    private let profiles = ServerProfiles.shared
    @State private var isHovering = false

    private var isActive: Bool { profiles.active.id == profile.id }
    private var isDefault: Bool { profiles.book.defaultID == profile.id }

    var body: some View {
        HStack(spacing: Spacing.s + 2) {
            SettingsTile(symbol: profile.symbol, color: Theme.accent(profile.color))
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: Spacing.xs + 2) {
                    Text(profile.name)
                        .font(BrandFonts.sans(13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if isDefault {
                        Text("Padrão")
                            .font(BrandFonts.sans(10, weight: .semibold))
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, 5)
                            .frame(height: 15)
                            .background(Theme.surfaceRaised, in: Capsule())
                    }
                }
                Text(profile.host)
                    .font(BrandFonts.mono(11))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: Spacing.m)
            let status = profiles.status(of: profile)
            SettingsPill(text: status.label, color: status.color, pulsing: status == .checking)
            if isActive {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
                    .frame(width: 44)
                    .help("Em uso")
            } else {
                Button("Usar") {
                    profiles.activate(profile.id)
                }
                .buttonStyle(SettingsButtonStyle(kind: .plain))
                .frame(width: 44)
                .help("Trocar para \(profile.name)")
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
        }
        .padding(.horizontal, Spacing.m - Spacing.xxs)
        .padding(.vertical, Spacing.xs + 1)
        .frame(minHeight: 44)
        .background(isHovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.horizontal, Spacing.xxs)
        .contentShape(Rectangle())
        .onTapGesture { navigator.push(.profile(profile.id)) }
        .onHover { isHovering = $0 }
        .clickable()
        .contextMenu {
            if !isActive {
                Button("Usar agora", systemImage: "arrow.right.circle") { profiles.activate(profile.id) }
            }
            if !isDefault {
                Button("Abrir com este servidor", systemImage: "star") { profiles.setDefault(profile.id) }
            }
            Button("Editar", systemImage: "pencil") { navigator.push(.profile(profile.id)) }
            if profiles.profiles.count > 1 {
                Divider()
                Button("Remover", systemImage: "trash", role: .destructive) { profiles.remove(profile.id) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

private enum ServerCheck: Equatable {
    case idle
    case testing
    case ok(Int)
    case failed(String)
}

struct ServerProfileEditor: View {
    let profileID: String?
    @Environment(SettingsNavigator.self) private var navigator
    private let profiles = ServerProfiles.shared

    @State private var name = ""
    @State private var address = ""
    @State private var color = "blue"
    @State private var symbol = "server.rack"
    @State private var check: ServerCheck = .idle
    @State private var loaded = false
    @State private var confirmRemove = false

    private var original: ServerProfile? {
        profileID.flatMap { profiles.profile(id: $0) }
    }

    private var isNew: Bool { profileID == nil }
    private var isActive: Bool { profileID == profiles.active.id }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedAddress: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var addressValid: Bool { ServerConfig.parse(trimmedAddress) != nil }
    private var canSave: Bool { !trimmedName.isEmpty && addressValid }

    private var dirty: Bool {
        guard let original else { return true }
        return original.name != trimmedName || original.address != trimmedAddress || original.color != color || original.symbol != symbol
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            SettingsGroup {
                SettingsRow(title: "Nome", icon: SettingsIcon(symbol, Theme.accent(color))) {
                    field("Local, VPS…", text: $name)
                }
                SettingsRow(title: "Endereço", icon: SettingsIcon("link", SettingsTint.blue)) {
                    field(ServerConfig.defaultURL, text: $address, mono: true)
                        .onChange(of: address) { check = .idle }
                }
                SettingsRow(title: "Cor", icon: SettingsIcon("paintpalette.fill", SettingsTint.pink)) {
                    HStack(spacing: 6) {
                        ForEach(ServerProfile.colors, id: \.self) { option in
                            Button {
                                color = option
                            } label: {
                                Circle()
                                    .fill(Theme.accent(option).gradient)
                                    .frame(width: 16, height: 16)
                                    .padding(2)
                                    .overlay {
                                        Circle()
                                            .strokeBorder(color == option ? Theme.textSecondary : Color.clear, lineWidth: 1.5)
                                    }
                                    .contentShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .clickable()
                            .help(Theme.accentName(option))
                        }
                    }
                }
                SettingsRow(title: "Ícone", icon: SettingsIcon("square.grid.2x2.fill", SettingsTint.indigo)) {
                    HStack(spacing: 4) {
                        ForEach(ServerProfile.symbols, id: \.self) { option in
                            Button {
                                symbol = option
                            } label: {
                                Image(systemName: option)
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(symbol == option ? Theme.textPrimary : Theme.textTertiary)
                                    .frame(width: 22, height: 22)
                                    .background(symbol == option ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .clickable()
                        }
                    }
                }
            }

            SettingsGroup {
                SettingsRow(title: "Conexão", icon: SettingsIcon("dot.radiowaves.left.and.right", SettingsTint.green), detail: checkDetail) {
                    HStack(spacing: Spacing.s) {
                        if let pill = statusPill {
                            pill
                        }
                        Button {
                            test()
                        } label: {
                            HStack(spacing: 4) {
                                if check == .testing {
                                    ProgressView()
                                        .controlSize(.mini)
                                }
                                Text("Testar")
                            }
                        }
                        .buttonStyle(SettingsButtonStyle(kind: .plain))
                        .disabled(!addressValid || check == .testing)
                    }
                }
                if let original {
                    SettingsRow(title: "Abrir com este servidor", icon: SettingsIcon("star.fill", SettingsTint.amber), info: "O app abre neste servidor quando você inicia.") {
                        SettingsToggle(
                            title: "Abrir com este servidor",
                            isOn: Binding(
                                get: { profiles.book.defaultID == original.id },
                                set: { if $0 { profiles.setDefault(original.id) } }
                            )
                        )
                        .disabled(profiles.book.defaultID == original.id)
                    }
                }
            }

            HStack(spacing: Spacing.s) {
                if let original, profiles.profiles.count > 1 {
                    Button(role: .destructive) {
                        confirmRemove = true
                    } label: {
                        Label("Remover", systemImage: "trash")
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .destructive))
                    .confirmationDialog("Remover \(original.name)?", isPresented: $confirmRemove) {
                        Button("Remover", role: .destructive) {
                            navigator.pop()
                            profiles.remove(original.id)
                        }
                        Button("Cancelar", role: .cancel) {}
                    } message: {
                        Text("O login deste servidor sai deste Mac. Os bots e conversas continuam no servidor.")
                    }
                }
                Spacer(minLength: 0)
                if isNew {
                    Button("Só adicionar") {
                        save(activate: false)
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .plain))
                    .disabled(!canSave)
                    Button {
                        save(activate: true)
                    } label: {
                        Label("Adicionar e entrar", systemImage: "arrow.right")
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .primary))
                    .disabled(!canSave)
                } else if dirty {
                    Button("Salvar") {
                        save(activate: false)
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .primary))
                    .disabled(!canSave)
                } else if !isActive, let original {
                    Button {
                        profiles.activate(original.id)
                    } label: {
                        Label("Usar este servidor", systemImage: "arrow.right")
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .primary))
                }
            }
            .springAnimation(value: dirty)
        }
        .onAppear(perform: load)
    }

    private var statusPill: SettingsPill? {
        switch check {
        case .ok(let ms): return SettingsPill(text: "Respondeu em \(ms) ms", color: Theme.success)
        case .failed: return SettingsPill(text: "Não respondeu", color: Theme.danger)
        case .testing: return nil
        case .idle:
            guard let original, !dirty else { return nil }
            let status = profiles.status(of: original)
            return SettingsPill(text: status.label, color: status.color, pulsing: status == .checking)
        }
    }

    private var checkDetail: String? {
        if case .failed(let message) = check { return message }
        if !trimmedAddress.isEmpty, !addressValid { return ServerTestFailure.invalid.message }
        if isNew { return "Depois de adicionar, entre ou crie a conta dona." }
        return nil
    }

    private func field(_ prompt: String, text: Binding<String>, mono: Bool = false) -> some View {
        TextField("", text: text, prompt: Text(prompt))
            .textFieldStyle(.plain)
            .font(mono ? BrandFonts.mono(12) : BrandFonts.sans(13))
            .multilineTextAlignment(.trailing)
            .autocorrectionDisabled()
            .padding(.horizontal, Spacing.s)
            .frame(width: 280, height: 26)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .onSubmit {
                if canSave, isNew || dirty {
                    save(activate: isNew)
                }
            }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        if let original {
            name = original.name
            address = original.address
            color = original.color
            symbol = original.symbol
        } else {
            let used = Set(profiles.profiles.map(\.color))
            color = ServerProfile.colors.first { !used.contains($0) } ?? "blue"
            symbol = profiles.profiles.isEmpty ? "server.rack" : "cloud"
            address = ""
        }
    }

    private func test() {
        check = .testing
        let target = trimmedAddress
        Task {
            switch await ServerProfiles.test(address: target) {
            case .success(let ms): check = .ok(ms)
            case .failure(let failure): check = .failed(failure.message)
            }
        }
    }

    private func save(activate: Bool) {
        guard canSave else { return }
        if var updated = original {
            updated.name = trimmedName
            updated.address = trimmedAddress
            updated.color = color
            updated.symbol = symbol
            profiles.update(updated)
            return
        }
        let created = profiles.add(name: trimmedName, address: trimmedAddress, color: color, symbol: symbol)
        navigator.pop()
        if activate {
            profiles.activate(created.id)
        }
    }
}
