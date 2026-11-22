import AppKit
import SwiftUI

enum GitInspectorTab: String, CaseIterable, Identifiable, Hashable {
    case description
    case conversation
    case files
    case checks

    var id: String { rawValue }
}

struct GitPullInspector: View {
    @State private var tab: GitInspectorTab = .description
    @Environment(\.appReduceMotion) private var reduceMotion

    private var store: GitHubStore { .shared }

    var body: some View {
        Group {
            if store.selectedKey == nil {
                BoardInlineNotice(systemImage: "arrow.triangle.pull", title: tr("Escolha um PR"), message: tr("A descrição, a conversa, os arquivos e os checks aparecem aqui."))
            } else if let detail = store.detail, detail.pull.key == store.selectedKey {
                loaded(detail)
                    .transition(.opacity)
            } else if case .failed(let message) = store.detailPhase {
                BoardInlineNotice(systemImage: "exclamationmark.icloud", title: tr("Não deu para abrir o PR"), message: message, actionTitle: tr("Tentar de novo")) {
                    Task { await store.reloadDetail(refresh: true) }
                }
            } else {
                GitInspectorSkeleton()
                    .transition(.opacity)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.detail?.pull.key)
    }

    private func loaded(_ detail: GHPullDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.l) {
                GitInspectorHeader(detail: detail)
                PillTabs(tabs: GitInspectorTab.allCases, selection: $tab) { title(for: $0, detail: detail) }
                switch tab {
                case .description:
                    GitDescriptionTab(detail: detail)
                case .conversation:
                    GitConversationTab(detail: detail)
                case .files:
                    GitFilesTab(detail: detail)
                case .checks:
                    GitChecksTab(detail: detail)
                }
            }
            .padding(.horizontal, Spacing.xl)
            .padding(.top, Spacing.xl)
            .padding(.bottom, Spacing.xxl + Spacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollEdgesHidden()
        .bottomBar {
            if detail.pull.isOpen {
                GitActionBar(detail: detail)
            }
        }
    }

    private func title(for tab: GitInspectorTab, detail: GHPullDetail) -> String {
        switch tab {
        case .description: return tr("Descrição")
        case .conversation:
            let count = detail.conversation.count + detail.reviews.filter { !$0.body.isEmpty || $0.state != "commented" }.count + detail.threads.count
            return count > 0 ? tr("Conversa %lld", count) : tr("Conversa")
        case .files: return tr("Arquivos %lld", detail.fileCount)
        case .checks: return detail.checks.isEmpty ? "Checks" : "Checks \(detail.checks.count)"
        }
    }
}

private struct GitInspectorSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            ShimmerBlock(width: 90, height: 18, radius: 9)
            ShimmerBlock(height: 16)
            ShimmerBlock(width: 220, height: 16)
            ShimmerBlock(width: 180, height: 10)
            HStack(spacing: Spacing.xs) {
                ForEach(0..<4, id: \.self) { _ in ShimmerBlock(width: 70, height: 26, radius: 13) }
            }
            .padding(.top, Spacing.s)
            ForEach(0..<6, id: \.self) { _ in ShimmerBlock(height: 9) }
            Spacer(minLength: 0)
        }
        .padding(Spacing.xl)
    }
}

private struct GitInspectorHeader: View {
    let detail: GHPullDetail

    private var pull: GHPull { detail.pull }
    private var store: GitHubStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(spacing: Spacing.s) {
                BoardChip(text: GHStyle.stateTitle(pull), systemImage: GHStyle.stateSymbol(pull), tint: GHStyle.stateColor(pull), filled: true)
                Text("\(pull.repo) #\(pull.number)")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                BoardIconButton(systemImage: "arrow.triangle.branch", help: tr("Copiar a branch")) {
                    store.copy(pull.head, notice: tr("Branch copiada"))
                }
                BoardIconButton(systemImage: "arrow.up.right.square", help: tr("Abrir no GitHub")) {
                    BoardLinks.open(pull.url)
                }
            }
            Text(pull.title)
                .font(BrandFonts.sans(17, weight: .semibold))
                .tracking(-0.17)
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                RemoteAvatar(url: pull.author.avatarUrl, name: pull.author.login, size: 18)
                Text(pull.author.login)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                Text(pull.state == "merged" ? "mergeou" : "quer mergear")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                BranchTag(name: pull.head)
                Image(systemName: "arrow.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Theme.textTertiary)
                BranchTag(name: pull.base)
            }
            .lineLimit(1)
            FlowChips(detail: detail)
        }
    }
}

