import SwiftUI

struct SidebarAccountBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var isHovering = false
    private let identity = UserIdentity.shared
    private let session = AuthSession.shared

    var body: some View {
        HStack(spacing: Spacing.m) {
            Button {
                open(.account)
            } label: {
                HStack(spacing: Spacing.m) {
                    UserAvatar(size: 40)
                    Text(identity.displayName)
                        .font(BrandFonts.sans(15, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Abrir a conta")
            .accessibilityLabel("Conta de \(identity.displayName)")

            Menu {
                Button {
                    open(.account)
                } label: {
                    Label("Conta", systemImage: "person.crop.circle")
                }
                Button {
                    open(.integrations)
                } label: {
                    Label("Integrações", systemImage: "key.horizontal")
                }
                Button {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        model.closeSettings()
                        model.section = .connectors
                    }
                } label: {
                    Label("Conectores", systemImage: "puzzlepiece.extension")
                }
                Button {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        model.openSettings()
                    }
                } label: {
                    Label("Configurações", systemImage: "gearshape")
                }
                if session.user != nil {
                    Divider()
                    Button(role: .destructive) {
                        Task { await session.signOut() }
                    } label: {
                        Label("Sair", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            } label: {
                GridPlusIcon()
                    .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textSecondary)
                    .frame(width: 40, height: 40)
                    .glassSurface(Circle(), interactive: true, fallback: Theme.surface)
                    .contentShape(Circle())
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .onHover { isHovering = $0 }
            .springAnimation(value: isHovering)
            .help("Atalhos da conta")
            .accessibilityLabel("Atalhos da conta")
        }
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.m)
    }

    private func open(_ section: SettingsSection) {
        withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
            model.openSettings(section)
        }
    }
}

private struct GridPlusIcon: View {
    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 6.5
            let gap: CGFloat = 2.5
            let total = cell * 2 + gap
            let origin = CGPoint(x: (size.width - total) / 2, y: (size.height - total) / 2)
            let stroke = StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
            for (column, row) in [(0, 0), (1, 0), (0, 1)] {
                let rect = CGRect(
                    x: origin.x + CGFloat(column) * (cell + gap),
                    y: origin.y + CGFloat(row) * (cell + gap),
                    width: cell,
                    height: cell
                )
                context.stroke(Path(roundedRect: rect, cornerRadius: 1.8, style: .continuous), with: .foreground, style: stroke)
            }
            let center = CGPoint(x: origin.x + cell + gap + cell / 2, y: origin.y + cell + gap + cell / 2)
            var plus = Path()
            plus.move(to: CGPoint(x: center.x - cell / 2, y: center.y))
            plus.addLine(to: CGPoint(x: center.x + cell / 2, y: center.y))
            plus.move(to: CGPoint(x: center.x, y: center.y - cell / 2))
            plus.addLine(to: CGPoint(x: center.x, y: center.y + cell / 2))
            context.stroke(plus, with: .foreground, style: stroke)
        }
        .frame(width: 18, height: 18)
    }
}
