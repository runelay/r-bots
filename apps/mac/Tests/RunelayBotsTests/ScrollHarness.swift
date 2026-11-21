import AppKit
import SwiftUI
import XCTest

@testable import RunelayBots

struct HarnessFixture {
    let botID: String
    let sessionID: String
    let fullTotal: Int
    let allEvents: [Any]
    var withheld = 0

    var total: Int { fullTotal - withheld }
    var events: [Any] { Array(allEvents.prefix(allEvents.count - withheld)) }

    static func load(_ url: URL) throws -> HarnessFixture {
        let data = try Data(contentsOf: url)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return HarnessFixture(
            botID: try XCTUnwrap(object["botId"] as? String),
            sessionID: try XCTUnwrap(object["sessionId"] as? String),
            fullTotal: try XCTUnwrap(object["total"] as? Int),
            allEvents: try XCTUnwrap(object["events"] as? [Any])
        )
    }

    func page(before: Int?, limit: Int) -> Data {
        let upper = before ?? total
        let slice = events.filter { (($0 as? [String: Any])?["index"] as? Int ?? 0) < upper }
        let chosen = Array(slice.suffix(min(limit, 200)))
        let first = (chosen.first as? [String: Any])?["index"] as? Int ?? 0
        var body: [String: Any] = ["events": chosen, "total": total]
        body["nextBefore"] = first > 0 ? first : NSNull()
        return (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
    }
}

final class FixtureURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var host = "harness.invalid"
    nonisolated(unsafe) static var fixtures: [String: HarnessFixture] = [:]
    nonisolated(unsafe) static var pageDelay: TimeInterval = 0.08
    nonisolated(unsafe) static var streams: [String: FixtureURLProtocol] = [:]
    private var thread: Thread?

