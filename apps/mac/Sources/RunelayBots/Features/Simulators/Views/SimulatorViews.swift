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
    @State private var chosen = ""

    private var store: SimulatorStore { .shared }
    private var presentation: BlockPresentation { .shared }
    private var device: SimDevice? { store.device(ref.id) ?? store.device(chosen) }

    private var expoServer: DevServerInfo? {
        ServerStore.shared.servers.first { $0.isMobile && $0.status == .running }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                MirrorView(mirror: mirror)
                    .padding(Spacing.l)
                    .opacity(mirror.source == nil ? 0 : 1)
                    .overlay(alignment: .bottom) {
                        if mirror.source != nil {
                            liveFooter
                                .padding(.bottom, Spacing.l + Spacing.s)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                    }
                if mirror.source == nil {
                    emptyState
                        .frame(maxWidth: 320)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Motion.spring, value: mirror.state)
            .animation(Motion.spring, value: device?.state)
        }
        .task(id: "\(device?.udid ?? "")#\(device?.booted == true)") {
            guard let device else {
                if store.devices.isEmpty { await store.refresh() }
                return
            }
            if device.booted, mirror.source == nil, !mirror.busy {
                await mirror.start(device)
            } else if !device.booted, store.pendingApp[device.udid] != nil, !mirror.busy {
                await mirror.boot(device)
            }
        }
        .onChange(of: mirror.source) { _, source in
            guard source != nil, let device, let server = store.takePending(device.udid) else { return }
            store.openExpo(server: server, client: model.client)
        }
        .onDisappear {
            mirror.stop()
        }
    }

    private var stateKey: String {
        switch mirror.state {
        case .booting: "booting"
        case .opening: "opening"
        case .failed: "failed"
        default: device.map { $0.booted ? "booted" : "off" } ?? "picker"
        }
    }

    private var emptyState: some View {
        emptyContent
            .id(stateKey)
            .transition(.opacity)
            .animation(Motion.crossFade, value: stateKey)
    }

    @ViewBuilder
    private var emptyContent: some View {
        VStack(spacing: Spacing.m) {
            switch mirror.state {
            case .booting, .opening:
                ProgressView()
                    .controlSize(.small)
                Text(mirror.state.label ?? "")
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(Theme.textSecondary)
                    .contentTransition(.opacity)
            case .failed(let message):
                stateText(icon: "exclamationmark.triangle", title: "Não deu para mostrar a tela", message: message)
                Button("Tentar de novo") { retry() }
                    .buttonStyle(.brandPrimary)
            default:
                if let device {
                    if device.booted {
                        stateText(icon: "iphone", title: device.name, message: "O simulador está ligado, mas a tela ainda não apareceu aqui.")
                        Button("Mostrar simulador") {
                            Task { await mirror.showWindow() }
                        }
                        .buttonStyle(.brandPrimary)
                    } else {
                        stateText(icon: "iphone", title: device.name, message: "\(device.runtime) · desligado")
                        Button("Ligar simulador") {
                            Task { await mirror.boot(device) }
                        }
                        .buttonStyle(.brandPrimary)
                    }
                } else {
                    picker
                }
            }
        }
        .multilineTextAlignment(.center)
    }

    private func stateText(icon: String, title: String, message: String) -> some View {
        VStack(spacing: Spacing.s) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Theme.textTertiary)
            Text(title)
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var picker: some View {
        let ios = store.devices.filter { $0.platform == "ios" }
        if ios.isEmpty {
            stateText(icon: "iphone.slash", title: "Nenhum simulador", message: store.loading ? "Procurando no Xcode…" : "Crie um simulador no Xcode e volte aqui.")
        } else {
            stateText(icon: "iphone", title: "Escolha um simulador", message: "Ele liga e a tela aparece aqui.")
            HStack(spacing: Spacing.s) {
                GlassSelect(
                    options: ios.map { GlassSelectOption("\($0.name) · \($0.runtime)", value: $0.udid, systemImage: "iphone") },
                    selection: Binding(get: { chosen.isEmpty ? (ios.first?.udid ?? "") : chosen }, set: { chosen = $0 }),
                    help: "Simulador",
                    maxWidth: 200
                )
                Button("Ligar") {
                    let udid = chosen.isEmpty ? (ios.first?.udid ?? "") : chosen
                    chosen = udid
                    guard let target = store.device(udid) else { return }
                    Task { await mirror.boot(target) }
                }
                .buttonStyle(.brandPrimary)
            }
        }
    }

    private var liveFooter: some View {
        HStack(spacing: Spacing.s) {
            if let server = expoServer {
                Button {
                    SimulatorStore.shared.openExpo(server: server, client: model.client)
                } label: {
                    Label("Abrir \(server.name)", systemImage: "play.fill")
                        .lineLimit(1)
                }
                .buttonStyle(.brandPrimary)
                .disabled(store.busy.contains(server.id))
            }
            if mirror.source == .snapshots {
                Button {
                    if mirror.needsPermission {
                        mirror.requestPermission()
                    } else {
                        Task { await mirror.showWindow() }
                    }
                } label: {
                    Label(mirror.needsPermission ? "Permitir gravação de tela" : "Espelho fluido", systemImage: "bolt")
                        .lineLimit(1)
                }
                .buttonStyle(.brandSecondary)
                .help(mirror.needsPermission ? "Com a permissão, a tela vem em tempo real e aceita teclado." : "Abre o Simulator atrás das janelas para espelhar em tempo real.")
            }
            if mirror.tapping {
                ProgressView()
                    .controlSize(.mini)
            }
        }
        .fixedSize()
    }

    private func retry() {
        guard let device else { return }
        Task {
            await store.refresh()
            let current = store.device(device.udid) ?? device
            if current.booted {
                await mirror.start(current)
            } else {
                await mirror.boot(current)
            }
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "iphone")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 28, height: 28)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(device?.name ?? ref.title)
                    .font(TypeScale.rowSubtitle.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                HStack(spacing: Spacing.xs + 2) {
                    ServerStatusDot(status: mirror.busy ? .starting : device?.booted == true ? .running : .stopped)
                    Text(statusText)
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: Spacing.s)
            if let device, device.booted {
                BlockHeaderButton(systemImage: "camera", help: "Print para a conversa") {
                    store.screenshot(udid: device.udid, into: model.selectedConversation)
                }
            }
            BlockHeaderButton(
                systemImage: presentation.fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                help: presentation.fullScreen ? "Voltar ao painel  ⇧⌘F" : "Tela cheia  ⇧⌘F",
                isActive: presentation.fullScreen
            ) {
                presentation.toggleFullScreen()
            }
            if let device {
                GlassMenuButton(edge: .trailing, help: "Mais", items: { menuItems(device) }) { isOpen in
                    BlockHeaderIcon(systemImage: "ellipsis", isActive: isOpen || openingURL)
                }
                .fixedSize()
                .glassPopup(isPresented: $openingURL, edge: .trailing) {
                    OpenURLPopover(url: $url) {
                        store.openURL(url, udid: device.udid)
                    }
                }
            }
            BlockHeaderButton(systemImage: "xmark", help: "Fechar") {
                presentation.close()
            }
            .layoutPriority(2)
        }
        .padding(.horizontal, Spacing.m)
        .frame(height: 48)
    }

    private var statusText: String {
        if let label = mirror.state.label { return label }
        guard let device else { return "Nenhum simulador escolhido" }
        return "\(device.booted ? "Ligado" : "Desligado") · \(device.runtime)"
    }

    private func menuItems(_ device: SimDevice) -> [GlassMenuItem] {
        var items: [GlassMenuItem] = []
        if device.booted {
            items.append(GlassMenuItem("Início", systemImage: "house", shortcut: "⇧⌘H") { mirror.home() })
            items.append(GlassMenuItem("Girar", systemImage: "rotate.right") { mirror.rotate() })
            items.append(GlassMenuItem("Abrir URL ou deep link", systemImage: "link") { openingURL = true })
            if let server = expoServer {
                items.append(GlassMenuItem("Abrir \(server.name)", systemImage: "play") {
                    SimulatorStore.shared.openExpo(server: server, client: model.client)
                })
            }
        }
        items.append(GlassMenuItem(device.booted ? "Desligar" : "Ligar", systemImage: "power", destructive: device.booted, startsSection: device.booted) {
            if device.booted {
                mirror.stop()
                store.toggle(device)
            } else {
                Task { await mirror.boot(device) }
            }
        })
        return items
    }
}

private struct OpenURLPopover: View {
    @Binding var url: String
    let open: () -> Void

    @Environment(\.glassPopupDismiss) private var dismiss

    var body: some View {
        HStack(spacing: Spacing.s) {
            TextField("myapp://home ou https://…", text: $url)
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
