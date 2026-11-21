import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let store: ConversationStore
    var onCall: (() -> Void)?

    @State private var position = ScrollPosition(edge: .bottom)
    @State private var pinned = true
    @State private var opening: AttachmentRef?

    var body: some View {
        let snapshot = store.transcriptSnapshot(now: Date())
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if store.hasOlder {
                    olderRow
                }
                ForEach(snapshot.items) { item in
                    TranscriptItemView(item: item, store: store, bubbles: snapshot.bubbles)
                        .padding(.top, spacing(before: item, bubbles: snapshot.bubbles))
                        .transition(Motion.message(fromTrailing: isUser(item), reduceMotion: reduceMotion))
                }
                if store.showsThinking, store.mood != .waiting {
                    ThinkingRow(bot: store.bot, mood: store.mood, queuePosition: store.queuePosition)
                        .padding(.top, Spacing.l)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, Spacing.l)
            .padding(.top, Spacing.s)
            .padding(.bottom, Spacing.l)
            .animation(Motion.animation(reduceMotion: reduceMotion), value: store.entryMotion)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
        .scrollDismissesKeyboard(.interactively)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.visibleRect.maxY >= geometry.contentSize.height - 120
        } action: { _, near in
            if pinned != near {
                pinned = near
            }
        }
        .onChange(of: store.entries.count) { followEnd() }
        .onChange(of: store.liveText.texts) { followEnd(animated: false) }
        .onChange(of: store.showsThinking) { followEnd() }
        .overlay {
            if snapshot.items.isEmpty {
                emptyState
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !pinned, !snapshot.items.isEmpty {
                jumpButton
                    .padding(.trailing, Spacing.l)
                    .padding(.bottom, Spacing.m)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            footer
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: pinned)
        .background(Theme.background.ignoresSafeArea())
        .environment(\.openAttachment) { opening = $0 }
        .modifier(AttachmentPreviewer(opening: $opening, client: store.clientValue))
    }

    private func isUser(_ item: TranscriptItem) -> Bool {
        if case .entry(let entry) = item, entry.kind == .user { return true }
        return false
    }

    private func spacing(before item: TranscriptItem, bubbles: [String: BubbleMeta]) -> CGFloat {
        if case .entry(let entry) = item, let meta = bubbles[entry.id], !meta.isFirst {
            return 3
        }
        return Spacing.m + 2
    }

    private func followEnd(animated: Bool = true) {
        guard pinned else { return }
        if animated, !reduceMotion {
            withAnimation(Motion.spring) {
                position.scrollTo(edge: .bottom)
            }
        } else {
            position.scrollTo(edge: .bottom)
        }
    }

    private var olderRow: some View {
        HStack {
            Spacer()
            if store.isLoadingOlder {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button("Ver mensagens anteriores") {
                    store.loadOlder()
                }
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
        }
        .frame(height: 36)
    }

    @ViewBuilder
    private var emptyState: some View {
        if store.isLoadingHistory {
            ProgressView()
                .controlSize(.small)
        } else if !store.showsThinking {
            VStack(spacing: Spacing.m) {
                BotAvatar(bot: store.bot, mood: .idle, size: 56)
                Text(store.sessionId == nil ? "Nova conversa com \(store.bot.name)" : "Comece uma conversa com \(store.bot.name)")
                    .font(BrandFonts.sans(16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                if !store.bot.role.isEmpty {
                    Text(store.bot.role)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                }
            }
            .padding(.horizontal, Spacing.xxl)
            .allowsHitTesting(false)
        }
    }

    private var jumpButton: some View {
        Button {
            pinned = true
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                position.scrollTo(edge: .bottom)
            }
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .frame(width: 40, height: 40)
                .glassEffect(.regular.interactive(), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ir para o fim")
    }

    private var footer: some View {
        VStack(spacing: Spacing.s) {
            if let error = store.lastError {
                Button {
                    store.dismissError()
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                        Image(systemName: "exclamationmark.circle.fill")
                        Text(error)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                    }
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, Spacing.s + 2)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                }
                .buttonStyle(.plain)
                .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
            if store.connection == .reconnecting {
                Text("Reconectando…")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .transition(.opacity)
            }
            if let question = store.openQuestion {
                QuestionCardView(store: store, approval: question)
                    .id(question.id)
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            } else {
                ComposerBar(store: store, onCall: onCall)
                    .transition(Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .padding(.horizontal, Spacing.m)
        .padding(.top, Spacing.xs)
        .padding(.bottom, Spacing.s)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.lastError)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.openQuestion?.id)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.connection)
    }
}

