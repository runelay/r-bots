import AppKit
import SwiftUI

private struct InlineLink: View {
    let title: String
    var color: Color = Theme.brandText
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(color)
                .underline(hovering)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }
}

struct PullRequestEventLine: View {
    let event: PullRequestEvent
    let ask: (String) -> Void
    @State private var asked = false

    var body: some View {
        VStack(spacing: Spacing.xs) {
            HStack(spacing: Spacing.s) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(color)
                Text(title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let url = event.logURL ?? (event.kind == .ciFailed ? nil : event.prURL) {
                    Text("·").foregroundStyle(Theme.textTertiary)
                    InlineLink(title: event.kind == .ciFailed ? "Ver log ↗" : "Abrir ↗") {
                        NSWorkspace.shared.open(url)
                    }
                    .help(url.absoluteString)
                }
                if let request {
                    Text("·").foregroundStyle(Theme.textTertiary)
                    InlineLink(title: asked ? "Pedido enviado" : "Pedir para corrigir", color: asked ? Theme.textTertiary : Theme.brandText) {
                        guard !asked else { return }
                        asked = true
                        ask(request)
                    }
                    .disabled(asked)
                    .help("Manda para o bot o que falhou, com o log resumido")
                }
            }
            if event.kind == .changesRequested, !summary.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(summary.prefix(4).enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .lineLimit(2)
                            .truncationMode(.tail)
                    }
                    if summary.count > 4 {
                        Text("e mais \(summary.count - 4)")
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .frame(maxWidth: 460, alignment: .leading)
            }
        }
        .font(TypeScale.captionStrong)
        .foregroundStyle(Theme.textSecondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xs)
        .help(event.kind == .ciFailed ? (event.log ?? "") : "")
        .springAnimation(value: asked)
    }

    private var title: String {
        switch event.kind {
        case .ciFailed: "CI falhou · \(event.check ?? "check")"
        case .ciPassed: "CI passou ✓"
        case .changesRequested: "Review pediu mudanças\(event.check.map { " · \($0)" } ?? "")"
        case .approved: "Review aprovado ✓"
        }
    }

    private var symbol: String {
        switch event.kind {
        case .ciFailed: "xmark.circle.fill"
        case .ciPassed: "checkmark.circle.fill"
        case .changesRequested: "exclamationmark.bubble.fill"
        case .approved: "checkmark.seal.fill"
        }
    }

    private var color: Color {
        switch event.kind {
        case .ciFailed, .changesRequested: Theme.danger
        case .ciPassed, .approved: Theme.success
        }
    }

    private var summary: [String] {
        var lines: [String] = []
        if let body = event.log, !body.isEmpty { lines.append(body) }
        lines.append(contentsOf: event.comments)
        return lines
    }

    private var request: String? {
        switch event.kind {
        case .ciFailed: event.fixRequest
        case .changesRequested: event.reviewRequest
        default: nil
        }
    }
}

struct PullRequestPillBadge: View {
    let pr: PullRequestInfo

    var body: some View {
        HStack(spacing: Spacing.xs) {
            switch pr.status {
            case .merged:
                Image(systemName: "arrow.triangle.merge")
                    .font(.system(size: 10, weight: .bold))
                Text("Mergeado ✓ #\(pr.number)")
            case .closed:
                Image(systemName: "xmark.circle")
                    .font(.system(size: 10, weight: .bold))
                Text("Fechado #\(pr.number)")
            case .open, .draft:
                Text("#\(pr.number)")
                    .foregroundStyle(Theme.textSecondary)
                if pr.ci != .none {
                    Circle()
                        .fill(pr.ci.color)
                        .frame(width: 6, height: 6)
                }
            }
        }
        .font(TypeScale.counter)
        .foregroundStyle(pr.status == .merged ? Theme.merged : pr.status == .closed ? Theme.danger : Theme.textSecondary)
        .padding(.horizontal, pr.status == .merged || pr.status == .closed ? Spacing.s : 0)
        .frame(height: 20)
        .background {
            if pr.status == .merged || pr.status == .closed {
                Capsule().fill(pr.status.color.opacity(0.14))
            }
        }
    }

    var helpText: String {
        "PR #\(pr.number) · \(pr.status.label)\(pr.status == .open || pr.status == .draft ? " · \(pr.ci.label)" : "")"
    }
}

struct PullRequestRow: View {
    let store: ConversationStore
    var workspaceID: String? = nil
    let pr: PullRequestInfo
    let closeRepository: () -> Void
    @State private var hovering = false
    @State private var showsCard = false
    @State private var hoverTask: Task<Void, Never>?