    static func release(sessionID: String, events: [Any]) {
        guard let stream = streams[sessionID], let thread = stream.thread else { return }
        var data = Data()
        for event in events {
            if let line = try? JSONSerialization.data(withJSONObject: event) {
                data.append(line)
                data.append(0x0A)
            }
        }
        stream.perform(#selector(push(_:)), on: thread, with: data as NSData, waitUntilDone: false)
    }

    @objc private func push(_ data: NSData) {
        client?.urlProtocol(self, didLoad: data as Data)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host() == host
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else { return }
        let path = url.path()
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if path.hasSuffix("/stream") {
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/x-ndjson"])
            client?.urlProtocol(self, didReceive: response!, cacheStoragePolicy: .notAllowed)
            let parts = path.split(separator: "/")
            if parts.count >= 2 {
                thread = Thread.current
                Self.streams[String(parts[parts.count - 2])] = self
            }
            return
        }
        if path.hasSuffix("/events") {
            let parts = path.split(separator: "/")
            let sessionID = parts.count >= 2 ? String(parts[parts.count - 2]) : ""
            if let fixture = Self.fixtures[sessionID] {
                let before = items.first { $0.name == "before" }?.value.flatMap(Int.init)
                let limit = items.first { $0.name == "limit" }?.value.flatMap(Int.init) ?? 60
                let data = fixture.page(before: before, limit: limit)
                DispatchQueue.global().asyncAfter(deadline: .now() + Self.pageDelay) { [self] in
                    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])
                    client?.urlProtocol(self, didReceive: response!, cacheStoragePolicy: .notAllowed)
                    client?.urlProtocol(self, didLoad: data)
                    client?.urlProtocolDidFinishLoading(self)
                }
                return
            }
        }
        let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)
        client?.urlProtocol(self, didReceive: response!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

struct ScrollSample: CustomStringConvertible {
    var time: Double
    var offset: CGFloat
    var documentHeight: CGFloat
    var viewportHeight: CGFloat
    var distanceToBottom: CGFloat
    var inkRatio: Double

    var description: String {
        String(format: "t=%.2f off=%.0f doc=%.0f view=%.0f toEnd=%.0f ink=%.3f", time, offset, documentHeight, viewportHeight, distanceToBottom, inkRatio)
    }
}

@MainActor
final class HarnessHost {
    let window: NSWindow
    let hosting: NSView
    let model = AppModel()
    let started = Date()
    var footerHeight: CGFloat = 150

    init<Content: View>(size: CGSize, @ViewBuilder content: () -> Content) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let root = content()
            .environment(model)
            .frame(width: size.width, height: size.height)
        let view = NSHostingView(rootView: AnyView(root))
        view.frame = CGRect(origin: .zero, size: size)
        let onScreen = ProcessInfo.processInfo.environment["RB_HARNESS_OFFSCREEN"] == nil
        let origin = onScreen ? CGPoint(x: 40, y: 40) : CGPoint(x: -30000, y: -30000)
        window = NSWindow(contentRect: CGRect(origin: origin, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        if onScreen {
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            window.level = .init(rawValue: -1000)
        }
        window.contentView = view
        window.orderFrontRegardless()
        hosting = view
    }

    func close() {
        window.orderOut(nil)
        window.contentView = nil
        window.close()
    }

    func pump(_ seconds: Double, every step: Double = 1.0 / 60.0, sample: ((ScrollSample) -> Void)? = nil) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            RunLoop.main.run(until: Date().addingTimeInterval(step))
            hosting.layoutSubtreeIfNeeded()
            if let sample, let current = measure(ink: true) {
                sample(current)
            }
        }
    }

    func pump(until condition: () -> Bool, timeout: Double) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(1.0 / 60.0))
        }
        return condition()
    }

    var transcriptScrollView: NSScrollView? {
        var best: NSScrollView?
        func walk(_ view: NSView) {
            if let scroll = view as? NSScrollView, !(scroll.documentView is NSTextView) {
                if best == nil || scroll.frame.height > best!.frame.height {
                    best = scroll
                }
            }
            for sub in view.subviews { walk(sub) }
        }
        walk(hosting)
        return best
    }

    func measure(ink: Bool) -> ScrollSample? {
        guard let scroll = transcriptScrollView, let document = scroll.documentView else { return nil }
        let clip = scroll.contentView
        let insets = scroll.contentInsets
        let visible = clip.bounds
        let docHeight = document.frame.height
        let offset: CGFloat
        let distance: CGFloat
        if document.isFlipped {
            offset = visible.minY
            distance = docHeight + insets.bottom - visible.maxY
        } else {
            offset = docHeight - visible.maxY
            distance = visible.minY + insets.bottom
        }
        return ScrollSample(
            time: Date().timeIntervalSince(started),
            offset: offset,
            documentHeight: docHeight,
            viewportHeight: visible.height,
            distanceToBottom: distance,
            inkRatio: ink ? inkRatio(in: scroll) : -1
        )
    }

    var rowFrames: [String: CGRect] {
        ((transcriptScrollView as? TranscriptListView)?.mountedRowFrames ?? [:]).filter { !$0.key.hasPrefix("transcript-") }
    }

    func visibleBand(_ scroll: NSScrollView) -> CGRect {
        let clip = scroll.contentView.bounds
        let insets = scroll.contentInsets
        let top = clip.minY + insets.top
        let bottom = clip.maxY - max(insets.bottom, 0)
        return CGRect(x: 0, y: top, width: clip.width, height: max(0, bottom - top))
    }

    func inkRatio(in scroll: NSScrollView) -> Double {
        let band = visibleBand(scroll)
        guard band.height > 0 else { return 0 }
        var rows = [Bool](repeating: false, count: Int(band.height))
        var count = 0
        for frame in rowFrames.values {
            let hit = frame.intersection(band)
            guard !hit.isNull, hit.height > 0 else { continue }
            count += 1
            let start = max(0, Int(hit.minY - band.minY))
            let end = min(rows.count, Int(hit.maxY - band.minY))
            if start < end { for index in start..<end { rows[index] = true } }
        }
        lastVisibleCount = count
        return Double(rows.filter { $0 }.count) / Double(rows.count)
    }

    var lastVisibleCount = 0

    private func visit(_ element: Any, depth: Int, _ body: (Any) -> Void) {
        guard depth < 80 else { return }
        body(element)
        for child in Self.children(of: element) {
            visit(child, depth: depth + 1, body)
        }
    }

    func scrollUp(by distance: CGFloat) {
        guard let scroll = transcriptScrollView else { return }
        let steps = 12
        let per = distance / CGFloat(steps)
        let phased = ProcessInfo.processInfo.environment["RB_HARNESS_NOPHASE"] == nil && String(describing: type(of: scroll)).contains("Hosting")
        if phased { send(scroll, delta: 0, phase: 1, momentum: 0) }
        for _ in 0..<steps {
            send(scroll, delta: per, phase: phased ? 2 : 0, momentum: 0)
            pump(1.0 / 60.0)
        }
        if phased { send(scroll, delta: 0, phase: 4, momentum: 0) }
        pump(0.4)
        if ProcessInfo.processInfo.environment["RB_HARNESS_VERBOSE"] != nil {
            var roles: [String: Int] = [:]
            var samples: [String] = []
            visit(hosting, depth: 0) { element in
                guard let item = element as? NSAccessibilityProtocol else { return }
                let role = item.accessibilityRole()?.rawValue ?? "nil"
                roles[role, default: 0] += 1
                if samples.count < 12, role == "AXStaticText" {
                    samples.append("\(item.accessibilityFrame()) \(String(describing: item.accessibilityLabel() ?? (item.accessibilityValue() as? String)).prefix(40))")
                }
            }
            print("[harness] ax roles \(roles) screenCapture=\(CGPreflightScreenCaptureAccess()) window=\(window.frame) ")
            samples.forEach { print("[harness]   \($0)") }
            print("[harness] scroll class \(type(of: scroll)) clip \(type(of: scroll.contentView)) doc \(type(of: scroll.documentView!)) gestures=\(hosting.gestureRecognizers.count)")
        }
    }

    private func send(_ scroll: NSScrollView, delta: CGFloat, phase: Int64, momentum: Int64) {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else { return }
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        if phase != 0 { event.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase) }
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
        event.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: Double(delta))
        event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(delta))
        let center = scroll.convert(CGPoint(x: scroll.bounds.midX, y: scroll.bounds.midY), to: nil)
        let screen = window.convertPoint(toScreen: center)
        let height = NSScreen.screens.first?.frame.height ?? 0
        event.location = CGPoint(x: screen.x, y: height - screen.y)
        guard let nsEvent = NSEvent(cgEvent: event) else { return }
        if ProcessInfo.processInfo.environment["RB_HARNESS_VERBOSE"] != nil {
            print("[harness] wheel phase=\(nsEvent.phase.rawValue) dy=\(nsEvent.scrollingDeltaY) precise=\(nsEvent.hasPreciseScrollingDeltas) loc=\(nsEvent.locationInWindow)")
        }
        if ProcessInfo.processInfo.environment["RB_HARNESS_DIRECT"] != nil {
            scroll.scrollWheel(with: nsEvent)
        } else {
            window.sendEvent(nsEvent)
        }
    }

    func scrollTo(y: CGFloat) {
        guard let scroll = transcriptScrollView else { return }
        scroll.contentView.setBoundsOrigin(CGPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    func viewportY(of id: String) -> CGFloat? {
        guard let scroll = transcriptScrollView else { return nil }
        return rowFrames[id].map { $0.minY - visibleBand(scroll).minY }
    }

    var topVisibleID: String? {
        guard let scroll = transcriptScrollView else { return nil }
        let band = visibleBand(scroll)
        return rowFrames.filter { $0.value.maxY > band.minY + 4 && $0.value.minY < band.maxY - 40 }
            .min { $0.value.minY < $1.value.minY }?.key
    }

    func pressJump() -> Bool {
        let characters = String(Character(UnicodeScalar(NSDownArrowFunctionKey)!))
        guard
            let event = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: [.command, .numericPad, .function], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters,
                isARepeat: false, keyCode: 125
            )
        else { return false }
        return window.performKeyEquivalent(with: event)
    }

    func pressButton(label: String) -> Bool {
        func walk(_ element: Any, depth: Int) -> Bool {
            guard depth < 60 else { return false }
            if let object = element as? NSObject, object.responds(to: #selector(NSAccessibilityProtocol.accessibilityLabel)) {
                let accessible = object as? NSAccessibilityProtocol
                if accessible?.accessibilityLabel()?.hasPrefix(label) == true, accessible?.accessibilityRole() == .button {
                    _ = accessible?.accessibilityPerformPress()
                    return true
                }
            }
            let children: [Any] = Self.children(of: element)
            for child in children where walk(child, depth: depth + 1) {
                return true
            }
            return false
        }
        return walk(hosting, depth: 0)
    }

    private static func children(of element: Any) -> [Any] {
        if let view = element as? NSView {
            return view.accessibilityChildren() ?? []
        }
        if let item = element as? NSAccessibilityElement {
            return item.accessibilityChildren() ?? []
        }
        return ((element as? NSObject)?.accessibilityAttributeValue(.children) as? [Any]) ?? []
    }
}
