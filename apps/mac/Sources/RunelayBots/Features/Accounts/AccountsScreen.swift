import SwiftUI

struct AIAccountsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        content
            .task {
                await model.loadAccounts()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.accounts {
        case .idle, .loading:
            VStack(alignment: .leading, spacing: Spacing.xl) {
                ForEach(0..<2, id: \.self) { _ in
                    ScreenSection(title: " ") {
                        ForEach(0..<2, id: \.self) { _ in
                            AccountSkeletonRow()
                        }
                    }
                    .redacted(reason: .placeholder)
                }
            }
        case .unsupported:
            placeholderList(note: "O servidor ainda não lista as contas. Estas são as que o runelay procura nele.")
        case .failed(let message):
            VStack(alignment: .leading, spacing: Spacing.m) {
                FieldError(message: message)
                Button("Tentar de novo") {
                    Task { await model.loadAccounts() }
                }
                .buttonStyle(.brandSecondary)
            }
        case .loaded(let list):
            VStack(alignment: .leading, spacing: Spacing.xl) {
                AccountsListSection(accounts: list)
                AddAccountSection()
            }
            .springAnimation(value: list.map(\.id))
        }
    }

    private func placeholderList(note: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text(note)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
            ScreenSection(title: "Contas suportadas") {
                ForEach(KnownProvider.all) { provider in
                    AccountRowLayout(provider: provider.id, title: provider.label, subtitle: provider.detail) {
                        EmptyView()
                    } badge: {
                        EmptyView()
                    } trailing: {
                        Text("Aguardando")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
            }
        }
    }
}

enum ScreenLayout {
    static let width: CGFloat = 880
}

struct ScreenSection<Trailing: View, Content: View>: View {
    let title: String
    var caption: String?
    let trailing: Trailing
    let content: Content

    init(title: String, caption: String? = nil, @ViewBuilder trailing: () -> Trailing, @ViewBuilder content: () -> Content) {
        self.title = title
        self.caption = caption
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                Text(title)
                    .font(BrandFonts.sans(13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                if let caption {
                    Text(caption)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                Spacer(minLength: 0)
                trailing
            }
            .padding(.horizontal, Spacing.xs)
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .padding(Spacing.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        }
    }
}

extension ScreenSection where Trailing == EmptyView {
    init(title: String, caption: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, caption: caption, trailing: { EmptyView() }, content: content)
    }
}

private struct AccountSkeletonRow: View {
    var body: some View {
        HStack(spacing: Spacing.m) {
            RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                .fill(Theme.surfaceRaised)
                .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 4) {
                Text("Carregando conta")
                    .font(TypeScale.rowTitle)
                Text("conta@exemplo.com")
                    .font(TypeScale.caption)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 60)
    }
}

struct AccountsListSection: View {
    let accounts: [AIAccount]

    private var shown: [AIAccount] {
        accounts.filter { $0.status != "missing" || $0.hasLogin }
    }

    private var missing: [AIAccount] {
        accounts.filter { $0.status == "missing" && !$0.hasLogin }
    }

    private var caption: String? {
        let ready = shown.filter(\.isReady).count
        guard !shown.isEmpty else { return nil }
        if ready == shown.count { return ready == 1 ? "1 pronta" : "\(ready) prontas" }
        return "\(ready) de \(shown.count) prontas"
    }

    var body: some View {
        ScreenSection(title: "Contas do servidor", caption: caption) {
            ForEach(shown) { account in
                AccountRow(account: account, showsDefault: shown.filter { $0.provider == account.provider }.count > 1)
                    .transition(.opacity)
            }
            if !missing.isEmpty {
                MissingToolsRow(accounts: missing)
            }
        }
    }
}

private struct MissingToolsRow: View {
    let accounts: [AIAccount]

    var body: some View {
        HStack(spacing: Spacing.m) {
            HStack(spacing: -8) {
                ForEach(accounts) { account in
                    ProviderLogo(provider: account.provider, size: 14)
                        .frame(width: 26, height: 26)
                        .background(Theme.surfaceRaised, in: Circle())
                        .background(Theme.surface, in: Circle().inset(by: -2))
                }
            }
            .opacity(0.6)
            Text(text)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 44)
    }

