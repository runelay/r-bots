import SwiftUI

enum SettingsRoute: Hashable {
    case profile(String)
    case addProfile
    case secret(String)
    case newSecret

    @MainActor
    var title: String {
        switch self {
        case .profile(let id): ServerProfiles.shared.profile(id: id)?.name ?? "Servidor"
        case .addProfile: "Adicionar servidor"
        case .secret(let name): name
        case .newSecret: "Novo segredo"
        }
    }
}

@MainActor
@Observable
final class SettingsNavigator {
    var path: [SettingsRoute] = []

    func push(_ route: SettingsRoute) {
        path.append(route)
    }

    func pop() {
        _ = path.popLast()
    }
}

enum SettingsSectionGroup: Int, CaseIterable, Identifiable {
    case account
    case app
    case automation
    case about

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .account: "Conta e servidor"
        case .app: "App"
        case .automation: "Bots e automação"
        case .about: "Sobre"
        }
    }
}

enum SettingsTint {
    static let blue = Color(red: 0.04, green: 0.48, blue: 0.98)
    static let graphite = Color(red: 0.46, green: 0.47, blue: 0.5)
    static let slate = Color(red: 0.2, green: 0.21, blue: 0.24)
    static let red = Color(red: 0.96, green: 0.27, blue: 0.27)
    static let orange = Color(red: 0.98, green: 0.52, blue: 0.13)
    static let purple = Color(red: 0.6, green: 0.36, blue: 0.93)
    static let green = Color(red: 0.2, green: 0.74, blue: 0.4)
    static let teal = Color(red: 0.1, green: 0.68, blue: 0.78)
    static let indigo = Color(red: 0.36, green: 0.38, blue: 0.94)
    static let amber = Color(red: 0.95, green: 0.65, blue: 0.1)
    static let pink = Color(red: 0.93, green: 0.3, blue: 0.55)
}

extension SettingsSection {
    var group: SettingsSectionGroup {
        switch self {
        case .server, .account, .devices, .vault: .account
        case .appearance, .notifications, .shortcuts: .app
        case .bots, .aiAccounts, .computer, .integrations: .automation
        case .versions, .about: .about
        }
    }

    var tileSymbol: String {
        switch self {
        case .server: "server.rack"
        case .account: "person.crop.circle.fill"
        case .appearance: "circle.lefthalf.filled"
        case .notifications: "bell.badge.fill"
        case .bots: "person.2.fill"
        case .aiAccounts: "key.fill"
        case .vault: "lock.shield.fill"
        case .computer: "cursorarrow.rays"
        case .integrations: "puzzlepiece.extension.fill"
        case .shortcuts: "command"
        case .about: "info"
        case .versions: "arrow.down.circle.fill"
        case .devices: "laptopcomputer.and.iphone"
        }
    }

    var tileColor: Color {
        switch self {
        case .server: SettingsTint.blue
        case .account: SettingsTint.graphite
        case .appearance: SettingsTint.slate
        case .notifications: SettingsTint.red
        case .bots: SettingsTint.orange
        case .aiAccounts: SettingsTint.amber
        case .vault: SettingsTint.indigo
        case .computer: SettingsTint.purple
        case .integrations: SettingsTint.green
        case .shortcuts: SettingsTint.graphite
        case .about: SettingsTint.graphite
        case .versions: SettingsTint.blue
        case .devices: SettingsTint.teal
        }
    }

