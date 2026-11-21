import SwiftUI

struct BotListScreen: View {
    @Environment(AppModel.self) private var model
    @Binding var path: [Route]
    @Binding var showsSettings: Bool
    @State private var creating = false
    @State private var managingServers = false

    var body: some View {
        content
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Bots")
            .sheet(isPresented: $creating) {
                BotEditorScreen(bot: nil) { created in
                    path.append(.conversation(botID: created.id))
                }
                .environment(model)
            }
            .sheet(isPresented: $managingServers) {
                NavigationStack {
                    ServersScreen()
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("OK") { managingServers = false }
                            }
                        }
                }
                .environment(model)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ServerSwitcher(managing: $managingServers)
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        creating = true
                    } label: {
                        Image(systemName: "plus")
                            .foregroundStyle(Theme.textPrimary)
                    }
                    .accessibilityLabel("Novo bot")
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(Theme.textPrimary)
                    }
                    .accessibilityLabel("Ajustes")
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.listState {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("Sem conexão", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Tentar de novo") {
                    Task { await model.refresh() }
                }
                .buttonStyle(SoftButtonStyle())
            }
        case .loaded:
            if model.visibleBots.isEmpty {
                ContentUnavailableView("Nenhum bot ainda", systemImage: "person.2", description: Text("Crie bots pelo app do Mac e eles aparecem aqui."))
            } else {
                list
            }
        }
    }

    private var list: some View {
        List {
            ForEach(model.visibleBots) { bot in
                Button {
                    path.append(.conversation(botID: bot.id))
                } label: {
                    BotRow(bot: bot)
                }
                .buttonStyle(RowButtonStyle())
                .listRowBackground(Theme.background)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: Spacing.s, leading: Spacing.l, bottom: Spacing.s, trailing: Spacing.l))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable {
            await model.refresh()
        }
    }
}

struct BotRow: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    var body: some View {
        let status = model.status(for: bot.id)
        let unread = model.unread(for: bot)
        let activity = model.activity(for: bot)
        HStack(spacing: Spacing.m + 2) {
            BotAvatar(bot: bot, mood: model.mood(for: bot.id), size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                    Text(bot.name)
                        .font(BrandFonts.sans(16, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.s)
                    if let date = activity?.date {
                        Text(ShortStamp.label(for: date, now: Date()))
                            .font(TypeScale.caption)
                            .monospacedDigit()
                            .foregroundStyle(unread > 0 ? Theme.brandText : Theme.textTertiary)
                    }
                }
                HStack(alignment: .center, spacing: Spacing.s) {
                    subtitle(status: status, activity: activity)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)")
                            .font(TypeScale.counter)
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 6)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(Theme.brandAccent, in: Capsule())
                            .transition(.scale.combined(with: .opacity))
                    }
                }
            }
        }
        .padding(.vertical, Spacing.xs)
        .contentShape(Rectangle())
        .animation(Motion.spring, value: status)
        .animation(Motion.spring, value: unread)
    }

    @ViewBuilder
    private func subtitle(status: BotStatus, activity: ThreadActivity?) -> some View {
        switch status {
        case .working:
            StatusText(text: "Trabalhando…", color: Theme.brandText)
        case .awaitingApproval:
            StatusText(text: "Precisa de você", color: Theme.attention)
        case .error:
            StatusText(text: "Algo deu errado", color: Theme.danger)
        case .idle:
            if let activity {
                Text(preview(activity))
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
            } else {
                Text(bot.role.isEmpty ? "Sem mensagens ainda" : bot.role)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
        }
    }

    private func preview(_ activity: ThreadActivity) -> String {
        let flat = activity.text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return activity.isUser ? "Você: \(flat)" : flat
    }
}

struct StatusText: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(text)
                .font(BrandFonts.sans(14, weight: .medium))
                .foregroundStyle(color)
                .lineLimit(1)
        }
    }
}