    var body: some View {
        Button {
            showsCard.toggle()
        } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: pr.status.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(pr.status.color)
                    .frame(width: 16)
                Text(pr.shortTitle)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: Spacing.s)
                if pr.status == .open || pr.status == .draft, pr.ci != .none {
                    Circle()
                        .fill(pr.ci.color)
                        .frame(width: 6, height: 6)
                }
                Text("#\(pr.number)")
                    .font(TypeScale.counter)
                    .foregroundStyle(Theme.textTertiary)
            }
            .padding(.horizontal, Spacing.m)
            .frame(height: 30)
            .background(hovering || showsCard ? Theme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { inside in
            hovering = inside
            hoverTask?.cancel()
            guard inside, !showsCard else { return }
            hoverTask = Task {
                try? await Task.sleep(for: .milliseconds(450))
                guard !Task.isCancelled, hovering else { return }
                showsCard = true
            }
        }
        .popover(isPresented: $showsCard, arrowEdge: .trailing) {
            PullRequestCard(store: store, workspaceID: workspaceID, pr: pr, closeRepository: {
                showsCard = false
                closeRepository()
            })
        }
        .help(pr.title)
    }
}

struct PullRequestCard: View {
    let store: ConversationStore
    var workspaceID: String? = nil
    let pr: PullRequestInfo
    let closeRepository: () -> Void
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(spacing: Spacing.s) {
                HStack(spacing: Spacing.xs) {
                    Image(systemName: pr.status.symbol)
                        .font(.system(size: 10, weight: .bold))
                    Text(pr.status.label)
                }
                .font(TypeScale.captionStrong)
                .foregroundStyle(pr.status.color)
                .padding(.horizontal, Spacing.s)
                .frame(height: 22)
                .background(Capsule().fill(pr.status.color.opacity(0.14)))
                Spacer(minLength: Spacing.s)
                Text("#\(pr.number)")
                    .font(TypeScale.counter)
                    .foregroundStyle(Theme.textTertiary)
            }
            Text(pr.title)
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Text("\(pr.base) ← \(pr.head)")
                .font(TypeScale.monoInline)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help("\(pr.base) ← \(pr.head)")
            counts
            if !pr.checks.isEmpty {
                checks
            }
            if let review = pr.reviewLabel {
                HStack(spacing: Spacing.s) {
                    Image(systemName: review.symbol)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(review.color)
                        .frame(width: 16)
                    Text(review.text)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textPrimary)
                }
            }
            if let problem {
                Text(problem)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            actions
        }
        .padding(Spacing.m)
        .frame(width: 320)
        .springAnimation(value: problem)
    }

    private var counts: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.s) {
                Text("\(pr.files) arquivo\(pr.files == 1 ? "" : "s")")
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textPrimary)
                ChangeCount(added: pr.additions, removed: pr.deletions)
            }
            ForEach(pr.categories) { category in
                HStack(spacing: Spacing.s) {
                    Text(category.label)
                        .foregroundStyle(Theme.textSecondary)
                    Text("\(category.files)")
                        .foregroundStyle(Theme.textTertiary)
                    Spacer(minLength: Spacing.s)
                    ChangeCount(added: category.added, removed: category.removed)
                }
                .font(TypeScale.caption)
            }
        }
    }

    private var checks: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(pr.checks) { check in
                        CheckRow(check: check)
                    }
                }
            }
            .frame(maxHeight: 180)
            .fixedSize(horizontal: false, vertical: true)
            .scrollEdgesHidden()
        }
    }

    private var actions: some View {
        HStack(spacing: Spacing.m) {
            if let url = pr.url {
                InlineLink(title: "Abrir no GitHub ↗") {
                    NSWorkspace.shared.open(url)
                }
                .help(url.absoluteString)
            }
            Spacer(minLength: Spacing.s)
            if working {
                ProgressView().controlSize(.mini)
            } else if pr.status == .closed {
                InlineLink(title: "Reabrir") { reopen() }
                    .help("Reabre o PR no GitHub")
                InlineLink(title: "Fechar cópia", color: Theme.textSecondary) { closeRepository() }
                    .help("Remove a worktree. A branch continua no GitHub")
            } else if pr.status == .merged {
                InlineLink(title: "Fechar cópia", color: Theme.merged) { closeRepository() }
                    .help("Remove a worktree. A branch continua no GitHub")
            }
        }
        .font(TypeScale.captionStrong)
    }

    private func reopen() {
        guard CodeActions.confirm("Reabrir o PR #\(pr.number)?", message: "O PR volta a ficar aberto no GitHub.", action: "Reabrir") else { return }
        working = true
        problem = nil
        Task {
            do {
                try await store.reopenPullRequest(workspaceID: workspaceID)
            } catch {
                problem = "Não consegui reabrir o PR agora."
            }
            working = false
        }
    }
}

private struct CheckRow: View {
    let check: PullRequestCheck
    @State private var hovering = false

    var body: some View {
        Button {
            if let url = check.url { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: check.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(check.color)
                    .frame(width: 16)
                Text(check.name)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: Spacing.s)
                if let duration = check.durationText {
                    Text(duration)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .monospacedDigit()
                }
                if check.url != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Theme.textTertiary)
                        .opacity(hovering ? 1 : 0)
                }
            }
            .frame(height: 26)
            .background(hovering && check.url != nil ? Theme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .disabled(check.url == nil)
        .onHover { hovering = $0 }
        .help(check.url == nil ? check.name : "\(check.workflow.map { "\($0) · " } ?? "")\(check.name) · ver o log")
    }
}