    var keywords: [String] {
        switch self {
        case .server: ["perfil", "endereço", "local", "vps", "conexão", "latência", "motor", "modelo", "padrão"]
        case .account: ["senha", "foto", "sair", "login", "primeiros passos"]
        case .appearance: ["tema", "escuro", "claro", "movimento", "texto", "fonte"]
        case .notifications: ["avisos", "respostas", "aprovações", "rotinas", "erros"]
        case .bots: ["arquivados", "ocultos", "excluídos", "restaurar", "novo bot", "editar"]
        case .aiAccounts: ["contas", "claude", "codex", "grok", "cursor", "modelos", "padrão", "adicionar"]
        case .vault: ["segredos", "senhas", "tokens", "keychain", "touch id"]
        case .computer: ["acessibilidade", "gravação de tela", "automação", "permissões", "executor", "gravações"]
        case .integrations: ["elevenlabs", "jev", "chave", "voz", "runelay"]
        case .shortcuts: ["teclado", "voz", "microfone", "atalho"]
        case .about: ["versão", "app"]
        case .versions: ["atualizar", "atualização", "versão", "cli", "claude code", "codex", "rbots update", "novidades"]
        case .devices: ["mac", "aparelhos", "conectar", "desconectar"]
        }
    }

    var info: String? {
        switch self {
        case .server: "Cada servidor guarda o próprio login neste Mac. Trocar de servidor recarrega o app sem misturar bots, conversas e caches. Atalho: ⌃⌘1 a ⌃⌘9."
        case .computer:
            "Bots com \"Seu Mac\" ligado podem ver a tela, clicar, digitar e mexer nas pastas liberadas. O botão Parar aparece no topo da tela enquanto um bot age. Depois de reinstalar o app, o macOS pode pedir as permissões de novo."
        case .aiAccounts: "As contas de IA logadas no servidor. Cada bot escolhe uma conta e um modelo; se ela acabar ou cair, o pedido segue na outra conta do mesmo provedor."
        case .vault: "Os valores ficam no Keychain deste Mac e nunca aparecem sem Touch ID. Abrir o cofre pede confirmação e ele tranca de novo em 5 minutos ou quando o app sai da frente."
        case .integrations: "Serviços opcionais. Os bots funcionam sem eles; cada chave liga uma parte a mais. A chave fica cifrada no servidor e nunca volta para o app."
        case .notifications: "O número no ícone do Dock mostra o total de mensagens não lidas."
        case .versions: "O r/bots atualiza com um comando no servidor. Os CLIs dos bots atualizam por aqui, sem reiniciar nada: o próximo pedido já usa a versão nova."
        default: nil
        }
    }

