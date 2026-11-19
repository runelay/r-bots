import SwiftUI

struct SetupGuide: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    private let store = OnboardingStore.shared
    private let activity = ComputerExecutor.shared.activity

    private var steps: [SetupStepID] { SetupStepID.allCases }

    private var bots: [Bot] {
        if case .loaded(let list) = model.bots { return list.filter { !$0.isPending } }
        return []
    }

    private func isDone(_ step: SetupStepID) -> Bool {
        if store.marks.contains(step) { return true }
        switch step {
        case .accounts: return !model.readyAccounts.isEmpty
        case .integrations: return false
        case .computer: return ComputerPermission.allCases.allSatisfy { activity.permissions.isGranted($0) }
        case .bot: return !bots.isEmpty
        }
    }

    private func isReachable(_ step: SetupStepID) -> Bool {
        guard let position = steps.firstIndex(of: step), position > 0 else { return true }
        return isDone(steps[position - 1]) || isDone(step)
    }

    private var currentStep: SetupStepID? { steps.first { !isDone($0) } }
    private var activeStep: SetupStepID? { store.activeStep ?? currentStep }
    private var completed: Int { steps.filter(isDone).count }
    private var finished: Bool { completed == steps.count }

    private func summary(for step: SetupStepID) -> String? {
        switch step {
        case .accounts:
            let count = model.readyAccounts.count
            return count == 0 ? nil : (count == 1 ? "1 conta pronta." : "\(count) contas prontas.")
        case .bot:
            return bots.isEmpty ? nil : (bots.count == 1 ? "1 bot no time." : "\(bots.count) bots no time.")
        case .integrations, .computer:
            return nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text("Primeiros passos")
                            .font(TypeScale.pageTitle)
                            .tracking(Metrics.pageTitleTracking)
                            .foregroundStyle(Theme.textPrimary)
                        Text("Poucos passos para seus bots usarem as suas contas, as suas chaves e o seu Mac.")
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: Spacing.l)
                    if !finished {
                        Button("Ir para o app") {
                            store.finish()
                        }
                        .buttonStyle(OnboardingGhostButtonStyle())
                    }
                }
                SetupProgressBar(completed: completed, total: steps.count)
                if finished {
                    SetupDoneCard {
                        store.finish()
                    }
                    .transition(.onboarding(reduceMotion: reduceMotion))
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.element) { position, step in
                        TimelineStepView(
                            step: step,
                            index: position + 1,
                            done: isDone(step),
                            open: activeStep == step,
                            reachable: isReachable(step),
                            last: position == steps.count - 1,
                            summary: summary(for: step),
                            onToggle: { toggle(step) },
                            onSkip: { store.mark(step) }
                        ) {
                            content(for: step)
                        } actions: {
                            actions(for: step)
                        }
                    }
                }
            }
            .frame(maxWidth: 600, alignment: .leading)
            .padding(.horizontal, Spacing.xxl)
            .padding(.top, FrameMetrics.stripHeight + Spacing.xxl + Spacing.l)
            .padding(.bottom, Spacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgesHidden()
        .overlay(alignment: .topLeading) {
            if let back = previousStep {
                Button {
                    store.activeStep = back
                } label: {
                    Label("Voltar", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(OnboardingGhostButtonStyle())
                .padding(.top, FrameMetrics.stripHeight + Spacing.s)
                .padding(.leading, Spacing.xl)
                .transition(.opacity)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: finished)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: activeStep)
        .task {
            await model.loadAccounts()
            activity.refreshPermissions()
        }
    }

    private var previousStep: SetupStepID? {
        guard let activeStep, let position = steps.firstIndex(of: activeStep), position > 0 else { return nil }
        return steps[position - 1]
    }

    private func toggle(_ step: SetupStepID) {
        store.activeStep = activeStep == step ? nil : step
    }

    @ViewBuilder
    private func content(for step: SetupStepID) -> some View {
        switch step {
        case .accounts:
            SetupAccountsList()
        case .integrations:
            IntegrationsSettings()
        case .computer:
            SetupPermissions()
        case .bot:
            if !bots.isEmpty {
                SetupBotsStrip(bots: bots)
            }
        }
    }

    @ViewBuilder
    private func actions(for step: SetupStepID) -> some View {
        switch step {
        case .accounts:
            Button {
                model.refreshAccounts()
            } label: {
                HStack(spacing: Spacing.xs + 2) {
                    if model.isRefreshingAccounts {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12, weight: .semibold))
                    }
                    Text("Procurar de novo")
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .buttonStyle(BrandButtonStyle(kind: isDone(.accounts) ? .secondary : .primary))
            .disabled(model.isRefreshingAccounts)
        case .integrations:
            Button {
                store.mark(.integrations)
            } label: {
                Label("Continuar", systemImage: "arrow.right")
                    .lineLimit(1)
                    .fixedSize()
            }
            .buttonStyle(.brandPrimary)
        case .computer:
            EmptyView()
        case .bot:
            Button {
                model.openEditor(for: nil)
            } label: {
                Label(bots.isEmpty ? "Criar bot" : "Criar outro bot", systemImage: "plus")
                    .lineLimit(1)
                    .fixedSize()
            }
            .buttonStyle(BrandButtonStyle(kind: bots.isEmpty ? .primary : .secondary))
        }
    }
}

private struct SetupDoneCard: View {
    let enter: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            VStack(alignment: .leading, spacing: Spacing.xs + 2) {
                Text("Tudo pronto.")
                    .font(BrandFonts.sans(18, weight: .semibold))
                    .tracking(-0.2)
                    .foregroundStyle(Theme.textPrimary)
                Text("Abra um bot e peça: \"o que você consegue fazer por mim?\"")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(action: enter) {
                HStack(spacing: Spacing.xs + 2) {
                    Text("Entrar no app")
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .semibold))
                }
                .lineLimit(1)
                .fixedSize()
            }
            .buttonStyle(.brandPrimary)
        }
        .padding(Spacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

private struct SetupAccountsList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            switch model.accounts {
            case .loaded(let list) where !list.allSatisfy({ $0.status == "missing" }):
                ForEach(list.filter { $0.status != "missing" }) { account in
                    SetupCheckRow(
                        provider: account.provider,
                        title: "\(account.providerTitle) · \(account.machineLabel)",
                        detail: account.isReady ? account.friendlyDetail : account.statusLabel,
                        state: account.isReady ? .ok : .warn
                    )
                }
            case .idle, .loading:
                ForEach(KnownProvider.all.prefix(2)) { provider in
                    SetupCheckRow(provider: provider.id, title: provider.label, detail: nil, state: .pending)
                        .redacted(reason: .placeholder)
                }
            default:
                ForEach(KnownProvider.all) { provider in
                    SetupCheckRow(provider: provider.id, title: provider.label, detail: provider.detail, state: .pending)
                }
            }
        }
        .springAnimation(value: model.readyAccounts.map(\.id))
        .task {
            while !Task.isCancelled && model.readyAccounts.isEmpty {
                try? await Task.sleep(for: .seconds(5))
                await model.loadAccounts()
            }
        }
    }
}

