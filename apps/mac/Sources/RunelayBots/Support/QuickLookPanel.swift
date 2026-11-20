import AppKit
@preconcurrency import Quartz

private final class PreviewWindow: NSPanel {
    override func cancelOperation(_ sender: Any?) {
        close()
    }
}

@MainActor
final class QuickLookPanel: NSObject, NSWindowDelegate {
    static let shared = QuickLookPanel()
    private var window: PreviewWindow?
    private var preview: QLPreviewView?
    private var items: [URL] = []
    private var index = 0
    private var monitor: Any?

    func show(_ urls: [URL], selected: URL) {
        guard !urls.isEmpty else { return }
        items = urls
        index = urls.firstIndex(of: selected) ?? 0
        let window = self.window ?? makeWindow()
        self.window = window
        display(fitting: true)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, let window = self.window, event.window === window else { return event }
                switch event.keyCode {
                case 123:
                    self.step(-1)
                    return nil
                case 124:
                    self.step(1)
                    return nil
                case 49:
                    window.close()
                    return nil
                default:
                    return event
                }
            }
        }
    }

    private func step(_ delta: Int) {
        guard items.count > 1 else { return }
        index = (index + delta + items.count) % items.count
        display(fitting: false)
    }

    private func display(fitting: Bool) {
        guard let window, items.indices.contains(index) else { return }
        let url = items[index]
        preview?.previewItem = url as NSURL
        window.title = items.count > 1 ? "\(url.lastPathComponent) · \(index + 1) de \(items.count)" : url.lastPathComponent
        guard fitting else { return }
        let screen = (NSApp.keyWindow?.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        var size = NSSize(width: 900, height: 600)
        if let image = NSImage(contentsOf: url), image.size.width > 0, image.size.height > 0 {
            let scale = min(screen.width * 0.8 / image.size.width, screen.height * 0.8 / image.size.height, 1)
            size = NSSize(width: max(320, image.size.width * scale), height: max(240, image.size.height * scale))
        }
        window.setContentSize(size)
        window.center()
    }

    private func makeWindow() -> PreviewWindow {
        let window = PreviewWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = false
        window.delegate = self
        let view = QLPreviewView(frame: window.contentLayoutRect, style: .normal)
        view?.autoresizingMask = [.width, .height]
        view?.shouldCloseWithWindow = false
        if let view {
            window.contentView = view
        }
        preview = view
        return window
    }

    func windowWillClose(_ notification: Notification) {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        monitor = nil
    }
}
