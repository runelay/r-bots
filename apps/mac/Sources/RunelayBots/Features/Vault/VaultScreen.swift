import SwiftUI

struct VaultSettings: View {
    @State private var lock = VaultLock.shared

    var body: some View {
        Group {
            if lock.isUnlocked {
                VaultPanel()
                    .transition(.opacity)
            } else {
                VaultLockedView(lock: lock)
                    .transition(.opacity)
            }
        }
        .springAnimation(value: lock.isUnlocked)
    }
}

private struct VaultLockedView: View {
    let lock: VaultLock

    var body: some View {
        VStack(spacing: Spacing.m) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(Theme.textTertiary)
            VStack(spacing: Spacing.xs) {
                Text("O cofre está trancado")
                    .font(BrandFonts.sans(15, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text("Confirme com Touch ID ou a senha do Mac. Ele tranca de novo em 5 minutos ou quando você sai do app.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let failure = lock.failure {
                Text(failure)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.attention)
            }
            Button {
                Task { await lock.unlock() }
            } label: {
                Label("Desbloquear", systemImage: "touchid")
            }
            .buttonStyle(SettingsButtonStyle(kind: .primary))
            .disabled(lock.isAuthenticating)
            .clickable()
        }
        .frame(maxWidth: 380)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.xxl)
        .task {
            await lock.unlock()
        }
    }
}

struct VaultSecretPage: View {
    let name: String?
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigator.self) private var navigator
    @State private var lock = VaultLock.shared
    @State private var store = VaultStore.shared

    var body: some View {
        Group {
            if !lock.isUnlocked {
                VaultLockedView(lock: lock)
                    .transition(.opacity)
            } else if let name {
                if let secret = store.secrets.first(where: { $0.name == name }) {
                    VaultEditor(secret: secret, bots: vaultBots(model)) { _ in
                    } onCancel: {
                    } onDeleted: {
                        navigator.pop()
                    }
                    .id(secret.name)
                    .transition(.opacity)
                }
            } else {
                VaultEditor(secret: nil, bots: vaultBots(model)) { saved in
                    navigator.pop()
                    navigator.push(.secret(saved))
                } onCancel: {
                    navigator.pop()
                }
                .id("new")
                .transition(.opacity)
            }
        }
        .springAnimation(value: lock.isUnlocked)
    }
}

@MainActor
private func vaultBots(_ model: AppModel) -> [Bot] {
    if case .loaded(let list) = model.bots { return list.filter { !$0.isGroup } }
    return []
}

private struct VaultPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigator.self) private var navigator
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var store = VaultStore.shared
    @State private var selection: String?
    @State private var creating = false
    @State private var width: CGFloat = 0

    private var isCompact: Bool { width > 0 && width < 720 }
    private var listWidth: CGFloat { max(280, (width * 0.32).rounded()) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            HStack(spacing: Spacing.s) {
                Text("Senhas e tokens que os bots usam sem ver. Ficam no Keychain deste Mac.")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: Spacing.m)
                Button {
                    if isCompact {
                        navigator.push(.newSecret)
                        return
                    }
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        selection = nil
                        creating = true
                    }
                } label: {
                    Label("Novo segredo", systemImage: "plus")
                }
                .buttonStyle(SettingsButtonStyle(kind: .primary))
                .clickable()
            }

            if let error = store.lastError {
                Text(error)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.attention)
            }

            if isCompact {
                list
            } else {
                HStack(alignment: .top, spacing: Spacing.xl) {
                    list
                        .frame(width: listWidth)
                    detail
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            width = newWidth
        }
        .task {
            await store.reload()
            if selection == nil, !creating {
                selection = store.secrets.first?.name
            }
        }
    }

    @ViewBuilder
    private var list: some View {
        VStack(alignment: .leading, spacing: 2) {
            if store.secrets.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 22))
                        .foregroundStyle(Theme.textTertiary)
                    Text(store.isLoading ? "Abrindo o cofre…" : "Nenhum segredo ainda. Quando um bot precisar de uma senha, ele pede por um formulário seguro, ou você cria aqui.")
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Spacing.m)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(store.secrets) { secret in
                VaultRow(secret: secret, botName: botName(secret.lastUsedBy), isSelected: !isCompact && selection == secret.name && !creating) {
                    if isCompact {
                        navigator.push(.secret(secret.name))
                        return
                    }
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        creating = false
                        selection = secret.name
                    }
                }
                .transition(.opacity)
            }
        }
        .springAnimation(value: store.secrets.map(\.name))
    }

    @ViewBuilder
    private var detail: some View {
        if creating {
            VaultEditor(secret: nil, bots: bots) { name in
                creating = false
                selection = name
            } onCancel: {
                creating = false
            }
            .id("new")
            .transition(.opacity)
        } else if let name = selection, let secret = store.secrets.first(where: { $0.name == name }) {
            VaultEditor(secret: secret, bots: bots) { _ in
            } onCancel: {
            } onDeleted: {
                selection = store.secrets.first?.name
            }
            .id(secret.name)
            .transition(.opacity)
        }
    }

    private var bots: [Bot] {
        vaultBots(model)
    }

    private func botName(_ id: String?) -> String? {
        guard let id else { return nil }
        return model.bot(id: id)?.name ?? id
    }
}

