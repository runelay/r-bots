import AppKit
import SwiftUI

final class BrowserFrameView: NSView {
    var isInteractive = false {
        didSet {
            guard oldValue != isInteractive else { return }
            updateRing()
            window?.invalidateCursorRects(for: self)
        }
    }
    var onInput: ((JSONValue) -> Void)?
    var onBlockedClick: (() -> Void)?

    private let imageLayer = CALayer()
    private var imageSize = CGSize.zero
    private var pageSize = CGSize(width: 1280, height: 800)
    private var trackingArea: NSTrackingArea?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        imageLayer.contentsGravity = .resize
        imageLayer.cornerRadius = 12
        imageLayer.cornerCurve = .continuous
        imageLayer.masksToBounds = true
        imageLayer.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "borderWidth": NSNull()]
        layer?.addSublayer(imageLayer)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var isFlipped: Bool { true }

    override var acceptsFirstResponder: Bool { isInteractive }

    func show(_ frame: FrameImage) {
        pageSize = CGSize(width: frame.pageWidth, height: frame.pageHeight)
        show(frame.image)
    }

    func show(_ image: CGImage) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contents = image
        let size = CGSize(width: image.width, height: image.height)
        if size != imageSize {
            imageSize = size
            layoutImage()
        }
        CATransaction.commit()
    }

    func clear() {
        imageLayer.contents = nil
        imageSize = .zero
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layoutImage()
        CATransaction.commit()
    }

    private var imageRect: CGRect {
        guard imageSize.width > 0, imageSize.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
        let scale = min(bounds.width / imageSize.width, bounds.height / imageSize.height)
        let width = imageSize.width * scale
        let height = imageSize.height * scale
        return CGRect(x: (bounds.width - width) / 2, y: 0, width: width, height: height)
    }

    private func layoutImage() {
        imageLayer.frame = imageRect
    }

    private func updateRing() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.borderWidth = isInteractive ? 2 : 0
        imageLayer.borderColor = Theme.brandAccentRing.cgColor
        CATransaction.commit()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea {
            removeTrackingArea(trackingArea)
        }
        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func resetCursorRects() {
        addCursorRect(imageRect, cursor: .arrow)
    }

    private func pagePoint(_ event: NSEvent) -> CGPoint? {
        let rect = imageRect
        guard rect.width > 0, rect.height > 0 else { return nil }
        let point = convert(event.locationInWindow, from: nil)
        guard rect.contains(point) else { return nil }
        let x = (point.x - rect.minX) / rect.width * pageSize.width
        let y = (point.y - rect.minY) / rect.height * pageSize.height
        return CGPoint(x: x.rounded(), y: y.rounded())
    }

    private func sendMouse(_ kind: String, _ event: NSEvent, button: String = "left") {
        guard isInteractive, let point = pagePoint(event) else { return }
        onInput?(.object([
            "type": .string("mouse"),
            "event": .string(kind),
            "x": .number(point.x),
            "y": .number(point.y),
            "button": .string(button),
            "clickCount": .number(Double(max(event.clickCount, kind == "move" ? 0 : 1)))
        ]))
    }

    override func mouseDown(with event: NSEvent) {
        guard isInteractive else {
            onBlockedClick?()
            return
        }
        window?.makeFirstResponder(self)
        sendMouse("down", event)
    }

    override func mouseUp(with event: NSEvent) {
        sendMouse("up", event)
    }

    override func mouseDragged(with event: NSEvent) {
        sendMouse("move", event)
    }

    override func mouseMoved(with event: NSEvent) {
        sendMouse("move", event)
    }

    override func rightMouseDown(with event: NSEvent) {
        guard isInteractive else {
            onBlockedClick?()
            return
        }
        sendMouse("down", event, button: "right")
    }

    override func rightMouseUp(with event: NSEvent) {
        sendMouse("up", event, button: "right")
    }

    override func scrollWheel(with event: NSEvent) {
        guard isInteractive, let point = pagePoint(event) else {
            super.scrollWheel(with: event)
            return
        }
        let factor: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 40
        onInput?(.object([
            "type": .string("mouse"),
            "event": .string("wheel"),
            "x": .number(point.x),
            "y": .number(point.y),
            "button": .string("left"),
            "clickCount": .number(0),
            "deltaX": .number(-event.scrollingDeltaX * factor),
            "deltaY": .number(-event.scrollingDeltaY * factor)
        ]))
    }

    override func keyDown(with event: NSEvent) {
        guard isInteractive else {
            super.keyDown(with: event)
            return
        }
        sendKey("down", event)
        if let text = event.characters, !text.isEmpty, Self.namedKey(event.keyCode) == nil,
           !event.modifierFlags.contains(.command), !event.modifierFlags.contains(.control) {
            sendKey("char", event, text: text)
        }
    }

    override func keyUp(with event: NSEvent) {
        guard isInteractive else {
            super.keyUp(with: event)
            return
        }
        sendKey("up", event)
    }

    private func sendKey(_ kind: String, _ event: NSEvent, text: String? = nil) {
        let key = Self.namedKey(event.keyCode) ?? event.charactersIgnoringModifiers ?? ""
        var payload: [String: JSONValue] = [
            "type": .string("key"),
            "event": .string(kind),
            "key": .string(key),
            "code": .string(Self.code(for: event)),
            "modifiers": .number(Double(Self.modifiers(event.modifierFlags)))
        ]
        if let text {
            payload["text"] = .string(text)
        }
        onInput?(.object(payload))
    }

    private static func modifiers(_ flags: NSEvent.ModifierFlags) -> Int {
        var value = 0
        if flags.contains(.option) { value |= 1 }
        if flags.contains(.control) { value |= 2 }
        if flags.contains(.command) { value |= 4 }
        if flags.contains(.shift) { value |= 8 }
        return value
    }

    private static func namedKey(_ keyCode: UInt16) -> String? {
        switch keyCode {
        case 36, 76: "Enter"
        case 48: "Tab"
        case 51: "Backspace"
        case 117: "Delete"
        case 53: "Escape"
        case 123: "ArrowLeft"
        case 124: "ArrowRight"
        case 125: "ArrowDown"
        case 126: "ArrowUp"
        case 115: "Home"
        case 119: "End"
        case 116: "PageUp"
        case 121: "PageDown"
        default: nil
        }
    }

    private static func code(for event: NSEvent) -> String {
        if let named = namedKey(event.keyCode) {
            return named
        }
        guard let character = event.charactersIgnoringModifiers?.uppercased().first else { return "" }
        if character.isLetter {
            return "Key\(character)"
        }
        if character.isNumber {
            return "Digit\(character)"
        }
        if character == " " {
            return "Space"
        }
        return ""
    }
}

struct BrowserCanvas: NSViewRepresentable {
    let session: BrowserLiveSession?
    let fallbackImage: NSImage?
    let fallbackVersion: Int
    let isInteractive: Bool
    let onInput: (JSONValue) -> Void
    let onBlockedClick: () -> Void

    func makeNSView(context: Context) -> BrowserFrameView {
        let view = BrowserFrameView()
        if let session {
            session.renderer = view
            if let frame = session.lastFrame {
                view.show(frame)
            }
        }
        return view
    }

    func updateNSView(_ view: BrowserFrameView, context: Context) {
        view.isInteractive = isInteractive
        view.onInput = onInput
        view.onBlockedClick = onBlockedClick
        if let session {
            if session.renderer !== view {
                session.renderer = view
                if let frame = session.lastFrame {
                    view.show(frame)
                }
            }
        } else if context.coordinator.version != fallbackVersion {
            context.coordinator.version = fallbackVersion
            if let image = fallbackImage?.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                view.show(image)
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator {
        var version = -1
    }
}
