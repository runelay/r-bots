import SwiftUI

struct BotProfileView: View {
    @Environment(AppModel.self) private var model
    let botID: String

    @State private var confirmsArchive = false

    var body: some View {
        if let bot = model.bot(id: botID) {
            BannerPanel(bot: bot, mood: model.mood(for: bot.id), close: { model.dismissSheet() }) {
                header(for: bot)
            } content: {
                VStack(alignment: .leading, spacing: Spacing.l) {
                    PillTabs(tabs: ProfileTab.allCases, selection: Bindable(model).profileTab, title: \.title)
                        .padding(.leading, -Spacing.xs)
                    switch model.profileTab {
                    case .general:
                        general(for: bot)
                            .transition(.opacity)
                    case .routines:
                        RoutinesSection(bot: bot)
                            .transition(.opacity)
                    }
                }
                .springAnimation(value: model.profileTab)
            } footer: {
                EmptyView()
            }
            .confirmationDialog("Arquivar \(bot.name)?", isPresented: $confirmsArchive) {
                Button("Arquivar", role: .destructive) {
                    model.archive(bot)
                }
                Button("Cancelar", role: .cancel) {}
            } message: {
                Text("\(bot.name) some da lista. Dá para restaurar em Arquivados.")
            }
        } else {
            PanelEmptyState(systemImage: "person.crop.circle.badge.questionmark", title: "Bot não encontrado", message: "Ele pode ter sido arquivado.")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func header(for bot: Bot) -> some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.m) {
                Text(bot.name)
                    .font(TypeScale.pageTitle)
                    .tracking(Metrics.pageTitleTracking)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: Spacing.m)
                Button {
                    model.openEditor(for: bot)
                } label: {
                    Label("Editar", systemImage: "pencil")
                }
                .buttonStyle(.brandSecondary)
                .disabled(bot.isPending)
                RoundIconButton(systemImage: "archivebox", help: "Arquivar \(bot.name)", size: 36) {
                    confirmsArchive = true
                }
                .disabled(bot.isPending)
            }
            if !bot.role.isEmpty {
                Text(bot.role)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
            }
            Label("Privado para você", systemImage: "lock")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        }
    }

    @ViewBuilder
    private func general(for bot: Bot) -> some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            VStack(alignment: .leading, spacing: Spacing.s) {
                SectionCaption(title: "Computador")
                if bot.hasBrowser {
                    ComputerCard(
                        bot: bot,
                        store: model.browser,
                        client: model.client,
                        isWorking: model.status(for: bot.id) == .working
                    )
                } else {
                    SoftCard {
                        Text("\(bot.name) não usa navegador.")
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
            }

            VStack(alignment: .leading, spacing: Spacing.s) {
                SectionCaption(title: "Decisões")
                SoftCard {
                    AutoApproveToggle(bot: bot, compact: false)
                }
            }

            VStack(alignment: .leading, spacing: Spacing.s) {
                SectionCaption(title: "Instruções")
                InstructionsSection(bot: bot)
            }
        }
    }

}

struct AutoApproveToggle: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    let compact: Bool

    var body: some View {
        let isOn = Binding(
            get: { model.bot(id: bot.id)?.decisions?.autoApprove ?? true },
            set: { model.setAutoApprove($0, for: bot) }
        )
        if compact {
            Toggle("Auto", isOn: isOn)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .tint(Theme.brandAccent)
                .clickable()
                .help("Aprovar ações seguras automaticamente")
                .disabled(bot.isPending)
        } else {
            HStack(alignment: .top, spacing: Spacing.m) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Aprovar ações seguras automaticamente")
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text("O Jev avalia cada ação. Só o que for claramente seguro roda sem te perguntar; o resto continua pedindo aprovação.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Spacing.m)
                Toggle("Aprovar ações seguras automaticamente", isOn: isOn)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .tint(Theme.brandAccent)
                    .clickable()
                    .disabled(bot.isPending)
            }
        }
    }
}

struct InstructionsSection: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    @State private var isEditing = false
    @State private var text = ""

    var body: some View {
        SoftCard {
            if isEditing {
                TextEditor(text: $text)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 140)
                HStack(spacing: Spacing.s) {
                    Spacer(minLength: 0)
                    Button("Cancelar") {
                        isEditing = false
                    }
                    .buttonStyle(.brandSecondary)
                    Button("Salvar") {
                        model.saveInstructions(text, for: bot)
                        isEditing = false
                    }
                    .buttonStyle(.brandPrimary)
                }
            } else {
                Text(bot.instructions.isEmpty ? "\(bot.name) ainda não tem instruções. Conte na conversa o que ele deve fazer." : bot.instructions)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(bot.instructions.isEmpty ? Theme.textTertiary : Theme.textSecondary)
                    .lineLimit(8)
                    .textSelection(.enabled)
                Button {
                    text = bot.instructions
                    isEditing = true
                } label: {
                    Label("Editar instruções", systemImage: "chevron.right")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.brandText)
                }
                .buttonStyle(.plain)
                .clickable()
                .disabled(bot.isPending)
            }
        }
        .springAnimation(value: isEditing)
    }
}

struct MemoryToggleRow: View {
    let title: String
    let detail: String
    let isOn: Binding<Bool>

    var body: some View {
        HStack(spacing: Spacing.m) {
            Image(systemName: "brain")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                Text(detail)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer(minLength: Spacing.m)
            Toggle(title, isOn: isOn)
                .toggleStyle(.switch)
                .labelsHidden()
                .tint(Theme.brandAccent)
                .clickable()
        }
    }
}
