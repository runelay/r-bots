import SwiftUI

struct DevicesSettings: View {
    @State private var store = DeviceStore.shared
    @State private var confirming: DeviceInfo?
    private let connection = RunnerConnection.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            Text("Cada Mac em que você entrou fica ligado à sua conta. Os bots usam as contas de IA e o computador dele enquanto o app estiver aberto.")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            SettingsGroup(caption: "Este Mac") {
                SettingsRow(title: DeviceIdentity.name, detail: thisMacDetail) {
                    HStack(spacing: Spacing.s) {
                        MacLinkStatus(state: connection.state)
                        if needsConnect {
                            Button {
                                Task { await store.connectThisMac() }
                            } label: {
                                HStack(spacing: Spacing.xs + 2) {
                                    if store.registering {
                                        ProgressView()
                                            .controlSize(.small)
                                    }
                                    Text("Conectar este Mac")
                                }
                            }
                            .buttonStyle(.brandPrimary)
                            .disabled(store.registering)
                            .transition(.opacity)
                        }
                    }
                }
            }
            .springAnimation(value: needsConnect)

            if let error = store.error {
                Text(error)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }

            switch store.state {
            case .loading:
                VStack(spacing: Spacing.s) {
                    ForEach(0..<2, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                            .fill(Theme.surface)
                            .frame(height: 56)
                    }
                }
            case .failed(let message):
                EmptyStateView(systemImage: "exclamationmark.triangle", title: "Não deu para carregar os dispositivos", description: message)
            case .loaded:
                if store.items.isEmpty {
                    EmptyStateView(systemImage: "laptopcomputer", title: "Nenhum Mac na conta", description: "Entre no app em um Mac para ele aparecer aqui.")
                } else {
                    SettingsGroup(caption: "Na sua conta") {
                        ForEach(store.items) { device in
                            DeviceRow(device: device, isCurrent: device.id == store.currentId, isBusy: store.busy == device.id) {
                                confirming = device
                            }
                        }
                    }
                }
            }
        }
        .springAnimation(value: store.items)
        .springAnimation(value: store.error)
        .task {
            await store.load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await store.load()
            }
        }
        .alert(
            confirming.map { "Desconectar \($0.name)?" } ?? "",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
        ) {
            Button("Desconectar", role: .destructive) {
                if let device = confirming {
                    Task { await store.revoke(device) }
                }
                confirming = nil
            }
            Button("Cancelar", role: .cancel) {
                confirming = nil
            }
        } message: {
            Text("Os bots param de usar as contas de IA e o computador desse Mac na hora. Para voltar, entre de novo nele.")
        }
    }

    private var needsConnect: Bool {
        RunnerToken.read() == nil
    }

    private var thisMacDetail: String {
        "\(DeviceIdentity.model) · macOS \(DeviceIdentity.osVersion)"
    }
}

private struct DeviceRow: View {
    let device: DeviceInfo
    let isCurrent: Bool
    let isBusy: Bool
    let revoke: () -> Void

    var body: some View {
        SettingsRow(title: isCurrent ? "\(device.name) · este Mac" : device.name, detail: detail) {
            HStack(spacing: Spacing.m) {
                HStack(spacing: Spacing.xs) {
                    Circle()
                        .fill(device.connected ? Theme.success : Theme.textTertiary)
                        .frame(width: 6, height: 6)
                    Text(device.connected ? "Conectado" : "Desconectado")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                Button(action: revoke) {
                    HStack(spacing: Spacing.xs + 2) {
                        if isBusy {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text("Desconectar")
                    }
                }
                .buttonStyle(.brandSecondary)
                .disabled(isBusy)
            }
        }
    }

    private var detail: String {
        var parts: [String] = []
        if let model = device.model { parts.append(model) }
        if let os = device.osVersion { parts.append("macOS \(os)") }
        if let app = device.appVersion { parts.append("app \(app)") }
        if !device.connected, let seen = device.lastSeenAt.flatMap(Self.date) {
            parts.append("visto \(seen.formatted(.relative(presentation: .named)))")
        }
        return parts.joined(separator: " · ")
    }

    private static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)
    }
}
