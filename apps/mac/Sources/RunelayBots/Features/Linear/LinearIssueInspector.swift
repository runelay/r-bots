import AppKit
import SwiftUI

struct LinearIssueInspector: View {
    @Environment(\.appReduceMotion) private var reduceMotion

    private var store: LinearStore { .shared }

    var body: some View {
        Group {
            if let detail = store.detail, detail.card.id == store.selectedID {
                LinearIssueContent(detail: detail)
                    .transition(.opacity)
            } else if case .failed(let message) = store.detailPhase {
                VStack(spacing: 0) {
                    closeRow
                    BoardInlineNotice(systemImage: "exclamationmark.icloud", title: "Não deu para abrir a issue", message: message, actionTitle: "Tentar de novo") {
                        Task { await store.reloadDetail() }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: Spacing.m) {
                    closeRow
                    ShimmerBlock(width: 80, height: 18, radius: 9)
                    ShimmerBlock(height: 16)
                    ShimmerBlock(width: 220, height: 16)
                    ForEach(0..<7, id: \.self) { _ in ShimmerBlock(height: 9) }
                    Spacer(minLength: 0)
                }
                .padding(Spacing.xl)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.detail?.card.id)
    }

    private var closeRow: some View {
        HStack {
            Spacer()
            BoardIconButton(systemImage: "xmark", help: "Fechar (Esc)") { store.select(nil) }
        }
        .padding(.top, Spacing.m)
        .padding(.horizontal, Spacing.m)
    }
}

private struct LinearIssueContent: View {
    let detail: LNIssueDetail

    private var store: LinearStore { .shared }
    private var card: LNCard { detail.card }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.l) {
                header
                actions
                properties
                if let pr = card.pr {
                    LinearPullCard(link: pr)
                }
                if !detail.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownView(text: detail.description, fontSize: 13.5, lineSpacing: 3)
                        .textSelection(.enabled)
                } else {
                    Text("Sem descrição.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textTertiary)
                }
                if !detail.children.isEmpty {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        BoardCaption(text: "SUB-ISSUES")
                            .padding(.bottom, Spacing.xs)
                        ForEach(detail.children) { child in
                            LinearChildRow(card: child)
                        }
                    }
                }
                if !detail.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        BoardCaption(text: "LINKS")
                            .padding(.bottom, Spacing.xs)
                        ForEach(detail.attachments, id: \.url) { link in
                            LinearLinkRow(link: link)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: Spacing.m) {
                    BoardCaption(text: detail.comments.isEmpty ? "SEM COMENTÁRIOS" : "\(detail.comments.count) COMENTÁRIO\(detail.comments.count == 1 ? "" : "S")")
                    ForEach(detail.comments) { comment in
                        LinearCommentView(comment: comment)
                    }
                }
            }
            .padding(Spacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollEdgesHidden()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                BoardChip(text: card.state, systemImage: LNStyle.stateSymbol(card.stateType), tint: LNStyle.stateColor(card.stateType), filled: true)
                Text(card.id)
                    .font(BrandFonts.mono(11.5))
                    .foregroundStyle(Theme.textSecondary)
                    .textSelection(.enabled)
                Spacer(minLength: 0)
                if let branch = card.branch {
                    BoardIconButton(systemImage: "arrow.triangle.branch", help: "Copiar a branch \(branch)") {
                        store.copy(branch)
                        store.show(.success("Branch copiada"))
                    }
                }
                BoardIconButton(systemImage: "arrow.up.right.square", help: "Abrir no Linear") {
                    BoardLinks.open(card.url)
                }
                BoardIconButton(systemImage: "xmark", help: "Fechar (Esc)") {
                    store.select(nil)
                }
            }
            Text(card.title)
                .font(BrandFonts.sans(17, weight: .semibold))
                .tracking(-0.17)
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actions: some View {
        HStack(spacing: Spacing.s) {
            if card.stateType != "started" && card.stateType != "completed" {
                BoardActionButton(title: "Iniciar", systemImage: "play.fill", prominent: true, isBusy: store.busy == "start") {
                    Task { await store.startIssue(card.id) }
                }
                .help("Move para o andamento do time e copia a branch")
            } else if let branch = card.branch {
                BoardActionButton(title: "Copiar branch", systemImage: "arrow.triangle.branch") {
                    store.copy(branch)
                    store.show(.success("Branch copiada"))
                }
            }
            if card.assignee == nil {
                BoardActionButton(title: "Atribuir a mim", systemImage: "person.crop.circle.badge.plus", isBusy: store.busy == "assign") {
                    Task { await store.assignToMe(card.id) }
                }
            }
            BoardActionButton(title: "Abrir no Linear", systemImage: "arrow.up.right") {
                BoardLinks.open(card.url)
            }
        }
        .disabled(store.busy != nil)
    }

