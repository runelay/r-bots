import AppKit
import SwiftUI

struct ComputerSettings: View {
    private let activity = ComputerExecutor.shared.activity

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            SettingsGroup(caption: "Permissões do macOS") {
                ForEach(ComputerPermission.allCases) { permission in
                    ComputerPermissionRow(permission: permission, isGranted: activity.permissions.isGranted(permission))
                }
            }

            SettingsGroup(caption: "Neste Mac") {
                SettingsRow(title: "Executor local", icon: SettingsIcon("bolt.fill", SettingsTint.amber), info: executorInfo) {
                    SettingsPill(text: executorLabel, color: executorColor, pulsing: isStarting)
                }
                SettingsRow(title: "Gravações", icon: SettingsIcon("film.fill", SettingsTint.red), info: "Os vídeos que os bots gravam ficam em ~/Movies/runelay bots.") {
                    Button {
                        let folder = ScreenRecorder.folder
                        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                        NSWorkspace.shared.activateFileViewerSelecting([folder])
                    } label: {
                        Label("Mostrar no Finder", systemImage: "folder")
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .plain))
                }
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

    private var isStarting: Bool {
        if case .starting = activity.executor { return true }
        return false
    }

    private var executorLabel: String {
        switch activity.executor {
        case .starting: "Iniciando"
        case .running: "Ativo"
        case .failed: "Parado"
        }
    }

    private var executorInfo: String {
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

    private var icon: SettingsIcon {
        switch permission {
        case .accessibility: SettingsIcon("accessibility", SettingsTint.blue)
        case .screenRecording: SettingsIcon("record.circle", SettingsTint.red)
        case .automation: SettingsIcon("gearshape.2.fill", SettingsTint.graphite)
        }
    }

    var body: some View {
        SettingsRow(title: permission.title, icon: icon, info: permission.detail) {
            HStack(spacing: Spacing.s) {
                SettingsPill(text: isGranted ? "Liberada" : "Falta", color: isGranted ? Theme.success : Theme.warning)
                if !isGranted {
                    Button("Liberar") {
                        Task { await ComputerPermissionsSnapshot.request(permission) }
                    }
                    .buttonStyle(SettingsButtonStyle(kind: .primary))
                    .transition(.opacity)
                }
            }
        }
        .contextMenu {
            Button("Abrir nos Ajustes do Sistema", systemImage: "gearshape") {
                Task { await ComputerPermissionsSnapshot.request(permission) }
            }
        }
    }
}
