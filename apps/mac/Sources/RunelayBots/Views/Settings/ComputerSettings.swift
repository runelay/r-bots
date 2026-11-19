import AppKit
import SwiftUI

struct ComputerSettings: View {
    private let activity = ComputerExecutor.shared.activity

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            Text("Bots com \"Seu Mac\" ligado podem ver a tela, clicar, digitar e mexer em arquivos nas pastas que você liberou. Toda ação passa pela sua aprovação ou pela do Jev, e o botão Parar aparece no topo da tela enquanto um bot age.")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            SettingsGroup(caption: "Permissões do macOS") {
                ForEach(ComputerPermission.allCases) { permission in
                    ComputerPermissionRow(permission: permission, isGranted: activity.permissions.isGranted(permission))
                }
            }

            SettingsGroup(caption: "Executor local") {
                SettingsRow(title: "Estado", detail: executorDetail) {
                    HStack(spacing: Spacing.s) {
                        Image(systemName: "circle.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(executorColor)
                        Text(executorLabel)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                SettingsRow(title: "Gravações", detail: "Os vídeos que os bots gravam ficam em ~/Movies/runelay bots.") {
                    Button("Mostrar no Finder") {
                        let folder = ScreenRecorder.folder
                        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                        NSWorkspace.shared.activateFileViewerSelecting([folder])
                    }
                    .buttonStyle(.brandSecondary)
                }
            }

            Text("Depois de reinstalar o app, o macOS pode pedir as permissões de novo.")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
        }
        .springAnimation(value: activity.permissions)
        .task {
            while !Task.isCancelled {
                activity.refreshPermissions()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var executorLabel: String {
        switch activity.executor {
        case .starting: "Iniciando"
        case .running: "Ativo"
        case .failed: "Parado"
        }
    }

    private var executorDetail: String {
        switch activity.executor {
        case .starting, .running: "Recebe as ações dos bots pela conexão com o servidor."
        case .failed(let message): message
        }
    }

    private var executorColor: Color {
        switch activity.executor {
        case .starting: Theme.textTertiary
        case .running: Theme.success
        case .failed: Theme.danger
        }
    }
}

struct ComputerPermissionRow: View {
    let permission: ComputerPermission
    let isGranted: Bool

    var body: some View {
        SettingsRow(title: permission.title, detail: permission.detail) {
            HStack(spacing: Spacing.m) {
                HStack(spacing: Spacing.xs + 2) {
                    Image(systemName: isGranted ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(isGranted ? Theme.success : Theme.warning)
                    Text(isGranted ? "Liberada" : "Falta liberar")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(isGranted ? Theme.textSecondary : Theme.textPrimary)
                }
                .contentTransition(.opacity)
                Button(isGranted ? "Abrir Ajustes" : "Liberar") {
                    Task { await ComputerPermissionsSnapshot.request(permission) }
                }
                .buttonStyle(BrandButtonStyle(kind: isGranted ? .secondary : .primary))
            }
        }
    }
}