private struct VaultRow: View {
    let secret: VaultSecret
    let botName: String?
    let isSelected: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(spacing: Spacing.m) {
                VaultKindIcon(secret: secret, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(secret.name)
                        .font(BrandFonts.sans(13, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Text(metaLine)
                        .font(TypeScale.caption)
                        .foregroundStyle(secret.isExpired ? Theme.attention : Theme.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Spacing.s + 2)
            .frame(height: 52)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Theme.selection : (isHovering ? Theme.hover : Theme.maskHidden), in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerStyle(.link)
        .onHover { isHovering = $0 }
        .springAnimation(value: isHovering)
    }

    private var metaLine: String {
        if secret.isExpired { return "Vencido" }
        let site = secret.policy.domains.first.map { first in
            secret.policy.domains.count > 1 ? "\(first) +\(secret.policy.domains.count - 1)" : first
        } ?? "Qualquer site"
        if let date = secret.lastUsedAt {
            return "\(site) · \(VaultText.relative(date))\(botName.map { " por \($0)" } ?? "")"
        }
        return "\(site) · nunca usado"
    }
}

private struct VaultKindIcon: View {
    let secret: VaultSecret?
    var size: CGFloat = 30

    var body: some View {
        Image(systemName: secret?.policy.kind == "text" ? "person.text.rectangle" : "key.fill")
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(secret?.isExpired == true ? Theme.textTertiary : Theme.brandText)
            .frame(width: size, height: size)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
    }
}

private struct VaultSettingRow<Content: View>: View {
    let title: String
    var help: String?
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.l) {
            HStack(spacing: Spacing.xs) {
                Text(title)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                if let help {
                    Image(systemName: "info.circle")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textTertiary)
                        .help(help)
                        .accessibilityLabel(help)
                }
            }
            .frame(width: 128, height: 32, alignment: .leading)
            content
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.s)
    }
}

private struct VaultEditor: View {
    let secret: VaultSecret?
    let bots: [Bot]
    let onSaved: (String) -> Void
    let onCancel: () -> Void
    var onDeleted: () -> Void = {}

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var name = ""
    @State private var value = ""
    @State private var descriptionText = ""
    @State private var domainsText = ""
    @State private var allBots = true
    @State private var chosenBots: Set<String> = []
    @State private var touch: VaultTouchPolicy = .hourly
    @State private var hasExpiry = false
    @State private var expiry = Date().addingTimeInterval(30 * 86400)
    @State private var keepOnServer = false
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var rotating = false
    @State private var newValue = ""
    @State private var confirmDelete = false
    @State private var revealed: String?
    @State private var revealTask: Task<Void, Never>?
    @State private var history: [VaultAuditEntry] = []

