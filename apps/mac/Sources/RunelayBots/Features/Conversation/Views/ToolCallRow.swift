import SwiftUI

struct ToolCallRow: View {
    let call: ToolCall
    var via: Bot? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let via {
                ViaAgentTag(bot: via)
            }
            CompactToolRow(call: call)
        }
    }
}

struct CompactToolRow: View {
    @Environment(AppModel.self) private var model
    let call: ToolCall
    var showsBackground = true
    var showsThumbnail = true

    @State private var showsResult = false
    @State private var showsTechnical = false
    @State private var showsShot = false
    @State private var isHovering = false

    private var phrase: ActionPhrase {
        ActionPhrase(call: call)
    }

    private var hasTechnical: Bool {
        !call.input.isNull || call.output != nil || call.errorMessage != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            card
            if showsResult {
                ReadableResult(call: call)
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, Spacing.s + 2)
                    .frame(width: 360, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
            if showsTechnical {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    if !call.input.isNull {
                        CodeBlock(title: tr("Entrada"), text: call.input.prettyPrinted())
                    }
                    if let output = call.output {
                        CodeBlock(title: tr("Saída"), text: output.prettyPrinted())
                    }
                    if let error = call.errorMessage {
                        CodeBlock(title: tr("Erro"), text: error)
                    }
                }
                .frame(maxWidth: 560, alignment: .leading)
                .transition(.opacity)
            }
        }
        .springAnimation(value: showsResult)
        .springAnimation(value: showsTechnical)
    }

    private var isVisual: Bool {
        showsThumbnail && (ActionShots.hasShot(call) || phrase.url != nil)
    }

    private var card: some View {
        let phrase = phrase
        let visual = isVisual
        return HStack(spacing: Spacing.s + 2) {
            Button(action: open) {
                HStack(spacing: Spacing.s + 2) {
                    ActionLeading(call: call, phrase: phrase, showsShot: showsThumbnail, compact: !visual)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title(phrase))
                            .font(TypeScale.captionStrong)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if let subtitle = subtitle(phrase) {
                            Text(subtitle)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .frame(maxWidth: visual ? .infinity : nil, alignment: .leading)
                    ActionStatus(status: call.status)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            .help(openHint)
            .popover(isPresented: $showsShot, arrowEdge: .bottom) {
                ActionShotPreview(call: call, phrase: phrase)
            }

            GlassMenuIconButton(systemImage: "ellipsis", help: tr("Mais opções"), iconSize: 11, size: 22, weight: .semibold, edge: .trailing) {
                var items: [GlassMenuItem] = []
                if let url = phrase.url {
                    items.append(GlassMenuItem(tr("Abrir no meu navegador"), systemImage: "safari") { NSWorkspace.shared.open(url) })
                    items.append(
                        GlassMenuItem(tr("Copiar link"), systemImage: "link") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(url.absoluteString, forType: .string)
                        })
                }
                if hasTechnical {
                    items.append(
                        GlassMenuItem(showsTechnical ? tr("Ocultar detalhes técnicos") : tr("Detalhes técnicos"), id: "technical", systemImage: "curlybraces", startsSection: phrase.url != nil) {
                            showsTechnical.toggle()
                        })
                }
                return items
            }
            .opacity(isHovering || showsTechnical ? 1 : 0)
            .disabled(phrase.url == nil && !hasTechnical)
        }
        .padding(.leading, visual ? 6 : Spacing.m)
        .padding(.trailing, visual ? Spacing.s : Spacing.xs)
        .padding(.vertical, visual ? 0 : Spacing.xs + 2)
        .frame(minHeight: visual ? 52 : 36)
        .frame(height: visual ? 52 : nil)
        .fixedSize(horizontal: !visual, vertical: false)
        .frame(maxWidth: visual ? 420 : nil, alignment: .leading)
        .background(
            isHovering ? Theme.surfaceRaised : (showsBackground ? Theme.surface : Theme.hover),
            in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        )
        .onHover { hovering in
            isHovering = hovering
        }
        .frame(maxWidth: 420, alignment: .leading)
        .springAnimation(value: isHovering)
    }

    private func title(_ phrase: ActionPhrase) -> AttributedString {
        if phrase.surface == .browser, let pageTitle = call.output?["title"]?.stringValue, !pageTitle.isEmpty,
            ["browser_open", "browser_snapshot", "browser_screenshot"].contains(call.name)
        {
            return AttributedString(pageTitle)
        }
        var bare = phrase
        bare.place = nil
        return bare.text
    }

    private func subtitle(_ phrase: ActionPhrase) -> String? {
        var parts: [String] = []
        switch phrase.surface {
        case .browser:
            parts.append(phrase.host ?? tr("Navegador do bot"))
        case .desktop:
            parts.append(tr("Computador do bot"))
        case .computer:
            parts.append(phrase.app ?? tr("Seu Mac"))
        case .connector:
            if let connector = call.connectorName {
                parts.append(ConnectorNames.pretty(connector))
            }
        case .other:
            if call.isDelegation {
                parts.append(tr("Delegação"))
            } else if call.name == "prod_query" {
                parts.append(tr("Banco de produção"))
            }
        }
        if let note = call.decisionNote {
            parts.append(note)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var callBot: Bot? {
        call.viaAgent.flatMap { model.bot(id: $0) } ?? model.selectedBot
    }

    private var canShowBotScreen: Bool {
        guard let bot = callBot, bot.id == model.selectedBot?.id else { return false }
        return phrase.surface == .desktop ? bot.hasDesktop : bot.hasBrowser
    }

    private var openHint: String {
        switch phrase.surface {
        case .browser:
            return canShowBotScreen ? tr("Ver no navegador do bot") : tr("Ver o resultado")
        case .desktop:
            return canShowBotScreen ? tr("Ver o computador do bot") : tr("Ver o resultado")
        case .computer:
            return ActionShots.hasShot(call) ? tr("Ver como ficou a tela") : tr("Ver o resultado")
        case .connector, .other:
            return showsResult ? tr("Ocultar o resultado") : tr("Ver o resultado")
        }
    }

    private func open() {
        switch phrase.surface {
        case .browser:
            if canShowBotScreen, let bot = callBot {
                model.showBrowserAction(call, botID: bot.id)
            } else {
                showsResult.toggle()
            }
        case .desktop:
            if canShowBotScreen {
                model.switchComputerSurface("desktop")
                model.openComputer()
            } else {
                showsResult.toggle()
            }
        case .computer:
            if ActionShots.hasShot(call) {
                showsShot = true
            } else {
                showsResult.toggle()
            }
        case .connector, .other:
            showsResult.toggle()
        }
    }
}

struct ActionLeading: View {
    @Environment(AppModel.self) private var model
    let call: ToolCall
    let phrase: ActionPhrase
    var showsShot = true
    var compact = false

    @State private var image: NSImage?

    var body: some View {
        if compact {
            ActionIcon(phrase: phrase, connector: call.connectorName, size: 14)
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 18, height: 18)
        } else {
            tile
        }
    }

    private var tile: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                .fill(Theme.selection)
            ActionIcon(phrase: phrase, connector: call.connectorName, size: 18)
            if let image {
                ActionThumbnail(image: image, width: 64, height: 40)
                    .transition(.opacity)
            }
        }
        .frame(width: 64, height: 40)
        .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .springAnimation(value: image != nil)
        .task(id: showsShot ? call.id + (call.screenshotPath ?? "") + (call.output?["screenshot"]?.stringValue ?? "") : "") {
            guard showsShot, ActionShots.hasShot(call) else { return }
            image = await ActionShots.load(call: call, model: model)
        }
    }
}

