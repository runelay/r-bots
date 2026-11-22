import SwiftUI

struct InspectorView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if let bot = model.selectedBot {
                    RoundIconButton(systemImage: "gearshape", help: tr("Perfil de %@", bot.name)) {
                        model.openProfile(bot)
                    }
                }
                Spacer(minLength: 0)
                RoundIconButton(systemImage: "xmark", help: tr("Fechar painel (⌥⌘I)")) {
                    model.toggleInspector()
                }
            }
            .padding(.horizontal, Spacing.l)
            .frame(height: Metrics.headerHeight)
            .padding(.top, Spacing.s)

            if let bot = model.selectedBot {
                ScrollView {
                    VStack(spacing: Spacing.l) {
                        Button {
                            model.openProfile(bot)
                        } label: {
                            InspectorHero(bot: bot, mood: model.mood(for: bot.id), status: model.status(for: bot.id))
                        }
                        .buttonStyle(.plain)
                        .clickable()
                        .help("Abrir o perfil de \(bot.name)")

                        PillTabs(
                            tabs: InspectorTab.allCases,
                            selection: Bindable(model).inspectorTab,
                            title: \.title
                        )

                        switch model.inspectorTab {
                        case .activity:
                            ActivitySection(bot: bot)
                                .transition(.opacity)
                        case .library:
                            LibrarySection(bot: bot)
                                .transition(.opacity)
                        case .routines:
                            RoutinesSection(bot: bot)
                                .transition(.opacity)
                        }
                    }
                    .padding(.horizontal, Spacing.l)
                    .padding(.bottom, Spacing.xl)
                    .frame(width: Metrics.inspectorWidth)
                    .springAnimation(value: model.inspectorTab)
                }
                .scrollEdgesHidden()
            } else {
                Spacer(minLength: 0)
                PanelEmptyState(
                    systemImage: "sidebar.right",
                    title: tr("Nada para mostrar"),
                    message: tr("Escolha um bot para ver o que ele está fazendo.")
                )
                Spacer(minLength: 0)
            }
        }
    }
}

struct InspectorHero: View {
    let bot: Bot
    let mood: CharacterMood
    let status: BotStatus

    var body: some View {
        VStack(spacing: Spacing.s) {
            BotCharacter(bot: bot, mood: mood, size: 64)
            Text(bot.name)
                .font(TypeScale.heroName)
                .tracking(-0.2)
                .foregroundStyle(Theme.textPrimary)
            Text(status == .idle ? bot.role : status.label)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .contentTransition(.opacity)
                .springAnimation(value: status)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Spacing.xs)
        .contentShape(Rectangle())
    }
}

struct SectionCaption<Trailing: View>: View {
    let title: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack {
            Text(title)
                .font(TypeScale.sectionCaption)
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 0)
            trailing
        }
        .padding(.horizontal, Spacing.l)
    }
}

extension SectionCaption where Trailing == EmptyView {
    init(title: String) {
        self.init(title: title) { EmptyView() }
    }
}

struct SoftCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            content
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

struct ActivitySection: View {
    @Environment(AppModel.self) private var model
    @AppStorage("suggestionsHidden") private var suggestionsHidden = false
    let bot: Bot

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            if !bot.isGroup && !bot.isPending {
                ServersSection(bot: bot)
            }

            if bot.hasBrowser {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    SectionCaption(title: tr("Computador"))
                    ComputerCard(
                        bot: bot,
                        store: model.browser,
                        client: model.client,
                        isWorking: model.status(for: bot.id) == .working
                    )
                }
            }

            if !bot.isGroup && !bot.isPending {
                VoiceChatSection(bot: bot)
            }

            VStack(alignment: .leading, spacing: Spacing.s) {
                SectionCaption(title: tr("Sugestões")) {
                    Button(suggestionsHidden ? "Mostrar" : "Ocultar") {
                        suggestionsHidden.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(TypeScale.sectionCaption)
                    .foregroundStyle(Theme.textSecondary)
                    .clickable()
                }
                if !suggestionsHidden {
                    ActionRowCard(systemImage: "clock", title: tr("Criar uma rotina")) {
                        model.inspectorTab = .routines
                    }
                    .transition(.opacity)
                }
            }
            .springAnimation(value: suggestionsHidden)
        }
    }
}

