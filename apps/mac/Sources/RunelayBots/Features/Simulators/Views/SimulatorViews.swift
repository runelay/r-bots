import AppKit
import SwiftUI

final class MirrorInputView: NSView {
    var mirror: SimulatorMirror?
    let surface: MirrorSurface

    init(surface: MirrorSurface) {
        self.surface = surface
        super.init(frame: .zero)
        wantsLayer = true
        layer = CALayer()
        layer?.contentsGravity = .resizeAspect
        layer?.cornerCurve = .continuous
        surface.layer = layer
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    private func normalized(_ event: NSEvent) -> CGPoint {
        let point = convert(event.locationInWindow, from: nil)
        let aspect = mirror?.aspect ?? 0.46
        let fitWidth = min(bounds.width, bounds.height * aspect)
        let fitHeight = fitWidth / max(aspect, 0.01)
        let origin = CGPoint(x: (bounds.width - fitWidth) / 2, y: (bounds.height - fitHeight) / 2)
        return CGPoint(
            x: min(max((point.x - origin.x) / max(fitWidth, 1), 0), 1),
            y: min(max((point.y - origin.y) / max(fitHeight, 1), 0), 1)
        )
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        mirror?.mouse(.leftMouseDown, normalized: normalized(event))
    }

    override func mouseDragged(with event: NSEvent) {
        mirror?.mouse(.leftMouseDragged, normalized: normalized(event))
    }

    override func mouseUp(with event: NSEvent) {
        mirror?.mouse(.leftMouseUp, normalized: normalized(event))
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            super.keyDown(with: event)
            return
        }
        mirror?.key(code: CGKeyCode(event.keyCode), flags: CGEventFlags(rawValue: UInt64(event.modifierFlags.rawValue)))
    }
}

struct MirrorView: NSViewRepresentable {
    let mirror: SimulatorMirror

    func makeNSView(context: Context) -> MirrorInputView {
        let view = MirrorInputView(surface: mirror.surface)
        view.mirror = mirror
        return view
    }

    func updateNSView(_ view: MirrorInputView, context: Context) {
        view.mirror = mirror
    }
}

struct SimulatorPanel: View {
    let ref: ArtifactRef

    @Environment(AppModel.self) private var model
    @State private var mirror = SimulatorMirror()
    @State private var openingURL = false
    @State private var url = ""

