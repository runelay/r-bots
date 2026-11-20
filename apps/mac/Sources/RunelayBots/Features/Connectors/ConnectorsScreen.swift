import AppKit
import Combine
import SwiftUI

struct ConnectorsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                ConnectorsCatalog(onRunelayOff: model.openIntegrations) { actions in
                    PageHeaderView(
                        title: "Catálogo",
                        description: "Conecte suas contas uma vez. Todos os agentes da organização usam.",
                        signed: true
                    ) {
                        actions
                    }
                }
            }
            .frame(maxWidth: 880, alignment: .leading)
            .padding(.horizontal, Spacing.xxl)
            .padding(.top, Spacing.xl + 4)
            .padding(.bottom, Spacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgesHidden()
        .background(Theme.background)
    }
}

struct ConnectorsCatalog<Header: View>: View {
    let onRunelayOff: () -> Void
    @ViewBuilder let header: (AnyView) -> Header

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        let store = model.catalog
        VStack(alignment: .leading, spacing: Spacing.xl) {
            if let name = store.detail, let connector = model.connector(named: name) {
                SourceDetailView(connector: connector) {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        store.detail = nil
                    }
                }
                .transition(.opacity)
            } else if !model.meta.integrationOn("runelay") {
                header(AnyView(EmptyView()))
                RunelayOffState(action: onRunelayOff)
                    .transition(.opacity)
            } else {
                header(AnyView(actions))
                CatalogSearchField()
                CatalogContent()
                    .transition(.opacity)
            }
        }
        .springAnimation(value: store.detail)
        .task(id: model.meta.integrationOn("runelay")) {
            await store.load(model: model)
            await model.loadConnectors()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            store.appBecameActive(model: model)
        }
        .alert(
            "Remover \(store.pendingRemoval?.name ?? "")?",
            isPresented: Binding(
                get: { store.pendingRemoval != nil },
                set: { if !$0 { store.pendingRemoval = nil } }
            ),
            presenting: store.pendingRemoval
        ) { item in
            Button("Remover", role: .destructive) {
                store.remove(item, model: model)
            }
            Button("Cancelar", role: .cancel) {}
        } message: { _ in
            Text("As tools dela somem de todos os agentes da organização. O login dessa conexão é apagado.")
        }
        .sheet(item: Binding(
            get: { store.tokenRequest },
            set: { store.tokenRequest = $0 }
        )) { item in
            CatalogTokenSheet(connector: item)
        }
    }

    private var actions: some View {
        HStack(spacing: Spacing.s) {
            IconActionButton(
                systemImage: "arrow.clockwise",
                label: "Testar os instalados de novo",
                spinning: model.isRefreshingConnectors
            ) {
                model.refreshConnectors()
                Task { await model.catalog.load(model: model) }
            }
            .disabled(model.isRefreshingConnectors)
            AddConnectorButton()
        }
    }
}

private struct CatalogContent: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.catalog
        switch store.state {
        case .idle, .loading:
            LazyVGrid(columns: CatalogGrid.columns, spacing: Spacing.s) {
                ForEach(0..<8, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                        .fill(Theme.surface)
                        .frame(height: 64)
                }
            }
        case .failed(let message):
            EmptyStateView(systemImage: "exclamationmark.triangle", title: "Não deu para carregar o catálogo", description: message)
        case .loaded(let catalog):
            if catalog.isEmpty {
                EmptyStateView(
                    systemImage: "powerplug",
                    title: store.query.isEmpty ? "Catálogo vazio" : "Nenhum conector com “\(store.query)”",
                    description: "Use Adicionar e Conexão personalizada para ligar qualquer servidor MCP ou OpenAPI."
                )
            } else {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    ForEach(catalog.featured) { connector in
                        FeaturedConnectorCard(connector: connector)
                    }
                    ForEach(catalog.sections) { section in
                        CatalogSectionView(section: section)
                            .padding(.horizontal, -Spacing.m)
                    }
                }
                .opacity(store.isSearching ? 0.6 : 1)
                .id(store.query)
                .transition(.opacity)
                .springAnimation(value: store.isSearching)
            }
        }
    }
}

