import SwiftUI

struct ReviewButton: View {
    var view: String? = nil
    var project: String? = nil
    let notify: (BoardNotice) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var open = false

    private var store: ReviewStore { .shared }

    var body: some View {
        Button {
            open.toggle()
        } label: {
            BoardQuietFace(title: "Review", systemImage: "sparkles", isActive: open, isBusy: store.running != nil)
        }
        .buttonStyle(PressableButtonStyle())
        .help("Resumos prontos para a daily e a semana")
        .glassPopup(isPresented: $open, edge: .trailing) {
            ReviewPanel(run: run)
        }
        .task {
            store.attach(model.client)
            if store.presets.isEmpty { await store.load() }
        }
    }

    private func run(_ preset: ReviewPreset) {
        open = false
        notify(.success(tr("Juntando o contexto de %@…", preset.name)))
        Task {
            do {
                let reply = try await store.run(preset, view: view, project: project)
                withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                    model.openConversation(reply.botId, sessionID: reply.sessionId)
                    model.go(to: .conversations)
                }
            } catch {
                notify(.failure(tr("Não deu para rodar %1$@: %2$@", preset.name, error.localizedDescription)))
            }
        }
    }
}

struct BoardQuietFace: View {
    let title: String
    var systemImage: String? = nil
    var leading: AnyView? = nil
    var isActive = false
    var isBusy = false
    var showsChevron = false

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            if isBusy {
                ProgressView().controlSize(.mini)
            } else if let leading {
                leading
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(isActive ? Theme.textPrimary : Theme.textSecondary)
            }
            Text(title)
                .font(TypeScale.captionStrong)
                .foregroundStyle(isActive || hovering ? Theme.textPrimary : Theme.textSecondary)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 28)
        .background(isActive ? Theme.selection : hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .fixedSize()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: isActive)
    }
}

private struct ReviewPanel: View {
    let run: (ReviewPreset) -> Void

    @State private var editing = false

    var body: some View {
        Group {
            if editing {
                ReviewPresetEditor { editing = false }
            } else {
                ReviewMenu(run: run) { editing = true }
            }
        }
        .animation(Motion.crossFade, value: editing)
    }
}

private struct ReviewMenu: View {
    let run: (ReviewPreset) -> Void
    let edit: () -> Void

    @Environment(AppModel.self) private var model