    private var store: SimulatorStore { .shared }
    private var presentation: BlockPresentation { .shared }
    private var device: SimDevice? { store.device(ref.id) }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                if device?.booted == true {
                    MirrorView(mirror: mirror)
                        .padding(Spacing.l)
                        .opacity(mirror.state == .live ? 1 : 0)
                    if case .failed(let message) = mirror.state {
                        PanelEmptyState(systemImage: "rectangle.dashed", title: "Sem espelho", message: message)
                            .transition(.opacity)
                    } else if mirror.state != .live {
                        ProgressView()
                            .controlSize(.small)
                            .transition(.opacity)
                    }
                } else {
                    VStack(spacing: Spacing.m) {
                        PanelEmptyState(systemImage: "iphone", title: "Simulador desligado", message: "Ligue para ver a tela aqui.")
                        if let device {
                            ServerCardButton(title: "Ligar", systemImage: "power") {
                                store.toggle(device)
                            }
                        }
                    }
                    .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Motion.spring, value: mirror.state)
        }
        .task(id: device?.booted == true) {
            guard device?.booted == true else {
                mirror.stop()
                return
            }
            await mirror.start(deviceName: device?.name ?? ref.title)
        }
        .onDisappear {
            mirror.stop()
        }
        .task {
            if store.devices.isEmpty { await store.refresh() }
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "iphone")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 26, height: 26)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            VStack(alignment: .leading, spacing: 0) {
                Text(device?.name ?? ref.title)
                    .font(TypeScale.rowSubtitle.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                HStack(spacing: Spacing.xs + 2) {
                    ServerStatusDot(status: device?.booted == true ? .running : .stopped)
                    Text(device.map { "\($0.booted ? "Ligado" : "Desligado") · \($0.runtime)" } ?? "")
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            Spacer(minLength: Spacing.m)
            if let device, device.booted {
                BlockHeaderButton(systemImage: "house", help: "Início  ⇧⌘H") { mirror.home() }
                BlockHeaderButton(systemImage: "rotate.right", help: "Girar") { mirror.rotate() }
                BlockHeaderButton(systemImage: "camera", help: "Print para a conversa") {
                    store.screenshot(udid: device.udid, into: model.selectedConversation)
                }
                BlockHeaderButton(systemImage: "link", help: "Abrir URL ou deep link", isActive: openingURL) {
                    openingURL.toggle()
                }
                .glassPopup(isPresented: $openingURL, edge: .trailing) {
                    OpenURLPopover(url: $url) {
                        store.openURL(url, udid: device.udid)
                    }
                }
            }
            if let device {
                BlockHeaderButton(systemImage: "power", help: device.booted ? "Desligar" : "Ligar") {
                    store.toggle(device)
                }
            }
            BlockHeaderButton(
                systemImage: presentation.fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                help: presentation.fullScreen ? "Voltar ao painel  ⇧⌘F" : "Tela cheia  ⇧⌘F",
                isActive: presentation.fullScreen
            ) {
                presentation.toggleFullScreen()
            }
            BlockHeaderButton(systemImage: "xmark", help: "Fechar") {
                presentation.close()
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 48)
    }
}

private struct OpenURLPopover: View {
    @Binding var url: String
    let open: () -> Void

    @Environment(\.glassPopupDismiss) private var dismiss

    var body: some View {
        HStack(spacing: Spacing.s) {
            TextField("conty://campanhas ou https://…", text: $url)
                .textFieldStyle(.plain)
                .font(TypeScale.rowSubtitle)
                .padding(.horizontal, Spacing.m)
                .frame(height: 30)
                .background(Theme.surface, in: Capsule())
                .onSubmit(submit)
            ServerCardButton(title: "Abrir", systemImage: "arrow.up.right") { submit() }
        }
        .padding(Spacing.m)
        .frame(width: 340)
        .glassMenuSurface()
    }

    private func submit() {
        guard !url.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        open()
        dismiss()
    }
}

struct SimulatorRow: View {
    let device: SimDevice
    let botID: String

    @Environment(AppModel.self) private var model

    private var store: SimulatorStore { .shared }
    private var busy: Bool { store.busy.contains(device.udid) }

    var body: some View {
        InspectorRowCard {
            store.openPanel(device, botID: botID, client: model.client)
        } leading: {
            Image(systemName: device.platform == "android" ? "smartphone" : "iphone")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 32, height: 32)
                .background(Theme.background.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        } content: {
            Text(device.name)
                .font(TypeScale.rowTitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            HStack(alignment: .center, spacing: Spacing.xs + 2) {
                ServerStatusDot(status: busy ? .starting : device.booted ? .running : .stopped)
                Text(busy ? (device.booted ? "Desligando" : "Ligando") : device.booted ? "Ligado" : "Desligado")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .fixedSize()
                    .contentTransition(.opacity)
                Text("·")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .fixedSize()
                Text(device.runtime)
                    .font(TypeScale.caption.monospacedDigit())
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
            }
        } trailing: { hovering in
            Button {
                store.toggle(device)
            } label: {
                BlockHeaderIcon(systemImage: "power", isActive: device.booted)
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel(device.booted ? "Desligar" : "Ligar")
            .opacity(hovering || device.booted ? 1 : 0.0001)
        }
        .springAnimation(value: device.state)
        .springAnimation(value: busy)
    }
}

struct SimulatorsSection: View {
    let bot: Bot

    @State private var showAll = false

    private var store: SimulatorStore { .shared }

    private var shown: [SimDevice] {
        let booted = store.devices.filter(\.booted)
        if showAll || booted.isEmpty { return Array(store.devices.prefix(showAll ? 40 : 3)) }
        return booted
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            SectionCaption(title: "Simuladores") {
                if store.devices.count > shown.count || showAll {
                    Button(showAll ? "Menos" : "Todos") { showAll.toggle() }
                        .buttonStyle(.plain)
                        .font(TypeScale.sectionCaption)
                        .foregroundStyle(Theme.textSecondary)
                        .clickable()
                }
            }
            if store.devices.isEmpty {
                Text(store.loading ? "Procurando simuladores…" : "Nenhum simulador no Xcode deste Mac.")
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.horizontal, Spacing.l)
            } else {
                VStack(spacing: Spacing.s) {
                    ForEach(shown) { device in
                        SimulatorRow(device: device, botID: bot.id)
                            .transition(.opacity)
                    }
                }
            }
            if let failure = store.failure {
                Text(failure)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, Spacing.l)
                    .transition(.opacity)
            }
        }
        .springAnimation(value: shown.map(\.id))
        .springAnimation(value: store.failure)
        .task { await store.refresh() }
    }
}
