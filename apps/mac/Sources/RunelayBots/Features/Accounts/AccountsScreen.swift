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
            placeholderList(note: "O servidor ainda não lista as contas. Estas são as que o runelay procura nas suas máquinas.")
        case .failed(let message):
            VStack(alignment: .leading, spacing: Spacing.m) {
                FieldError(message: message)
                Button("Tentar de novo") {
                    Task { await model.loadAccounts() }
                }
                .buttonStyle(.brandSecondary)
            }
        case .loaded(let list):
            if list.allSatisfy({ $0.status == "missing" }) {
                placeholderList(note: "Nenhuma conta logada. Entre no Claude Code, Codex, Grok ou Cursor numa das máquinas e procure de novo.")
            } else {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    ForEach(AccountMachine.group(list)) { machine in
                        MachineSection(machine: machine)
                            .transition(.opacity)
                    }
                }
                .springAnimation(value: list.map(\.status))
            }
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

struct AccountMachine: Identifiable {
    let id: String
    let title: String
    let ready: [AIAccount]
    let missing: [AIAccount]
    var disconnected = false

    static func group(_ accounts: [AIAccount]) -> [AccountMachine] {
        var order: [String] = []
        for account in accounts where !order.contains(account.machineKey) {
            order.append(account.machineKey)
        }
        order.sort { rank($0, accounts) < rank($1, accounts) }
        return order.map { key in
            let items = accounts.filter { $0.machineKey == key }
            let first = items.first
            let offline = first?.runner == "mac" && items.allSatisfy { $0.status == "offline" }
            return AccountMachine(
                id: key,
                title: title(first),
                ready: items.filter { $0.status != "missing" },
                missing: items.filter { $0.status == "missing" },
                disconnected: offline
            )
        }
    }

    var caption: String? {
        if disconnected { return "Mac desconectado" }
        let count = ready.filter(\.isReady).count
        guard !ready.isEmpty else { return nil }
        if count == ready.count { return count == 1 ? "1 pronta" : "\(count) prontas" }
        return "\(count) de \(ready.count) prontas"
    }

    private static func rank(_ key: String, _ accounts: [AIAccount]) -> Int {
        guard let account = accounts.first(where: { $0.machineKey == key }) else { return 3 }
        if account.device?.id == DeviceIdentity.currentId, account.device != nil { return 0 }
        switch account.runner {
        case "mac": return 1
        case "vps": return 2
        default: return 3
        }
    }

    private static func title(_ account: AIAccount?) -> String {
        guard let account else { return "" }
        if let device = account.device {
            return device.id == DeviceIdentity.currentId ? "\(device.name) · este Mac" : device.name
        }
        switch account.runner {
        case "mac": return "Este Mac"
        case "vps": return "VPS"
        default: return account.runner.uppercased()
        }
    }
}

private struct MachineSection: View {
    let machine: AccountMachine

    var body: some View {
        ScreenSection(title: machine.title, caption: machine.caption) {
            ForEach(machine.ready) { account in
                AccountRow(account: account)
            }
            if !machine.missing.isEmpty {
                missingRow
            }
        }
    }

    private var missingRow: some View {
        HStack(spacing: Spacing.m) {
            HStack(spacing: -8) {
                ForEach(machine.missing) { account in
                    ProviderLogo(provider: account.provider, size: 14)
                        .frame(width: 26, height: 26)
                        .background(Theme.surfaceRaised, in: Circle())
                        .background(Theme.surface, in: Circle().inset(by: -2))
                }
            }
            .opacity(0.6)
            Text(missingText)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 44)
    }

    private var missingText: String {
        let names = machine.missing.map(\.providerTitle)
        let list: String
        if names.count > 1 {
            list = names.dropLast().joined(separator: ", ") + " e " + (names.last ?? "")
        } else {
            list = names.first ?? ""
        }
        let verb = names.count > 1 ? "não estão instalados" : "não está instalado"
        return "\(list) \(verb) aqui."
    }
}

private struct AccountRow: View {
    let account: AIAccount

    var body: some View {
        AccountRowLayout(provider: account.provider, title: account.providerTitle, subtitle: account.friendlyDetail) {
            if account.isReady {
                Circle()
                    .fill(Theme.success)
                    .frame(width: 6, height: 6)
                    .help("Pronta")
                    .accessibilityLabel("Pronta")
            }
        } trailing: {
            if account.isReady {
                ModelChips(models: account.models)
            } else {
                Text(account.statusLabel)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(statusColor)
            }
        }
    }

    private var statusColor: Color {
        switch account.status {
        case "logged_out": Theme.attention
        case "offline": Theme.textTertiary
        default: Theme.danger
        }
    }
}

private struct AccountRowLayout<Badge: View, Trailing: View>: View {
    let provider: String
    let title: String
    let subtitle: String?
    @ViewBuilder let badge: Badge
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: Spacing.m) {
            ProviderLogo(provider: provider, size: 20)
                .frame(width: 36, height: 36)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.small + 2, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Spacing.s) {
                    Text(title)
                        .font(BrandFonts.sans(13, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
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
        KnownProvider(id: "claude", label: "Claude · assinatura", detail: "Claude Code com a sua assinatura."),
        KnownProvider(id: "codex", label: "ChatGPT · Codex", detail: "Codex CLI com a assinatura do ChatGPT."),
        KnownProvider(id: "grok", label: "Grok", detail: "Grok CLI."),
        KnownProvider(id: "cursor", label: "Cursor", detail: "cursor-agent com a assinatura do Cursor.")
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
