import SwiftUI

struct ApprovalCard: View {
    let approval: Approval
    let call: ToolCall?
    let accent: String
    var via: Bot? = nil
    var bot: Bot? = nil
    var shortcutsEnabled = false
    let answer: (String) -> Void

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var selection: String?
    @State private var hasEntered = false

    private var isSimpleApproval: Bool {
        let ids = Set(approval.options.map(\.id))
        return approval.kind == "approval" && ids.isSubset(of: ["approve", "approve_always", "deny"])
    }

    private var skipOption: ApprovalOption? {
        approval.options.first { ["deny", "skip", "cancel"].contains($0.id) }
    }

    var body: some View {
        if isSimpleApproval || approval.options.isEmpty {
            simpleBody
        } else {
            choiceBody
        }
    }

    private var phrase: ActionPhrase {
        ActionPhrase(approval: approval, call: call)
    }

    @ViewBuilder
    private var simpleBody: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let via, approval.isOpen {
                ViaAgentTag(bot: via)
            }
            if approval.isOpen {
                ActionApprovalCard(
                    approval: approval,
                    phrase: phrase,
                    connector: call?.connectorName,
                    bot: bot,
                    shortcutsEnabled: shortcutsEnabled,
                    answer: answer
                )
                .scaleEffect(hasEntered || reduceMotion ? 1 : 0.94, anchor: .topLeading)
                .opacity(hasEntered ? 1 : 0)
                .transition(.asymmetric(
                    insertion: .opacity,
                    removal: reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.9, anchor: .leading))
                ))
            } else {
                ApprovalOutcomeLine(approval: approval, phrase: phrase, connector: call?.connectorName)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -4)))
            }
        }
        .springAnimation(value: approval.resolution)
        .onAppear {
            guard !hasEntered else { return }
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                hasEntered = true
            }
        }
    }

    private var choiceBody: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            if let via {
                ViaAgentTag(bot: via)
            }

            Text(approval.prompt.isEmpty ? approval.title : approval.prompt)
                .font(BrandFonts.sans(15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            switch approval.resolution {
            case .open:
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    ForEach(Array(approval.options.enumerated()), id: \.element.id) { index, option in
                        LetteredOption(
                            letter: Self.letter(index),
                            option: option,
                            isSelected: selection == option.id
                        ) {
                            selection = option.id
                        }
                    }
                }
                HStack(spacing: Spacing.s) {
                    Spacer(minLength: 0)
                    if let skipOption {
                        Button("Pular") { answer(skipOption.id) }
                            .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                    }
                    Button("Concluído") {
                        if let selection {
                            answer(selection)
                        }
                    }
                    .buttonStyle(SmallPillButtonStyle(kind: .primary))
                    .disabled(selection == nil)
                }
                .transition(.opacity)
            case .answering(let optionID):
                ResolvedLabel(summary: approval.summary(for: optionID))
                    .transition(.opacity)
            case .settled(let text, let tone):
                ResolvedLabel(summary: (text, tone))
                    .transition(.opacity)
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .springAnimation(value: approval.resolution)
        .springAnimation(value: selection)
    }

    private static func letter(_ index: Int) -> String {
        let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        return index < letters.count ? String(letters[index]) : "\(index + 1)"
    }
}

struct ActionApprovalCard: View {
    let approval: Approval
    let phrase: ActionPhrase
    var connector: String? = nil
    var bot: Bot? = nil
    var shortcutsEnabled = false
    let answer: (String) -> Void

    private var previewImage: NSImage? {
        approval.previewImage.flatMap(NSImage.init(data:))
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Spacing.m) {
                leading
                sentence
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing
            }
            VStack(alignment: .leading, spacing: Spacing.s) {
                HStack(spacing: Spacing.m) {
                    leading
                    sentence
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack(spacing: Spacing.s) {
                    Spacer(minLength: 0)
                    trailing
                }
            }
        }
        .padding(.leading, Spacing.s + 2)
        .padding(.trailing, Spacing.m)
        .padding(.vertical, Spacing.s + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.medium + 2, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pedido de permissão: \(phrase.plain)")
    }

