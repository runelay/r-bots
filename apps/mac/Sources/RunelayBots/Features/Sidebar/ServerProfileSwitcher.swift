import SwiftUI

struct ServerProfileSwitcher: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    private let profiles = ServerProfiles.shared
    private let environments = RunEnvironmentStore.shared
    @State private var open = false
    @State private var isHovering = false

    var body: some View {
        Button {
            open.toggle()
            if open {
                profiles.refreshStatuses()
                Task { await environments.refresh() }
            }
        } label: {
            HStack(spacing: Spacing.s) {
                SettingsTile(symbol: profiles.active.symbol, color: Theme.accent(profiles.active.color), size: 18)
                Text(profiles.active.name)
                    .font(BrandFonts.sans(12.5, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Circle()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)
                    .springAnimation(value: statusColor)
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
        .glassMenu(isPresented: $open, title: tr("Servidores"), minWidth: 280) {
            items
        }
        .task(id: PollKey(server: profiles.active.id, active: scenePhase == .active)) {
            guard scenePhase == .active else { return }
            await environments.poll()
        }
        .onChange(of: environments.failure) { _, failure in
            if let failure {
                model.showNotice(failure)
            }
        }
    }

    private struct PollKey: Hashable {
        let server: String
        let active: Bool
    }

    private var statusColor: Color {
        guard let snapshot = environments.snapshot else { return Theme.connection(model.connection) }
        return snapshot.currentOnline ? Theme.success : Theme.danger
    }

    private var environmentItems: [GlassMenuItem] {
        guard let snapshot = environments.snapshot else { return [] }
        return snapshot.environments.enumerated().map { index, environment in
            GlassMenuItem(
                environment.label,
                id: "environment-\(environment.id)",
                shortcut: environment.canRun ? nil : tr("fora do ar"),
                isOn: snapshot.selected == environment.id,
                isEnabled: environment.canRun,
                sectionTitle: index == 0 ? tr("Onde roda") : nil,
                badge: environment.online ? Theme.success : Theme.danger
            ) {
                environments.select(environment.id)
            }
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
        list.append(contentsOf: environmentItems)
        list.append(
            GlassMenuItem(tr("Gerenciar servidores…"), id: "manage", systemImage: "slider.horizontal.3", startsSection: true) {
                model.openSettings(.server)
            })
        return list
    }
}