    func matches(_ query: String) -> String? {
        let needle = query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        guard !needle.isEmpty else { return nil }
        func folded(_ text: String) -> String {
            text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        }
        if folded(title).contains(needle) { return "" }
        return keywords.first { folded($0).contains(needle) }
    }
}

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var navigator = SettingsNavigator()
    @State private var query = ""

    private var isOwner: Bool {
        AuthSession.shared.user?.isOwner == true
    }

    private var visibleSections: [(SettingsSectionGroup, [(SettingsSection, String?)])] {
        SettingsSectionGroup.allCases.compactMap { group in
            let items: [(SettingsSection, String?)] = SettingsSection.allCases
                .filter { $0.group == group && ($0 != .versions || isOwner) }
                .compactMap { section in
                    if query.isEmpty { return (section, nil) }
                    guard let hit = section.matches(query) else { return nil }
                    return (section, hit.isEmpty ? nil : hit)
                }
            return items.isEmpty ? nil : (group, items)
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 232)
                .frame(maxHeight: .infinity)
                .background(Theme.sidebarBackground)

            VStack(spacing: 0) {
                header
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.l) {
                        titleLine
                        content
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Metrics.settingsGutter)
                    .padding(.bottom, Spacing.xxl)
                    .id(contentID)
                    .transition(.opacity)
                }
                .scrollEdgesHidden()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
        }
        .environment(navigator)
        .background {
            Button("Fechar") {
                if navigator.path.isEmpty {
                    model.closeSettings()
                } else {
                    navigator.pop()
                }
            }
            .keyboardShortcut(.cancelAction)
            .opacity(0)
            .accessibilityHidden(true)
        }
        .springAnimation(value: contentID)
        .onChange(of: model.settingsSection) {
            navigator.path = []
        }
    }

    private var contentID: String {
        "\(model.settingsSection.rawValue)|\(navigator.path.last.map { "\($0)" } ?? "")"
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSearchField(text: $query)
                .padding(.horizontal, Spacing.m)
                .padding(.top, Spacing.xl + Spacing.s)
                .padding(.bottom, Spacing.m)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.m) {
                    ForEach(visibleSections, id: \.0) { group, items in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(group.title)
                                .font(BrandFonts.sans(11, weight: .semibold))
                                .foregroundStyle(Theme.textTertiary)
                                .padding(.horizontal, Spacing.s + 2)
                                .padding(.bottom, Spacing.xxs)
                            ForEach(items, id: \.0) { section, hit in
                                SettingsNavRow(section: section, hit: hit, isSelected: model.settingsSection == section) {
                                    select(section)
                                }
                            }
                        }
                    }
                    if visibleSections.isEmpty {
                        Text("Nada encontrado")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .padding(.horizontal, Spacing.s + 2)
                    }
                }
                .padding(.horizontal, Spacing.s)
                .padding(.bottom, Spacing.l)
            }
            .scrollEdgesHidden()
        }
    }

    private func select(_ section: SettingsSection) {
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            model.settingsSection = section
            navigator.path = []
        }
        if section == .bots {
            Task {
                await model.loadArchived()
                await model.loadExtraBots()
            }
        }
        if section == .aiAccounts {
            Task { await model.loadAccounts() }
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            if !navigator.path.isEmpty {
                Button {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        navigator.pop()
                    }
                } label: {
                    HStack(spacing: Spacing.xs) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 12, weight: .semibold))
                        Text(navigator.path.count > 1 ? navigator.path[navigator.path.count - 2].title : model.settingsSection.title)
                            .font(TypeScale.captionStrong)
                    }
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, Spacing.s)
                    .frame(height: 26)
                    .background(Theme.surface, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle())
                .clickable()
                .help("Voltar (Esc)")
                .transition(.opacity)
            }
            Spacer(minLength: 0)
            RoundIconButton(systemImage: "xmark", help: "Fechar ajustes", size: 28) {
                model.closeSettings()
            }
        }
        .padding(.horizontal, Spacing.l)
        .padding(.top, Spacing.m)
        .frame(height: 48)
    }

    private var titleLine: some View {
        HStack(spacing: Spacing.s) {
            if navigator.path.isEmpty {
                SettingsTile(symbol: model.settingsSection.tileSymbol, color: model.settingsSection.tileColor, size: 26)
            }
            Text(navigator.path.last?.title ?? model.settingsSection.title)
                .font(BrandFonts.sans(20, weight: .semibold))
                .tracking(-0.3)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            if navigator.path.isEmpty, let info = model.settingsSection.info {
                SettingsInfoButton(text: info)
            }
            Spacer(minLength: 0)
            if navigator.path.isEmpty, model.settingsSection == .bots {
                Button {
                    model.openEditor(for: nil)
                } label: {
                    Label("Novo bot", systemImage: "plus")
                }
                .buttonStyle(SettingsButtonStyle(kind: .primary))
            }
            if navigator.path.isEmpty, model.settingsSection == .aiAccounts {
                Button {
                    model.refreshAccounts()
                } label: {
                    Label("Procurar de novo", systemImage: "arrow.clockwise")
                }
                .buttonStyle(SettingsButtonStyle(kind: .plain))
                .disabled(model.isRefreshingAccounts)
                .clickable()
            }
        }
        .padding(.bottom, Spacing.xs)
    }

    @ViewBuilder
    private var content: some View {
        if let route = navigator.path.last {
            switch route {
            case .profile(let id): ServerProfileEditor(profileID: id)
            case .addProfile: ServerProfileEditor(profileID: nil)
            case .secret(let name): VaultSecretPage(name: name)
            case .newSecret: VaultSecretPage(name: nil)
            }
        } else {
            switch model.settingsSection {
            case .server: ServerSettings()
            case .account: AccountSettings()
            case .appearance: AppearanceSettings()
            case .notifications: NotificationSettings()
            case .bots: BotsSettings()
            case .aiAccounts: AIAccountsSettings()
            case .vault: VaultSettings()
            case .computer: ComputerSettings()
            case .devices: DevicesSettings()
            case .integrations: IntegrationsSettings()
            case .shortcuts: ShortcutsSettings()
            case .versions:
                if isOwner {
                    VersionsSettings()
                } else {
                    EmptyStateView(systemImage: "lock", title: "Só para a dona da conta", description: "Quem cuida do servidor vê e atualiza as versões por aqui.")
                }
            case .about: AboutSettings()
            }
        }
    }
}

