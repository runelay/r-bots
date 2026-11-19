import SwiftUI

struct BotEditorView: View {
    @Environment(AppModel.self) private var model
    let request: EditorRequest

    @State private var draft: BotDraft
    @State private var errors: [String: String]
    @FocusState private var nameFocused: Bool
    @Environment(\.appReduceMotion) private var reduceMotion

    init(request: EditorRequest) {
        self.request = request
        _draft = State(initialValue: request.draft)
        _errors = State(initialValue: request.errors)
    }

    private var isEditing: Bool { request.botID != nil }

    private var palette: [String] {
        var list = Theme.swatchAccents
        if !list.contains(draft.accent) {
            list.append(draft.accent)
        }
        return list
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(isEditing ? "Editar bot" : "Criar novo bot")
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
                BotCharacter(
                    botID: request.botID ?? draft.previewID,
                    glyph: draft.glyph,
                    accent: draft.accent,
                    mood: .idle,
                    size: 88
                )
                .keyframeAnimator(initialValue: 1.0, trigger: changeToken) { content, scale in
                    content.scaleEffect(scale)
                } keyframes: { _ in
                    if reduceMotion {
                        LinearKeyframe(1.0, duration: 0.01)
                    } else {
                        SpringKeyframe(1.1, duration: 0.12, spring: .snappy)
                        SpringKeyframe(1.0, duration: 0.35, spring: .bouncy)
                    }
                }

                VStack(spacing: Spacing.m) {
                    TextField("Dê um nome ao seu bot", text: $draft.name)
                        .textFieldStyle(.plain)
                        .font(BrandFonts.sans(17, weight: .medium))
                        .multilineTextAlignment(.center)
                        .focused($nameFocused)
                        .onSubmit {
                            submit()
                        }
                        .padding(.horizontal, Spacing.l)
                        .frame(width: 300, height: 40)
                        .glassSurface(Capsule(), interactive: true, fallback: Theme.surface)
                    if let error = errors["name"] ?? errors["general"] {
                        FieldError(message: error)
                    }
                }

                FacePicker(selection: $draft.glyph, accent: draft.accent)

                ColorPalette(accents: palette, selection: $draft.accent)
            }
            .padding(.horizontal, Spacing.xl + 4)
            .padding(.top, Spacing.xs)

            HStack(spacing: Spacing.m) {
                Spacer(minLength: 0)
                Button("Cancelar") {
                    model.dismissSheet()
                }
                .buttonStyle(.brandSecondary)
                Button(isEditing ? "Salvar" : "Criar") {
                    submit()
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.brandPrimary)
                .disabled(draft.trimmedName.isEmpty)
            }
            .padding(.horizontal, Spacing.xl + 4)
            .padding(.top, Spacing.xl + 4)
            .padding(.bottom, Spacing.xl + 4)
        }
        .springAnimation(value: draft.glyph)
        .springAnimation(value: draft.accent)
        .springAnimation(value: errors)
        .onAppear {
            nameFocused = true
        }
    }

    private var changeToken: String {
        "\(draft.trimmedName)|\(draft.glyph)|\(draft.accent)"
    }

    private func submit() {
        let local = draft.localErrors()
        guard local.isEmpty else {
            errors = local
            return
        }
        if let botID = request.botID {
            model.saveBot(id: botID, draft: draft)
        } else {
            model.createBot(from: draft)
        }
    }
}

struct FacePicker: View {
    @Binding var selection: String
    let accent: String

    private let columns = Array(repeating: GridItem(.fixed(36), spacing: 8), count: 7)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(CharacterGlyph.faceIDs, id: \.self) { face in
                let isSelected = face == selection
                Button {
                    selection = face
                } label: {
                    BotCharacter(botID: face, glyph: face, accent: accent, mood: .idle, size: 32)
                        .frame(width: 36, height: 36)
                        .opacity(isSelected ? 1 : 0.7)
                        .modifier(ChoiceRing(isSelected: isSelected, shape: Circle()))
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel("Rosto \(face)")
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
    }
}

struct ColorPalette: View {
    let accents: [String]
    @Binding var selection: String

    private let columns = Array(repeating: GridItem(.fixed(30), spacing: 24), count: 6)

    var body: some View {
        LazyVGrid(columns: columns, spacing: Spacing.m) {
            ForEach(accents, id: \.self) { accent in
                let isSelected = accent == selection
                Button {
                    selection = accent
                } label: {
                    Circle()
                        .fill(Theme.accent(accent))
                        .frame(width: 24, height: 24)
                        .padding(3)
                        .modifier(ChoiceRing(isSelected: isSelected, shape: Circle()))
                }
                .buttonStyle(PressableButtonStyle())
                .help(Theme.accentName(accent))
                .accessibilityLabel(Theme.accentName(accent))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
    }
}

struct ChoiceRing<S: Shape>: ViewModifier {
    let isSelected: Bool
    let shape: S

    func body(content: Content) -> some View {
        if isSelected {
            content.glassSurface(shape, interactive: true, fallback: Theme.surfaceRaised)
        } else {
            content
        }
    }
}

struct FormField<Content: View>: View {
    let title: String
    let error: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Text(title)
                .font(TypeScale.sectionCaption)
                .foregroundStyle(Theme.textSecondary)
            content
            if let error {
                FieldError(message: error)
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
    }
}

struct FieldError: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(TypeScale.caption)
            .foregroundStyle(Theme.danger)
    }
}
