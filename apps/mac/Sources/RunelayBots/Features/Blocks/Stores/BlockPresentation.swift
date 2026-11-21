import AppKit
import Observation

@MainActor
@Observable
final class BlockPresentation {
    static let shared = BlockPresentation()

    static let minPanelWidth: CGFloat = 380
    static let minConversationWidth: CGFloat = 360
    static let treeWidth: CGFloat = 228
    static let fullScreenTreeWidth: CGFloat = 264

    private enum Keys {
        static let width = "blocks.panelWidth"
        static let treeVisible = "blocks.treeVisible"
    }

    private(set) var fullScreen = false {
        didSet { fullScreen ? startEscapeMonitor() : stopEscapeMonitor() }
    }
    private(set) var dragging = false
    private(set) var preferredWidth: CGFloat
    var treeVisible: Bool {
        didSet { UserDefaults.standard.set(treeVisible, forKey: Keys.treeVisible) }
    }

    @ObservationIgnored private var dragStart: CGFloat?
    @ObservationIgnored private var escapeMonitor: Any?

    private init() {
        let stored = UserDefaults.standard.double(forKey: Keys.width)
        preferredWidth = stored > 0 ? stored : 640
        treeVisible = UserDefaults.standard.object(forKey: Keys.treeVisible) as? Bool ?? true
    }

    var isOpen: Bool {
        ArtifactCenter.shared.current != nil && !ArtifactCenter.shared.presenting
    }

    func panelWidth(available: CGFloat) -> CGFloat {
        let ceiling = max(Self.minPanelWidth, available - Self.minConversationWidth)
        return min(max(preferredWidth, Self.minPanelWidth), ceiling)
    }

    func inset(available: CGFloat) -> CGFloat {
        isOpen ? panelWidth(available: available) : 0
    }

    func toggleFullScreen() {
        guard isOpen else { return }
        fullScreen.toggle()
    }

    func exitFullScreen() {
        fullScreen = false
    }

    private func startEscapeMonitor() {
        guard escapeMonitor == nil else { return }
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.keyCode == 53, self.escapeExits(event) else { return event }
            self.exitFullScreen()
            return nil
        }
    }

    private func stopEscapeMonitor() {
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
        }
        escapeMonitor = nil
    }

    private func escapeExits(_ event: NSEvent) -> Bool {
        guard let window = event.window, window === NSApp.mainWindow, window.attachedSheet == nil else { return false }
        if (window.firstResponder as? NSTextInputClient)?.hasMarkedText() == true { return false }
        if ArtifactCenter.shared.presenting { return false }
        let blocks = BlockCenter.shared
        if !(blocks.noteEditor?.suggestions.isEmpty ?? true) || (blocks.sheetEditor?.editing ?? false) { return false }
        if let canvas = ArtifactCenter.shared.canvas,
            canvas.editingNode != nil || canvas.editingEdge != nil || !canvas.selection.isEmpty || !canvas.selectedEdges.isEmpty
        {
            return false
        }
        return true
    }

    func close() {
        fullScreen = false
        ArtifactCenter.shared.close()
    }

    func drag(by translation: CGFloat, available: CGFloat) {
        let start = dragStart ?? panelWidth(available: available)
        dragStart = start
        dragging = true
        let ceiling = max(Self.minPanelWidth, available - Self.minConversationWidth)
        preferredWidth = min(max(start - translation, Self.minPanelWidth), ceiling)
    }

    func endDrag() {
        dragStart = nil
        dragging = false
        UserDefaults.standard.set(Double(preferredWidth), forKey: Keys.width)
    }
}
