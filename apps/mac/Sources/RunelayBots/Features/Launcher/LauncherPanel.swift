import SwiftUI

enum LauncherDestination: String, CaseIterable, Identifiable {
    case git
    case linear
    case agenda
    case notes
    case routines
    case connectors
    case usage

    var id: String { rawValue }

    var title: String {
        switch self {
        case .git: "GitHub"
        case .linear: "Linear"
        case .agenda: "Agenda"
        case .notes: "Notas e planilhas"
        case .routines: "Rotinas"
        case .connectors: "Conectores"
        case .usage: "Uso"
        }
    }

    var symbol: String {
        switch self {
        case .git: "arrow.triangle.pull"
        case .linear: "circle.dashed"
        case .agenda: "calendar.badge.clock"
        case .notes: "doc.on.doc"
        case .routines: "list.bullet"
        case .connectors: "safari"
        case .usage: "gauge.with.dots.needle.33percent"
        }
    }

    var brandMark: BrandMark? {
        switch self {
        case .git: .github
        case .linear: .linear
        case .agenda: .googleCalendar
        default: nil
        }
    }

    var tint: Color {
        switch self {
        case .git: Theme.textPrimary
        case .linear: BrandMark.linearColor
        case .agenda: Theme.accent("blue")
        case .notes: Theme.attention
        case .routines: Theme.brandText
        case .connectors: Theme.accent("teal")
        case .usage: Theme.textSecondary
        }
    }

    var needsBot: Bool {
        self == .agenda || self == .notes
    }
}

struct LauncherLayer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if model.launcherPresented {
                Theme.scrim
                    .opacity(0.55)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                    .transition(.opacity)
                    .accessibilityHidden(true)
                LauncherPanel(close: close)
                    .padding(.leading, FrameMetrics.railWidth + Spacing.s)
                    .padding(.bottom, FrameMetrics.panelInset + 64)
                    .transition(transition)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .allowsHitTesting(model.launcherPresented)
    }

    private var transition: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .move(edge: .leading).combined(with: .opacity).combined(with: .scale(scale: 0.96, anchor: .bottomLeading)),
            removal: .opacity.combined(with: .scale(scale: 0.97, anchor: .bottomLeading)).combined(with: .offset(x: -16))
        )
    }

    private func close() {
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            model.launcherPresented = false
        }
    }
}

