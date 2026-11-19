import SwiftUI

struct GroupEditorView: View {
    @Environment(AppModel.self) private var model
    let request: GroupRequest

    @State private var name: String
    @State private var members: Set<String>
    @FocusState private var nameFocused: Bool

    init(request: GroupRequest) {
        self.request = request
        _name = State(initialValue: request.name)
        _members = State(initialValue: Set(request.members))
    }

    private var candidates: [Bot] {
        model.loadedBots.filter { !$0.isPending && !$0.isDeleted }
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && members.count >= 2
    }

    private let columns = Array(repeating: GridItem(.fixed(72), spacing: Spacing.s), count: 4)

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(request.groupID == nil ? "Novo grupo" : "Editar grupo")
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
                RoundIconButton(systemImage: "xmark", help: "Fechar (Esc)", size: 28) {
                    model.dismissSheet()
                }
            }
            .padding(.horizontal, Spacing.xl + 4)
            .padding(.top, Spacing.xl + 4)

            VStack(spacing: Spacing.xl + 4) {
                GroupAvatar(members: candidates.filter { members.contains($0.id) }, size: 72)
                    .padding(.top, Spacing.s)

                TextField("Dê um nome ao grupo", text: $name)
                    .textFieldStyle(.plain)
                    .font(BrandFonts.sans(17, weight: .medium))
                    .multilineTextAlignment(.center)
                    .focused($nameFocused)
                    .padding(.horizontal, Spacing.l)
                    .frame(width: 300, height: 40)
                    .glassSurface(Capsule(), interactive: true, fallback: Theme.surface)

                VStack(spacing: Spacing.m) {
                    Text(members.count < 2 ? "Escolha pelo menos dois bots" : "\(members.count) bots no grupo")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .contentTransition(.opacity)
                    LazyVGrid(columns: columns, spacing: Spacing.s) {
                        ForEach(candidates) { candidate in
                            let isOn = members.contains(candidate.id)
                            Button {
                                if isOn {
                                    members.remove(candidate.id)
                                } else {
                                    members.insert(candidate.id)
                                }
                            } label: {
                                VStack(spacing: Spacing.xs) {
                                    BotCharacter(bot: candidate, mood: .idle, size: 36)
                                        .frame(width: 48, height: 48)
                                        .opacity(isOn ? 1 : 0.6)
                                        .modifier(ChoiceRing(isSelected: isOn, shape: Circle()))
                                    Text(candidate.name)
                                        .font(TypeScale.caption)
                                        .foregroundStyle(isOn ? Theme.textPrimary : Theme.textSecondary)
                                        .lineLimit(1)
                                }
                                .frame(width: 72)
                            }
                            .buttonStyle(PressableButtonStyle())
                            .accessibilityAddTraits(isOn ? .isSelected : [])
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.xl + 4)
            .padding(.top, Spacing.xs)

            HStack(spacing: Spacing.m) {
                Spacer(minLength: 0)
                Button("Cancelar") {
                    model.dismissSheet()
                }
                .buttonStyle(.brandSecondary)
                Button(request.groupID == nil ? "Criar" : "Salvar") {
                    save()
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.brandPrimary)
                .disabled(!canSave)
            }
            .padding(.horizontal, Spacing.xl + 4)
            .padding(.top, Spacing.xl + 4)
            .padding(.bottom, Spacing.xl + 4)
        }
        .springAnimation(value: members)
        .onAppear {
            nameFocused = true
        }
    }

    private func save() {
        guard canSave else { return }
        let ordered = candidates.map(\.id).filter { members.contains($0) }
        if let groupID = request.groupID {
            model.saveGroup(id: groupID, name: name, members: ordered)
        } else {
            model.createGroup(name: name, members: ordered)
        }
    }
}
