import SwiftUI

struct ConversationTopBar: View {
    @Environment(AppModel.self) private var model
    let bot: Bot?
    let mood: CharacterMood
    let tokens: Int
    let openProfile: (() -> Void)?

    var body: some View {
        HStack(spacing: Spacing.xs) {
            if let bot {
                BotTagButton(bot: bot, mood: mood, action: openProfile)
            }
            Spacer(minLength: Spacing.m)
            if let bot, !bot.isPending, !bot.isGroup {
                ModelPicker(bot: bot)
                PermissionPill(bot: bot)
            }
            if let bot, !bot.isPending, !bot.isGroup {
                HeaderIconButton(
                    systemImage: "square.stack",
                    help: "Arquivos do bot: notas, planilhas e agenda",
                    isActive: ArtifactCenter.shared.current?.kind == BlockKind.filesKind && ArtifactCenter.shared.current?.botID == bot.id
                ) {
                    if ArtifactCenter.shared.current?.kind == BlockKind.filesKind {
                        ArtifactCenter.shared.close()
                    } else {
                        ArtifactCenter.shared.openFiles(botID: bot.id, client: model.client)
                    }
                }
            }
            if let bot, bot.hasComputer {
                HeaderIconButton(
                    systemImage: bot.hasBrowser ? "globe" : "desktopcomputer",
                    help: model.computerMode ? "Voltar para a conversa (Esc)" : "Abrir o computador de \(bot.name)",
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
        .padding(.leading, Spacing.s)
        .padding(.trailing, Spacing.s)
        .frame(height: 44)
    }
}

struct BotTagButton: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    let mood: CharacterMood
    let action: (() -> Void)?

    @State private var isHovering = false

    var body: some View {
        Button {
            action?()
        } label: {
            HStack(spacing: Spacing.s) {
                if bot.isGroup {
                    GroupAvatar(members: model.members(of: bot), size: 20)
                } else {
                    BotCharacter(bot: bot, mood: mood, size: 18)
                }
                Text(bot.name)
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                if model.isDraft(bot.id) {
                    Text("Nova conversa")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                } else if showsRole {
                    Text(bot.role)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                }
                if let status = statusLine {
                    Text(status)
                        .font(TypeScale.caption)
                        .foregroundStyle(mood == .waiting ? Theme.attention : Theme.brandText)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 30)
            .background(isHovering && action != nil ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .disabled(action == nil)
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: statusLine)
        .springAnimation(value: isHovering)
        .help("Abrir o perfil de \(bot.name)")
    }

    private var statusLine: String? {
        switch mood {
        case .thinking: "pensando…"
        case .speaking: "escrevendo…"
        case .waiting: "aguardando você"
        default: nil
        }
    }

    private var showsRole: Bool {
        let role = bot.role.trimmingCharacters(in: .whitespaces)
        return !role.isEmpty && role.lowercased() != bot.name.lowercased()
    }
}

struct HeaderIconButton: View {
    let systemImage: String
    let help: String
    var isActive = false
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(isActive || isHovering ? Theme.textPrimary : Theme.textSecondary)
                .frame(width: 28, height: 28)
                .background(isActive ? Theme.selection : isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct ModelPicker: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    @State private var isHovering = false

    var body: some View {
        Button {
            model.modelPickerOpen.toggle()
        } label: {
            HStack(spacing: Spacing.xs + 2) {
                ProviderLogo(provider: ModelNames.provider(bot.engine?.account ?? "vps:claude"), size: 13)
                Text(model.engineLabel(for: bot))
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(isHovering || model.modelPickerOpen ? Theme.textPrimary : Theme.textSecondary)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Theme.textTertiary)
                    .rotationEffect(.degrees(model.modelPickerOpen ? 180 : 0))
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 28)
            .background(isHovering || model.modelPickerOpen ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .springAnimation(value: model.modelPickerOpen)
        .help("Conta e modelo deste bot")
    }
}

struct DelegationSummary: View {
    @Environment(AppModel.self) private var model
    let store: ConversationStore
    let callIDs: [String]

    @State private var isExpanded = false

    var body: some View {
        let calls = callIDs.compactMap { store.toolCalls[$0] }
        let delegations = calls.filter(\.isDelegation)
        let leaders = delegations.isEmpty ? calls.filter { $0.ownerCallID == nil } : delegations
        let done = leaders.filter { $0.status == .completed }.count
        let running = leaders.contains { $0.status.isActive }

        VStack(alignment: .leading, spacing: Spacing.s) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack(spacing: Spacing.s) {
                    HStack(spacing: -6) {
                        ForEach(agentBots(leaders).prefix(3)) { agent in
                            BotCharacter(bot: agent, mood: running ? .thinking : .idle, size: 18)
                                .padding(2)
                                .background(Theme.background, in: Circle())
                        }
                    }
                    Text(leaders.count == 1 ? "1 subagente \(running ? "trabalhando" : "executado")" : "\(leaders.count) subagentes \(running ? "trabalhando" : "executados")")
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                    if done > 0 {
                        Text(done == 1 ? "1 concluído" : "\(done) concluídos")
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, Spacing.s)
                            .frame(height: 22)
                            .background(Theme.surfaceRaised, in: Capsule())
                    }
                    if let duration = duration(calls) {
                        Text(duration)
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.textTertiary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()

            if isExpanded {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    ForEach(leaders) { leader in
                        DelegationDetail(
                            leader: leader,
                            agent: agentBot(for: leader),
                            children: calls.filter { $0.ownerCallID == leader.id && $0.id != leader.id }
                        )
                    }
                }
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .padding(.vertical, Spacing.xs)
        .springAnimation(value: isExpanded)
        .springAnimation(value: done)
    }

    private func agentBot(for call: ToolCall) -> Bot? {
        model.bot(id: call.viaAgent ?? call.name)
    }

    private func agentBots(_ calls: [ToolCall]) -> [Bot] {
        var seen: Set<String> = []
        return calls.compactMap { call in
            guard let bot = agentBot(for: call), seen.insert(bot.id).inserted else { return nil }
            return bot
        }
    }

    private func duration(_ calls: [ToolCall]) -> String? {
        guard let start = calls.compactMap(\.requestedAt).min(),
            let end = calls.compactMap(\.settledAt).max(),
            end >= start
        else { return nil }
        let seconds = Int(end.timeIntervalSince(start).rounded())
        return seconds < 60 ? "\(max(seconds, 1)) s" : "\(seconds / 60) min"
    }
}

struct DelegationDetail: View {
    let leader: ToolCall
    let agent: Bot?
    let children: [ToolCall]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                if let agent {
                    BotCharacter(bot: agent, mood: leader.status.isActive ? .thinking : .idle, size: 18)
                }
                Text(leader.displayName)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: Spacing.s)
                ToolCallStatusBadge(status: leader.status)
            }
            ForEach(children) { child in
                ToolCallSummary(call: child)
                    .padding(.leading, Spacing.xl + 2)
            }
            if let output = leader.output, let text = output.stringValue ?? Optional(ReadableResult.plainText(output)) {
                Text(MarkdownText.attributed(text))
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(4)
                    .textSelection(.enabled)
                    .padding(.leading, Spacing.xl + 2)
            }
        }
        .padding(Spacing.m)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }
}