    private var properties: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            PropertyRow(label: "Status") {
                GlassMenuButton(help: "Mudar o status", items: {
                    detail.states.map { state in
                        GlassMenuItem(state.name, id: state.id, systemImage: LNStyle.stateSymbol(state.type), isOn: state.name == card.state) {
                            Task { await store.move(card.id, to: "\(state.type):\(state.name)") }
                        }
                    }
                }) { isOpen in
                    HStack(spacing: 6) {
                        StateIcon(type: card.stateType, size: 11)
                        Text(card.state)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textPrimary)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                    }
                    .padding(.horizontal, Spacing.s)
                    .frame(height: 24)
                    .background(isOpen ? Theme.selection : Theme.hover, in: Capsule())
                }
            }
            PropertyRow(label: "Prioridade") {
                HStack(spacing: 6) {
                    PriorityIcon(priority: card.priority)
                    Text(LNStyle.priorityTitle(card.priority)).propertyValue()
                }
            }
            PropertyRow(label: "Responsável") {
                if let assignee = card.assignee {
                    HStack(spacing: 6) {
                        RemoteAvatar(url: nil, name: assignee, size: 18)
                        Text(assignee).propertyValue()
                    }
                } else {
                    Text("Ninguém").propertyValue(muted: true)
                }
            }
            if let team = card.team {
                PropertyRow(label: "Time") { Text(team).propertyValue() }
            }
            if let project = card.project {
                PropertyRow(label: "Projeto") { Text(project).propertyValue() }
            }
            if let estimate = card.estimate {
                PropertyRow(label: "Estimativa") { Text(estimate.formatted()).propertyValue() }
            }
            if let due = BoardDates.parse(detail.dueDate.map { $0.count == 10 ? "\($0)T12:00:00Z" : $0 }) {
                PropertyRow(label: "Prazo") { Text(due.formatted(.dateTime.day().month(.wide))).propertyValue() }
            }
            if !card.labels.isEmpty {
                PropertyRow(label: "Etiquetas") {
                    HStack(spacing: 4) {
                        ForEach(card.labels, id: \.self) { BoardChip(text: $0) }
                    }
                }
            }
            PropertyRow(label: "Atualizada") { Text(BoardDates.relative(card.updatedAt)).propertyValue(muted: true) }
        }
        .padding(Spacing.m)
        .background(Theme.hover, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

private struct PropertyRow<Value: View>: View {
    let label: String
    @ViewBuilder let value: Value

    var body: some View {
        HStack(spacing: Spacing.m) {
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 84, alignment: .leading)
            value
            Spacer(minLength: 0)
        }
        .frame(minHeight: 28)
    }
}

private extension Text {
    func propertyValue(muted: Bool = false) -> some View {
        self
            .font(TypeScale.rowSubtitle)
            .foregroundStyle(muted ? Theme.textTertiary : Theme.textPrimary)
            .lineLimit(1)
    }
}

private struct LinearPullCard: View {
    let link: LNPullLink

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        Button {
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                GitHubStore.shared.focus(repo: link.repo, number: link.number)
                model.closeSettings()
                model.section = .git
            }
        } label: {
            HStack(spacing: Spacing.m) {
                Image(systemName: link.state == "merged" ? "arrow.triangle.merge" : "arrow.triangle.pull")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(link.state == "merged" ? Theme.merged : link.state == "closed" ? Theme.danger : link.draft ? Theme.textTertiary : Theme.success)
                    .frame(width: 32, height: 32)
                    .background(Theme.background, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(link.title)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Text("\(link.repo.split(separator: "/").last.map(String.init) ?? link.repo) #\(link.number)")
                        if link.state == "open", link.ci != "none" {
                            Text("·")
                            BoardDot(color: GHStyle.ciColor(link.ci), size: 6)
                            Text(GHStyle.ciTitle(link.ci))
                        }
                        if link.state == "open", let review = GHStyle.reviewTitle(link.review) {
                            Text("·")
                            Text(review)
                        }
                    }
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("Abrir no Git")
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(hovering ? Theme.textPrimary : Theme.textTertiary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .padding(Spacing.m)
            .background(hovering ? Theme.selection : Theme.hover, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }
}

private struct LinearChildRow: View {
    let card: LNCard

    @State private var hovering = false

    var body: some View {
        Button {
            LinearStore.shared.select(card.id)
        } label: {
            HStack(spacing: Spacing.s) {
                StateIcon(type: card.stateType, size: 11.5)
                Text(card.id)
                    .font(BrandFonts.mono(10.5))
                    .foregroundStyle(Theme.textTertiary)
                Text(card.title)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let assignee = card.assignee {
                    RemoteAvatar(url: nil, name: assignee, size: 16)
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 32)
            .background(hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }
}

private struct LinearLinkRow: View {
    let link: LNAttachment

    @State private var hovering = false

    var body: some View {
        Button {
            BoardLinks.open(link.url)
        } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: link.url.contains("github.com") ? "arrow.triangle.pull" : "link")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 16)
                Text(link.title)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                if let subtitle = link.subtitle {
                    Text(subtitle)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(hovering ? Theme.textPrimary : Theme.textTertiary)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 32)
            .background(hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }
}

private struct LinearCommentView: View {
    let comment: LNComment

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            RemoteAvatar(url: nil, name: comment.author, size: 24)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: 5) {
                    Text(comment.author)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textPrimary)
                    Text(BoardDates.relative(comment.createdAt))
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                if let quoted = comment.quotedText {
                    Text(quoted)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                        .padding(.leading, Spacing.s)
                        .overlay(alignment: .leading) {
                            Capsule().fill(Theme.textTertiary).frame(width: 2)
                        }
                }
                MarkdownView(text: comment.body, fontSize: 13, lineSpacing: 2)
                    .textSelection(.enabled)
                    .padding(Spacing.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            }
        }
        .padding(.leading, comment.parentId == nil ? 0 : 32)
    }
}