private struct BranchTag: View {
    let name: String

    var body: some View {
        Text(name)
            .font(BrandFonts.mono(11))
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 6)
            .frame(height: 20)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

private struct FlowChips: View {
    let detail: GHPullDetail

    private var pull: GHPull { detail.pull }

    var body: some View {
        HStack(spacing: 5) {
            if pull.ci != "none" {
                BoardChip(text: checksText, systemImage: GHStyle.checkSymbol(pull.ci), tint: GHStyle.ciColor(pull.ci), filled: true)
            }
            if pull.isOpen, let review = GHStyle.reviewTitle(pull.review) {
                BoardChip(text: review, systemImage: GHStyle.reviewSymbol(pull.review), tint: GHStyle.reviewColor(pull.review), filled: true)
            }
            if pull.isOpen {
                switch pull.mergeable {
                case "conflicting":
                    BoardChip(text: tr("Conflitos com %@", pull.base), systemImage: "exclamationmark.triangle", tint: Theme.danger, filled: true)
                case "mergeable" where detail.mergeState == "clean":
                    BoardChip(text: tr("Pronto para mergear"), systemImage: "checkmark", tint: Theme.success, filled: true)
                case "mergeable" where detail.mergeState == "behind":
                    BoardChip(text: tr("Atrás da base"), systemImage: "arrow.down", tint: Theme.warning, filled: true)
                default:
                    EmptyView()
                }
            }
            if let key = pull.linear {
                LinearKeyChip(identifier: key)
            }
            DiffStat(additions: pull.additions, deletions: pull.deletions)
                .padding(.leading, 2)
        }
    }

    private var checksText: String {
        if detail.failedChecks > 0 { return detail.failedChecks == 1 ? tr("1 check falhou") : tr("%lld checks falharam", detail.failedChecks) }
        if detail.pendingChecks > 0 { return tr("%lld rodando", detail.pendingChecks) }
        return GHStyle.ciTitle(pull.ci)
    }
}

private struct GitDescriptionTab: View {
    let detail: GHPullDetail

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            if detail.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Sem descrição.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
            } else {
                BoardRichText(text: detail.body, fontSize: 13.5, lineSpacing: 3)
                    .textSelection(.enabled)
            }
            if !detail.pull.labels.isEmpty {
                HStack(spacing: 5) {
                    ForEach(detail.pull.labels, id: \.name) { label in
                        BoardChip(text: label.name, tint: labelColor(label.color), filled: true)
                    }
                }
            }
            if !detail.commits.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    BoardCaption(
                        text: detail.commitCount > detail.commits.count ? tr("ÚLTIMOS %lld DE %lld COMMITS", detail.commits.count, detail.commitCount) : tr("%lld COMMITS", detail.commitCount))
                    ForEach(detail.commits, id: \.oid) { commit in
                        HStack(spacing: Spacing.s) {
                            RemoteAvatar(url: commit.author.avatarUrl, name: commit.author.login, size: 16)
                            Text(commit.message)
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            Spacer(minLength: Spacing.s)
                            Button {
                                BoardLinks.open(commit.url)
                            } label: {
                                Text(commit.short)
                                    .font(BrandFonts.mono(11))
                                    .foregroundStyle(Theme.textTertiary)
                            }
                            .buttonStyle(.plain)
                            .clickable()
                        }
                        .frame(height: 26)
                    }
                }
            }
        }
    }

    private func labelColor(_ hex: String) -> Color {
        guard let value = Int(hex, radix: 16) else { return Theme.textSecondary }
        let rgb = Theme.rgb(value)
        return Color.dynamic(light: (rgb.red * 0.7, rgb.green * 0.7, rgb.blue * 0.7), dark: rgb)
    }
}

struct BoardCaption: View {
    let text: String

    var body: some View {
        Text(text)
            .font(BrandFonts.sans(10.5, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.textTertiary)
    }
}

private enum TimelineEntry: Identifiable {
    case review(GHReview)
    case comment(GHComment)

    var id: String {
        switch self {
        case .review(let review): "r-\(review.id)"
        case .comment(let comment): "c-\(comment.id)"
        }
    }

    var date: String {
        switch self {
        case .review(let review): review.submittedAt ?? ""
        case .comment(let comment): comment.createdAt
        }
    }
}

private struct GitConversationTab: View {
    let detail: GHPullDetail

