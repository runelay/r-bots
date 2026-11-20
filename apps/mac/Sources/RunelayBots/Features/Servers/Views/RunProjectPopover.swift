import SwiftUI

struct RunProjectPopover: View {
    let botID: String

    @Environment(\.glassPopupDismiss) private var dismiss
    @State private var projects: [ServerProject] = []
    @State private var projectPath = ""
    @State private var worktreePath = ""
    @State private var scripts: ProjectScripts?
    @State private var selectedScript: String?
    @State private var loading = true
    @State private var starting = false
    @State private var profileName = ""
    @State private var savingProfile = false

    private var store: ServerStore { .shared }

    private var project: ServerProject? { projects.first { $0.path == projectPath } }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text("Rodar projeto")
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)

            if !store.profiles.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    caption("Perfis")
                    ForEach(store.profiles) { profile in
                        ProfileRow(profile: profile) {
                            run(profile: profile.id)
                        } onDelete: {
                            Task { await store.deleteProfile(profile.id) }
                        }
                    }
                }
            }

            if loading {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
            } else if projects.isEmpty {
                Text("Nenhum repositório liberado. Peça a um bot para trabalhar num repositório e libere pelo card.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            } else {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    caption("Repositório e worktree")
                    HStack(spacing: Spacing.s) {
                        GlassSelect(
                            options: projects.map { GlassSelectOption($0.name, value: $0.path, systemImage: "folder") },
                            selection: $projectPath,
                            help: "Repositório",
                            maxWidth: 150
                        )
                        if let project, project.worktrees.count > 1 {
                            GlassSelect(
                                options: project.worktrees.map { GlassSelectOption($0.branch ?? "sem branch", value: $0.path, systemImage: $0.main ? "house" : "arrow.triangle.branch") },
                                selection: $worktreePath,
                                help: "Worktree",
                                maxWidth: 170
                            )
                        }
                    }
                }
                scriptList
            }

            if let selectedScript, let scripts {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    if !scripts.envKeys.isEmpty {
                        Label("\(scripts.envKeys.count) variáveis do \(scripts.envFiles.joined(separator: ", ")) entram sozinhas", systemImage: "lock.fill")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .help(scripts.envKeys.joined(separator: ", "))
                    }
                    HStack(spacing: Spacing.s) {
                        TextField("Salvar como perfil (opcional)", text: $profileName)
                            .textFieldStyle(.plain)
                            .font(TypeScale.rowSubtitle)
                            .padding(.horizontal, Spacing.m)
                            .frame(height: 30)
                            .background(Theme.surface, in: Capsule())
                            .onSubmit { runSelected(selectedScript) }
                        Button {
                            runSelected(selectedScript)
                        } label: {
                            HStack(spacing: Spacing.xs) {
                                if starting {
                                    ProgressView().controlSize(.mini)
                                } else {
                                    Image(systemName: "play.fill")
                                        .font(.system(size: 10, weight: .bold))
                                }
                                Text("Rodar")
                                    .font(TypeScale.captionStrong)
                            }
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, Spacing.m)
                            .frame(height: 30)
                            .background(Theme.brandAccent, in: Capsule())
                        }
                        .buttonStyle(PressableButtonStyle())
                        .disabled(starting)
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(Spacing.l)
        .frame(width: 360, alignment: .leading)
        .glassMenuSurface()
        .springAnimation(value: selectedScript)
        .springAnimation(value: loading)
        .task { await load() }
        .onChange(of: projectPath) { _, path in
            worktreePath = project?.worktrees.first?.path ?? path
        }
        .task(id: worktreePath) { await loadScripts() }
    }

    private var scriptList: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            caption("Script")
            if let scripts {
                if scripts.scripts.isEmpty {
                    Text("Sem scripts no package.json desta pasta.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        ForEach(scripts.scripts) { script in
                            ScriptRow(script: script, selected: selectedScript == script.name) {
                                selectedScript = script.name
                            }
                        }
                    }
                }
                .frame(maxHeight: 220)
                .scrollEdgesHidden()
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(TypeScale.caption)
            .foregroundStyle(Theme.textTertiary)
    }

    private func load() async {
        guard let client = store.client else { return }
        async let loadedProjects = (try? client.serverProjects()) ?? []
        await store.loadProfiles()
        projects = await loadedProjects
        if projectPath.isEmpty, let first = projects.first {
            projectPath = first.path
            worktreePath = first.worktrees.first?.path ?? first.path
        }
        loading = false
    }

    private func loadScripts() async {
        guard let client = store.client, !worktreePath.isEmpty else { return }
        scripts = nil
        selectedScript = nil
        scripts = try? await client.projectScripts(path: worktreePath)
        selectedScript = scripts?.scripts.first { $0.name == "dev" }?.name ?? scripts?.scripts.first?.name
    }

    private func runSelected(_ script: String) {
        let name = profileName.trimmingCharacters(in: .whitespaces)
        let path = worktreePath
        starting = true
        Task {
            if !name.isEmpty {
                await store.saveProfile(name: name, path: path, script: script)
            }
            let server = await store.start(path: path, script: script, profile: nil)
            starting = false
            if server != nil {
                dismiss()
            }
        }
    }

    private func run(profile: String) {
        starting = true
        Task {
            let server = await store.start(path: nil, script: nil, profile: profile)
            starting = false
            if server != nil {
                dismiss()
            }
        }
    }
}

private struct ProfileRow: View {
    let profile: RunProfile
    let onRun: () -> Void
    let onDelete: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: Spacing.s) {
            Button(action: onRun) {
                HStack(spacing: Spacing.s) {
                    Image(systemName: "play.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Theme.brandText)
                        .frame(width: 18)
                    Text(profile.name)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            Button(action: onDelete) {
                Image(systemName: "trash")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textTertiary)
            }
            .buttonStyle(.plain)
            .clickable()
            .opacity(hovering ? 1 : 0)
            .help("Apagar perfil")
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 30)
        .background(hovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
    }
}

private struct ScriptRow: View {
    let script: ServerScript
    let selected: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.s) {
                Image(systemName: ServerTool.symbol(script.tool))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 0) {
                    Text(script.name)
                        .font(TypeScale.rowSubtitle.weight(.medium))
                        .foregroundStyle(Theme.textPrimary)
                    Text(script.command)
                        .font(TypeScale.monoInline)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.brandText)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, Spacing.s)
            .padding(.vertical, Spacing.xs)
            .background(selected ? Theme.selection : hovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: selected)
    }
}
