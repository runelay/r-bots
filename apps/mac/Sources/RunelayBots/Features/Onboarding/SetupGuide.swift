import SwiftUI

struct SetupGuide: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    private let store = OnboardingStore.shared
    private let session = AuthSession.shared
    private let activity = ComputerExecutor.shared.activity

    private var steps: [SetupStepID] { SetupStepID.allCases }

    private var bots: [Bot] {
        if case .loaded(let list) = model.bots { return list.filter { !$0.isPending } }
        return []
    }

    private func answered(_ step: SetupStepID) -> Bool {
        store.marks.contains(step) || store.skipped.contains(step)
    }

    private var reached: Int { steps.firstIndex { !answered($0) } ?? steps.count }

    private var current: SetupStepID? {
        if let picked = store.picked, let index = steps.firstIndex(of: picked), index <= reached { return picked }
        return reached < steps.count ? steps[reached] : nil
    }

    private var macReady: Bool {
        ComputerPermission.allCases.allSatisfy { activity.permissions.isGranted($0) }
    }

    private var progress: SetupProgress {
        SetupProgress(
            steps: steps,
            current: current,
            reached: reached,
            values: Dictionary(uniqueKeysWithValues: steps.compactMap { step in value(for: step).map { (step, $0) } })
        )
    }

    private func value(for step: SetupStepID) -> String? {
        guard answered(step) else { return nil }
        if store.skipped.contains(step) { return "Depois" }
        switch step {
        case .profile:
            return session.user?.name
        case .bot:
            return bots.isEmpty ? "Depois" : SetupText.names(bots.map(\.name))
        case .accounts:
            let titles = Array(Set(model.readyAccounts.map(\.providerTitle))).sorted()
            return titles.isEmpty ? "Depois" : SetupText.names(titles)
        case .integrations, .connectors:
            return "Feito"
        case .computer:
            return macReady ? "Liberado" : "Em parte"
        }
    }

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                SetupRail(progress: progress, say: say) { step in
                    store.picked = step
                }
                .frame(width: 272)
                .frame(maxHeight: .infinity)
                .background(Theme.sidebarBackground)
                ScrollView {
                    HStack(alignment: .top, spacing: Spacing.xxl + Spacing.l) {
                        stepColumn
                            .frame(maxWidth: 540, alignment: .leading)
                        if geometry.size.width >= 1160 {
                            SetupPreview(bots: bots, awake: !model.readyAccounts.isEmpty, macReady: macReady)
                                .frame(width: 280)
                                .padding(.top, Spacing.xxl + Spacing.l)
                                .transition(.opacity)
                        }
                    }
                    .padding(.horizontal, Spacing.xxl)
                    .padding(.top, FrameMetrics.stripHeight + Spacing.xl)
                    .padding(.bottom, Spacing.xxl)
                    .frame(maxWidth: .infinity)
                }
                .scrollEdgesHidden()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.background)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: current)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: reached)
        .task {
            await model.loadAccounts()
            activity.refreshPermissions()
        }
    }

    private var say: String {
        let first = SetupText.firstName(session.user?.name)
        switch current {
        case .profile:
            return first.isEmpty
                ? "Oi! Eu monto tudo com você em poucos minutos."
                : "Oi, \(first)! Eu monto tudo com você em poucos minutos."
        case .bot:
            return bots.isEmpty
                ? "Agora o primeiro bot. Um nome e um rosto já bastam."
                : "Ele chegou. Quando quiser, a gente segue."
        case .accounts:
            if !model.readyAccounts.isEmpty { return "Acordou! Agora ele já pensa." }
            return bots.isEmpty
                ? "Sem uma IA logada, os bots não respondem."
                : "Seu bot está dormindo. Uma conta de IA acorda ele."
        case .integrations:
            return "Daqui em diante é tudo opcional. Pule o que não usar."
        case .connectors:
            return "Com conectores, os bots mexem nas suas contas por você."
        case .computer:
            return "Última etapa. Depois é só abrir uma conversa."
        case nil:
            return "Tudo certo. O time está esperando você."
        }
    }

    @ViewBuilder
    private var stepColumn: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            backRow
            Group {
                if let current {
                    SetupStepBody(
                        step: current,
                        index: steps.firstIndex(of: current) ?? 0,
                        total: steps.count,
                        bots: bots,
                        macReady: macReady
                    )
                } else {
                    SetupDoneBody(bots: bots)
                }
            }
            .id(current)
            .transition(SetupMotion.step(reduceMotion: reduceMotion))
        }
    }

    private var backRow: some View {
        HStack {
            if let back = previous {
                Button {
                    store.picked = back
                } label: {
                    Label("Voltar", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(OnboardingGhostButtonStyle())
                .padding(.leading, -Spacing.m)
                .transition(.opacity)
            }
        }
        .frame(height: 32, alignment: .leading)
    }

    private var previous: SetupStepID? {
        guard let current, let index = steps.firstIndex(of: current), index > 0 else { return nil }
        return steps[index - 1]
    }
}

struct SetupProgress {
    let steps: [SetupStepID]
    let current: SetupStepID?
    let reached: Int
    let values: [SetupStepID: String]

    var answered: Int { min(reached, steps.count) }
    var left: Int { steps.count - answered }
}

enum SetupMotion {
    static func step(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(x: 18)),
            removal: .opacity
        )
    }

    static func say(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(y: 6)),
            removal: .opacity
        )
    }
}

