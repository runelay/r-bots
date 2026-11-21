import SwiftUI

struct BotConversationScreen: View {
    @Environment(AppModel.self) private var model
    let botID: String

    @State private var sessionID: String?
    @State private var isDraft = false
    @State private var resolving = true
    @State private var showsList = false
    @State private var active: ConversationStore?
    @State private var calling = false
    @State private var showsDetails = false

    private var bot: Bot? { model.bot(id: botID) }

    private var conversation: BotConversation? {
        guard let sessionID else { return nil }
        return model.conversations(for: botID).first { $0.sessionId == sessionID }
    }

    var body: some View {
        Group {
            if let active {
                ConversationView(store: active) {
                    calling = true
                }
                .id(ObjectIdentifier(active))
            } else if resolving {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Conversa indisponível", systemImage: "bubble.left.and.exclamationmark.bubble.right")
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {
                    showsDetails = true
                } label: {
                    titleView
                }
                .buttonStyle(.plain)
                .accessibilityHint("Abre os detalhes do bot")
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showsList = true
                } label: {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .foregroundStyle(Theme.textPrimary)
                }
                .accessibilityLabel("Conversas")
            }
        }
        .fullScreenCover(isPresented: $calling) {
            if let bot, let active {
                CallScreen(bot: bot, store: active)
                    .environment(model)
            }
        }
        .sheet(isPresented: $showsDetails) {
            if let bot {
                BotDetailsScreen(botID: bot.id, sessionID: active?.sessionId)
                    .environment(model)
            }
        }
        .sheet(isPresented: $showsList) {
            if let bot {
                ConversationListSheet(bot: bot, selected: isDraft ? nil : sessionID) { choice in
                    switch choice {
                    case .new:
                        isDraft = true
                        sessionID = nil
                    case .existing(let id):
                        isDraft = false
                        sessionID = id
                    }
                    activate()
                }
            }
        }
        .task(id: bot != nil) {
            guard let bot, sessionID == nil, !isDraft, active == nil else { return }
            sessionID = await model.resolveMainSession(for: bot)
            resolving = false
            activate()
        }
        .onDisappear {
            if let active { model.close(active) }
        }
        .onAppear {
            if let active { model.open(active) }
        }
    }

    private func activate() {
        guard let bot else { return }
        let next: ConversationStore?
        if isDraft {
            next = model.draftStore(for: bot) { created in
                isDraft = false
                sessionID = created
            }
        } else if let sessionID {
            next = model.store(for: bot, sessionID: sessionID)
        } else {
            next = nil
        }
        if let previous = active, previous !== next {
            model.close(previous)
        }
        active = next
        if let next {
            model.open(next)
            model.markRead(bot: bot, sessionID: next.sessionId)
        }
    }

    private var titleView: some View {
        HStack(spacing: Spacing.s) {
            if let bot {
                BotAvatar(bot: bot, mood: model.mood(for: bot.id), size: 26)
            }
            ViewThatFits(in: .horizontal) {
                titleText(full: true)
                titleText(full: false)
            }
            .font(BrandFonts.sans(15, weight: .medium))
            .contentTransition(.opacity)
        }
        .padding(.leading, 6)
        .padding(.trailing, Spacing.m + 2)
        .frame(height: 40)
        .glassEffect(.regular.interactive(), in: Capsule())
        .animation(Motion.spring, value: subtitle?.text)
        .accessibilityElement(children: .combine)
    }

    private func titleText(full: Bool) -> some View {
        let name = Text(bot?.name ?? "").foregroundStyle(Theme.textPrimary)
        let detail: Text
        if let subtitle {
            detail = Text(full ? "  \(subtitle.text)" : "").foregroundStyle(subtitle.color)
        } else {
            let role = bot?.role ?? ""
            detail = Text(full && !role.isEmpty ? " | \(role)" : "").foregroundStyle(Theme.textSecondary)
        }
        return (name + detail)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
    }

    private var subtitle: (text: String, color: Color)? {
        if let active {
            switch active.botStatus {
            case .working: return ("Trabalhando…", Theme.brandText)
            case .awaitingApproval: return ("Precisa de você", Theme.attention)
            default: break
            }
        }
        if isDraft { return ("Nova conversa", Theme.textTertiary) }
        if let conversation, !conversation.isMain { return (conversation.title, Theme.textTertiary) }
        return nil
    }
}

enum ConversationChoice {
    case new
    case existing(String)
}

struct ConversationListSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let bot: Bot
    let selected: String?
    let choose: (ConversationChoice) -> Void

    private var conversations: [BotConversation] {
        model.conversations(for: bot.id).sorted { lhs, rhs in
            if lhs.isMain != rhs.isMain { return lhs.isMain }
            return (lhs.activityDate ?? .distantPast) > (rhs.activityDate ?? .distantPast)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Button {
                    choose(.new)
                    dismiss()
                } label: {
                    HStack(spacing: Spacing.m) {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(Theme.brandText)
                            .frame(width: 32, height: 32)
                        Text("Nova conversa")
                            .font(BrandFonts.sans(16, weight: .medium))
                            .foregroundStyle(Theme.brandText)
                    }
                }
                .listRowBackground(Theme.background)
                .listRowSeparator(.hidden)
                ForEach(conversations) { conversation in
                    Button {
                        choose(.existing(conversation.sessionId))
                        dismiss()
                    } label: {
                        ConversationRow(conversation: conversation, isSelected: conversation.sessionId == selected)
                    }
                    .listRowBackground(conversation.sessionId == selected ? Theme.selection : Theme.background)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Conversas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
            .refreshable {
                await model.loadConversations(for: bot.id)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.background)
        .task {
            await model.loadConversations(for: bot.id)
        }
    }
}

struct ConversationRow: View {
    @Environment(AppModel.self) private var model
    let conversation: BotConversation
    let isSelected: Bool

    var body: some View {
        let status = model.status(of: conversation)
        HStack(spacing: Spacing.m) {
            Image(systemName: conversation.isMain ? "house" : "bubble.left")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Spacing.s) {
                    Text(conversation.isMain ? "Conversa principal" : conversation.title)
                        .font(BrandFonts.sans(15, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.s)
                    if let date = conversation.activityDate {
                        Text(ShortStamp.label(for: date, now: Date()))
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                HStack(spacing: Spacing.s) {
                    Group {
                        switch status {
                        case .working:
                            Text("Trabalhando…").foregroundStyle(Theme.brandText)
                        case .awaitingApproval:
                            Text("Precisa de você").foregroundStyle(Theme.attention)
                        default:
                            Text(conversation.lastMessage?.text.replacingOccurrences(of: "\n", with: " ") ?? "Sem mensagens")
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .font(TypeScale.rowSubtitle)
                    .lineLimit(1)
                    Spacer(minLength: 0)
                    if conversation.unread > 0, !isSelected {
                        Text("\(conversation.unread)")
                            .font(TypeScale.counter)
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 6)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(Theme.brandAccent, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, Spacing.xs)
        .contentShape(Rectangle())
    }
}
