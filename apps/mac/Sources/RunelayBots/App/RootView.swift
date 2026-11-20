import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage(PreferenceKeys.appearance) private var appearance = AppearancePreference.system.rawValue
    @AppStorage(PreferenceKeys.motion) private var motion = MotionPreference.system.rawValue
    @AppStorage(PreferenceKeys.textSize) private var textSize = ConversationTextSize.regular.rawValue
    @AppStorage(PreferenceKeys.sidebarCollapsed) private var sidebarCollapsed = false

    private var reduceMotion: Bool {
        systemReduceMotion || motion == MotionPreference.reduced.rawValue
    }

    var body: some View {
        ZStack {
            Theme.windowFrame

            VStack(spacing: 0) {
                TopStrip()
                    .zIndex(1)
                HStack(spacing: 0) {
                    IconRail()
                    panel
                        .background(Theme.panelBackground)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Theme.panelEdge, lineWidth: 1)
                        }
                        .padding(.trailing, FrameMetrics.panelInset)
                        .padding(.bottom, FrameMetrics.panelInset)
                }
            }

            ModelPickerRootLayer()

            if model.computerMode, let bot = model.selectedBot, bot.hasComputer {
                GeometryReader { geometry in
                    ModalOverlay(
                        width: geometry.size.width * 0.92,
                        height: geometry.size.height * 0.92
                    ) {
                        model.closeComputer()
                    } content: {
                        ComputerView(bot: bot)
                    }
                }
                .modifier(ModalTransition())
                .zIndex(1.5)
            }

            if let sheet = model.activeSheet {
                ModalOverlay(width: sheet.preferredWidth, height: sheet.preferredHeight) {
                    model.dismissSheet()
                } content: {
                    SheetContent(sheet: sheet)
                        .id(sheet.id)
                }
                .modifier(ModalTransition())
                .zIndex(2)
            }

            ArtifactViewerLayer()
                .zIndex(2.5)
        }
        .overlayPreferenceValue(FloatingMenuAnchorKey.self) { anchors in
            FloatingMenuLayer(anchors: anchors)
                .environment(\.appReduceMotion, reduceMotion)
        }
        .authGate()
        .background(WindowConfigurator())
        .ignoresSafeArea()
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        .environment(\.appReduceMotion, reduceMotion)
        .environment(\.conversationFontSize, (ConversationTextSize(rawValue: textSize) ?? .regular).pointSize)
        .preferredColorScheme((AppearancePreference(rawValue: appearance) ?? .system).colorScheme)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: model.activeSheet?.id)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: model.settingsPresented)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: model.section)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: model.computerMode)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: sidebarCollapsed)
        .animation(.easeOut(duration: 0.18), value: model.selectedBotID)
        .task {
            Notifier.shared.setUp(model: model)
            UsageStore.shared.start()
            await model.start()
        }
    }

    @ViewBuilder
    private var panel: some View {
        if model.settingsPresented {
            SettingsScreen()
                .transition(.opacity)
        } else {
            switch model.section {
            case .conversations:
                HStack(spacing: 0) {
                    SidebarView()
                        .frame(width: FrameMetrics.sidebarWidth)
                        .frame(maxHeight: .infinity)
                        .background(Theme.sidebarBackground)
                        .frame(width: sidebarCollapsed ? 0 : FrameMetrics.sidebarWidth, alignment: .trailing)
                        .clipped()
                        .allowsHitTesting(!sidebarCollapsed)
                        .accessibilityHidden(sidebarCollapsed)
                    Rectangle()
                        .fill(Theme.paneDivider)
                        .frame(width: sidebarCollapsed ? 0 : 1)
                    GeometryReader { geometry in
                        let blockInset = BlockPresentation.shared.inset(available: geometry.size.width)
                        let showsInspector = model.inspectorPresented
                            && blockInset == 0
                            && geometry.size.width >= Metrics.conversationMinWidth + Metrics.inspectorWidth
                        ZStack(alignment: .trailing) {
                            DetailView()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .background(Theme.background)
                                .padding(.trailing, showsInspector ? Metrics.inspectorWidth : blockInset)
                                .animation(nil, value: showsInspector)
                                .animation(BlockPresentation.shared.dragging ? nil : Motion.animation(reduceMotion: reduceMotion), value: blockInset)

                            if showsInspector {
                                HStack(spacing: 0) {
                                    Rectangle()
                                        .fill(Theme.paneDivider)
                                        .frame(width: 1)
                                    InspectorView()
                                        .frame(maxHeight: .infinity)
                                        .background(Theme.inspectorBackground)
                                }
                                .frame(width: Metrics.inspectorWidth)
                                .clipped()
                                .transition(Motion.panel(reduceMotion: reduceMotion))
                            }
                        }
                        .animation(Motion.animation(reduceMotion: reduceMotion), value: showsInspector)
                    }
                    .frame(minWidth: Metrics.conversationMinWidth)
                }
                .overlay {
                    BlockStage(reserved: sidebarCollapsed ? 0 : FrameMetrics.sidebarWidth + 1)
                }
            case .routines:
                RoutinesScreen()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            case .connectors:
                ConnectorsScreen()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            case .usage:
                UsageScreen()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            }
        }
    }
}

struct TopStrip: View {
    @Environment(AppModel.self) private var model
    @AppStorage(PreferenceKeys.sidebarCollapsed) private var sidebarCollapsed = false

    private var tabsLeading: CGFloat {
        sidebarCollapsed
            ? FrameMetrics.sidebarContentTrailing + Spacing.xs - ChromeTabShape.flare
            : FrameMetrics.railWidth + FrameMetrics.sidebarWidth + 1
    }

