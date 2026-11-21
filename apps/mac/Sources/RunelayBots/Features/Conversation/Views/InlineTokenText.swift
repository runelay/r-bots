import QuickLook
import SwiftUI

struct InlineTokenText: View {
    @Environment(AppModel.self) private var model
    let segments: [InlineSegment]
    let fontSize: CGFloat
    let ink: Color
    @State private var shownSkill: SkillSummary?

    private static let scheme = "rbots-token"

    var body: some View {
        content
            .font(BrandFonts.sans(fontSize))
            .lineSpacing(Metrics.bodyLineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .tint(ink)
            .environment(
                \.openURL,
                OpenURLAction { url in
                    open(url)
                    return .handled
                }
            )
            .popover(item: $shownSkill, arrowEdge: .bottom) { skill in
                SkillDescriptionCard(skill: skill)
            }
    }

    private var content: Text {
        segments.enumerated().reduce(Text(verbatim: "")) { result, item in
            Text("\(result)\(piece(item.element, index: item.offset))")
        }
    }

    private func piece(_ segment: InlineSegment, index: Int) -> Text {
        switch segment {
        case .text(let value):
            return Text(verbatim: value)
        case .file(let ref):
            let kind = FileTokenKind(name: ref.name)
            let size = Text(verbatim: " \(ref.sizeLabel)")
                .font(BrandFonts.sans((fontSize * 0.78).rounded()))
                .foregroundStyle(ink.opacity(0.7))
            return Text("\(Image(systemName: kind.systemImage)) \(link(ref.name, kind: "file", index: index))\(size)")
        case .skill(let skill):
            return Text("\(Image(systemName: SkillTokenStyle.systemImage)) \(link(skill.slug, kind: "skill", index: index))")
        }
    }

    private func link(_ label: String, kind: String, index: Int) -> Text {
        var value = AttributedString(label)
        value.link = URL(string: "\(Self.scheme)://\(kind)/\(index)")
        return Text(value).fontWeight(.semibold)
    }

    private func open(_ url: URL) {
        guard url.scheme == Self.scheme, let index = Int(url.lastPathComponent), segments.indices.contains(index) else { return }
        switch segments[index] {
        case .file(let ref):
            let client = model.client
            Task {
                guard let local = await AttachmentOpening.localFile(ref, client: client) else {
                    model.showNotice("Não consegui abrir \(ref.name).")
                    return
                }
                QuickLookPanel.shared.show([local], selected: local)
            }
        case .skill(let skill):
            shownSkill = skill
        case .text:
            break
        }
    }
}

struct SkillDescriptionCard: View {
    @Environment(AppModel.self) private var model
    let skill: SkillSummary
    @State private var description: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                Image(systemName: SkillTokenStyle.systemImage)
                    .foregroundStyle(SkillTokenStyle.color)
                Text(skill.name)
                    .font(TypeScale.rowTitle)
                    .foregroundStyle(Theme.textPrimary)
            }
            Text(skill.slug)
                .font(TypeScale.monoInline)
                .foregroundStyle(Theme.textTertiary)
            Group {
                if let description {
                    Text(description.isEmpty ? "Essa skill não tem descrição." : description)
                        .foregroundStyle(description.isEmpty ? Theme.textTertiary : Theme.textSecondary)
                } else {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .font(TypeScale.rowSubtitle)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Spacing.xs)
        }
        .padding(Spacing.m)
        .frame(width: 300, alignment: .leading)
        .task {
            guard description == nil else { return }
            if !skill.description.isEmpty {
                description = skill.description
                return
            }
            let found = try? await model.client.skills(query: skill.slug)
            description = found?.first { $0.slug == skill.slug }?.description ?? ""
        }
    }
}