private enum CatalogGrid {
    static let columns = [
        GridItem(.flexible(), spacing: Spacing.s, alignment: .top),
        GridItem(.flexible(), spacing: Spacing.s, alignment: .top),
    ]
}

private struct CatalogSearchField: View {
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Theme.textSecondary)
            TextField("Buscar no catálogo", text: $draft)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textPrimary)
                .focused($focused)
                .onSubmit {
                    model.catalog.search(draft, model: model)
                }
            if !draft.isEmpty {
                Button {
                    draft = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textTertiary)
                }
                .buttonStyle(.plain)
                .clickable()
                .transition(.opacity)
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 36)
        .background(focused ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            focused = true
        }
        .onChange(of: draft) { _, value in
            model.catalog.search(value, model: model)
        }
        .onAppear {
            draft = model.catalog.query
        }
        .springAnimation(value: draft.isEmpty)
        .springAnimation(value: focused)
    }
}

private struct AddConnectorButton: View {
    @Environment(AppModel.self) private var model
    @State private var isHovering = false

    private var isOpen: Bool { model.floatingMenu == .connectorsAdd }

    var body: some View {
        Button {
            model.floatingMenu = isOpen ? nil : .connectorsAdd
        } label: {
            HStack(spacing: Spacing.xs + 2) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
                Text("Adicionar")
                    .font(BrandFonts.sans(13, weight: .medium))
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .opacity(0.7)
                    .rotationEffect(.degrees(isOpen ? 180 : 0))
            }
            .foregroundStyle(Theme.background)
            .padding(.horizontal, Spacing.m)
            .frame(height: 32)
            .background(Theme.textPrimary.opacity(isHovering || isOpen ? 0.88 : 1), in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isOpen)
        .anchorPreference(key: FloatingMenuAnchorKey.self, value: .bounds) { [.connectorsAdd: $0] }
        .accessibilityLabel("Adicionar")
    }
}

private struct FeaturedConnectorCard: View {
    let connector: CatalogConnector

    private var pitch: String {
        connector.id == "conty"
            ? "Rode suas campanhas com creators pelo agente: briefing, convites, aprovação de vídeos, cupons e vendas."
            : connector.description
    }