    private var timeline: [TimelineEntry] {
        let reviews = detail.reviews
            .filter { !$0.body.isEmpty || $0.state != "commented" }
            .map(TimelineEntry.review)
        let comments = detail.conversation.map(TimelineEntry.comment)
        return (reviews + comments).sorted { $0.date < $1.date }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            if timeline.isEmpty && detail.threads.isEmpty {
                Text("Ninguém comentou ainda.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
            }
            ForEach(timeline) { entry in
                switch entry {
                case .review(let review):
                    GitCommentBubble(
                        author: review.author,
                        action: GHStyle.reviewStateTitle(review.state),
                        date: review.submittedAt,
                        text: review.body,
                        tint: review.state == "approved" ? Theme.success : review.state == "changes_requested" ? Theme.danger : nil
                    )
                case .comment(let comment):
                    GitCommentBubble(author: comment.author, action: tr("comentou"), date: comment.createdAt, text: comment.body, tint: nil)
                }
            }
            if !detail.threads.isEmpty {
                BoardCaption(text: tr("COMENTÁRIOS NO CÓDIGO"))
                    .padding(.top, Spacing.xs)
                ForEach(detail.threads) { thread in
                    GitThreadView(thread: thread)
                }
            }
        }
    }
}

private struct GitCommentBubble: View {
    let author: GHPerson
    let action: String
    let date: String?
    let text: String
    let tint: Color?

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            RemoteAvatar(url: author.avatarUrl, name: author.login, size: 24)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: 5) {
                    Text(author.login)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textPrimary)
                    Text(action)
                        .font(TypeScale.caption)
                        .foregroundStyle(tint ?? Theme.textSecondary)
                    Text(BoardDates.relative(date))
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                if !text.isEmpty {
                    BoardRichText(text: text, fontSize: 13, lineSpacing: 2)
                        .textSelection(.enabled)
                        .padding(Spacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                }
            }
        }
    }
}

private struct GitThreadView: View {
    let thread: GHThread

    @State private var replying = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var store: GitHubStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.system(size: 10.5, weight: .medium))
                Text(thread.line.map { "\(thread.path):\($0)" } ?? thread.path)
                    .font(BrandFonts.mono(11))
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                if thread.resolved {
                    BoardChip(text: tr("Resolvido"), systemImage: "checkmark", tint: Theme.success, filled: true)
                } else if thread.outdated {
                    BoardChip(text: tr("Desatualizado"), tint: Theme.textTertiary)
                }
            }
            .foregroundStyle(Theme.textSecondary)
            ForEach(thread.comments) { comment in
                GitCommentBubble(author: comment.author, action: "", date: comment.createdAt, text: comment.body, tint: nil)
            }
            if replying {
                VStack(alignment: .trailing, spacing: Spacing.s) {
                    TextField("Responder…", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(TypeScale.rowSubtitle)
                        .lineLimit(2...6)
                        .focused($focused)
                        .padding(Spacing.m)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                    HStack(spacing: Spacing.s) {
                        BoardActionButton(title: tr("Cancelar")) {
                            replying = false
                            draft = ""
                        }
                        BoardActionButton(title: tr("Responder"), prominent: true, isBusy: store.busy == "reply") {
                            let text = draft
                            Task {
                                await store.reply(threadID: thread.id, body: text)
                                if store.notice?.isError == false {
                                    draft = ""
                                    replying = false
                                }
                            }
                        }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy != nil)
                    }
                }
                .padding(.leading, 32)
                .onAppear { focused = true }
            } else {
                Button {
                    replying = true
                } label: {
                    Label("Responder", systemImage: "arrowshape.turn.up.left")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textSecondary)
                }
                .buttonStyle(.plain)
                .clickable()
                .padding(.leading, 32)
            }
        }
        .padding(Spacing.m)
        .background(Theme.hover, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

private struct GitFilesTab: View {
    let detail: GHPullDetail

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            if detail.files.isEmpty {
                Text("Nenhum arquivo mudou.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
            }
            ForEach(detail.files, id: \.path) { file in
                HStack(spacing: Spacing.s) {
                    Image(systemName: GHStyle.fileSymbol(file.change))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(file.change == "added" ? Theme.success : file.change == "deleted" ? Theme.danger : Theme.textTertiary)
                        .frame(width: 16)
                    fileName(file.path)
                    Spacer(minLength: Spacing.s)
                    DiffBar(additions: file.additions, deletions: file.deletions)
                    DiffStat(additions: file.additions, deletions: file.deletions)
                }
                .frame(height: 28)
            }
            if detail.fileCount > detail.files.count {
                Text("Mais \(detail.fileCount - detail.files.count) arquivos no GitHub")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.top, Spacing.s)
            }
        }
    }

    private func fileName(_ path: String) -> some View {
        let parts = path.split(separator: "/")
        let name = parts.last.map(String.init) ?? path
        let folder = parts.dropLast().joined(separator: "/")
        return HStack(spacing: 4) {
            Text(name)
                .font(BrandFonts.mono(11.5))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .layoutPriority(1)
            if !folder.isEmpty {
                Text(folder)
                    .font(BrandFonts.mono(10.5))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .help(path)
    }
}

private struct DiffBar: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        let total = max(additions + deletions, 1)
        let green = Int((Double(additions) / Double(total) * 5).rounded())
        HStack(spacing: 1.5) {
            ForEach(0..<5, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(index < green ? Theme.success : additions + deletions == 0 ? Theme.surfaceRaised : Theme.danger)
                    .frame(width: 5, height: 5)
            }
        }
    }
}

