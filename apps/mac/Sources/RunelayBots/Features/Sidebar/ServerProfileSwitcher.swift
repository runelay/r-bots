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
            .background(isHovering || open ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { isHovering = $0 }
        .help("Trocar de servidor (⌃⌘1…9)")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            ServerProfileMenu {
                open = false
            }
        }
    }
}

private struct ServerProfileMenu: View {
    @Environment(AppModel.self) private var model
    private let profiles = ServerProfiles.shared
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Servidores")
                .font(BrandFonts.sans(11, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
                .padding(.horizontal, Spacing.s)
                .padding(.bottom, Spacing.xxs)
            ForEach(Array(profiles.profiles.enumerated()), id: \.element.id) { index, profile in
                ServerProfileMenuRow(profile: profile, index: index) {
                    dismiss()
                    profiles.activate(profile.id)
                }
            }
            ServerMenuAction(title: "Gerenciar servidores…", systemImage: "slider.horizontal.3") {
                dismiss()
                model.openSettings(.server)
            }
            .padding(.top, Spacing.xs)
        }
        .padding(Spacing.s)
        .frame(width: 280)
    }
}

private struct ServerProfileMenuRow: View {
    let profile: ServerProfile
    let index: Int
    let action: () -> Void
    private let profiles = ServerProfiles.shared
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.s) {
                SettingsTile(symbol: profile.symbol, color: Theme.accent(profile.color))
                VStack(alignment: .leading, spacing: 0) {
                    Text(profile.name)
                        .font(BrandFonts.sans(13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        let status = profiles.status(of: profile)
                        Circle()
                            .fill(status.color)
                            .frame(width: 5, height: 5)
                        Text(status.label)
                        Text("·")
                        Text(profile.host)
                            .truncationMode(.middle)
                    }
                    .font(BrandFonts.sans(11))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                }
                Spacer(minLength: Spacing.s)
                if profiles.active.id == profile.id {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Theme.brandAccent)
                } else if index < 9 {
                    Text("⌃⌘\(index + 1)")
                        .font(BrandFonts.sans(11, weight: .medium))
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 38)
            .background(isHovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { isHovering = $0 }
    }
}

private struct ServerMenuAction: View {
    let title: String
    let systemImage: String
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.s) {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 20)
                Text(title)
                    .font(BrandFonts.sans(12.5, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 30)
            .background(isHovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { isHovering = $0 }
    }
}