struct SettingsSearchField: View {
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Spacing.xs + 2) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
            TextField("Buscar", text: $text)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .focused($focused)
                .onKeyPress(.escape) {
                    guard !text.isEmpty else { return .ignored }
                    text = ""
                    return .handled
                }
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textTertiary)
                }
                .buttonStyle(PressableButtonStyle())
                .clickable()
                .help("Limpar busca")
            }
        }
        .padding(.horizontal, Spacing.s + 2)
        .frame(height: 28)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
    }
}

struct SettingsTile: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.52, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.gradient, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
            .shadow(color: Theme.elevationShadow, radius: 1, y: 0.5)
            .accessibilityHidden(true)
    }
}

struct SettingsNavRow: View {
    let section: SettingsSection
    var hit: String?
    let isSelected: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(spacing: Spacing.s + 1) {
                SettingsTile(symbol: section.tileSymbol, color: section.tileColor)
                VStack(alignment: .leading, spacing: 0) {
                    Text(section.title)
                        .font(BrandFonts.sans(13, weight: isSelected ? .semibold : .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if let hit {
                        Text(hit.prefix(1).uppercased() + hit.dropFirst())
                            .font(BrandFonts.sans(11))
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s - 2)
            .frame(height: hit == nil ? 30 : 38)
            .background(isSelected ? Theme.selection : (isHovering ? Theme.hover : Color.clear), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct SettingsGroup<Content: View>: View {
    var caption: String?
    var trailing: AnyView?
    @ViewBuilder let content: Content

    init(caption: String? = nil, @ViewBuilder content: () -> Content) {
        self.caption = caption
        self.trailing = nil
        self.content = content()
    }

    init<Trailing: View>(caption: String?, @ViewBuilder trailing: () -> Trailing, @ViewBuilder content: () -> Content) {
        self.caption = caption
        self.trailing = AnyView(trailing())
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs + 2) {
            if caption != nil || trailing != nil {
                HStack(spacing: Spacing.s) {
                    if let caption {
                        Text(caption)
                            .font(BrandFonts.sans(12, weight: .semibold))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Spacer(minLength: 0)
                    trailing
                }
                .padding(.horizontal, Spacing.xs)
                .frame(minHeight: 20)
            }
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .padding(.vertical, Spacing.xxs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .shadow(color: Theme.elevationShadow, radius: 2, y: 1)
        }
    }
}

struct SettingsIcon: Equatable {
    let symbol: String
    let color: Color

    init(_ symbol: String, _ color: Color) {
        self.symbol = symbol
        self.color = color
    }
}

struct SettingsRow<Trailing: View>: View {
    let title: String
    var icon: SettingsIcon?
    var detail: String?
    var info: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: Spacing.s + 2) {
            if let icon {
                SettingsTile(symbol: icon.symbol, color: icon.color)
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: Spacing.xs) {
                    Text(title)
                        .font(BrandFonts.sans(13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if let info {
                        SettingsInfoButton(text: info)
                    }
                }
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(BrandFonts.sans(11.5))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Spacing.m)
            trailing
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.xs + 2)
        .frame(minHeight: 40)
    }
}

struct SettingsLinkRow<Trailing: View>: View {
    let title: String
    var icon: SettingsIcon?
    var detail: String?
    let action: () -> Void
    @ViewBuilder var trailing: Trailing

    @State private var isHovering = false

    var body: some View {
        SettingsRow(title: title, icon: icon, detail: detail) {
            HStack(spacing: Spacing.s) {
                trailing
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .background(isHovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.horizontal, Spacing.xxs)
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .onHover { isHovering = $0 }
        .clickable()
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { action() }
    }
}

extension SettingsLinkRow where Trailing == EmptyView {
    init(title: String, icon: SettingsIcon? = nil, detail: String? = nil, action: @escaping () -> Void) {
        self.init(title: title, icon: icon, detail: detail, action: action) { EmptyView() }
    }
}

struct SettingsInfoButton: View {
    let text: String
    @State private var shown = false

    var body: some View {
        Button {
            shown.toggle()
        } label: {
            Image(systemName: "info.circle")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .help(text)
        .popover(isPresented: $shown, arrowEdge: .bottom) {
            Text(text)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 260, alignment: .leading)
                .padding(Spacing.m)
        }
    }
}

struct SettingsPill: View {
    let text: String
    let color: Color
    var pulsing = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .symbolEffect(.pulse, options: .repeating, isActive: pulsing)
            Text(text)
                .font(BrandFonts.sans(11, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 20)
        .background(color.opacity(0.12), in: Capsule())
        .contentTransition(.opacity)
    }
}

struct SettingsValue: View {
    let text: String

    var body: some View {
        Text(text)
            .font(BrandFonts.sans(12.5))
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(1)
            .contentTransition(.numericText())
    }
}

struct SettingsButtonStyle: ButtonStyle {
    enum Kind {
        case plain
        case primary
        case destructive
    }

    let kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        SettingsButtonBody(kind: kind, configuration: configuration)
    }
}

private struct SettingsButtonBody: View {
    let kind: SettingsButtonStyle.Kind
    let configuration: ButtonStyleConfiguration
    @State private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .labelStyle(SettingsButtonLabelStyle())
            .font(BrandFonts.sans(12, weight: .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, Spacing.s + 2)
            .frame(height: 24)
            .background(background, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .contentShape(Capsule())
            .onHover { isHovering = $0 }
            .clickable()
            .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private var foreground: Color {
        switch kind {
        case .plain: Theme.textPrimary
        case .primary: Theme.onAccent
        case .destructive: Theme.danger
        }
    }

    private var background: Color {
        switch kind {
        case .plain: isHovering ? Theme.selection : Theme.surfaceRaised
        case .primary: isHovering ? Theme.brandAccent.opacity(0.88) : Theme.brandAccent
        case .destructive: Theme.danger.opacity(isHovering ? 0.16 : 0.1)
        }
    }
}

private struct SettingsButtonLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
                .font(.system(size: 10, weight: .semibold))
            configuration.title
        }
    }
}

struct ChoicePills<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let title: (Option) -> String

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            ForEach(options) { option in
                let isSelected = option == selection
                Button {
                    selection = option
                } label: {
                    Text(title(option))
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .padding(.horizontal, Spacing.m)
                        .frame(height: 28)
                        .background(isSelected ? Theme.surfaceRaised : Theme.surface, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .clickable()
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .springAnimation(value: selection)
    }
}

struct SettingsSegmented<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let title: (Option) -> String

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let isSelected = option == selection
                Button {
                    selection = option
                } label: {
                    Text(title(option))
                        .font(BrandFonts.sans(11.5, weight: .medium))
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .padding(.horizontal, Spacing.s + 2)
                        .frame(height: 22)
                        .background(isSelected ? Theme.background : Color.clear, in: Capsule())
                        .shadow(color: isSelected ? Theme.elevationShadow : .clear, radius: 1.5, y: 0.5)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .clickable()
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Theme.surfaceRaised, in: Capsule())
        .springAnimation(value: selection)
    }
}

struct SettingsToggle: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(title, isOn: $isOn)
            .toggleStyle(.switch)
            .controlSize(.small)
            .labelsHidden()
            .tint(Theme.brandAccent)
            .clickable()
    }
}

struct AppearanceSettings: View {
    @AppStorage(PreferenceKeys.appearance) private var appearance = AppearancePreference.system.rawValue
    @AppStorage(PreferenceKeys.motion) private var motion = MotionPreference.system.rawValue
    @AppStorage(PreferenceKeys.textSize) private var textSize = ConversationTextSize.regular.rawValue

    var body: some View {
        SettingsGroup {
            SettingsRow(title: "Tema", icon: SettingsIcon("circle.lefthalf.filled", SettingsTint.slate)) {
                SettingsSegmented(
                    options: AppearancePreference.allCases,
                    selection: Binding(
                        get: { AppearancePreference(rawValue: appearance) ?? .system },
                        set: { appearance = $0.rawValue }
                    ),
                    title: \.title
                )
            }
            SettingsRow(title: "Reduzir movimento", icon: SettingsIcon("wind", SettingsTint.teal), info: "Troca molas e ondas por transições curtas.") {
                SettingsSegmented(
                    options: MotionPreference.allCases,
                    selection: Binding(
                        get: { MotionPreference(rawValue: motion) ?? .system },
                        set: { motion = $0.rawValue }
                    ),
                    title: \.title
                )
            }
            SettingsRow(title: "Texto da conversa", icon: SettingsIcon("textformat.size", SettingsTint.indigo)) {
                SettingsSegmented(
                    options: ConversationTextSize.allCases,
                    selection: Binding(
                        get: { ConversationTextSize(rawValue: textSize) ?? .regular },
                        set: { textSize = $0.rawValue }
                    ),
                    title: \.title
                )
            }
        }
    }
}

struct ShortcutsSettings: View {
    private let shortcuts: [(String, String, String)] = [
        ("Escrever mensagem", "square.and.pencil", "⌘N"),
        ("Enviar mensagem", "paperplane.fill", "⌘↩"),
        ("Limpar o campo de mensagem", "delete.left.fill", "Esc"),
        ("Novo bot", "plus", "⇧⌘N"),
        ("Mostrar ou ocultar o painel", "sidebar.right", "⌥⌘I"),
        ("Trocar de servidor", "server.rack", "⌃⌘1…9"),
        ("Ajustes", "gearshape.fill", "⌘,"),
        ("Fechar janela aberta por cima", "xmark", "Esc"),
        ("Falar com o bot (segure)", "mic.fill", "⌥Espaço"),
    ]
    @AppStorage(VoicePreferenceKeys.autoSend) private var voiceAutoSend = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            SettingsGroup(caption: "Voz") {
                SettingsRow(title: "Enviar ao terminar de falar", icon: SettingsIcon("waveform", SettingsTint.red), info: "Manda a mensagem sozinha depois de 1,2 s de silêncio.") {
                    SettingsToggle(title: "Enviar ao terminar de falar", isOn: $voiceAutoSend)
                }
                MicrophoneSettingRow {
                    VoiceCall.shared.microphoneChanged()
                }
            }
            SettingsGroup(caption: "Teclado") {
                ForEach(shortcuts, id: \.0) { shortcut in
                    SettingsRow(title: shortcut.0, icon: SettingsIcon(shortcut.1, SettingsTint.graphite)) {
                        Text(shortcut.2)
                            .font(TypeScale.counter)
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, Spacing.s)
                            .frame(height: 22)
                            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
            }
        }
    }
}

struct AboutSettings: View {
    @Environment(AppModel.self) private var model
    private let profiles = ServerProfiles.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            HStack(alignment: .center, spacing: Spacing.s + 2) {
                RunelayAppMark(size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    RunelayWordmark(text: "r/bots", height: 20)
                    Text("Versão \(AppInfo.version)")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            SettingsGroup {
                SettingsRow(title: "App para Mac", icon: SettingsIcon("macwindow", SettingsTint.graphite)) {
                    SettingsValue(text: AppInfo.version)
                }
                if let version = model.meta.version {
                    SettingsRow(title: "Servidor", icon: SettingsIcon("server.rack", SettingsTint.blue)) {
                        SettingsValue(text: version)
                    }
                }
                SettingsRow(title: profiles.active.name, icon: SettingsIcon(profiles.active.symbol, Theme.accent(profiles.active.color)), detail: ServerConfig.currentURL().absoluteString) {
                    Link(destination: ServerConfig.currentURL()) {
                        Label("Abrir", systemImage: "arrow.up.right")
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .plain))
                }
            }
        }
    }
}

struct ConnectionStatusLine: View {
    let status: ConnectionStatus

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "circle.fill")
                .font(.system(size: 8))
                .foregroundStyle(Theme.connection(status))
                .symbolEffect(.pulse, options: .repeating, isActive: status == .checking)
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
        }
        .springAnimation(value: status)
    }

    private var label: String {
        switch status {
        case .unknown: "Ainda não testado"
        case .checking: "Conectando…"
        case .online(let count): count == 1 ? "Conectado, 1 bot" : "Conectado, \(count) bots"
        case .offline(let message): "Sem conexão. \(message)"
        }
    }
}