enum SetupText {
    static func firstName(_ name: String?) -> String {
        name?.split(separator: " ").first.map(String.init) ?? ""
    }

    static func names(_ list: [String]) -> String {
        switch list.count {
        case 0: return ""
        case 1: return list[0]
        case 2: return "\(list[0]) e \(list[1])"
        default: return "\(list[0]), \(list[1]) e mais \(list.count - 2)"
        }
    }
}

private struct SetupRail: View {
    let progress: SetupProgress
    let say: String
    let go: (SetupStepID) -> Void

    @Environment(\.appReduceMotion) private var reduceMotion
    private let store = OnboardingStore.shared
    private let session = AuthSession.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            HStack(spacing: Spacing.s) {
                RunelayAppMark(size: 22)
                Text("runelay bots")
                    .font(BrandFonts.sans(14, weight: .semibold))
                    .tracking(-0.2)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: Spacing.s)
                Menu {
                    Button("Terminar depois") {
                        store.finish()
                    }
                    Divider()
                    Button("Sair da conta") {
                        Task { await session.signOut() }
                    }
                } label: {
                    UserAvatar(size: 26)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .clickable()
                .help("Sua conta")
            }
            VStack(alignment: .leading, spacing: Spacing.s) {
                HStack {
                    Text(progress.left == 0 ? "Tudo certo" : (progress.left == 1 ? "Falta 1 etapa" : "Faltam \(progress.left) etapas"))
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textSecondary)
                        .contentTransition(.numericText())
                    Spacer(minLength: Spacing.s)
                    Text("\(progress.answered)/\(progress.steps.count)")
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(Theme.textTertiary)
                        .contentTransition(.numericText())
                }
                SetupProgressTrack(fraction: Double(progress.answered) / Double(max(progress.steps.count, 1)))
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(progress.steps.enumerated()), id: \.element) { index, step in
                    SetupRailRow(
                        step: step,
                        index: index + 1,
                        current: progress.current == step,
                        done: index < progress.reached && progress.current != step,
                        enabled: index <= progress.reached && progress.current != step,
                        value: progress.values[step]
                    ) {
                        go(step)
                    }
                }
            }
            .padding(.horizontal, -Spacing.s)
            Spacer(minLength: Spacing.l)
            SetupGuideSays(text: say)
        }
        .padding(.horizontal, Spacing.l + 2)
        .padding(.top, FrameMetrics.stripHeight + Spacing.s)
        .padding(.bottom, Spacing.xl)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: progress.answered)
    }
}

private struct SetupProgressTrack: View {
    let fraction: Double

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            Capsule()
                .fill(Theme.textPrimary.opacity(0.08))
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Theme.brandAccent)
                        .frame(width: max(6, geometry.size.width * fraction))
                }
        }
        .frame(height: 6)
        .animation(reduceMotion ? Motion.reduced : .spring(response: 0.7, dampingFraction: 0.85), value: fraction)
        .accessibilityElement()
        .accessibilityLabel("Progresso")
        .accessibilityValue("\(Int(fraction * 100))%")
    }
}

private struct SetupRailRow: View {
    let step: SetupStepID
    let index: Int
    let current: Bool
    let done: Bool
    let enabled: Bool
    let value: String?
    let action: () -> Void

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var hovering = false