    var body: some View {
        HStack(spacing: Spacing.l) {
            HStack(spacing: Spacing.m + 2) {
                CatalogConnectorIcon(name: connector.name, icon: connector.icon, size: .large)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    HStack(spacing: Spacing.s) {
                        Text(connector.name)
                            .font(BrandFonts.sans(15, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Text("Destaque")
                            .font(BrandFonts.sans(11, weight: .medium))
                            .foregroundStyle(Theme.background)
                            .padding(.horizontal, Spacing.s)
                            .padding(.vertical, Spacing.xxs)
                            .background(Theme.textPrimary, in: Capsule())
                        if let status = connector.status {
                            SourceStatusDot(status: status)
                        }
                    }
                    Text(pitch)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CatalogItemActions(connector: connector, prominent: true)
        }
        .padding(Spacing.l)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

private struct CatalogSectionView: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let section: CatalogSection

    @State private var open = true
    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Button {
                withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                    open.toggle()
                }
            } label: {
                HStack(spacing: Spacing.xs + 2) {
                    Text(section.title)
                        .font(BrandFonts.sans(13, weight: .semibold))
                        .foregroundStyle(isHovering ? Theme.textSecondary : Theme.textPrimary)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                        .rotationEffect(.degrees(open ? 0 : -90))
                }
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, Spacing.xs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            .onHover { isHovering = $0 }
            .springAnimation(value: isHovering)
            .accessibilityValue(open ? "Aberta" : "Fechada")

            if open {
                LazyVGrid(columns: CatalogGrid.columns, spacing: 0) {
                    ForEach(section.items) { connector in
                        CatalogItemRow(connector: connector)
                    }
                }
                .transition(.opacity.combined(with: .offset(y: -6)))
            }
        }
        .clipped()
    }
}

private struct CatalogItemRow: View {
    let connector: CatalogConnector
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: Spacing.m) {
            CatalogConnectorIcon(name: connector.name, icon: connector.icon, size: .medium)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: Spacing.s) {
                    Text(connector.name)
                        .font(BrandFonts.sans(13, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if let status = connector.status {
                        SourceStatusDot(status: status)
                    }
                }
                Text(connector.description)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CatalogItemActions(connector: connector, prominent: false)
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.s + 2)
        .frame(minHeight: 64)
        .background(isHovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
    }
}

private struct CatalogItemActions: View {
    @Environment(AppModel.self) private var model
    let connector: CatalogConnector
    let prominent: Bool

    private enum Mode: Hashable {
        case login
        case installed
        case available
    }

    private var mode: Mode {
        connector.needsLogin ? .login : connector.installed ? .installed : .available
    }

    var body: some View {
        let store = model.catalog
        let busy = !store.pending.isEmpty
        HStack(spacing: Spacing.xs) {
            switch mode {
            case .login:
                Button("Concluir login") {
                    store.reconnect(connector, model: model)
                }
                .buttonStyle(CatalogPillButtonStyle(kind: .glass))
                .disabled(busy)
                ConnectorOptionsButton(connector: connector)
            case .installed:
                ConnectorOptionsButton(connector: connector)
            case .available:
                if prominent {
                    Button("Conectar") {
                        store.requestInstall(connector, model: model)
                    }
                    .buttonStyle(CatalogPillButtonStyle(kind: .solid))
                    .disabled(busy)
                } else {
                    InstallConnectorButton(name: connector.name, pending: busy) {
                        store.requestInstall(connector, model: model)
                    }
                }
            }
        }
        .id(mode)
        .transition(.scale(scale: 0.8).combined(with: .opacity))
        .springAnimation(value: mode)
    }
}

private struct CatalogPillButtonStyle: ButtonStyle {
    enum Kind {
        case solid
        case glass
    }

    let kind: Kind
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.appReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(BrandFonts.sans(13, weight: .medium))
            .foregroundStyle(kind == .solid ? Theme.background : Theme.textPrimary)
            .padding(.horizontal, Spacing.m)
            .frame(height: 32)
            .background(kind == .solid ? Theme.textPrimary : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .clickable()
            .animation(Motion.animation(reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

private struct InstallConnectorButton: View {
    let name: String
    let pending: Bool
    let install: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: install) {
            Image(systemName: "plus")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 32, height: 32)
                .background(isHovering ? Theme.selection : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(pending)
        .opacity(pending ? 0.45 : 1)
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .help("Instalar \(name)")
        .accessibilityLabel("Instalar \(name)")
    }
}

private struct ConnectorOptionsButton: View {
    @Environment(AppModel.self) private var model
    let connector: CatalogConnector
    @State private var isHovering = false

    private var menuID: FloatingMenuID { .connectorOptions(connector.id) }
    private var isOpen: Bool { model.floatingMenu == menuID }

    var body: some View {
        Button {
            model.floatingMenu = isOpen ? nil : menuID
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(isOpen || isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 30, height: 30)
                .background(isOpen ? Theme.selection : isHovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isOpen)
        .anchorPreference(key: FloatingMenuAnchorKey.self, value: .bounds) { [menuID: $0] }
        .help("Opções de \(connector.name)")
        .accessibilityLabel("Opções de \(connector.name)")
    }
}

struct CatalogConnectorIcon: View {
    enum Size {
        case medium
        case large

        var tile: CGFloat { self == .large ? 48 : 36 }
        var image: CGFloat { self == .large ? 28 : 18 }
        var radius: CGFloat { self == .large ? Radius.medium : Radius.small }
        var monogram: CGFloat { self == .large ? 16 : 13 }
    }

    let name: String
    let icon: String?
    var size: Size = .medium

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size.radius, style: .continuous)
        if icon == "/logos/conty.png", let image = BrandAssets.connector("conty") {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fill)
                .frame(width: size.tile, height: size.tile)
                .clipShape(shape)
                .accessibilityHidden(true)
        } else if let image = logo {
            Image(nsImage: image)
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(Theme.textPrimary)
                .frame(width: size.image, height: size.image)
                .frame(width: size.tile, height: size.tile)
                .background(Theme.surfaceRaised, in: shape)
                .accessibilityHidden(true)
        } else {
            Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                .font(BrandFonts.mono(size.monogram, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .frame(width: size.tile, height: size.tile)
                .background(Theme.surfaceRaised, in: shape)
                .accessibilityHidden(true)
        }
    }

    private var logo: NSImage? {
        guard let icon, !icon.isEmpty else { return nil }
        if icon.hasPrefix("/") {
            return BrandAssets.connector(ConnectorNames.key(icon))
        }
        return BrandIconStore.shared.icon(slug: icon)?.image
    }
}

private struct CatalogTokenSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let connector: CatalogConnector
    @State private var token = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            HStack(spacing: Spacing.m) {
                CatalogConnectorIcon(name: connector.name, icon: connector.icon)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("Conectar \(connector.name)")
                        .font(TypeScale.sectionTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text("Cole o token da sua conta. Ele fica guardado na runelay.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            SecureField("Token", text: $token)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .padding(.horizontal, Spacing.m)
                .frame(height: 36)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .onSubmit(submit)
            HStack(spacing: Spacing.s) {
                if let link = connector.tokenUrl, let url = URL(string: link) {
                    Button("Gerar token") {
                        NSWorkspace.shared.open(url)
                    }
                    .buttonStyle(.plain)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.brandText)
                    .clickable()
                }
                Spacer(minLength: Spacing.m)
                Button("Cancelar") {
                    dismiss()
                }
                .buttonStyle(CatalogPillButtonStyle(kind: .glass))
                .keyboardShortcut(.cancelAction)
                Button("Instalar", action: submit)
                    .buttonStyle(CatalogPillButtonStyle(kind: .solid))
                    .keyboardShortcut(.defaultAction)
                    .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Spacing.xl)
        .frame(width: 400)
        .background(Theme.background)
    }

    private func submit() {
        let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        model.catalog.install(connector, token: value, model: model)
        dismiss()
    }
}

struct PageHeaderView<Actions: View>: View {
    let title: String
    let description: String
    var signed = false
    @ViewBuilder let actions: Actions

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                    Text(title)
                        .font(BrandFonts.sans(18, weight: .semibold))
                        .tracking(-0.18)
                        .foregroundStyle(Theme.textPrimary)
                    if signed {
                        RunelaySignature()
                    }
                }
                Text(description)
                    .font(BrandFonts.sans(13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Spacing.m)
            HStack(spacing: Spacing.s) {
                actions
            }
        }
    }
}

struct RunelaySignature: View {
    @State private var isHovering = false

    var body: some View {
        Button {
            if let url = CatalogLinks.dashboard {
                NSWorkspace.shared.open(url)
            }
        } label: {
            HStack(spacing: Spacing.xs) {
                Text("by")
                RunelayMark(size: 12)
                Text("runelay")
            }
            .font(TypeScale.caption)
            .foregroundStyle(isHovering ? Theme.textSecondary : Theme.textTertiary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .help("Abrir o painel da runelay")
        .accessibilityLabel("by runelay, abrir o painel da runelay")
    }
}

struct IconActionButton: View {
    let systemImage: String
    let label: String
    var spinning = false
    var destructive = false
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isHovering ? (destructive ? Theme.danger : Theme.textPrimary) : Theme.textSecondary)
                .symbolEffect(.rotate, options: .repeating, isActive: spinning)
                .frame(width: 32, height: 32)
                .background(isHovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .help(label)
        .accessibilityLabel(label)
    }
}

private struct RunelayOffState: View {
    let action: () -> Void

    var body: some View {
        VStack(spacing: Spacing.m) {
            EmptyStateView(
                systemImage: "powerplug",
                title: "Conectores e memória estão desligados",
                description: "Conecte o runelay para os bots usarem Linear, GitHub, Supabase e o resto das suas contas, além da memória e das skills compartilhadas."
            )
            Button("Conectar runelay", action: action)
            .buttonStyle(.brandPrimary)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, Spacing.xxl)
    }
}

struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let description: String

    var body: some View {
        VStack(spacing: Spacing.s) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 44, height: 44)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            Text(title)
                .font(BrandFonts.sans(14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(description)
                .font(BrandFonts.sans(13))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xxl)
    }
}

struct SourceStatusDot: View {
    let status: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 6, height: 6)
            .help(SourceStatus.label(status))
            .accessibilityLabel(SourceStatus.label(status))
    }

    private var color: Color {
        switch status {
        case "ok": Theme.success
        case "error": Theme.danger
        case "needs_auth": Theme.attention
        default: Theme.textTertiary
        }
    }
}

enum SourceStatus {
    static func label(_ status: String) -> String {
        switch status {
        case "ok": "Conectado"
        case "error": "Com erro"
        case "needs_auth": "Precisa de login"
        default: "Não testado"
        }
    }