struct ActionRowCard: View {
    let systemImage: String
    let title: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.m) {
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 20)
                Text(title)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
                    .offset(x: isHovering ? 2 : 0)
            }
            .padding(.horizontal, Spacing.l)
            .frame(minHeight: Metrics.rowHeight - 6)
            .background(isHovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
    }
}

struct ComputerCard: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    let store: BrowserStore
    let client: BotsClient
    let isWorking: Bool

    @State private var isExpanded = false
    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Button {
                model.openComputer()
            } label: {
                HStack(spacing: Spacing.m) {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text("Navegador do bot")
                            .font(TypeScale.rowTitle)
                            .foregroundStyle(Theme.textPrimary)
                        Text(statusText)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(isWorking ? Theme.brandText : Theme.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .contentTransition(.opacity)
                    }
                    Spacer(minLength: Spacing.s)
                    thumbnail
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            .help("Abrir o navegador em tela cheia")

            if isExpanded {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    if let title = store.info?.title, !title.isEmpty {
                        Text(title)
                            .font(TypeScale.rowTitle)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(2)
                    }
                    ScreenshotView(store: store)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(store.updatedLabel(now: context.date))
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .springAnimation(value: isExpanded)
        .springAnimation(value: isWorking)
        .task(id: "\(bot.id)|\(isWorking)") {
            await store.run(client: client, botID: bot.id, polling: isWorking)
        }
    }

    private var statusText: String {
        if isWorking {
            if let url = store.info?.url, !url.isEmpty {
                return url
            }
            return tr("Navegando")
        }
        return tr("Em repouso")
    }

    @ViewBuilder
    private var thumbnail: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                .fill(Theme.surfaceRaised)
            if isWorking, let image = store.image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fill)
                    .id(store.imageVersion)
                    .transition(.opacity)
            } else {
                BotCharacter(bot: bot, mood: .sleeping, size: 40)
                    .transition(.opacity)
            }
        }
        .frame(width: 96, height: 60)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .animation(Motion.crossFade, value: store.imageVersion)
    }
}

struct RoutinesSection: View {
    let bot: Bot

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            SectionCaption(title: tr("Rotinas de %@", bot.name))
            SoftCard {
                if bot.schedules.isEmpty {
                    Text("\(bot.name) ainda não tem rotinas.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textTertiary)
                } else {
                    ForEach(bot.schedules) { schedule in
                        RoutineRow(bot: bot, schedule: schedule)
                    }
                }
            }
        }
    }
}

struct RoutineRow: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    let schedule: BotSchedule

    var body: some View {
        let running = model.isRunning(schedule, of: bot)
        HStack(alignment: .center, spacing: Spacing.m) {
            Image(systemName: "clock")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.accent(bot.accent))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(schedule.name.prefix(1).uppercased() + schedule.name.dropFirst())
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                TimelineView(.everyMinute) { context in
                    Text(running ? "Rodando agora" : "Roda \(ScheduleFormatter.nextRun(for: schedule, now: context.date))")
                        .font(TypeScale.caption)
                        .monospacedDigit()
                        .foregroundStyle(running ? Theme.brandText : Theme.textSecondary)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(schedule.description ?? "")
            Button {
                model.runNow(schedule, of: bot)
            } label: {
                Image(systemName: running ? "circle.dotted" : "play.fill")
                    .font(.system(size: 10, weight: .bold))
                    .symbolEffect(.pulse, options: .repeating, isActive: running)
                    .foregroundStyle(running ? Theme.brandText : Theme.textPrimary)
                    .frame(width: 30, height: 30)
                    .background(Theme.surfaceRaised, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(running || bot.isPending)
            .help("Rodar \(schedule.name) agora")
            .accessibilityLabel("Rodar \(schedule.name) agora")
        }
        .springAnimation(value: running)
    }
}

struct ScreenshotView: View {
    let store: BrowserStore

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                .fill(Theme.surfaceRaised)

            if let image = store.image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .id(store.imageVersion)
                    .transition(.opacity)
            } else {
                placeholder
            }
        }
        .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .animation(Motion.crossFade, value: store.imageVersion)
    }

    @ViewBuilder
    private var placeholder: some View {
        switch store.state {
        case .empty:
            VStack(spacing: Spacing.s) {
                Image(systemName: "globe")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(Theme.textTertiary)
                Text("Nenhuma página aberta ainda")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
        case .failed(let message):
            VStack(spacing: Spacing.s) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(Theme.warning)
                Text(message)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Spacing.l)
            }
        case .idle, .loading, .ready:
            EmptyView()
        }
    }
}