struct NotificationSettings: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            if !Notifier.shared.isAvailable {
                SettingsGroup {
                    SettingsRow(
                        title: "Só no app instalado", icon: SettingsIcon("exclamationmark.triangle.fill", SettingsTint.amber), detail: "As notificações funcionam no r/bots instalado em Aplicativos."
                    ) {
                        EmptyView()
                    }
                }
            }
            SettingsGroup(caption: "Avisar quando") {
                ForEach(NotificationPreference.allCases) { preference in
                    NotificationToggleRow(preference: preference)
                }
            }
        }
    }
}

struct NotificationToggleRow: View {
    let preference: NotificationPreference
    @AppStorage private var isOn: Bool

    init(preference: NotificationPreference) {
        self.preference = preference
        _isOn = AppStorage(wrappedValue: true, preference.key)
    }

    private var icon: SettingsIcon {
        switch preference {
        case .replies: SettingsIcon("bubble.left.fill", SettingsTint.blue)
        case .approvals: SettingsIcon("checkmark.shield.fill", SettingsTint.orange)
        case .routines: SettingsIcon("clock.fill", SettingsTint.purple)
        case .failures: SettingsIcon("exclamationmark.octagon.fill", SettingsTint.red)
        }
    }

    var body: some View {
        SettingsRow(title: preference.title, icon: icon, info: preference.detail) {
            SettingsToggle(title: preference.title, isOn: $isOn)
        }
        .onChange(of: isOn) { _, value in
            guard PreferencesSync.applying == false else { return }
            PreferencesSync.push(.object(["notifications": .object([preference.rawValue: .bool(value)])]))
        }
    }
}

struct MacLinkStatus: View {
    let state: RunnerLinkState

    var body: some View {
        SettingsPill(text: label, color: color, pulsing: state == .connecting)
            .help(help)
            .springAnimation(value: state)
    }

    private var label: String {
        switch state {
        case .connecting: "Conectando"
        case .connected: "Conectado"
        case .offline: "Desconectado"
        }
    }

    private var help: String {
        switch state {
        case .connecting: "Conectando o Mac ao servidor…"
        case .connected: "Mac conectado ao servidor"
        case .offline(let message): message
        }
    }

    private var color: Color {
        switch state {
        case .connecting: Theme.textTertiary
        case .connected: Theme.success
        case .offline: Theme.warning
        }
    }
}

struct PageContainer<Content: View>: View {
    var maxWidth: CGFloat = Metrics.pageWidth
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: maxWidth, alignment: .leading)
            .padding(.horizontal, Spacing.xxl + Spacing.xs)
            .frame(maxWidth: .infinity, alignment: .center)
    }
}