private struct GitChecksTab: View {
    let detail: GHPullDetail

    private var store: GitHubStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            if detail.checks.isEmpty {
                Text("Esse PR não tem checks.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
            }
            if detail.failedChecks > 0, detail.pull.isOpen {
                BoardActionButton(title: tr("Rodar as falhas de novo"), systemImage: "arrow.clockwise", isBusy: store.busy == "rerun") {
                    Task { await store.rerunFailed() }
                }
                .disabled(store.busy != nil)
                .padding(.bottom, Spacing.s)
            }
            ForEach(Array(sortedChecks.enumerated()), id: \.offset) { _, check in
                GitCheckRow(check: check)
            }
        }
    }

    private var sortedChecks: [GHCheck] {
        let order = ["failure": 0, "pending": 1, "success": 2, "neutral": 3, "skipped": 4]
        return detail.checks.sorted { (order[$0.status] ?? 5) < (order[$1.status] ?? 5) }
    }
}

private struct GitCheckRow: View {
    let check: GHCheck

    @State private var hovering = false

    var body: some View {
        Button {
            BoardLinks.open(check.url)
        } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: GHStyle.checkSymbol(check.status))
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(GHStyle.checkColor(check.status))
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 0) {
                    Text(check.name)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if let workflow = check.workflow {
                        Text(workflow)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: Spacing.s)
                if check.url != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(hovering ? Theme.textPrimary : Theme.textTertiary)
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 40)
            .background(hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .disabled(check.url == nil)
    }
}

private struct GitActionBar: View {
    let detail: GHPullDetail

    @State private var approving = false
    @State private var requesting = false
    @State private var commenting = false
    @State private var merging = false

    private var store: GitHubStore { .shared }
    private var pull: GHPull { detail.pull }

    var body: some View {
        HStack(spacing: Spacing.s) {
            if !detail.viewerIsAuthor {
                BoardActionButton(title: tr("Aprovar"), systemImage: "checkmark", isBusy: store.busy == "review") {
                    approving = true
                }
                .glassPopup(isPresented: $approving) {
                    GitComposer(title: tr("Aprovar #%lld", pull.number), placeholder: tr("Comentário opcional"), confirmTitle: tr("Aprovar"), requiresText: false, tint: Theme.success) { text in
                        Task { await store.review(event: "approve", body: text) }
                    }
                }
                BoardActionButton(title: tr("Pedir mudanças"), systemImage: "exclamationmark.bubble") {
                    requesting = true
                }
                .glassPopup(isPresented: $requesting) {
                    GitComposer(title: tr("Pedir mudanças"), placeholder: tr("O que precisa mudar?"), confirmTitle: tr("Enviar"), requiresText: true, tint: Theme.danger) { text in
                        Task { await store.review(event: "request_changes", body: text) }
                    }
                }
            }
            BoardActionButton(title: tr("Comentar"), systemImage: "bubble.left") {
                commenting = true
            }
            .glassPopup(isPresented: $commenting) {
                GitComposer(title: tr("Comentar em #%lld", pull.number), placeholder: tr("Escreva um comentário"), confirmTitle: tr("Comentar"), requiresText: true, tint: Theme.brandAccent) { text in
                    Task { await store.comment(text) }
                }
            }
            Spacer(minLength: Spacing.s)
            if pull.draft {
                BoardActionButton(title: tr("Pronto para revisão"), systemImage: "eye", prominent: true, isBusy: store.busy == "ready") {
                    Task { await store.markReady() }
                }
            } else {
                BoardActionButton(title: tr("Mergear"), systemImage: "arrow.triangle.merge", prominent: true, tint: Theme.merged, isBusy: store.busy == "merge") {
                    merging = true
                }
                .disabled(pull.mergeable == "conflicting" || detail.mergeMethods.isEmpty)
                .glassPopup(isPresented: $merging, edge: .trailing) {
                    GitMergePanel(detail: detail)
                }
            }
        }
        .disabled(store.busy != nil)
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.m)
    }
}