    static func tools(_ count: Int?) -> String? {
        count.map { "\($0) tools" }
    }
}

struct SourceDetailView: View {
    @Environment(AppModel.self) private var model
    let connector: Connector
    let back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            Button(action: back) {
                Label("Catálogo", systemImage: "arrow.left")
                    .font(BrandFonts.sans(13))
                    .foregroundStyle(Theme.textSecondary)
            }
            .buttonStyle(.plain)
            .clickable()

            HStack(alignment: .top, spacing: Spacing.m) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    HStack(spacing: Spacing.s) {
                        SourceStatusDot(status: connector.status)
                        ConnectorTile(name: connector.name, icon: connector.icon, size: 36)
                        Text(connector.label)
                            .font(BrandFonts.sans(18, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                    }
                    Text([SourceStatus.label(connector.status), SourceStatus.tools(connector.toolCount), connector.name]
                        .compactMap { $0 }
                        .joined(separator: " · "))
                        .font(BrandFonts.sans(13))
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: Spacing.m)
                IconActionButton(systemImage: "arrow.clockwise", label: "Testar de novo", spinning: model.isRefreshingConnectors) {
                    model.refreshConnectors()
                }
                if connector.status != "ok", let link = connector.reconnectUrl, let url = URL(string: link) {
                    Button("Reconectar") {
                        NSWorkspace.shared.open(url)
                    }
                    .buttonStyle(.brandSecondary)
                }
            }