enum SetupCheckState {
    case pending
    case ok
    case warn
}

private struct SetupCheckRow: View {
    let provider: String
    let title: String
    let detail: String?
    let state: SetupCheckState

    var body: some View {
        HStack(spacing: Spacing.m) {
            ProviderLogo(provider: provider, size: 16)
                .frame(width: 28, height: 28)
                .background(Theme.background.opacity(0.7), in: RoundedRectangle(cornerRadius: Radius.small - 2, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(BrandFonts.sans(13, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: Spacing.s)
            stateBadge
        }
        .padding(.horizontal, Spacing.m)
        .frame(minHeight: 48)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
    }

    @ViewBuilder
    private var stateBadge: some View {
        switch state {
        case .ok:
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Theme.success)
                .frame(width: 22, height: 22)
                .background(Theme.success.opacity(0.12), in: Circle())
                .accessibilityLabel("Pronta")
        case .warn:
            Image(systemName: "exclamationmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Theme.warning)
                .frame(width: 22, height: 22)
                .background(Theme.warning.opacity(0.14), in: Circle())
                .accessibilityLabel("Precisa de atenção")
        case .pending:
            Text("Aguardando")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        }
    }
}

private struct SetupPermissions: View {
    private let activity = ComputerExecutor.shared.activity

    var body: some View {
        SettingsGroup(caption: "Permissões do macOS") {
            ForEach(ComputerPermission.allCases) { permission in
                ComputerPermissionRow(permission: permission, isGranted: activity.permissions.isGranted(permission))
            }
        }
        .springAnimation(value: activity.permissions)
        .task {
            while !Task.isCancelled {
                activity.refreshPermissions()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
}

private struct SetupBotsStrip: View {
    let bots: [Bot]

    var body: some View {
        HStack(spacing: Spacing.s) {
            ForEach(bots.prefix(6)) { bot in
                HStack(spacing: Spacing.xs + 2) {
                    BotCharacter(bot: bot, mood: .idle, size: 20)
                    Text(bot.name)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                }
                .padding(.leading, Spacing.xs)
                .padding(.trailing, Spacing.s + 2)
                .frame(height: 30)
                .background(Theme.surface, in: Capsule())
            }
            if bots.count > 6 {
                Text("+\(bots.count - 6)")
                    .font(TypeScale.counter)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }
}