private struct GitComposer: View {
    let title: String
    let placeholder: String
    let confirmTitle: String
    let requiresText: Bool
    let tint: Color
    let onSubmit: (String) -> Void

    @State private var text = ""
    @FocusState private var focused: Bool
    @Environment(\.glassPopupDismiss) private var dismiss

    private var canSend: Bool {
        !requiresText || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text(title)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .lineLimit(4...10)
                .focused($focused)
                .padding(Spacing.m)
                .background(Theme.hover, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            HStack(spacing: Spacing.s) {
                Text("Markdown funciona aqui")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                Spacer(minLength: 0)
                BoardActionButton(title: tr("Cancelar")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                BoardActionButton(title: confirmTitle, prominent: true, tint: tint) {
                    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    dismiss()
                    onSubmit(value)
                }
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(Spacing.m)
        .frame(width: 380)
        .onAppear { focused = true }
    }
}

private struct GitMergePanel: View {
    let detail: GHPullDetail

    @State private var method: GHMergeMethod = .squash
    @State private var deleteBranch = true
    @Environment(\.glassPopupDismiss) private var dismiss

    private var store: GitHubStore { .shared }

    private var methods: [GHMergeMethod] {
        detail.mergeMethods.compactMap(GHMergeMethod.init(rawValue:))
    }

    private var warnings: [MergeWarning] {
        var list: [MergeWarning] = []
        if detail.pull.ci == "failure" { list.append(MergeWarning(text: tr("Tem check falhando"), color: Theme.danger)) }
        if detail.pull.ci == "pending" { list.append(MergeWarning(text: tr("Ainda tem check rodando"), color: Theme.warning)) }
        if detail.pull.review == "changes_requested" { list.append(MergeWarning(text: tr("Pediram mudanças neste PR"), color: Theme.danger)) }
        if detail.pull.review == "review_required" { list.append(MergeWarning(text: tr("Ainda falta revisão"), color: Theme.warning)) }
        if detail.mergeState == "blocked" { list.append(MergeWarning(text: tr("A regra da branch pode bloquear o merge"), color: Theme.warning)) }
        if detail.mergeState == "behind" { list.append(MergeWarning(text: tr("A branch está atrás de %@", detail.pull.base), color: Theme.warning)) }
        return list
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Mergear #\(detail.pull.number)")
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                Text("\(detail.pull.head) → \(detail.pull.base)")
                    .font(BrandFonts.mono(11))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            VStack(spacing: Spacing.xxs) {
                ForEach(methods, id: \.self) { option in
                    Button {
                        method = option
                    } label: {
                        HStack(spacing: Spacing.s) {
                            Image(systemName: method == option ? "largecircle.fill.circle" : "circle")
                                .font(.system(size: 13))
                                .foregroundStyle(method == option ? Theme.merged : Theme.textTertiary)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(option.title)
                                    .font(TypeScale.rowSubtitle)
                                    .foregroundStyle(Theme.textPrimary)
                                Text(option.subtitle)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textTertiary)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, Spacing.s)
                        .frame(height: 42)
                        .background(method == option ? Theme.selection : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .clickable()
                }
            }
            if !detail.crossRepository && !detail.deleteBranchOnMerge {
                Toggle(isOn: $deleteBranch) {
                    Text("Apagar a branch depois")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                }
                .toggleStyle(.switch)
                .controlSize(.small)
            }
            if !warnings.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    ForEach(warnings, id: \.text) { warning in
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(warning.color)
                            Text(warning.text)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
            }
            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                BoardActionButton(title: tr("Cancelar")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                BoardActionButton(title: tr("Confirmar merge"), systemImage: "arrow.triangle.merge", prominent: true, tint: Theme.merged) {
                    let chosen = method
                    let delete = deleteBranch && !detail.crossRepository && !detail.deleteBranchOnMerge
                    dismiss()
                    Task { await store.merge(method: chosen, deleteBranch: delete) }
                }
                .disabled(!methods.contains(method))
            }
        }
        .padding(Spacing.m)
        .frame(width: 340)
        .onAppear {
            method = GHMergeMethod(rawValue: detail.defaultMergeMethod).flatMap { methods.contains($0) ? $0 : nil } ?? methods.first ?? .merge
        }
    }
}

private struct MergeWarning {
    let text: String
    let color: Color
}