struct ActionStatus: View {
    let status: ToolCallStatus

    var body: some View {
        Group {
            switch status {
            case .requested, .running:
                ProgressView()
                    .controlSize(.mini)
                    .frame(width: 14, height: 14)
            case .failed:
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.danger)
            case .rejected:
                Text("não permitido")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            case .interrupted:
                Text("interrompido")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
            case .completed, .other:
                EmptyView()
            }
        }
        .transition(.opacity)
        .accessibilityLabel(status.label)
    }
}

struct ActionShotPreview: View {
    @Environment(AppModel.self) private var model
    let call: ToolCall
    let phrase: ActionPhrase

    @State private var image: NSImage?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Text(phrase.text)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
            Group {
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                } else {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(width: 640, height: 400)
        }
        .padding(Spacing.m)
        .task(id: call.id) {
            image = await ActionShots.load(call: call, model: model)
        }
    }
}

struct StatusDot: View {
    let status: ToolCallStatus

    var body: some View {
        Circle()
            .fill(Theme.toolStatus(status))
            .frame(width: 7, height: 7)
            .opacity(status.isActive ? 0.9 : 1)
            .symbolEffect(.pulse, options: .repeating, isActive: status.isActive)
            .accessibilityLabel(status.label)
    }
}

struct ToolGroupRow: View {
    let calls: [ToolCall]

