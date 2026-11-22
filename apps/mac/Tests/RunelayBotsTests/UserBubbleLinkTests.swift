import AppKit
import SwiftUI
import XCTest

@testable import RunelayBots

@MainActor
final class UserBubbleLinkTests: XCTestCase {
    func testLinkStaysVisibleAfterNarrowSizeProbe() throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let message = UserMessage(id: "m1", text: "https://example.com/landing-page\n\ntext after the link", state: .sent, isConfirmed: true)
        let size = CGSize(width: 700, height: 200)
        let hosting = NSHostingView(
            rootView: UserBubble(message: message, meta: BubbleMeta(), canReact: true, retry: {})
                .frame(width: size.width, height: size.height)
                .background(Theme.background)
        )
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: CGRect(origin: CGPoint(x: -30000, y: -30000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = hosting
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }
        pump(hosting)

        let link = try XCTUnwrap(Self.linkTextView(in: hosting))
        _ = link.fittingSize(width: 0)
        pump(hosting)

        XCTAssertEqual(link.textContainer?.size.width ?? 0, link.bounds.width, accuracy: 1)
        let ink = try Self.inkRatio(of: link, in: hosting)
        XCTAssertGreaterThan(ink, 0.03, "link line rendered without visible ink")
    }

    private func pump(_ view: NSView) {
        for _ in 0..<20 {
            RunLoop.main.run(until: Date().addingTimeInterval(1.0 / 60.0))
            view.layoutSubtreeIfNeeded()
        }
    }

    private static func linkTextView(in view: NSView) -> LinkTextView? {
        if let link = view as? LinkTextView {
            return link
        }
        for subview in view.subviews {
            if let link = linkTextView(in: subview) {
                return link
            }
        }
        return nil
    }

    private static func inkRatio(of link: NSView, in hosting: NSView) throws -> Double {
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / hosting.bounds.width
        var rect = hosting.convert(link.bounds, from: link)
        if !hosting.isFlipped {
            rect.origin.y = hosting.bounds.height - rect.maxY
        }
        let minX = Int(rect.minX * scale)
        let maxX = min(rep.pixelsWide, Int(rect.maxX * scale))
        let minY = Int(rect.minY * scale)
        let maxY = min(rep.pixelsHigh, Int(rect.maxY * scale))
        var inked = 0
        var total = 0
        for y in minY..<maxY {
            for x in minX..<maxX {
                guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                total += 1
                if color.redComponent < 0.3, color.greenComponent < 0.3, color.blueComponent < 0.3 {
                    inked += 1
                }
            }
        }
        return total == 0 ? 0 : Double(inked) / Double(total)
    }
}
