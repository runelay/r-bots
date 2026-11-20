import AppKit
@preconcurrency import Quartz

final class QuickLookPanel: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate, @unchecked Sendable {
    static let shared = QuickLookPanel()
    private var items: [URL] = []

    @MainActor
    func show(_ urls: [URL], selected: URL) {
        guard !urls.isEmpty, let panel = QLPreviewPanel.shared() else { return }
        items = urls
        panel.dataSource = self
        panel.delegate = self
        panel.reloadData()
        panel.currentPreviewItemIndex = urls.firstIndex(of: selected) ?? 0
        panel.makeKeyAndOrderFront(nil)
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        items.count
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
        guard items.indices.contains(index) else { return nil }
        return items[index] as NSURL
    }
}