    @State private var isExpanded = false

    var body: some View {
        let nouns = Set(calls.map(\.groupNoun))
        let noun = nouns.count == 1 ? nouns.first ?? tr("ferramentas") : tr("ferramentas")
        let failed = calls.filter { $0.status == .failed || $0.status == .rejected }.count
        let phrases = calls.map { ActionPhrase(call: $0) }
        let hosts = phrases.compactMap(\.host).reduce(into: [String]()) { result, host in
            if !result.contains(host), result.count < 3 { result.append(host) }
        }

        VStack(alignment: .leading, spacing: Spacing.xs) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack(spacing: Spacing.s) {
                    if hosts.isEmpty {
                        Image(systemName: calls.first?.symbol ?? "wrench.and.screwdriver")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.textSecondary)
                    } else {
                        HStack(spacing: -4) {
                            ForEach(hosts, id: \.self) { host in
                                ActionIcon(phrase: ActionPhrase(verb: "", url: URL(string: "https://\(host)")), size: 14)
                            }
                        }
                    }
                    Text("\(calls.count) \(noun)")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textPrimary)
                    if let current = calls.last(where: { $0.status.isActive }) {
                        Text("\(String(ActionPhrase(call: current).text.characters))…")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.brandText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .contentTransition(.opacity)
                    } else if failed > 0 {
                        Text(failed == 1 ? "1 falhou" : "\(failed) falharam")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .frame(height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()

            if isExpanded {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    ForEach(calls) { call in
                        CompactToolRow(call: call)
                    }
                }
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .springAnimation(value: isExpanded)
    }
}

struct ToolCallSummary: View {
    let call: ToolCall

    var body: some View {
        let phrase = ActionPhrase(call: call)
        HStack(spacing: Spacing.s) {
            ActionIcon(phrase: phrase, connector: call.connectorName, size: 14)
                .frame(width: 16)
            Text(phrase.text)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: Spacing.s)
            ToolCallStatusBadge(status: call.status)
        }
        .contentShape(Rectangle())
    }
}

struct ToolCallStatusBadge: View {
    let status: ToolCallStatus

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: status.symbol)
                .symbolEffect(.pulse, options: .repeating, isActive: status.isActive)
            Text(status.label)
        }
        .font(TypeScale.caption)
        .foregroundStyle(Theme.toolStatus(status))
        .contentTransition(.opacity)
        .springAnimation(value: status)
    }
}

struct CodeBlock: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(title)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textSecondary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(TypeScale.mono)
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(Spacing.s + 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        }
    }
}

struct ToolSymbol: View {
    let call: ToolCall

    var body: some View {
        if let connector = call.connectorName {
            ConnectorLogo(name: connector, size: 14)
                .frame(width: 16)
        } else {
            Image(systemName: call.symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 16)
        }
    }
}