    init(secret: VaultSecret?, bots: [Bot], onSaved: @escaping (String) -> Void, onCancel: @escaping () -> Void, onDeleted: @escaping () -> Void = {}) {
        self.secret = secret
        self.bots = bots
        self.onSaved = onSaved
        self.onCancel = onCancel
        self.onDeleted = onDeleted
        let policy = secret?.policy ?? VaultPolicy()
        _name = State(initialValue: secret?.name ?? "")
        _descriptionText = State(initialValue: policy.description)
        _domainsText = State(initialValue: policy.domains.joined(separator: ", "))
        _allBots = State(initialValue: policy.bots.isEmpty)
        _chosenBots = State(initialValue: Set(policy.bots))
        _touch = State(initialValue: policy.touchId)
        _hasExpiry = State(initialValue: policy.expiresAt != nil)
        _expiry = State(initialValue: policy.expiresAt ?? Date().addingTimeInterval(30 * 86400))
        _keepOnServer = State(initialValue: secret?.onServer ?? false)
    }

    private var isNew: Bool { secret == nil }

    private var isDirty: Bool {
        guard let secret else { return false }
        let original = secret.policy
        let current = policy
        return current.description != original.description
            || current.domains != original.domains
            || Set(current.bots) != Set(original.bots)
            || current.touchId != original.touchId
            || current.expiresAt != original.expiresAt
            || keepOnServer != secret.onServer
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            header
            if !isNew, secret?.onMac == false {
                Label("Esse segredo não está no Keychain deste Mac. Apague e crie de novo, ou peça ao bot para pedir outra vez.", systemImage: "exclamationmark.triangle.fill")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.attention)
            }
            if rotating {
                rotateRow
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
            fields
            if let error {
                FieldError(message: error)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
            footer
            if !isNew {
                historySection
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: error)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: notice)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: revealed)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: rotating)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: isDirty)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: allBots)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: hasExpiry)
        .task(id: secret?.name) {
            await loadHistory()
        }
        .onDisappear {
            revealTask?.cancel()
            revealed = nil
            value = ""
            newValue = ""
        }
        .confirmationDialog("Apagar “\(secret?.name ?? "")”?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Apagar", role: .destructive) { delete() }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Some do Keychain e do servidor. Os bots param de conseguir usar.")
        }
    }

    @ViewBuilder
    private var header: some View {
        if isNew {
            HStack(spacing: Spacing.m) {
                VaultKindIcon(secret: nil, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Novo segredo")
                        .font(TypeScale.heroName)
                        .foregroundStyle(Theme.textPrimary)
                    Text("O valor vai direto para o Keychain. Nenhum bot vê.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
        } else if let secret {
            VStack(alignment: .leading, spacing: Spacing.m) {
                HStack(alignment: .center, spacing: Spacing.m) {
                    VaultKindIcon(secret: secret, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(secret.name)
                            .font(TypeScale.heroName)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Button {
                            copyReference(secret)
                        } label: {
                            HStack(spacing: Spacing.xs) {
                                Text(notice == "Copiado" ? "Copiado" : secret.reference)
                                    .font(TypeScale.monoInline)
                                    .contentTransition(.opacity)
                                Image(systemName: notice == "Copiado" ? "checkmark" : "doc.on.doc")
                                    .font(.system(size: 10, weight: .medium))
                            }
                            .foregroundStyle(notice == "Copiado" ? Theme.success : Theme.textTertiary)
                        }
                        .buttonStyle(.plain)
                        .pointerStyle(.link)
                        .help("Copiar a referência que o bot usa")
                    }
                    Spacer(minLength: Spacing.m)
                    moreMenu(secret)
                }
                if secret.onMac {
                    HStack(spacing: Spacing.s) {
                        Text(revealed ?? String(repeating: "•", count: 12))
                            .font(TypeScale.mono)
                            .foregroundStyle(revealed == nil ? Theme.textTertiary : Theme.textPrimary)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentTransition(.opacity)
                        if let revealed {
                            Button {
                                copyValue(revealed)
                            } label: {
                                Label(notice == "Valor copiado" ? "Copiado" : "Copiar", systemImage: notice == "Valor copiado" ? "checkmark" : "doc.on.doc")
                                    .font(TypeScale.captionStrong)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                            .buttonStyle(.plain)
                            .pointerStyle(.link)
                            .help("Copia por 60 segundos")
                            Button("Esconder") { hide() }
                                .buttonStyle(.plain)
                                .font(TypeScale.captionStrong)
                                .foregroundStyle(Theme.textSecondary)
                                .pointerStyle(.link)
                        } else {
                            Button {
                                reveal()
                            } label: {
                                Label("Mostrar", systemImage: "touchid")
                                    .font(TypeScale.captionStrong)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                            .buttonStyle(.plain)
                            .pointerStyle(.link)
                            .disabled(busy)
                            .help("Pede Touch ID e mostra por 20 segundos")
                        }
                    }
                    .padding(.horizontal, Spacing.m)
                    .frame(minHeight: 40)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                    .transition(.opacity)
                }
            }
        }
    }

    private func moreMenu(_ secret: VaultSecret) -> some View {
        Menu {
            Button {
                rotating.toggle()
                newValue = ""
            } label: {
                Label("Trocar valor", systemImage: "arrow.triangle.2.circlepath")
            }
            .disabled(busy || !secret.onMac)
            Button {
                copyReference(secret)
            } label: {
                Label("Copiar referência", systemImage: "doc.on.doc")
            }
            Divider()
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Label("Apagar", systemImage: "trash")
            }
            .disabled(busy)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .pointerStyle(.link)
        .help("Mais ações")
    }

    private var rotateRow: some View {
        HStack(spacing: Spacing.s) {
            plainField(SecureField("", text: $newValue, prompt: Text("Valor novo").foregroundStyle(Theme.textTertiary)), mono: true)
            Button("Cancelar") {
                rotating = false
                newValue = ""
            }
            .buttonStyle(.brandSecondary)
            Button("Trocar") { rotate() }
                .buttonStyle(.brandPrimary)
                .disabled(busy || newValue.isEmpty)
        }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: Spacing.l) {
            if isNew {
                ScreenSection(title: "Segredo") {
                    VaultSettingRow(title: "Nome", help: "Os bots usam como segredo:nome. Letras minúsculas e hífen.") {
                        plainField(TextField("", text: $name, prompt: Text("github-token").foregroundStyle(Theme.textTertiary)))
                    }
                    VaultSettingRow(title: "Valor") {
                        plainField(SecureField("", text: $value, prompt: Text("Cole ou digite aqui").foregroundStyle(Theme.textTertiary)), mono: true)
                    }
                }
            }
            ScreenSection(title: "Onde pode ser usado") {
                VaultSettingRow(title: "Para que serve") {
                    plainField(TextField("", text: $descriptionText, prompt: Text("Login do GitHub no navegador").foregroundStyle(Theme.textTertiary)))
                }
                VaultSettingRow(title: "Sites", help: "Vazio vale para qualquer site. *.dominio libera os subdomínios.") {
                    plainField(TextField("", text: $domainsText, prompt: Text("Qualquer site").foregroundStyle(Theme.textTertiary), axis: .vertical).lineLimit(1...6))
                }
                VaultSettingRow(title: "Bots") {
                    VStack(alignment: .leading, spacing: Spacing.s) {
                        Toggle("Todos os bots", isOn: $allBots)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .font(TypeScale.rowSubtitle)
                            .frame(height: 32)
                        if !allBots {
                            FlowRow(spacing: Spacing.xs) {
                                ForEach(bots) { bot in
                                    BotChip(name: bot.name, isOn: chosenBots.contains(bot.id)) {
                                        if chosenBots.contains(bot.id) { chosenBots.remove(bot.id) } else { chosenBots.insert(bot.id) }
                                    }
                                }
                            }
                            .transition(.opacity)
                        }
                    }
                }
            }
            ScreenSection(title: "Proteção") {
                VaultSettingRow(title: "Touch ID") {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Picker("", selection: $touch) {
                            ForEach(VaultTouchPolicy.allCases) { item in
                                Text(item.label).tag(item)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(maxWidth: 300, minHeight: 32)
                        Text(touch.detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .contentTransition(.opacity)
                    }
                }
                VaultSettingRow(title: "Validade") {
                    HStack(spacing: Spacing.m) {
                        Toggle(hasExpiry ? "Vence em" : "Não vence", isOn: $hasExpiry)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .font(TypeScale.rowSubtitle)
                        if hasExpiry {
                            DatePicker("", selection: $expiry, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                                .labelsHidden()
                                .datePickerStyle(.field)
                                .transition(.opacity)
                        }
                    }
                    .frame(height: 32)
                }
                VaultSettingRow(title: "Mac fechado") {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Toggle("Usar mesmo com o Mac fechado", isOn: $keepOnServer)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .font(TypeScale.rowSubtitle)
                            .frame(height: 32)
                        if keepOnServer {
                            Text("Menos seguro: uma cópia cifrada fica no servidor e os bots usam sem Touch ID.")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.attention)
                                .fixedSize(horizontal: false, vertical: true)
                                .transition(.opacity)
                        }
                    }
                }
            }
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: keepOnServer)
    }

    @ViewBuilder
    private var footer: some View {
        if isNew {
            HStack(spacing: Spacing.s) {
                Spacer(minLength: 0)
                Button("Cancelar", action: onCancel)
                    .buttonStyle(.brandSecondary)
                saveButton(title: "Criar")
                    .disabled(busy || name.isEmpty || value.isEmpty)
            }
        } else if isDirty {
            HStack(spacing: Spacing.s) {
                Text("Alterações não salvas")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                Spacer(minLength: 0)
                Button("Descartar") { resetFields() }
                    .buttonStyle(.brandSecondary)
                    .disabled(busy)
                saveButton(title: "Salvar")
                    .disabled(busy)
            }
            .transition(.opacity.combined(with: .offset(y: 4)))
        } else if let notice, notice != "Copiado" {
            Label(notice, systemImage: "checkmark.circle.fill")
                .font(TypeScale.caption)
                .foregroundStyle(Theme.success)
                .transition(.opacity)
        }
    }

    private func saveButton(title: String) -> some View {
        Button {
            save()
        } label: {
            HStack(spacing: Spacing.xs) {
                if busy { ProgressView().controlSize(.mini) }
                Text(title)
            }
        }
        .buttonStyle(.brandPrimary)
    }

    private var historySection: some View {
        ScreenSection(title: "Histórico") {
            if history.isEmpty {
                Text("Nenhum uso ainda.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.horizontal, Spacing.m)
                    .frame(height: 40)
            }
            ForEach(history.prefix(40)) { entry in
                HStack(alignment: .center, spacing: Spacing.m) {
                    Circle()
                        .fill(entry.isProblem ? Theme.attention : Theme.textTertiary)
                        .frame(width: 6, height: 6)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(entry.headline)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textPrimary)
                        if !entry.detail.isEmpty {
                            Text(entry.detail)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                        }
                    }
                    Spacer(minLength: Spacing.s)
                    Text(VaultText.relative(entry.at))
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                .padding(.horizontal, Spacing.m)
                .frame(minHeight: 40)
            }
        }
    }

    private func copyReference(_ secret: VaultSecret) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(secret.reference, forType: .string)
        flash("Copiado")
    }

    private func copyValue(_ value: String) {
        guard VaultLock.shared.copy(value) else { return }
        flash("Valor copiado")
    }

    private func resetFields() {
        let policy = secret?.policy ?? VaultPolicy()
        descriptionText = policy.description
        domainsText = policy.domains.joined(separator: ", ")
        allBots = policy.bots.isEmpty
        chosenBots = Set(policy.bots)
        touch = policy.touchId
        hasExpiry = policy.expiresAt != nil
        expiry = policy.expiresAt ?? Date().addingTimeInterval(30 * 86400)
        keepOnServer = secret?.onServer ?? false
    }

    private func plainField(_ field: some View, mono: Bool = false) -> some View {
        field
            .textFieldStyle(.plain)
            .font(mono ? TypeScale.mono : TypeScale.rowSubtitle)
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, Spacing.xs + 2)
            .frame(minHeight: 32)
            .background(Theme.background, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
    }

    private var policy: VaultPolicy {
        var policy = secret?.policy ?? VaultPolicy()
        policy.description = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
        policy.domains = VaultText.normalizeDomains(domainsText)
        policy.bots = allBots ? [] : bots.map(\.id).filter { chosenBots.contains($0) }
        policy.touchId = touch
        policy.expiresAt = hasExpiry ? expiry : nil
        policy.keepOnServer = keepOnServer
        return policy
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        busy = true
        error = nil
        Task { @MainActor in
            do {
                try await work()
            } catch {
                self.error = (error as? VaultFailure)?.message ?? "Não deu certo. Tente de novo."
            }
            busy = false
        }
    }

    private func save() {
        let policy = policy
        if isNew {
            let name = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = value
            run {
                try await VaultStore.shared.create(name: name, value: value, policy: policy)
                self.value = ""
                onSaved(name)
            }
        } else if let secret {
            run {
                try await VaultStore.shared.update(secret, policy: policy)
                flash("Salvo")
                await loadHistory()
            }
        }
    }

    private func rotate() {
        guard let secret else { return }
        let value = newValue
        run {
            try await VaultStore.shared.rotate(secret, value: value)
            newValue = ""
            rotating = false
            flash("Valor trocado")
            await loadHistory()
        }
    }

    private func delete() {
        guard let secret else { return }
        run {
            try await VaultStore.shared.delete(secret)
            onDeleted()
        }
    }

    private func reveal() {
        guard let secret else { return }
        run {
            guard VaultLock.shared.isUnlocked else { return }
            let value = try await VaultLock.shared.authenticated {
                try await VaultStore.shared.reveal(secret)
            }
            guard VaultLock.shared.isUnlocked else { return }
            revealed = value
            revealTask?.cancel()
            revealTask = Task { @MainActor in
                try? await Task.sleep(for: VaultLock.revealWindow)
                guard !Task.isCancelled else { return }
                hide()
            }
            await loadHistory()
        }
    }

    private func hide() {
        revealTask?.cancel()
        revealed = nil
    }

    private func flash(_ text: String) {
        notice = text
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            if notice == text { notice = nil }
        }
    }

    private func loadHistory() async {
        guard let name = secret?.name else { return }
        history = (try? await VaultStore.shared.history(name)) ?? []
    }
}

private struct BotChip: View {
    let name: String
    let isOn: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: Spacing.xs) {
                Image(systemName: isOn ? "checkmark" : "plus")
                    .font(.system(size: 10, weight: .bold))
                Text(name)
                    .font(TypeScale.captionStrong)
            }
            .foregroundStyle(isOn ? Theme.onAccent : Theme.textSecondary)
            .padding(.horizontal, Spacing.s + 2)
            .frame(height: 26)
            .background(isOn ? Theme.brandAccent : Theme.surfaceRaised, in: Capsule())
        }
        .buttonStyle(.plain)
        .pointerStyle(.link)
    }
}

private struct FlowRow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 480
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += line + spacing
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
        }
        return CGSize(width: width, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += line + spacing
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
