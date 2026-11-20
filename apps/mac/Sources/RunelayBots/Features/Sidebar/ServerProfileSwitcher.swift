import SwiftUI

struct ServerProfileSwitcher: View {
    @Environment(AppModel.self) private var model
    private let profiles = ServerProfiles.shared
    @State private var open = false
    @State private var isHovering = false

    var body: some View {
        Button {
            open.toggle()
            if open {
                profiles.refreshStatuses()
            }
        } label: {
            HStack(spacing: Spacing.s) {
                SettingsTile(symbol: profiles.active.symbol, color: Theme.accent(profiles.active.color), size: 18)
                Text(profiles.active.name)
                    .font(BrandFonts.sans(12.5, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Circle()
                    .fill(Theme.connection(model.connection))
                    .frame(width: 6, height: 6)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 28)
            .background(open ? Theme.selection : isHovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: open)
        .help("Trocar de servidor (⌃⌘1…9)")
        .accessibilityLabel("Servidor")
        .accessibilityValue(profiles.active.name)
        .glassMenu(isPresented: $open, title: "Servidores", minWidth: 280) {
            items
        }
    }

    private var items: [GlassMenuItem] {
        var list = profiles.profiles.enumerated().map { index, profile in
            let status = profiles.status(of: profile)
            return GlassMenuItem(
                profile.name,
                id: profile.id,
                subtitle: "\(status.label) · \(profile.host)",
                shortcut: index < 9 ? "⌃⌘\(index + 1)" : nil,
                isOn: profiles.active.id == profile.id,
                leading: AnyView(
                    SettingsTile(symbol: profile.symbol, color: Theme.accent(profile.color), size: 20)
                        .overlay(alignment: .bottomTrailing) {
                            Circle()
                                .fill(status.color)
                                .frame(width: 6, height: 6)
                                .offset(x: 2, y: 2)
                        }
                )
            ) {
                profiles.activate(profile.id)
            }
        }
        list.append(GlassMenuItem("Gerenciar servidores…", id: "manage", systemImage: "slider.horizontal.3", startsSection: true) {
            model.openSettings(.server)
        })
        return list
    }
}