private struct LauncherPanel: View {
    let close: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Atalhos")
                        .font(BrandFonts.sans(16, weight: .semibold))
                        .tracking(-0.16)
                        .foregroundStyle(Theme.textPrimary)
                    Text("Tudo o que você acompanha, a um clique")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: 0)
                BoardIconButton(systemImage: "xmark", help: "Fechar (Esc)", action: close)
            }

            VStack(spacing: Spacing.xxs) {
                ForEach(Array(LauncherDestination.allCases.enumerated()), id: \.element) { index, destination in
                    LauncherTile(
                        destination: destination,
                        summary: summary(for: destination),
                        isActive: isActive(destination),
                        isEnabled: isAvailable(destination),
                        accessory: accessory(for: destination)
                    ) {
                        open(destination)
                    }
                    .opacity(appeared ? 1 : 0)
                    .offset(x: appeared || reduceMotion ? 0 : -10)
                    .animation(reduceMotion ? Motion.reduced : Motion.spring.delay(Double(index) * 0.025), value: appeared)
                }
            }
        }
        .padding(Spacing.l)
        .frame(width: 344)
        .glassPane(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .softElevation(lifted: true)
        .background {
            Button("", action: close)
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .accessibilityHidden(true)
        }
        .onAppear { appeared = true }
        .task {
            GitHubStore.shared.attach(model.client)
            LinearStore.shared.attach(model.client)
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await GitHubStore.shared.loadSummary() }
                group.addTask { await LinearStore.shared.loadSummary() }
                group.addTask {
                    if await LinearStore.shared.views.isEmpty { await LinearStore.shared.loadViews(refresh: false) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Atalhos")
    }

    private var bot: Bot? {
        if let selected = model.selectedBot, !selected.isGroup, !selected.isPending { return selected }
        return model.loadedBots.first { !$0.isGroup && !$0.isPending }
    }

    private func isAvailable(_ destination: LauncherDestination) -> Bool {
        !destination.needsBot || bot != nil
    }

    private func isActive(_ destination: LauncherDestination) -> Bool {
        guard !model.settingsPresented else { return false }
        switch destination {
        case .git: return model.section == .git
        case .linear: return model.section == .linear
        case .routines: return model.section == .routines
        case .connectors: return model.section == .connectors
        case .usage: return model.section == .usage
        case .agenda: return model.section == .conversations && ArtifactCenter.shared.current?.kind == BlockKind.agenda.rawValue
        case .notes: return model.section == .conversations && ArtifactCenter.shared.current?.kind == BlockKind.filesKind
        }
    }

    private func accessory(for destination: LauncherDestination) -> AnyView? {
        guard destination == .linear, let view = LinearStore.shared.currentView else { return nil }
        return AnyView(
            HStack(spacing: 4) {
                LinearViewIcon(view: view, size: 13)
                Text(view.name)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }
            .frame(maxWidth: 110, alignment: .trailing)
        )
    }

    private func summary(for destination: LauncherDestination) -> String {
        switch destination {
        case .git:
            let store = GitHubStore.shared
            if let counts = store.summary {
                if counts.review > 0 {
                    return counts.review == 1 ? "1 PR esperando sua revisão" : "\(counts.review) PRs esperando sua revisão"
                }
                if counts.mine > 0 {
                    return counts.mine == 1 ? "1 PR seu aberto" : "\(counts.mine) PRs seus abertos"
                }
                return "Nenhum PR pendente"
            }
            if store.summaryError != nil { return "Não deu para falar com o GitHub" }
            return "Carregando…"
        case .linear:
            let store = LinearStore.shared
            if let summary = store.summary {
                let count = "\(summary.started)\(summary.more ? "+" : "")"
                if summary.started == 0 { return "Nada em andamento com você" }
                return summary.started == 1 && !summary.more ? "1 issue em andamento" : "\(count) issues em andamento"
            }
            if let error = store.summaryError {
                return error.localizedCaseInsensitiveContains("conect") ? "Conecte o Linear em Conectores" : "Não deu para falar com o Linear"
            }
            return "Carregando…"
        case .agenda:
            guard let bot else { return "Crie um bot para usar a agenda" }
            return "Semana com suas contas do Google · \(bot.name)"
        case .notes:
            guard let bot else { return "Crie um bot para guardar notas" }
            return "Arquivos de \(bot.name)"
        case .routines:
            return "Tarefas que seus bots fazem sozinhos"
        case .connectors:
            if case .loaded(let list) = model.connectors {
                let ready = list.filter { $0.status == "ok" }.count
                return ready == 1 ? "1 conta conectada" : "\(ready) contas conectadas"
            }
            return "Catálogo de contas e ferramentas"
        case .usage:
            return "Limites e consumo das contas de IA"
        }
    }

    private func open(_ destination: LauncherDestination) {
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            model.launcherPresented = false
            model.closeSettings()
            switch destination {
            case .git: model.section = .git
            case .linear: model.section = .linear
            case .routines: model.section = .routines
            case .connectors: model.section = .connectors
            case .usage: model.section = .usage
            case .agenda, .notes:
                guard let bot else { return }
                model.section = .conversations
                if model.selectedBotID != bot.id {
                    model.selectBot(bot.id)
                }
                if destination == .agenda {
                    ArtifactCenter.shared.open(
                        ArtifactRef(botID: bot.id, id: BlockKind.agendaID, title: "Agenda", kind: BlockKind.agenda.rawValue, version: 1),
                        client: model.client
                    )
                } else {
                    ArtifactCenter.shared.openFiles(botID: bot.id, client: model.client)
                }
            }
        }
    }
}

private struct LauncherTile: View {
    let destination: LauncherDestination
    let summary: String
    let isActive: Bool
    let isEnabled: Bool
    var accessory: AnyView? = nil
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.m) {
                LauncherGlyph(destination: destination)
                    .foregroundStyle(destination.tint)
                    .frame(width: 34, height: 34)
                    .background(destination.tint.opacity(hovering || isActive ? 0.18 : 0.11), in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(destination.title)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Text(summary)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .contentTransition(.opacity)
                }
                Spacer(minLength: 0)
                if let accessory, !hovering {
                    accessory
                        .transition(.opacity)
                }
                Image(systemName: isActive ? "checkmark" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(isActive ? Theme.textSecondary : Theme.textTertiary)
                    .opacity(hovering || isActive ? 1 : 0)
                    .offset(x: hovering ? 0 : -4)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 50)
            .background(isActive ? Theme.selection : hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
        .onHover { hovering = $0 && isEnabled }
        .springAnimation(value: hovering)
        .springAnimation(value: summary)
        .accessibilityLabel("\(destination.title), \(summary)")
    }
}

private struct LauncherGlyph: View {
    let destination: LauncherDestination

    var body: some View {
        if let mark = destination.brandMark {
            BrandMarkImage(mark: mark, size: 16)
        } else {
            Image(systemName: destination.symbol)
                .font(.system(size: 14, weight: .medium))
        }
    }
}