    private var titleControls: some View {
        HStack(spacing: Spacing.xs) {
            ServerProfileSwitcher()
                .padding(.leading, -Spacing.s)
            Spacer(minLength: Spacing.s)
            HeaderIconButton(
                systemImage: "sidebar.left",
                help: sidebarCollapsed ? "Mostrar as conversas (⌃⌘S)" : "Ocultar as conversas (⌃⌘S)",
                isActive: !sidebarCollapsed
            ) {
                sidebarCollapsed.toggle()
            }
            FloatingMenuButton(id: .sidebarNew, systemImage: "plus", help: "Novo bot ou grupo", iconSize: 15, size: 28)
        }
        .padding(.leading, FrameMetrics.titleLeading)
        .frame(width: FrameMetrics.sidebarContentTrailing, alignment: .leading)
    }

    var body: some View {
        HStack(spacing: Spacing.s) {
            if model.section == .conversations && !model.settingsPresented {
                Color.clear
                    .frame(width: tabsLeading - Spacing.s)
                BotTabStrip(leadingFlush: !sidebarCollapsed)
                    .frame(maxHeight: .infinity)
                if let bot = model.selectedBot {
                    HStack(spacing: Spacing.s) {
                        if !bot.isPending, !bot.isGroup {
                            ModelPicker(bot: bot)
                            PermissionPill(bot: bot)
                        }
                        if bot.hasComputer {
                            HeaderIconButton(
                                systemImage: bot.hasBrowser ? "globe" : "desktopcomputer",
                                help: "Abrir o computador de \(bot.name)",
                                isActive: model.computerMode
                            ) {
                                model.toggleComputer()
                            }
                        }
                        HeaderIconButton(
                            systemImage: "sidebar.right",
                            help: "Mostrar ou ocultar o painel (⌥⌘I)",
                            isActive: model.inspectorPresented
                        ) {
                            model.toggleInspector()
                        }
                    }
                    .fixedSize()
                    .padding(.leading, Spacing.s)
                    .layoutPriority(1)
                }
            } else {
                Spacer(minLength: 0)
            }
        }
        .padding(.trailing, FrameMetrics.panelInset + Spacing.xs)
        .frame(minWidth: 0, maxWidth: .infinity)
        .frame(height: FrameMetrics.stripHeight)
        .overlay(alignment: .leading) {
            if model.section == .conversations && !model.settingsPresented {
                titleControls
            }
        }
        .background {
            Rectangle()
                .fill(Theme.windowFrame)
                .gesture(WindowDragGesture())
        }
    }
}

struct ModelPickerRootLayer: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let bot = model.selectedBot, model.section == .conversations {
            ModelPickerLayer(bot: bot)
        }
    }
}

struct SheetContent: View {
    let sheet: AppSheet

    var body: some View {
        switch sheet {
        case .profile(let botID):
            BotProfileView(botID: botID)
        case .editor(let request):
            BotEditorView(request: request)
        case .groupEditor(let request):
            GroupEditorView(request: request)
        case .changes(let botID):
            CodeChangesView(botID: botID)
        case .repoPicker(let botID):
            RepoPickerView(botID: botID)
        }
    }
}

struct DetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let store = model.selectedConversation, let bot = model.selectedBot {
            ConversationView(store: store, bot: bot, focusToken: model.composerFocusToken)
                .id(ObjectIdentifier(store))
                .transition(.identity)
        } else {
            ZStack(alignment: .top) {
                VStack(spacing: Spacing.m) {
                    Spacer(minLength: 0)
                    if let bot = model.selectedBot {
                        BotCharacter(bot: bot, mood: bot.isPending ? .thinking : .idle, size: 96)
                        Text(bot.isPending ? "Criando \(bot.name)…" : "Abrindo a conversa…")
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textSecondary)
                    } else if case .loaded(let bots) = model.bots, bots.isEmpty {
                        VStack(spacing: Spacing.m) {
                            PanelEmptyState(
                                systemImage: "person.badge.plus",
                                title: "Seu time ainda está vazio",
                                message: "Crie um bot e diga a ele o que fazer."
                            )
                            Button("Criar seu primeiro bot") {
                                model.openEditor(for: nil)
                            }
                            .buttonStyle(.brandPrimary)
                            .clickable()
                        }
                    } else {
                        PanelEmptyState(
                            systemImage: "person.2",
                            title: "Nenhum bot por aqui",
                            message: "Escolha alguém do time na barra lateral."
                        )
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}


struct ChromeTabShape: Shape {
    static let flare: CGFloat = 10
    static let topRadius: CGFloat = 12
    var leftFlush = false

    func path(in rect: CGRect) -> Path {
        let flare = Self.flare
        let radius = min(Self.topRadius, rect.height / 2)
        var path = Path()
        if leftFlush {
            path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
            path.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        } else {
            path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.addQuadCurve(to: CGPoint(x: rect.minX + flare, y: rect.maxY - flare), control: CGPoint(x: rect.minX + flare, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX + flare, y: rect.minY + radius))
            path.addQuadCurve(to: CGPoint(x: rect.minX + flare + radius, y: rect.minY), control: CGPoint(x: rect.minX + flare, y: rect.minY))
        }
        path.addLine(to: CGPoint(x: rect.maxX - flare - radius, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - flare, y: rect.minY + radius), control: CGPoint(x: rect.maxX - flare, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - flare, y: rect.maxY - flare))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.maxY), control: CGPoint(x: rect.maxX - flare, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}
