import SwiftUI
import UIKit

struct ServerBadge: View {
    let profile: ServerProfile
    var size: CGFloat = 26

    var body: some View {
        Image(systemName: profile.symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Theme.accent(profile.color).gradient, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct ServerSwitcher: View {
    @Environment(AppModel.self) private var model
    @Binding var managing: Bool
    @Environment(\.scenePhase) private var scenePhase
    private let session = AuthSession.shared
    private let environments = RunEnvironmentStore.shared

    var body: some View {
        let book = ServerConfig.book()
        let active = book.active
        Menu {
            Section("Servidor") {
                ForEach(book.profiles) { profile in
                    Button {
                        Task { await session.switchServer(to: profile) }
                    } label: {
                        if profile.id == active.id {
                            Label(profile.name, systemImage: "checkmark")
                        } else {
                            Text(profile.name)
                        }
                    }
                }
            }
            if let snapshot = environments.snapshot {
                Section {
                    ForEach(snapshot.environments) { environment in
                        Toggle(isOn: selection(environment.id, in: snapshot)) {
                            Label {
                                Text(environment.label)
                                Text(environment.online ? "Conectado" : "Desconectado")
                            } icon: {
                                dot(environment.online ? Theme.success : Theme.danger)
                            }
                        }
                        .disabled(!environment.canRun)
                    }
                }
            }
            Button("Gerenciar servidores", systemImage: "server.rack") {
                managing = true
            }
        } label: {
            HStack(spacing: 6) {
                ServerBadge(profile: active, size: 24)
                    .overlay(alignment: .bottomTrailing) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                            .padding(1.5)
                            .background(Theme.background, in: Circle())
                            .offset(x: 3, y: 3)
                    }
                Text(active.name)
                    .font(BrandFonts.sans(15, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 150, alignment: .leading)
                    .padding(.leading, 2)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .simultaneousGesture(
            TapGesture().onEnded {
                Task { await environments.refresh() }
            }
        )
        .accessibilityLabel("Servidor \(active.name), \(model.statusStreamLive ? "conectado" : "sem conexão")")
        .id(session.serverRevision)
        .task(id: PollKey(server: session.serverRevision, active: scenePhase == .active)) {
            guard scenePhase == .active else { return }
            await environments.poll()
        }
    }

    private struct PollKey: Hashable {
        let server: Int
        let active: Bool
    }

    private var statusColor: Color {
        if let snapshot = environments.snapshot {
            return snapshot.currentOnline ? Theme.success : Theme.danger
        }
        return model.statusStreamLive ? Theme.success : (model.listState == .loaded ? Theme.attention : Theme.danger)
    }

    private func selection(_ id: String, in snapshot: RunEnvironments) -> Binding<Bool> {
        Binding(
            get: { snapshot.selected == id },
            set: { isOn in
                if isOn {
                    environments.select(id)
                }
            }
        )
    }

    private func dot(_ color: Color) -> Image {
        let configuration = UIImage.SymbolConfiguration(pointSize: 8, weight: .regular)
        guard let symbol = UIImage(systemName: "circle.fill", withConfiguration: configuration) else {
            return Image(systemName: "circle.fill")
        }
        return Image(uiImage: symbol.withTintColor(UIColor(color), renderingMode: .alwaysOriginal))
    }
}
