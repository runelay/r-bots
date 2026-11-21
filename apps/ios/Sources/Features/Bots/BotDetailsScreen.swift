import SwiftUI

struct BotDetailsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let botID: String
    var sessionID: String?

    @State private var editing = false
    @State private var confirmsArchive = false
    @State private var error: String?
    @State private var busy = false

    private var bot: Bot? { model.bot(id: botID) }

    var body: some View {
        NavigationStack {
            List {
                if let bot {
                    header(bot)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                    if let sessionID {
                        Section {
                            Picker(selection: permissionBinding(sessionID)) {
                                ForEach(PermissionMode.allCases) { mode in
                                    Label(mode.title, systemImage: mode.systemImage).tag(mode)
                                }
                            } label: {
                                Text("Permissões nesta conversa")
                            }
                        } footer: {
                            Text(model.permission(botID: botID, sessionID: sessionID).detail)
                        }
                        .listRowBackground(Theme.surface)
                    }
                    Section {
                        NavigationLink {
                            BotLibraryScreen(bot: bot)
                        } label: {
                            Label("Biblioteca", systemImage: "books.vertical")
                        }
                    }
                    .listRowBackground(Theme.surface)
                    Section("Modelo") {
                        Picker("Conta e modelo", selection: engineBinding(bot)) {
                            ForEach(engineOptions, id: \.self) { option in
                                Text(engineLabel(option)).tag(option)
                            }
                        }
                        .pickerStyle(.navigationLink)
                    }
                    .listRowBackground(Theme.surface)
                    if !bot.instructions.isEmpty {
                        Section("Instruções") {
                            Text(bot.instructions)
                                .font(TypeScale.rowSubtitle)
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(8)
                        }
                        .listRowBackground(Theme.surface)
                    }
                    if !bot.schedules.isEmpty {
                        Section("Rotinas") {
                            ForEach(bot.schedules, id: \.name) { schedule in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(schedule.name)
                                        .font(BrandFonts.sans(15, weight: .medium))
                                    Text(ScheduleText.describe(schedule.cron))
                                        .font(TypeScale.caption)
                                        .foregroundStyle(Theme.textTertiary)
                                }
                            }
                        }
                        .listRowBackground(Theme.surface)
                    }
                    Section {
                        Button("Arquivar bot", role: .destructive) {
                            confirmsArchive = true
                        }
                        .disabled(busy)
                    } footer: {
                        if let error {
                            Text(error).foregroundStyle(Theme.danger)
                        }
                    }
                    .listRowBackground(Theme.surface)
                }
            }
            .font(BrandFonts.sans(16))
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Editar") { editing = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
            .sheet(isPresented: $editing) {
                BotEditorScreen(bot: bot)
                    .environment(model)
            }
            .confirmationDialog("Arquivar \(bot?.name ?? "bot")?", isPresented: $confirmsArchive, titleVisibility: .visible) {
                Button("Arquivar", role: .destructive) { archive() }
            } message: {
                Text("O bot sai da lista. Dá para restaurar pelo app do Mac.")
            }
            .task { await model.loadAccounts() }
        }
        .presentationBackground(Theme.background)
    }

    private func header(_ bot: Bot) -> some View {
        VStack(spacing: Spacing.m) {
            BotAvatar(bot: bot, mood: model.mood(for: bot.id), size: 88)
            VStack(spacing: Spacing.xs) {
                Text(bot.name)
                    .font(BrandFonts.sans(24, weight: .semibold))
                    .tracking(-0.4)
                    .foregroundStyle(Theme.textPrimary)
                if !bot.role.isEmpty {
                    Text(bot.role)
                        .font(TypeScale.rowSubtitle)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.l)
    }

    private var engineOptions: [BotEngine] {
        var options: [BotEngine] = []
        for account in model.accounts where account.status != "missing" {
            if account.models.isEmpty {
                options.append(BotEngine(account: account.id, model: nil, effort: nil))
            }
            for item in account.models {
                options.append(BotEngine(account: account.id, model: item.id, effort: nil))
            }
        }
        if let current = bot?.engine, !options.contains(where: { $0.account == current.account && $0.model == current.model }) {
            options.insert(BotEngine(account: current.account, model: current.model, effort: nil), at: 0)
        }
        return options
    }

    private func engineLabel(_ engine: BotEngine) -> String {
        let account = model.accounts.first { $0.id == engine.account }
        let accountName = account?.name.isEmpty == false ? account?.name ?? engine.account : account?.label ?? engine.account
        let modelName = engine.model.flatMap { id in account?.models.first { $0.id == id }?.label ?? ModelNames.pretty(id) }
        return [modelName, accountName].compactMap { $0 }.joined(separator: " · ")
    }

    private func engineBinding(_ bot: Bot) -> Binding<BotEngine> {
        Binding(
            get: {
                let current = bot.engine ?? BotEngine(account: "vps:claude", model: nil, effort: nil)
                return BotEngine(account: current.account, model: current.model, effort: nil)
            },
            set: { engine in
                var next = bot.engine ?? engine
                next.account = engine.account
                next.model = engine.model
                run { try await model.updateBot(bot.id, body: .object(["engine": next.json])) }
            }
        )
    }

    private func permissionBinding(_ sessionID: String) -> Binding<PermissionMode> {
        Binding(
            get: { model.permission(botID: botID, sessionID: sessionID) },
            set: { mode in run { try await model.setPermission(mode, botID: botID, sessionID: sessionID) } }
        )
    }

    private func archive() {
        run {
            try await model.archiveBot(botID)
            dismiss()
        }
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await action()
            } catch {
                self.error = ErrorMessage.describe(error)
            }
        }
    }
}

