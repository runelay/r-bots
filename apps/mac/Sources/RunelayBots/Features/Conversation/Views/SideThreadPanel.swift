import SwiftUI

enum SideThread {
    static let panelKind = "side"

    static func command(in draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("/side") else { return nil }
        let rest = trimmed.dropFirst(5)
        guard rest.isEmpty || rest.first?.isWhitespace == true else { return nil }
        return rest.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct SideThreadPanel: View {
    let ref: ArtifactRef

    @Environment(AppModel.self) private var model
    @State private var focusToken = 0

    private var presentation: BlockPresentation { .shared }

    private var conversation: BotConversation? {
        model.conversations(for: ref.botID).first { $0.sessionId == ref.id }
    }

    private var parentTitle: String? {
        guard let parent = conversation?.parentSessionId else { return nil }
        return model.conversations(for: ref.botID).first { $0.sessionId == parent }?.title
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .zIndex(1)
            Group {
                if let store = model.sideStore, store.sessionId == ref.id, let bot = model.bot(id: ref.botID) {
                    ConversationView(store: store, bot: bot, focusToken: focusToken, compact: true)
                        .id(ObjectIdentifier(store))
                } else {
                    PanelEmptyState(
                        systemImage: "rectangle.split.2x1",
                        title: "Conversa secundária fechada",
                        message: "Abra de novo pela barra lateral."
                    )
                    .frame(maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear {
            focusToken &+= 1
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(conversation?.title ?? ref.title)
                    .font(TypeScale.rowSubtitle.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(parentTitle.map { "Secundária de \($0)" } ?? "Conversa secundária")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: Spacing.s)
            BlockHeaderButton(systemImage: "arrow.up.left.and.arrow.down.right", help: "Abrir como conversa principal") {
                model.promoteSide()
            }
            BlockHeaderButton(systemImage: "xmark", help: "Fechar") {
                presentation.close()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 44)
    }
}