            if connector.status == "error" {
                Text("A runelay não conseguiu falar com essa conexão. Reconecte ou teste de novo.")
                    .font(BrandFonts.sans(13))
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, Spacing.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            }

            VStack(alignment: .leading, spacing: Spacing.s) {
                Text("Usado por")
                    .font(BrandFonts.sans(13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                VStack(spacing: 0) {
                    ForEach(model.loadedBots.filter { !$0.isPending }) { bot in
                        HStack(spacing: Spacing.m) {
                            BotCharacter(bot: bot, mood: .idle, size: 24)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(bot.name)
                                    .font(BrandFonts.sans(14, weight: .medium))
                                    .foregroundStyle(Theme.textPrimary)
                                if !bot.role.isEmpty {
                                    Text(bot.role)
                                        .font(BrandFonts.sans(12))
                                        .foregroundStyle(Theme.textSecondary)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: Spacing.m)
                            Toggle(bot.name, isOn: Binding(
                                get: { model.bot(id: bot.id)?.connectors?.allowed.contains(connector.name) ?? false },
                                set: { model.setConnector(connector.name, allowed: $0, for: bot) }
                            ))
                            .toggleStyle(.switch)
                            .labelsHidden()
                            .tint(Theme.brandAccent)
                            .clickable()
                        }
                        .padding(.horizontal, 20)
                        .frame(height: 56)
                    }
                }
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                Text("A lista de tools de cada conexão fica na runelay.")
                    .font(BrandFonts.sans(12))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
    }
}