    private var text: String {
        let names = accounts.map(\.name)
        let list = names.count > 1 ? names.dropLast().joined(separator: ", ") + " e " + (names.last ?? "") : names.first ?? ""
        return "\(list) \(names.count > 1 ? "não estão instalados" : "não está instalado") no servidor."
    }
}

private struct AccountRow: View {
    @Environment(AppModel.self) private var model
    let account: AIAccount
    let showsDefault: Bool

    @State private var hovering = false
    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        AccountRowLayout(provider: account.provider, title: account.name, subtitle: subtitle, editing: editing) {
            TextField("", text: $draft, prompt: Text(account.autoName))
                .textFieldStyle(.plain)
                .font(BrandFonts.sans(13, weight: .semibold))
                .focused($focused)
                .padding(.horizontal, Spacing.s)
                .frame(width: 220, height: 26)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .onSubmit(commit)
                .onKeyPress(.escape) {
                    editing = false
                    return .handled
                }
                .onChange(of: focused) {
                    if !focused, editing { commit() }
                }
        } badge: {
            if account.isReady {
                Circle()
                    .fill(Theme.success)
                    .frame(width: 6, height: 6)
                    .help("Pronta")
                    .accessibilityLabel("Pronta")
            }
            if showsDefault, account.isDefault {
                RoleTag(text: "Padrão")
                    .fixedSize()
                    .help("Bots novos usam esta conta.")
            }
        } trailing: {
            HStack(spacing: Spacing.s) {
                if account.isReady {
                    ModelChips(models: account.models)
                } else {
                    Text(account.statusLabel)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(statusColor)
                }
                if account.hasLogin {
                    GlassMenuButton(edge: .trailing, help: "Ações da conta", items: { actions }) { isOpen in
                        BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen)
                    }
                    .fixedSize()
                    .opacity(hovering || editing ? 1 : 0.0001)
                }
            }
        }
        .background(hovering ? Theme.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .onHover { hovering = $0 }
        .springAnimation(value: hovering)
        .springAnimation(value: editing)
    }

    private var subtitle: String? {
        let parts = [hovering ? account.email : nil, account.planLabel, account.configDir].compactMap { $0 }.filter { !$0.isEmpty }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return account.friendlyDetail
    }

    private var actions: [GlassMenuItem] {
        var items = [
            GlassMenuItem("Renomear", systemImage: "pencil") {
                draft = account.name == account.autoName ? "" : account.name
                editing = true
                focused = true
            }
        ]
        if account.name != account.autoName {
            items.append(
                GlassMenuItem("Voltar para \(account.autoName)", systemImage: "arrow.uturn.backward") {
                    model.renameAccount(account, to: nil)
                })
        }
        if !account.isDefault {
            items.append(
                GlassMenuItem("Usar como padrão", systemImage: "checkmark.circle", startsSection: true) {
                    model.makeDefaultAccount(account)
                })
        }
        if account.added {
            items.append(
                GlassMenuItem("Tirar da lista", systemImage: "minus.circle", destructive: true, startsSection: true) {
                    model.removeAccount(account)
                })
        }
        return items
    }

    private func commit() {
        guard editing else { return }
        editing = false
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != account.name else { return }
        model.renameAccount(account, to: trimmed.isEmpty ? nil : trimmed)
    }

    private var statusColor: Color {
        switch account.status {
        case "logged_out": Theme.attention
        case "offline": Theme.textTertiary
        default: Theme.danger
        }
    }
}

enum LoginProvider: String, CaseIterable, Identifiable {
    case claude
    case codex

    var id: String { rawValue }
    var title: String { self == .claude ? "Claude" : "Codex" }
}

struct AddAccountSection: View {
    @Environment(AppModel.self) private var model

    @State private var provider = LoginProvider.claude
    @State private var guide: AccountLoginGuide?
    @State private var path = ""
    @State private var error: String?
    @State private var adding = false
    @State private var copied = false

