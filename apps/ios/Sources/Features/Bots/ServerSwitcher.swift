import SwiftUI

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
    private let session = AuthSession.shared

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
            Button("Gerenciar servidores", systemImage: "server.rack") {
                managing = true
            }
        } label: {
            HStack(spacing: 6) {
                ServerBadge(profile: active, size: 24)
                    .overlay(alignment: .bottomTrailing) {
                        Circle()
                            .fill(model.statusStreamLive ? Theme.success : (model.listState == .loaded ? Theme.attention : Theme.danger))
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
        .accessibilityLabel("Servidor \(active.name), \(model.statusStreamLive ? "conectado" : "sem conexão")")
        .id(session.serverRevision)
    }
}
