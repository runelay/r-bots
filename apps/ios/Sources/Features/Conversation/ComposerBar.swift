import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposerBar: View {
    @Bindable var store: ConversationStore
    var onCall: (() -> Void)?
    @FocusState private var focused: Bool
    @State private var sent = 0
    @State private var stopped = 0
    @State private var recorder = AudioRecorder()
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var importingFiles = false
    @State private var takingPhoto = false
    @State private var fieldWidth: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let voice = VoiceInput.shared

    private var visibleText: Binding<String> {
        Binding(
            get: {
                let text = ComposerToken.stripped(store.draft)
                return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : text
            },
            set: { value in
                let tokens = store.draftTokens
                store.updateDraft(Self.compose(value, tokenCount: tokens.count), tokens: tokens)
            }
        )
    }

    private var typed: String {
        ComposerToken.stripped(store.draft).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var showsStop: Bool {
        store.canStop && typed.isEmpty && store.composerAttachments.isEmpty
    }

    private var dictating: Bool { voice.isBusy(for: store) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            if let notice {
                Text(notice)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, Spacing.m)
                    .transition(.opacity)
            }
            VStack(alignment: .leading, spacing: 0) {
                if !store.composerAttachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.s) {
                            ForEach(store.composerAttachments) { attachment in
                                ComposerChip(attachment: attachment, client: store.clientValue) {
                                    remove(attachment)
                                } retry: {
                                    store.retryUpload(attachment)
                                }
                            }
                        }
                        .padding(.horizontal, Spacing.s)
                        .padding(.top, Spacing.s)
                    }
                    .transition(.opacity)
                }
                if recorder.isRecording {
                    recordingRow
                } else {
                    inputRow
                }
            }
            .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: showsStop)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: recorder.isRecording)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.composerAttachments.count)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: dictating)
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .medium), trigger: stopped)
        .sensoryFeedback(.start, trigger: recorder.isRecording)
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 6, matching: .any(of: [.images, .videos]))
        .fileImporter(isPresented: $importingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            attachImported(urls)
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                if let data = image.jpegData(compressionQuality: 0.85),
                    let url = AttachmentPasteboard.writeTemporary(data, name: tr("Foto") + ".jpg")
                {
                    store.attachFiles([url], ownsFiles: true)
                }
            }
            .ignoresSafeArea()
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await attachPhotos(items) }
        }
        .onDisappear {
            voice.release(store)
            if recorder.isRecording { recorder.cancel() }
        }
    }

    private var notice: String? {
        if recorder.phase == .denied { return tr("O microfone está bloqueado. Libere em Ajustes do iPhone.") }
        if case .failed(let message) = recorder.phase { return message }
        if voice.showsNotice(for: store) {
            if voice.deniedPermission != nil { return voice.deniedPermission?.message }
            return voice.failure
        }
        return nil
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: Spacing.xs) {
            Menu {
                Button("Fotos e vídeos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Câmera", systemImage: "camera") { takingPhoto = true }
                }
                Button("Arquivo", systemImage: "doc") { importingFiles = true }
                Button("Mensagem de áudio", systemImage: "waveform") {
                    focused = false
                    Task { await recorder.start() }
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 36, height: 36)
                    .background(Theme.hover, in: Circle())
                    .contentShape(Circle())
            }
            .accessibilityLabel("Anexar")
            .padding(.leading, 6)
            .padding(.bottom, 6)
            TextField(dictating ? tr("Ouvindo…") : placeholder, text: visibleText, axis: .vertical)
                .font(BrandFonts.sans(16))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.leading, Spacing.xs)
                .padding(.vertical, 13)
                .frame(minHeight: 48)
                .onGeometryChange(for: CGFloat.self) {
                    $0.size.width
                } action: {
                    fieldWidth = $0
                }
            trailingButtons
                .buttonStyle(.plain)
                .padding(.trailing, 6)
                .padding(.bottom, 6)
        }
    }

    private var accent: Color { Theme.accent(store.bot.accent) }

    private var placeholder: String {
        let full = tr("Mensagem para %@", store.bot.headline)
        let font = BrandFonts.uiSans(16, weight: .regular)
        let width = (full as NSString).size(withAttributes: [.font: font]).width
        return width <= fieldWidth - Spacing.xs - 4 ? full : tr("Mensagem para %@", store.bot.name)
    }

    private var hasContent: Bool { !typed.isEmpty || !store.composerAttachments.isEmpty }

    private var trailingButtons: some View {
        HStack(spacing: Spacing.xs + 2) {
            if !hasContent || dictating {
                Button {
                    voice.toggle(for: store)
                } label: {
                    Image(systemName: dictating ? "waveform" : "mic")
                        .font(.system(size: 15, weight: .semibold))
                        .symbolEffect(.variableColor.iterative, isActive: dictating && !reduceMotion)
                        .foregroundStyle(dictating ? accent : Theme.textSecondary)
                        .frame(width: 36, height: 36)
                        .background(Theme.hover, in: Circle())
                        .contentShape(Circle())
                }
                .accessibilityLabel(dictating ? "Parar o ditado" : "Ditar")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
            primaryButton
        }
    }

    @ViewBuilder
    private var primaryButton: some View {
        if showsStop {
            Button {
                stopped += 1
                store.cancelTurn()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.textPrimary)
                    .frame(width: 36, height: 36)
                    .background(Theme.surfaceRaised, in: Circle())
            }
            .accessibilityLabel("Parar")
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        } else if hasContent {
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(accent.opacity(store.canSend ? 1 : 0.4), in: Circle())
            }
            .disabled(!store.canSend)
            .accessibilityLabel("Enviar")
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        } else {
            Button {
                onCall?()
            } label: {
                Image(systemName: "waveform")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(accent.opacity(onCall == nil ? 0.4 : 1), in: Circle())
            }
            .disabled(onCall == nil)
            .accessibilityLabel("Chamada de voz")
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        }
    }

    private var recordingRow: some View {
        HStack(spacing: Spacing.s) {
            Button {
                recorder.cancel()
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.danger)
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel("Descartar áudio")
            Circle()
                .fill(Theme.danger)
                .frame(width: 8, height: 8)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(AttachmentFormat.clock(recorder.startedAt.map { context.date.timeIntervalSince($0) } ?? 0))
                    .font(TypeScale.captionStrong)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
            }
            Waveform(levels: recorder.levels, color: Theme.brandText)
                .frame(height: 22)
            Button {
                if let url = recorder.finish() {
                    store.attachFiles([url], ownsFiles: true)
                }
            } label: {
                Image(systemName: "checkmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Theme.onAccent)
                    .frame(width: 36, height: 36)
                    .background(Theme.brandAccent, in: Circle())
            }
            .accessibilityLabel("Anexar áudio")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .padding(.vertical, 4)
        .frame(minHeight: 44)
    }

    private func send() {
        guard store.canSend else { return }
        sent += 1
        store.send()
    }

    private func remove(_ attachment: ComposerAttachment) {
        attachment.task?.cancel()
        let tokens = store.draftTokens.filter { token in
            if case .file(let id) = token { return id != attachment.id }
            return true
        }
        store.updateDraft(Self.compose(ComposerToken.stripped(store.draft), tokenCount: tokens.count), tokens: tokens)
    }

    private static func compose(_ text: String, tokenCount: Int) -> String {
        guard tokenCount > 0 else { return text }
        let separator = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " "
        return text + separator + String(repeating: ComposerToken.glyphString, count: tokenCount)
    }

    private func attachImported(_ urls: [URL]) {
        var copies: [URL] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url), let copy = AttachmentPasteboard.writeTemporary(data, name: url.lastPathComponent) {
                copies.append(copy)
            }
        }
        store.attachFiles(copies, ownsFiles: true)
    }

    private func attachPhotos(_ items: [PhotosPickerItem]) async {
        var urls: [URL] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let base = type?.conforms(to: .movie) == true ? tr("Vídeo") : tr("Foto")
            if let url = AttachmentPasteboard.writeTemporary(data, name: "\(base).\(ext)") {
                urls.append(url)
            }
        }
        store.attachFiles(urls, ownsFiles: true)
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onImage(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