    private var sub: String? {
        if done, let value { return value }
        if step.optional && !done { return "opcional" }
        return nil
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Spacing.m) {
                ZStack {
                    Circle()
                        .fill(done ? Theme.textPrimary : (current ? Theme.background : Theme.textPrimary.opacity(0.06)))
                        .shadow(color: current ? Theme.elevationShadowLifted : .clear, radius: 4, y: 1)
                    Group {
                        if done {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(Theme.background)
                        } else {
                            Text("\(index)")
                                .font(BrandFonts.sans(11, weight: .semibold).monospacedDigit())
                                .foregroundStyle(current ? Theme.textPrimary : Theme.textTertiary)
                        }
                    }
                    .id(done)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity))
                }
                .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(step.railName)
                        .font(BrandFonts.sans(13, weight: current ? .semibold : .medium))
                        .foregroundStyle(current || done ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(1)
                    if let sub {
                        Text(sub)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .transition(.opacity)
                    }
                }
                .padding(.top, 3)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .padding(.vertical, Spacing.xs + 2)
            .background(
                (current ? Theme.selection : (hovering && enabled ? Theme.hover : .clear)),
                in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .modifier(SetupPointer(enabled: enabled))
        .onHover { hovering = $0 }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: done)
        .animation(.easeOut(duration: 0.15), value: hovering)
        .accessibilityLabel(done ? "\(step.railName), concluído" : step.railName)
    }
}

private struct SetupPointer: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.clickable()
        } else {
            content
        }
    }
}

private struct SetupGuideSays: View {
    let text: String

    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            ZStack(alignment: .bottomLeading) {
                Text(text)
                    .font(BrandFonts.sans(13))
                    .foregroundStyle(Theme.textPrimary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, Spacing.s + 2)
                    .background(
                        Theme.background,
                        in: UnevenRoundedRectangle(
                            topLeadingRadius: Radius.large,
                            bottomLeadingRadius: 4,
                            bottomTrailingRadius: Radius.large,
                            topTrailingRadius: Radius.large,
                            style: .continuous
                        )
                    )
                    .softElevation()
                    .id(text)
                    .transition(SetupMotion.say(reduceMotion: reduceMotion))
            }
            .animation(Motion.animation(reduceMotion: reduceMotion), value: text)
            BotCharacter(botID: "setup-guide", glyph: "antenna", accent: "orange", mood: .speaking, size: 44)
                .frame(width: 52, height: 52)
                .background(Theme.background.opacity(0.8), in: Circle())
        }
        .accessibilityElement(children: .combine)
    }
}

private struct SetupStepBody: View {
    let step: SetupStepID
    let index: Int
    let total: Int
    let bots: [Bot]
    let macReady: Bool

    @Environment(AppModel.self) private var model
    @State private var name = AuthSession.shared.user?.name ?? ""
    @State private var saving = false
    @State private var failure: String?
    @FocusState private var nameFocused: Bool
    private let store = OnboardingStore.shared
    private let session = AuthSession.shared