enum ScheduleText {
    static func describe(_ cron: String) -> String {
        CronSchedule.describe(cron)
    }
}

struct BotEditorScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let bot: Bot?
    var onCreated: ((Bot) -> Void)?

    @State private var name = ""
    @State private var role = ""
    @State private var instructions = ""
    @State private var accent = "orange"
    @State private var glyph = "face-1"
    @State private var busy = false
    @State private var error: String?

    private var canSave: Bool {
        !busy && !name.trimmingCharacters(in: .whitespaces).isEmpty && name.count <= 40
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        BotAvatar(botID: bot?.id ?? BotDraft.slug(name), glyph: glyph, accent: accent, mood: .idle, size: 80)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }
                Section("Nome") {
                    TextField("Ex.: Boss", text: $name)
                    TextField("Função curta (ex.: Chefe da operação)", text: $role)
                }
                .listRowBackground(Theme.surface)
                Section("Rosto") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.m) {
                            ForEach(CharacterGlyph.faceIDs, id: \.self) { face in
                                Button {
                                    glyph = face
                                } label: {
                                    BotAvatar(botID: face, glyph: face, accent: accent, mood: .idle, size: 44)
                                        .padding(3)
                                        .overlay {
                                            Circle()
                                                .stroke(Theme.textPrimary, lineWidth: glyph == face ? 2 : 0)
                                        }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Rosto \(face)")
                            }
                        }
                        .padding(.vertical, Spacing.xs)
                    }
                }
                .listRowBackground(Theme.surface)
                Section("Cor") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Spacing.s), count: 6), spacing: Spacing.m) {
                        ForEach(Theme.swatchAccents, id: \.self) { swatch in
                            Button {
                                accent = swatch
                            } label: {
                                Circle()
                                    .fill(Theme.accent(swatch))
                                    .frame(width: 32, height: 32)
                                    .overlay {
                                        if accent == swatch {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 12, weight: .bold))
                                                .foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Theme.accentName(swatch))
                        }
                    }
                    .padding(.vertical, Spacing.xs)
                }
                .listRowBackground(Theme.surface)
                Section("Instruções") {
                    TextField("O que este bot faz e como deve agir", text: $instructions, axis: .vertical)
                        .lineLimit(4...12)
                }
                .listRowBackground(Theme.surface)
                if let error {
                    Section {
                        Text(error).foregroundStyle(Theme.danger)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .font(BrandFonts.sans(16))
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle(bot == nil ? "Novo bot" : "Editar bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(bot == nil ? "Criar" : "Salvar", action: save)
                        .disabled(!canSave)
                }
            }
            .onAppear {
                let draft = BotDraft(bot: bot)
                name = draft.name
                accent = draft.accent
                glyph = draft.glyph
                role = bot?.role ?? ""
                instructions = bot?.instructions ?? ""
            }
        }
        .presentationBackground(Theme.background)
    }

    private func save() {
        busy = true
        error = nil
        var body: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "accent": .string(accent),
            "glyph": .string(glyph),
            "role": .string(role.trimmingCharacters(in: .whitespaces)),
        ]
        if !instructions.isEmpty || bot != nil {
            body["instructions"] = .string(instructions)
        }
        Task {
            defer { busy = false }
            do {
                if let bot {
                    try await model.updateBot(bot.id, body: .object(body))
                } else {
                    let created = try await model.createBot(.object(body))
                    onCreated?(created)
                }
                dismiss()
            } catch {
                self.error = ErrorMessage.describe(error)
            }
        }
    }
}
