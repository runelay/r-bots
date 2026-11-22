import SwiftUI

struct BotsSettings: View {
    @Environment(AppModel.self) private var model
    @State private var archiving: Bot?
    @State private var showExtra = false
    @State private var showArchived = false

    private var extra: [Bot] {
        if case .loaded(let list) = model.extraBots { return list }
        return []
    }

    private var archived: [Bot] {
        if case .loaded(let list) = model.archivedBots { return list }
        return []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            HostRunnerSettings()

            SettingsGroup(caption: "No time") {
                Text("Auto")
                    .font(BrandFonts.sans(11, weight: .medium))
                    .foregroundStyle(Theme.textTertiary)
                    .help("Aprovar ações seguras automaticamente")
                    .padding(.trailing, 38)
            } content: {
                ForEach(model.loadedBots) { bot in
                    SettingsBotRow(bot: bot) {
                        AutoApproveToggle(bot: bot, compact: true)
                        GlassMenuIconButton(systemImage: "ellipsis", help: "Mais ações", iconSize: 12, size: 24, weight: .semibold, edge: .trailing) {
                            [
                                GlassMenuItem("Editar", systemImage: "pencil") {
                                    model.openEditor(for: bot)
                                },
                                GlassMenuItem("Arquivar", systemImage: "archivebox", destructive: true) {
                                    archiving = bot
                                },
                            ]
                        }
                        .disabled(bot.isPending)
                    }
                    .transition(.opacity)
                }
                if model.loadedBots.isEmpty {
                    SettingsRow(title: "Nenhum bot no time", icon: SettingsIcon("person.2.slash", SettingsTint.graphite)) {
                        EmptyView()
                    }
                }
            }
            .springAnimation(value: model.loadedBots.map(\.id))

            if !extra.isEmpty {
                SettingsDisclosure(title: "Ocultos e excluídos", count: extra.count, icon: SettingsIcon("eye.slash.fill", SettingsTint.graphite), isOpen: $showExtra) {
                    ForEach(extra) { bot in
                        SettingsBotRow(bot: bot, mood: .sleeping) {
                            Button(bot.isDeleted ? "Restaurar" : "Mostrar") {
                                if bot.isDeleted {
                                    model.restoreDeleted(bot)
                                } else {
                                    model.showHidden(bot)
                                }
                            }
                            .buttonStyle(SettingsButtonStyle(kind: .plain))
                        }
                        .transition(.opacity)
                    }
                }
            }

            SettingsDisclosure(title: "Arquivados", count: archivedCount, icon: SettingsIcon("archivebox.fill", SettingsTint.graphite), isOpen: $showArchived) {
                switch model.archivedBots {
                case .idle, .loading:
                    SkeletonRow(width: 180)
                        .padding(.horizontal, Spacing.s)
                case .failed(let message):
                    SettingsRow(title: "Não deu para carregar", icon: SettingsIcon("exclamationmark.triangle.fill", SettingsTint.amber), detail: message) {
                        EmptyView()
                    }
                case .loaded(let list):
                    if list.isEmpty {
                        SettingsRow(title: "Nenhum bot arquivado", icon: SettingsIcon("archivebox", SettingsTint.graphite)) {
                            EmptyView()
                        }
                    } else {
                        ForEach(list) { bot in
                            SettingsBotRow(bot: bot, mood: .sleeping) {
                                Button("Restaurar") {
                                    model.restore(bot)
                                }
                                .buttonStyle(SettingsButtonStyle(kind: .plain))
                            }
                            .transition(.opacity)
                        }
                    }
                }
            }
        }
        .confirmationDialog(
            "Arquivar \(archiving?.name ?? "bot")?",
            isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } })
        ) {
            Button("Arquivar", role: .destructive) {
                if let archiving {
                    model.archive(archiving)
                }
                archiving = nil
            }
            Button("Cancelar", role: .cancel) {
                archiving = nil
            }
        } message: {
            Text("Ele some da lista. Dá para restaurar aqui em Arquivados.")
        }
    }

    private var archivedCount: Int? {
        if case .loaded = model.archivedBots { return archived.count }
        return nil
    }
}

struct SettingsDisclosure<Content: View>: View {
    let title: String
    var count: Int?
    let icon: SettingsIcon
    @Binding var isOpen: Bool
    @ViewBuilder let content: Content
    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.s + 2) {
                SettingsTile(symbol: icon.symbol, color: icon.color)
                Text(title)
                    .font(BrandFonts.sans(13, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                if let count {
                    Text("\(count)")
                        .font(TypeScale.counter)
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 6)
                        .frame(height: 18)
                        .background(Theme.surfaceRaised, in: Capsule())
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
            }
            .padding(.horizontal, Spacing.m - Spacing.xxs)
            .frame(height: 40)
            .background(isHovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(.horizontal, Spacing.xxs)
            .contentShape(Rectangle())
            .onTapGesture { isOpen.toggle() }
            .onHover { isHovering = $0 }
            .clickable()
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(isOpen ? "Aberto" : "Fechado")
            if isOpen {
                VStack(alignment: .leading, spacing: 0) {
                    content
                }
                .transition(.opacity)
            }
        }
        .padding(.vertical, Spacing.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .shadow(color: Theme.elevationShadow, radius: 2, y: 1)
        .springAnimation(value: isOpen)
    }
}

struct SettingsBotRow<Actions: View>: View {
    let bot: Bot
    var mood: CharacterMood = .idle
    @ViewBuilder let actions: Actions

    var body: some View {
        HStack(spacing: Spacing.s + 2) {
            BotCharacter(bot: bot, mood: mood, size: 22)
                .frame(width: 22, height: 22)
            Text(bot.name)
                .font(BrandFonts.sans(13, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .layoutPriority(1)
            Text(bot.role.isEmpty ? "Sem função" : bot.role)
                .font(BrandFonts.sans(12))
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: Spacing.m)
            actions
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 38)
    }
}

struct HostRunnerSettings: View {
    private let runner = HostRunner.shared

    var body: some View {
        SettingsGroup(caption: "Onde roda") {
            SettingsRow(
                title: "Rodar agentes neste Mac",
                icon: SettingsIcon("laptopcomputer", SettingsTint.graphite),
                detail: "Executa os bots neste Mac. Desligado, eles rodam só na VPS."
            ) {
                SettingsToggle(
                    title: "Rodar agentes neste Mac",
                    isOn: Binding(get: { runner.enabled }, set: { runner.enabled = $0 })
                )
            }
            if runner.enabled {
                SettingsRow(title: "Status", icon: SettingsIcon("dot.radiowaves.left.and.right", SettingsTint.green), detail: runner.state.hint) {
                    HStack(spacing: Spacing.s) {
                        if runner.state == .needsClaude || runner.state == .disconnected {
                            Button("Tentar de novo") {
                                runner.restart()
                            }
                            .buttonStyle(SettingsButtonStyle(kind: .plain))
                        }
                        SettingsPill(text: runner.state.label, color: color, pulsing: runner.state == .starting)
                    }
                }
                .transition(.opacity)
            }
        }
        .springAnimation(value: runner.enabled)
        .springAnimation(value: runner.state)
    }

    private var color: Color {
        switch runner.state {
        case .connected: Theme.success
        case .starting, .off: Theme.textTertiary
        case .needsClaude, .signedOut: Theme.warning
        case .disconnected, .unavailable: Theme.danger
        }
    }
}