    private var store: ReviewStore { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("REVIEW")
                .font(BrandFonts.sans(10.5, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(Theme.textTertiary)
                .padding(.horizontal, Spacing.s)
                .padding(.top, Spacing.xs)
                .padding(.bottom, Spacing.xs)
            if store.presets.isEmpty {
                Text(store.loadError ?? tr("Carregando…"))
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(Spacing.s)
            }
            ForEach(store.presets) { preset in
                ReviewRow(preset: preset, botName: botName(for: preset)) { run(preset) }
            }
            Rectangle().fill(Theme.paneDivider).frame(height: 1).padding(.vertical, Spacing.xs)
            ReviewRow(title: tr("Editar presets…"), systemImage: "slider.horizontal.3", action: edit)
        }
        .padding(Spacing.xs)
        .frame(width: 320)
    }

    private func botName(for preset: ReviewPreset) -> String {
        let id = preset.botId ?? store.defaultBotID
        return model.loadedBots.first { $0.id == id }?.name ?? tr("bot padrão")
    }
}

private struct ReviewRow: View {
    var preset: ReviewPreset? = nil
    var botName: String? = nil
    var title: String? = nil
    var systemImage: String? = nil
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.s) {
                Image(systemName: systemImage ?? icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(preset?.name ?? title ?? "")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if let preset {
                        Text("\(preset.scopeTitle) · \(preset.sourcesTitle) · \(botName ?? "")")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if preset != nil {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .opacity(hovering ? 1 : 0)
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(minHeight: preset == nil ? 30 : 42)
            .background(hovering ? Theme.hover : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }

    private var icon: String {
        switch preset?.scope {
        case "today": "sun.max"
        case "week": "calendar"
        default: preset?.github == true && preset?.linear == false ? "arrow.triangle.pull" : "calendar.badge.clock"
        }
    }
}

private struct ReviewPresetEditor: View {
    let back: () -> Void

    @Environment(AppModel.self) private var model
    @State private var drafts: [ReviewPreset] = ReviewStore.shared.presets
    @State private var selectedID: String? = ReviewStore.shared.presets.first?.id
    @State private var error: String?

    private var store: ReviewStore { .shared }

    private var index: Int? { drafts.firstIndex { $0.id == selectedID } }

    private var bots: [Bot] {
        model.loadedBots.filter { !$0.isGroup && !$0.isPending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(spacing: Spacing.s) {
                BoardIconButton(systemImage: "chevron.left", help: "Voltar", action: back)
                Text("Presets de review")
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
                if let error {
                    Text(error)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.danger)
                        .lineLimit(1)
                }
                BoardActionButton(title: tr("Salvar"), prominent: true, isBusy: store.saving) {
                    Task {
                        error = await store.save(drafts)
                        if error == nil { back() }
                    }
                }
                .disabled(drafts.contains { $0.name.trimmingCharacters(in: .whitespaces).isEmpty || $0.prompt.trimmingCharacters(in: .whitespaces).isEmpty || (!$0.linear && !$0.github) })
            }
            HStack(alignment: .top, spacing: Spacing.m) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(drafts) { preset in
                        Button {
                            selectedID = preset.id
                        } label: {
                            Text(preset.name.isEmpty ? tr("Sem nome") : preset.name)
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(preset.id == selectedID ? Theme.textPrimary : Theme.textSecondary)
                                .lineLimit(1)
                                .padding(.horizontal, Spacing.s)
                                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                                .background(preset.id == selectedID ? Theme.selection : Theme.maskHidden, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    Button {
                        let fresh = ReviewPreset.draft()
                        drafts.append(fresh)
                        selectedID = fresh.id
                    } label: {
                        Label("Novo", systemImage: "plus")
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, Spacing.s)
                            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(drafts.count >= 20)
                }
                .frame(width: 150)
                if let index {
                    form(index)
                } else {
                    Text("Crie um preset.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
            }
        }
        .padding(Spacing.m)
        .frame(width: 600)
    }

    @ViewBuilder
    private func form(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            TextField("Nome", text: $drafts[index].name)
                .textFieldStyle(.plain)
                .font(TypeScale.rowTitle)
                .padding(.horizontal, Spacing.m)
                .frame(height: 32)
                .background(Theme.hover, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            TextField("O que o bot deve fazer", text: $drafts[index].prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .lineLimit(5...10)
                .padding(Spacing.m)
                .background(Theme.hover, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            HStack(spacing: Spacing.s) {
                Picker("Período", selection: $drafts[index].scope) {
                    Text("Hoje").tag("today")
                    Text("Semana").tag("week")
                    Text("Dias").tag("custom")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 190)
                if drafts[index].scope == "custom" {
                    Stepper("\(drafts[index].days) dias", value: $drafts[index].days, in: 1...90)
                        .font(TypeScale.caption)
                        .fixedSize()
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: Spacing.m) {
                Toggle("Linear", isOn: $drafts[index].linear)
                Toggle("GitHub", isOn: $drafts[index].github)
                Spacer(minLength: 0)
                Picker("Bot", selection: $drafts[index].botId) {
                    Text("Padrão").tag(String?.none)
                    ForEach(bots) { bot in
                        Text(bot.name).tag(Optional(bot.id))
                    }
                }
                .fixedSize()
            }
            .toggleStyle(.checkbox)
            .font(TypeScale.caption)
            HStack {
                Spacer(minLength: 0)
                Button("Apagar este preset", role: .destructive) {
                    drafts.remove(at: index)
                    selectedID = drafts.first?.id
                }
                .buttonStyle(.plain)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.danger)
                .clickable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
