import SwiftUI

struct SlashCommand: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let systemImage: String
    let action: () -> Void
}

enum SlashItem: Identifiable {
    case command(SlashCommand)
    case skill(SkillSummary)

    var id: String {
        switch self {
        case .command(let command): "command-\(command.id)"
        case .skill(let skill): "skill-\(skill.slug)"
        }
    }
}

struct SlashMenu: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let commands: [SlashCommand]
    let skills: [SkillSummary]
    let isLoading: Bool
    let failed: Bool
    var unavailable = false
    let selection: Int
    let hover: (Int) -> Void
    let select: (SlashItem) -> Void
    let retry: () -> Void

    @State private var appeared = false
    @State private var pulse = false
    @Namespace private var highlight

    private static let rowHeight: CGFloat = 40
    private static let headerHeight: CGFloat = 26
    private static let inset: CGFloat = Spacing.xs + 1
    private static let visibleRows: CGFloat = 8
    private static let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)

    private var showsSkills: Bool {
        !unavailable || !skills.isEmpty || commands.isEmpty
    }

    private var skillPlaceholderRows: Int {
        guard showsSkills, skills.isEmpty else { return 0 }
        if failed {
            return 1
        }
        return isLoading ? 3 : 1
    }

    private var contentHeight: CGFloat {
        let headers = (commands.isEmpty ? 0 : Self.headerHeight) + (showsSkills ? Self.headerHeight : 0)
        let rows = CGFloat(commands.count + skills.count + skillPlaceholderRows)
        return Self.inset * 2 + headers + rows * Self.rowHeight
    }

    private var height: CGFloat {
        min(contentHeight, Self.inset * 2 + Self.rowHeight * Self.visibleRows)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    if !commands.isEmpty {
                        header("Comandos")
                        ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                            row(index: index, item: .command(command), title: command.title, subtitle: command.subtitle, systemImage: command.systemImage)
                        }
                    }
                    if showsSkills {
                        header("Skills")
                    }
                    if showsSkills && skills.isEmpty {
                        if unavailable {
                            Text("Sem skills. Conecte o runelay em Integrações para usar as suas.")
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(Theme.textTertiary)
                                .lineLimit(1)
                                .padding(.horizontal, Spacing.s)
                                .frame(height: Self.rowHeight)
                        } else if failed {
                            failureRow
                        } else if isLoading {
                            ForEach(0..<3, id: \.self) { index in
                                skeletonRow(index)
                            }
                        } else {
                            Text("Nenhuma skill com esse nome")
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(Theme.textTertiary)
                                .padding(.horizontal, Spacing.s)
                                .frame(height: Self.rowHeight)
                        }
                    }
                    ForEach(Array(skills.enumerated()), id: \.element.id) { offset, skill in
                        row(index: commands.count + offset, item: .skill(skill), title: "/\(skill.slug)", subtitle: skill.description, systemImage: "wand.and.stars")
                    }
                }
                .padding(Self.inset)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.automatic)
            .modifier(HiddenScrollEdges())
            .onChange(of: selection) {
                withAnimation(reduceMotion ? Motion.reduced : Motion.spring) {
                    proxy.scrollTo(selection)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: height)
        .clipShape(Self.shape)
        .background {
            Color.clear
                .glassSurface(Self.shape, fallback: Theme.surfaceRaised)
        }
        .softElevation(lifted: true)
        .springAnimation(value: selection)
        .springAnimation(value: height)
        .onAppear {
            appeared = true
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }

    private func header(_ title: String) -> some View {
        Text(title)
            .font(TypeScale.captionStrong)
            .foregroundStyle(Theme.textTertiary)
            .padding(.horizontal, Spacing.s)
            .padding(.bottom, Spacing.xxs)
            .frame(height: Self.headerHeight, alignment: .bottomLeading)
            .opacity(appeared ? 1 : 0)
    }

    private func row(index: Int, item: SlashItem, title: String, subtitle: String, systemImage: String) -> some View {
        let isSelected = index == selection
        return Button {
            select(item)
        } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                    .frame(width: 18)
                Text(title)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .layoutPriority(1)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: Self.rowHeight)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                        .fill(Theme.hover)
                        .matchedGeometryEffect(id: "highlight", in: highlight)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .id(index)
        .onHover { hovering in
            if hovering {
                hover(index)
            }
        }
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared || reduceMotion ? 0 : 4)
        .animation(
            reduceMotion ? Motion.reduced : Motion.spring.delay(0.025 * Double(min(index, 8)) + 0.03),
            value: appeared
        )
    }

    private func skeletonRow(_ index: Int) -> some View {
        let widths: [CGFloat] = [96, 128, 84]
        let details: [CGFloat] = [180, 140, 200]
        return HStack(spacing: Spacing.s) {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(Theme.selection)
                .frame(width: 16, height: 16)
                .frame(width: 18)
            Capsule()
                .fill(Theme.selection)
                .frame(width: widths[index % widths.count], height: 9)
            Capsule()
                .fill(Theme.hover)
                .frame(width: details[index % details.count], height: 9)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: Self.rowHeight)
        .opacity(pulse ? 0.45 : 1)
        .accessibilityHidden(true)
    }

    private var failureRow: some View {
        Button(action: retry) {
            HStack(spacing: Spacing.s) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 18)
                Text("Não consegui carregar as skills")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                Text("·")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textTertiary)
                Text("Tentar de novo")
                    .font(TypeScale.rowSubtitle.weight(.medium))
                    .foregroundStyle(Theme.brandText)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
    }
}

private struct HiddenScrollEdges: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.scrollEdgeEffectHidden(true, for: .all)
        } else {
            content
        }
    }
}

struct SkillChip: View {
    let skill: SkillSummary
    var compact = false
    var remove: (() -> Void)?

    @State private var isHovering = false

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: "wand.and.stars")
                .font(.system(size: compact ? 9.5 : 11, weight: .medium))
                .foregroundStyle(Theme.brandText)
            Text(skill.invocation)
                .font(compact ? TypeScale.caption : TypeScale.captionStrong)
                .foregroundStyle(compact ? Theme.textSecondary : Theme.textPrimary)
                .lineLimit(1)
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8.5, weight: .bold))
                        .foregroundStyle(isHovering ? Theme.textPrimary : Theme.textTertiary)
                        .frame(width: 16, height: 16)
                        .background(isHovering ? Theme.hover : .clear, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .clickable()
                .onHover { hovering in
                    isHovering = hovering
                }
                .springAnimation(value: isHovering)
                .help("Tirar \(skill.name)")
                .accessibilityLabel("Tirar \(skill.name)")
            }
        }
        .padding(.leading, compact ? 7 : Spacing.s)
        .padding(.trailing, remove == nil ? (compact ? 7 : Spacing.s) : 3)
        .frame(height: compact ? 20 : 24)
        .background(Theme.selection, in: Capsule())
        .help(skill.description.isEmpty ? skill.name : skill.description)
    }
}

struct SkillChipRow: View {
    let skills: [SkillSummary]
    var compact = false
    var remove: ((SkillSummary) -> Void)?

    var body: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(skills) { skill in
                SkillChip(skill: skill, compact: compact, remove: remove.map { action in { action(skill) } })
                    .transition(.scale(scale: 0.7).combined(with: .opacity))
            }
        }
        .springAnimation(value: skills.map(\.slug))
    }
}
