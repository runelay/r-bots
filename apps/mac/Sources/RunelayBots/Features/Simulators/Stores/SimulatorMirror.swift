import AppKit
import CoreMedia
import Foundation
import Observation
@preconcurrency import ScreenCaptureKit

final class MirrorSurface: @unchecked Sendable {
    weak var layer: CALayer?

    func show(_ surface: IOSurface) {
        DispatchQueue.main.async { [weak self] in
            self?.set(surface)
        }
    }

    @MainActor
    func show(image: CGImage) {
        set(image)
    }

    @MainActor
    private func set(_ contents: Any) {
        guard let layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contents = contents
        CATransaction.commit()
    }

    @MainActor
    func clear() {
        set(NSNull())
    }
}

final class MirrorOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let surface: MirrorSurface
    let onStop: @Sendable (String) -> Void

    init(surface: MirrorSurface, onStop: @escaping @Sendable (String) -> Void) {
        self.surface = surface
        self.onStop = onStop
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
            let buffer = sampleBuffer.imageBuffer,
            let io = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue()
        else { return }
        surface.show(unsafeBitCast(io, to: IOSurface.self))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop(error.localizedDescription)
    }
}

@MainActor
@Observable
final class SimulatorMirror {
    enum Source: Equatable {
        case window
        case snapshots
    }

    enum State: Equatable {
        case idle
        case booting
        case opening
        case live(Source)
        case failed(String)

        var label: String? {
            switch self {
            case .booting: tr("Ligando o simulador…")
            case .opening: tr("Abrindo a tela…")
            default: nil
            }
        }
    }

    private(set) var state: State = .idle
    private(set) var windowFrame: CGRect = .zero
    private(set) var aspect: CGFloat = 0.46
    private(set) var needsPermission = false
    private(set) var tapping = false

    let surface = MirrorSurface()
    @ObservationIgnored private var stream: SCStream?
    @ObservationIgnored private var output: MirrorOutput?
    @ObservationIgnored private var snapshots: Task<Void, Never>?
    @ObservationIgnored private var pid: pid_t = 0
    @ObservationIgnored private var device: SimDevice?

    var source: Source? {
        if case .live(let source) = state { return source }
        return nil
    }

    var busy: Bool { state == .booting || state == .opening }

    func start(_ device: SimDevice) async {
        stopCapture()
        self.device = device
        guard device.booted else {
            state = .idle
            return
        }
        state = .opening
        var window = await findWindow()
        if window == nil {
            await showSimulator(device)
            for _ in 0..<16 {
                if Task.isCancelled { return }
                window = await findWindow()
                if window != nil { break }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        needsPermission = !CGPreflightScreenCaptureAccess()
        if let window, !needsPermission, await capture(window) {
            state = .live(.window)
            return
        }
        startSnapshots(device)
    }

    func boot(_ device: SimDevice) async {
        state = .booting
        do {
            _ = try await SimulatorRunner.boot(device.udid)
        } catch {
            state = .failed(error.localizedDescription)
            return
        }
        await SimulatorStore.shared.refresh()
        let booted = SimulatorStore.shared.device(device.udid) ?? device
        await start(SimDevice(udid: booted.udid, name: booted.name, runtime: booted.runtime, state: "Booted", platform: booted.platform))
    }

    func showWindow() async {
        guard let device else { return }
        await showSimulator(device)
        await start(device)
    }

    func requestPermission() {
        if !CGRequestScreenCaptureAccess(), let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    func stop() {
        stopCapture()
        state = .idle
    }

    private func stopCapture() {
        snapshots?.cancel()
        snapshots = nil
        let current = stream
        stream = nil
        output = nil
        pid = 0
        if let current {
            Task { try? await current.stopCapture() }
        }
    }

    private func showSimulator(_ device: SimDevice) async {
        _ = await Shell.run("/usr/bin/open", ["-g", "-a", "Simulator", "--args", "-CurrentDeviceUDID", device.udid], timeout: .seconds(20))
    }

    private func findWindow() async -> SCWindow? {
        guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) else { return nil }
        let windows = content.windows.filter { window in
            window.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator" && window.frame.width > 100 && window.frame.height > 100 && window.isOnScreen
        }
        let name = device?.name ?? ""
        return windows.first { ($0.title ?? "").localizedCaseInsensitiveContains(name) } ?? windows.first
    }

    private func capture(_ window: SCWindow) async -> Bool {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 24)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.queueDepth = 3
        let output = MirrorOutput(surface: surface) { _ in
            Task { @MainActor in
                SimulatorMirror.current?.fallBack()
            }
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: output)
        do {
            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "runelay.mirror"))
            try await stream.startCapture()
        } catch {
            return false
        }
        pid = window.owningApplication?.processID ?? 0
        windowFrame = window.frame
        aspect = window.frame.width / max(window.frame.height, 1)
        self.stream = stream
        self.output = output
        Self.current = self
        return true
    }

    static weak var current: SimulatorMirror?

    private func fallBack() {
        guard let device, source == .window else { return }
        stopCapture()
        startSnapshots(device)
    }

    private func startSnapshots(_ device: SimDevice) {
        let udid = device.udid
        snapshots?.cancel()
        snapshots = Task { [weak self] in
            var first = true
            var misses = 0
            while !Task.isCancelled {
                if let image = await Self.snapshot(udid: udid) {
                    misses = 0
                    guard let self, !Task.isCancelled else { return }
                    self.aspect = CGFloat(image.width) / CGFloat(max(image.height, 1))
                    self.surface.show(image: image)
                    if first {
                        self.state = .live(.snapshots)
                        first = false
                    }
                } else {
                    misses += 1
                    if misses >= 5, first {
                        self?.state = .failed(tr("Não consegui ver a tela do simulador."))
                        return
                    }
                }
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    nonisolated private static func snapshot(udid: String) async -> CGImage? {
        let file = FileManager.default.temporaryDirectory.appending(path: "rb-mirror-\(udid).jpg")
        let result = await Shell.run(SimulatorRunner.xcrun, ["simctl", "io", udid, "screenshot", "--type=jpeg", file.path(percentEncoded: false)], timeout: .seconds(10))
        guard result.code == 0, let source = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1400]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    func screenPoint(normalized point: CGPoint) -> CGPoint {
        CGPoint(x: windowFrame.minX + point.x * windowFrame.width, y: windowFrame.minY + point.y * windowFrame.height)
    }

    func mouse(_ type: CGEventType, normalized point: CGPoint) {
        if source == .snapshots {
            if type == .leftMouseUp { tap(point) }
            return
        }
        guard pid != 0, let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: screenPoint(normalized: point), mouseButton: .left) else { return }
        event.postToPid(pid)
    }

    private func tap(_ point: CGPoint) {
        guard let device, !tapping else { return }
        tapping = true
        Task {
            _ = await SimulatorRunner.perform(op: "sim.tap", body: .object(["udid": .string(device.udid), "x": .number(point.x * 100), "y": .number(point.y * 100)]))
            tapping = false
        }
    }

    private var simulatorPID: pid_t {
        pid != 0 ? pid : NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first?.processIdentifier ?? 0
    }

    func key(code: CGKeyCode, flags: CGEventFlags) {
        let pid = simulatorPID
        guard pid != 0 else { return }
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags
            event.postToPid(pid)
        }
    }

    func home() {
        key(code: 4, flags: [.maskCommand, .maskShift])
    }

    func rotate() {
        key(code: 124, flags: .maskCommand)
    }
}