    @ViewBuilder
    private var leading: some View {
        if let previewImage {
            ActionThumbnail(image: previewImage)
        } else {
            ActionIcon(phrase: phrase, connector: connector, size: 20)
                .frame(width: 36, height: 36)
                .background(Theme.selection, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
    }

    private var sentence: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(phrase.text)
                .font(TypeScale.rowTitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(phrase.plain)
            if let reason = approval.reason {
                Text(reason)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .help(reason)
            }
            if let url = approval.signInURL {
                Link("Abrir login", destination: url)
                    .font(TypeScale.captionStrong)
                    .clickable()
            }
        }
    }

    private var trailing: some View {
        HStack(spacing: Spacing.s) {
            if let bot {
                BotCharacter(bot: bot, mood: .waiting, size: 18)
                    .help("\(bot.name) está esperando sua resposta")
                    .accessibilityLabel("\(bot.name) está esperando sua resposta")
            }
            denyButton
            if approval.options.contains(where: { $0.id == "approve_always" }) {
                Button("Sempre neste repo") { answer("approve_always") }
                    .buttonStyle(SmallPillButtonStyle(kind: .neutral))
                    .help(approval.grant.map { "Não perguntar mais: \($0)" } ?? "Não perguntar mais neste repositório")
            }
            allowButton
        }
        .fixedSize()
    }

    @ViewBuilder
    private var allowButton: some View {
        let button = Button("Permitir") { answer("approve") }
            .buttonStyle(SmallPillButtonStyle(kind: .primary))
            .help("Permitir (↩)")
        if shortcutsEnabled {
            button.keyboardShortcut(.defaultAction)
        } else {
            button
        }
    }

    @ViewBuilder
    private var denyButton: some View {
        let button = Button("Agora não") { answer("deny") }
            .buttonStyle(SmallPillButtonStyle(kind: .neutral))
            .help("Agora não (Esc)")
        if shortcutsEnabled {
            button.keyboardShortcut(.cancelAction)
        } else {
            button
        }
    }
}

struct ApprovalOutcomeLine: View {
    let approval: Approval
    let phrase: ActionPhrase
    var connector: String? = nil

    var body: some View {
        let outcome = Self.outcome(approval)
        HStack(spacing: Spacing.s) {
            ActionIcon(phrase: phrase, connector: connector, size: 14)
                .opacity(0.8)
            (Text(outcome.0).foregroundStyle(outcome.1) + Text(" · ").foregroundStyle(Theme.textTertiary) + Text(phrase.text).foregroundStyle(Theme.textSecondary))
                .font(TypeScale.caption)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 24, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    static func outcome(_ approval: Approval) -> (String, Color) {
        switch approval.resolution {
        case .open:
            return ("Aguardando", Theme.textTertiary)
        case .answering(let optionID):
            return optionID == "approve" ? ("Permitido", Theme.textSecondary) : ("Não permitido", Theme.textSecondary)
        case .settled(let text, let tone):
            switch tone {
            case .approved: return ("Permitido", Theme.textSecondary)
            case .denied: return ("Não permitido", Theme.textSecondary)
            case .neutral: return (text, Theme.textTertiary)
            }
        }
    }
}

struct LetteredOption: View {
    let letter: String
    let option: ApprovalOption
    let isSelected: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: Spacing.m) {
                Text(letter)
                    .font(TypeScale.counter)
                    .foregroundStyle(isSelected ? Theme.onAccent : Theme.textSecondary)
                    .frame(width: 24, height: 24)
                    .background(isSelected ? Theme.brandAccent : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(TypeScale.rowTitle)
                        .foregroundStyle(Theme.textPrimary)
                    if let detail = option.detail, !detail.isEmpty {
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s)
            .padding(.vertical, Spacing.s)
            .background(isHovering ? Theme.hover : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering in
            isHovering = hovering
        }
        .springAnimation(value: isHovering)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct ResolvedLabel: View {
    let summary: (String, ApprovalTone)

    var body: some View {
        Label(summary.0, systemImage: symbol)
            .font(TypeScale.captionStrong)
            .foregroundStyle(color)
    }

    private var symbol: String {
        switch summary.1 {
        case .approved: "checkmark.circle.fill"
        case .denied: "xmark.circle.fill"
        case .neutral: "minus.circle.fill"
        }
    }

    private var color: Color {
        switch summary.1 {
        case .approved: Theme.success
        case .denied: Theme.danger
        case .neutral: Theme.textSecondary
        }
    }
}
