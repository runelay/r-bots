import AppKit
import ApplicationServices

enum FrontmostPage {
    @MainActor
    static func host() -> String? {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success, let window else { return nil }
        var document: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXDocumentAttribute as CFString, &document) == .success,
              let text = document as? String,
              let url = URL(string: text),
              url.scheme == "https" || url.scheme == "http",
              let host = url.host()
        else { return nil }
        return host.lowercased()
    }
}