    private var accountsReady: Bool { !model.readyAccounts.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            VStack(alignment: .leading, spacing: Spacing.xs + 2) {
                Text("Passo \(index + 1) de \(total)")
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textTertiary)
                Text(title)
                    .font(BrandFonts.sans(26, weight: .semibold))
                    .tracking(-0.6)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(lead)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if step == .connectors {
                actions
                content
            } else {
                content
                actions
            }
        }
    }

    private var title: String {
        switch step {
        case .profile: "Como você quer aparecer?"
        case .bot: bots.isEmpty ? "Monte o seu primeiro bot" : "O seu bot chegou"
        case .accounts: accountsReady ? "Pronto, os bots já pensam" : "Qual IA os bots vão usar?"
        case .integrations: "Quer ligar mais alguma coisa?"
        case .connectors: "Quais contas os bots podem usar?"
        case .computer: "Libere o Mac para os bots"
        }
    }

    private var lead: String {
        switch step {
        case .profile:
            "Seu nome e sua foto aparecem nas conversas e para quem você convidar."
        case .bot:
            bots.isEmpty
                ? "Dê um nome, um rosto e diga o que ele faz. Você muda tudo depois."
                : "Ele já está no time. Dá para criar outros quando quiser."
        case .accounts:
            accountsReady
                ? "Cada bot usa uma destas contas. Dá para trocar depois, um por um."
                : "Os bots rodam nas assinaturas já logadas nas suas máquinas. Entre no Claude Code, Codex, Grok ou Cursor e ela aparece aqui sozinha."
        case .integrations:
            "Tudo opcional: cada chave liga uma parte a mais, como a voz ou os conectores do runelay. A chave fica cifrada no servidor."
        case .connectors:
            "Conecte uma vez e todos os bots da organização usam: Linear, GitHub, Supabase e o resto."
        case .computer:
            "Com estas permissões um bot vê a tela, clica e digita quando você pedir. Toda ação passa por você ou pelo Jev."
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .profile:
            VStack(alignment: .leading, spacing: Spacing.l) {
                AccountPhotoGroup(hasPhoto: session.user?.image != nil)
                OnboardingField(label: "Seu nome") {
                    TextField("", text: $name, prompt: Text("Como te chamam"))
                        .focused($nameFocused)
                        .onSubmit(saveProfile)
                        .onChange(of: name) { failure = nil }
                }
                if let failure {
                    Label(failure, systemImage: "exclamationmark.circle.fill")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.opacity)
                }
            }
            .onAppear { nameFocused = true }
        case .bot:
            if !bots.isEmpty {
                SetupBotsStrip(bots: bots)
            }
        case .accounts:
            SetupAccountsList()
        case .integrations:
            IntegrationsSettings(showsIntro: false)
        case .connectors:
            ConnectorsCatalog(onRunelayOff: { store.picked = .integrations }) { actions in
                HStack {
                    Spacer(minLength: 0)
                    actions
                }
            }
        case .computer:
            SetupPermissions()
        }
    }

    @ViewBuilder
    private var actions: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            switch step {
            case .profile:
                primary("Continuar", systemImage: "arrow.right", busy: saving, action: saveProfile)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
            case .bot:
                if bots.isEmpty {
                    primary("Criar bot", systemImage: "plus") { model.openEditor(for: nil) }
                        .keyboardShortcut(.defaultAction)
                    later(note: "Você cria os bots depois, um por um.", label: "Criar depois")
                } else {
                    primary("Continuar", systemImage: "arrow.right") { store.mark(.bot) }
                        .keyboardShortcut(.defaultAction)
                    Button("Criar outro bot") { model.openEditor(for: nil) }
                        .buttonStyle(OnboardingGhostButtonStyle())
                        .padding(.leading, -Spacing.m)
                }
            case .accounts:
                if accountsReady {
                    primary("Continuar", systemImage: "arrow.right") { store.mark(.accounts) }
                        .keyboardShortcut(.defaultAction)
                } else {
                    primary("Procurar de novo", systemImage: "arrow.clockwise", busy: model.isRefreshingAccounts, busyTitle: "Procurando…") {
                        model.refreshAccounts()
                    }
                    .disabled(model.isRefreshingAccounts)
                    later(note: "Sem uma conta, os bots não respondem.", label: "Conectar depois")
                }
            case .integrations:
                primary("Continuar", systemImage: "arrow.right") { store.mark(.integrations) }
                later(note: "Fica em Ajustes › Integrações.", label: "Pular esta etapa")
            case .connectors:
                primary("Continuar", systemImage: "arrow.right") { store.mark(.connectors) }
                later(note: "O catálogo fica em Conectores, na barra lateral.", label: "Pular esta etapa")
            case .computer:
                primary("Continuar", systemImage: "arrow.right") { store.mark(.computer) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!macReady)
                later(note: "Os bots trabalham sem o Mac; só não veem a tela.", label: "Deixar para depois")
            }
        }
    }

    private func primary(
        _ title: String,
        systemImage: String,
        busy: Bool = false,
        busyTitle: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        OnboardingPrimaryButton(title: title, systemImage: systemImage, busy: busy, busyTitle: busyTitle, action: action)
            .frame(maxWidth: 320)
    }

    private func later(note: String, label: String) -> some View {
        HStack(spacing: Spacing.xs) {
            Text(note)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
            Button(label) { store.skip(step) }
                .buttonStyle(SetupLinkButtonStyle())
        }
    }

    private func saveProfile() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !saving else { return }
        guard trimmed != session.user?.name else {
            store.mark(.profile)
            return
        }
        saving = true
        Task {
            do {
                try await session.updateName(trimmed)
                store.mark(.profile)
            } catch {
                failure = error.localizedDescription
            }
            saving = false
        }
    }
}

