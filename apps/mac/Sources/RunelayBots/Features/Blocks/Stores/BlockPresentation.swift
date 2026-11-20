import Foundation
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

    private(set) var fullScreen = false
    private(set) var dragging = false
    private(set) var preferredWidth: CGFloat
    var treeVisible: Bool {
        didSet { UserDefaults.standard.set(treeVisible, forKey: Keys.treeVisible) }
    }

    @ObservationIgnored private var dragStart: CGFloat?

    private init() {
        let stored = UserDefaults.standard.double(forKey: Keys.width)
        preferredWidth = stored > 0 ? stored : 640
        treeVisible = UserDefaults.standard.object(forKey: Keys.treeVisible) as? Bool ?? true
    }

    var isOpen: Bool {
        ArtifactCenter.shared.current != nil && ArtifactCenter.shared.isBlock
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
