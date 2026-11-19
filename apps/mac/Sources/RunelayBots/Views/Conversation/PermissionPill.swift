import SwiftUI

struct PermissionPill: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    @State private var isHovering = false
    @State private var isOpen = false

    var body: some View {
        let mode = model.permission(for: bot.id)
        Button {
            isOpen.toggle()
        } label: {
            HStack(spacing: Spacing.xs + 1) {
                Image(systemName: mode.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(mode == .full ? Theme.attention : Theme.textSecondary)
                    .contentTransition(.symbolEffect(.replace))
                Text(mode.title)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(isHovering || isOpen ? Theme.textPrimary : Theme.textSecondary)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: 28)
            .background(isHovering || isOpen ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: mode)
        .help("Permissão desta conversa (⇧⌘P)")
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            PermissionPopover(bot: bot)
        }
    }
}

private struct PermissionPopover: View {
    @Environment(AppModel.self) private var model
    let bot: Bot

    var body: some View {
        let mode = model.permission(for: bot.id)
        let botDefault = model.bot(id: bot.id)?.permission ?? .standard
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text("Permissões")
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
            HStack(spacing: Spacing.xxs) {
                ForEach(PermissionMode.allCases) { item in
                    PermissionSegment(mode: item, isSelected: item == mode) {
                        model.setPermission(item, for: bot.id)
                    }
                }
            }
            .padding(Spacing.xxs)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(mode.title)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
                Text(mode.detail)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .id(mode)
            .transition(.opacity)
            if mode != botDefault {
                Button {
                    model.setDefaultPermission(mode, for: bot.id)
                } label: {
                    Text("Usar como padrão de \(bot.name)")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.brandText)
                }
                .buttonStyle(PressableButtonStyle())
                .clickable()
                .transition(.opacity)
            }
        }
        .padding(Spacing.l)
        .frame(width: 280, alignment: .leading)
        .springAnimation(value: mode)
        .springAnimation(value: botDefault)
    }
}

private struct PermissionSegment: View {
    let mode: PermissionMode
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: mode.systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isSelected ? Theme.textPrimary : isHovering ? Theme.textSecondary : Theme.textTertiary)
                .frame(maxWidth: .infinity)
                .frame(height: 30)
                .background(isSelected ? Theme.surfaceRaised : isHovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .clickable()
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
        .springAnimation(value: isSelected)
        .help(mode.title)
        .accessibilityLabel(mode.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