    var body: some View {
        ScreenSection(title: "Adicionar conta", caption: "Outra assinatura do Claude ou do Codex no servidor") {
            VStack(alignment: .leading, spacing: Spacing.m) {
                HStack(spacing: Spacing.m) {
                    Text("Cada conta mora numa pasta própria no servidor. Faça o login numa pasta nova e ela aparece aqui sozinha.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: Spacing.l)
                    ChoicePills(options: LoginProvider.allCases, selection: $provider, title: \.title)
                        .fixedSize()
                }
                if let guide {
                    VStack(alignment: .leading, spacing: Spacing.s) {
                        ForEach(Array(guide.steps.enumerated()), id: \.offset) { index, step in
                            HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                                Text("\(index + 1)")
                                    .font(TypeScale.captionStrong)
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.textTertiary)
                                    .frame(width: 14, alignment: .trailing)
                                Text(step)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Theme.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if index == 1 {
                                commandLine(guide.command)
                            }
                        }
                    }
                    .transition(.opacity)
                }
                HStack(spacing: Spacing.s) {
                    TextField("", text: $path, prompt: Text("Já tem login noutra pasta? ~/.claude-trabalho"))
                        .textFieldStyle(.plain)
                        .font(BrandFonts.mono(12))
                        .autocorrectionDisabled()
                        .padding(.horizontal, Spacing.s)
                        .frame(height: 28)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .onSubmit(add)
                    Button(adding ? "Adicionando…" : "Adicionar pasta", action: add)
                        .buttonStyle(SettingsButtonStyle(kind: .plain))
                        .disabled(adding || path.trimmingCharacters(in: .whitespaces).isEmpty)
                        .clickable()
                }
                if let error {
                    FieldError(message: error)
                }
            }
            .padding(Spacing.m)
        }
        .springAnimation(value: guide)
        .springAnimation(value: error)
        .task(id: provider) {
            guide = await model.accountLoginGuide(provider: provider.rawValue)
        }
    }

    private func commandLine(_ command: String) -> some View {
        HStack(spacing: Spacing.s) {
            Text(command)
                .font(BrandFonts.mono(12))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(copied ? Theme.success : Theme.textSecondary)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Copiar comando")
        }
        .padding(.horizontal, Spacing.s)
        .frame(height: 32)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .padding(.leading, 22)
    }

    private func add() {
        let value = path.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, !adding else { return }
        adding = true
        Task {
            error = await model.addAccountDir(value)
            if error == nil { path = "" }
            adding = false
        }
    }
}

private struct AccountRowLayout<Editor: View, Badge: View, Trailing: View>: View {
    let provider: String
    let title: String
    let subtitle: String?
    var editing = false
    @ViewBuilder let editor: Editor
    @ViewBuilder let badge: Badge
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: Spacing.m) {
            ProviderLogo(provider: provider, size: 20)
                .frame(width: 36, height: 36)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Spacing.s) {
                    if editing {
                        editor
                    } else {
                        Text(title)
                            .font(BrandFonts.sans(13, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                    }
                    badge
                }
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: Spacing.l)
            trailing
        }
        .padding(.horizontal, Spacing.m)
        .frame(minHeight: 60)
    }
}

private struct ModelChips: View {
    let models: [AccountModel]
    private let limit = 3

    var body: some View {
        if !models.isEmpty {
            HStack(spacing: Spacing.xs) {
                ForEach(models.prefix(limit)) { model in
                    RoleTag(text: model.label)
                        .fixedSize()
                }
                if models.count > limit {
                    RoleTag(text: "+\(models.count - limit)")
                        .fixedSize()
                }
            }
            .help(models.map(\.label).joined(separator: ", "))
        }
    }
}

extension AIAccount {
    var friendlyDetail: String? {
        guard let detail, !detail.isEmpty else { return nil }
        let lowered = detail.lowercased()
        if lowered.contains("logged in using chatgpt") { return "Assinatura do ChatGPT" }
        if lowered.contains("api key") { return "Chave de API" }
        if lowered.contains("not installed") || lowered.contains("não instalada") { return nil }
        return detail.replacingOccurrences(of: " · team", with: " · Team")
    }
}

struct KnownProvider: Identifiable {
    let id: String
    let label: String
    let detail: String

    static let all = [
        KnownProvider(id: "claude", label: "Claude", detail: "Claude Code com a sua assinatura."),
        KnownProvider(id: "codex", label: "ChatGPT · Codex", detail: "Codex CLI com a assinatura do ChatGPT."),
        KnownProvider(id: "grok", label: "Grok", detail: "Grok CLI."),
        KnownProvider(id: "cursor", label: "Cursor", detail: "cursor-agent com a assinatura do Cursor."),
    ]
}

struct PillLabel: View {
    let text: String
    let dot: Color

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Circle()
                .fill(dot)
                .frame(width: 6, height: 6)
            Text(text)
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, Spacing.s + 2)
        .frame(height: 24)
        .background(Theme.surfaceRaised, in: Capsule())
    }
}