private struct SetupLinkButtonStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textPrimary)
            .underline(hovering)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Rectangle())
            .clickable()
            .onHover { hovering = $0 }
    }
}

private struct SetupDoneBody: View {
    let bots: [Bot]

    @Environment(AppModel.self) private var model
    private let store = OnboardingStore.shared
    private let session = AuthSession.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            VStack(alignment: .leading, spacing: Spacing.xs + 2) {
                Text(SetupText.firstName(session.user?.name).isEmpty ? "Tudo pronto." : "Tudo pronto, \(SetupText.firstName(session.user?.name)).")
                    .font(BrandFonts.sans(26, weight: .semibold))
                    .tracking(-0.6)
                    .foregroundStyle(Theme.textPrimary)
                Text("Abra um bot e peça: \u{201C}o que você consegue fazer por mim?\u{201D}")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !bots.isEmpty {
                SetupBotsStrip(bots: bots, mood: model.readyAccounts.isEmpty ? .sleeping : .idle)
            }
            OnboardingPrimaryButton(title: "Entrar no app", systemImage: "arrow.right") {
                store.finish()
            }
            .frame(maxWidth: 320)
            .keyboardShortcut(.defaultAction)
            Text("Dá para refazer tudo em Ajustes › Conta.")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        }
    }
}

private struct SetupPreview: View {
    let bots: [Bot]
    let awake: Bool
    let macReady: Bool

    @Environment(\.appReduceMotion) private var reduceMotion
    private let session = AuthSession.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text("O seu time, enquanto você configura")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: Spacing.m) {
                    UserAvatar(size: 30)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(session.user?.name ?? "Você")
                            .font(BrandFonts.sans(13, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Text("Dono da conta")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .padding(Spacing.s + 2)
                if bots.isEmpty {
                    HStack(spacing: Spacing.m) {
                        Circle()
                            .fill(Theme.textPrimary.opacity(0.06))
                            .frame(width: 30, height: 30)
                            .overlay {
                                Image(systemName: "plus")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(Theme.textTertiary)
                            }
                        Text("O seu bot aparece aqui")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    .padding(Spacing.s + 2)
                    .transition(.opacity)
                } else {
                    ForEach(bots.prefix(5)) { bot in
                        HStack(spacing: Spacing.m) {
                            BotCharacter(bot: bot, mood: awake ? .idle : .sleeping, size: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(bot.name)
                                    .font(BrandFonts.sans(13, weight: .semibold))
                                    .foregroundStyle(Theme.textPrimary)
                                    .lineLimit(1)
                                Text(awake ? "Pronto para conversar" : "Dormindo até ter uma IA")
                                    .font(TypeScale.caption)
                                    .foregroundStyle(awake ? Theme.success : Theme.textSecondary)
                                    .contentTransition(.opacity)
                            }
                        }
                        .padding(Spacing.s + 2)
                        .transition(SetupMotion.step(reduceMotion: reduceMotion))
                    }
                }
            }
            .padding(Spacing.xs)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
            HStack(spacing: Spacing.s) {
                SetupPreviewChip(systemImage: "sparkles", text: awake ? "IA conectada" : "Sem IA", on: awake)
                SetupPreviewChip(systemImage: "desktopcomputer", text: macReady ? "Mac liberado" : "Mac fechado", on: macReady)
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: bots.map(\.id))
        .animation(Motion.animation(reduceMotion: reduceMotion), value: awake)
        .accessibilityElement(children: .combine)
    }
}

private struct SetupPreviewChip: View {
    let systemImage: String
    let text: String
    let on: Bool

    var body: some View {
        HStack(spacing: Spacing.xs + 1) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .semibold))
            Text(text)
                .font(TypeScale.caption)
                .lineLimit(1)
        }
        .foregroundStyle(on ? Theme.success : Theme.textTertiary)
        .padding(.horizontal, Spacing.s + 2)
        .frame(height: 26)
        .background((on ? Theme.success.opacity(0.12) : Theme.textPrimary.opacity(0.05)), in: Capsule())
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
    var mood: CharacterMood = .idle

    var body: some View {
        HStack(spacing: Spacing.s) {
            ForEach(bots.prefix(6)) { bot in
                HStack(spacing: Spacing.xs + 2) {
                    BotCharacter(bot: bot, mood: mood, size: 20)
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
