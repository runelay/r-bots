import AppKit
import CoreMedia
import Foundation
import Observation
@preconcurrency import ScreenCaptureKit

final class MirrorSurface: @unchecked Sendable {
    weak var layer: CALayer?

    func show(_ surface: IOSurface) {
        DispatchQueue.main.async { [weak self] in
            guard let layer = self?.layer else { return }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.contents = surface
            CATransaction.commit()
        }
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
              let io = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else { return }
        surface.show(io)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop(error.localizedDescription)
    }
}

@MainActor
@Observable
final class SimulatorMirror {
    enum State: Equatable {
        case idle
        case starting
        case live
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var windowFrame: CGRect = .zero
    private(set) var aspect: CGFloat = 0.46

    let surface = MirrorSurface()
    @ObservationIgnored private var stream: SCStream?
    @ObservationIgnored private var output: MirrorOutput?
    @ObservationIgnored private var pid: pid_t = 0
    @ObservationIgnored private var deviceName = ""

    func start(deviceName: String) async {
        guard stream == nil else { return }
        self.deviceName = deviceName
        state = .starting
        for attempt in 0..<20 {
            if Task.isCancelled { return }
            if let window = await findWindow() {
                await capture(window)
                return
            }
            if attempt == 0 {
                _ = await Shell.run("/usr/bin/open", ["-g", "-a", "Simulator"], timeout: .seconds(10))
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        state = .failed("Não achei a janela do Simulator. Ligue o simulador e deixe a janela aberta.")
    }

    func stop() {
        let current = stream
        stream = nil
        output = nil
        if case .failed = state {} else { state = .idle }
        Task { try? await current?.stopCapture() }
    }

    private func findWindow() async -> SCWindow? {
        guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) else { return nil }
        let windows = content.windows.filter { window in
            window.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator" && window.frame.width > 100 && window.frame.height > 100
        }
        return windows.first { ($0.title ?? "").localizedCaseInsensitiveContains(deviceName) } ?? windows.first
    }

    private func capture(_ window: SCWindow) async {
        pid = window.owningApplication?.processID ?? 0
        windowFrame = window.frame
        aspect = window.frame.width / max(window.frame.height, 1)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 24)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.queueDepth = 3
        let output = MirrorOutput(surface: surface) { message in
            Task { @MainActor in
                SimulatorMirror.current?.failed(message)
            }
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: output)
        do {
            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "runelay.mirror"))
            try await stream.startCapture()
            self.stream = stream
            self.output = output
            Self.current = self
            state = .live
        } catch {
            state = .failed("Sem permissão de Gravação de Tela para espelhar o simulador.")
        }
    }

    static weak var current: SimulatorMirror?

    private func failed(_ message: String) {
        stream = nil
        output = nil
        state = .failed(message)
    }

    func refreshFrame() async {
        if let window = await findWindow() {
            windowFrame = window.frame
            aspect = window.frame.width / max(window.frame.height, 1)
        }
    }

    func screenPoint(normalized point: CGPoint) -> CGPoint {
        CGPoint(x: windowFrame.minX + point.x * windowFrame.width, y: windowFrame.minY + point.y * windowFrame.height)
    }

    func mouse(_ type: CGEventType, normalized point: CGPoint) {
        guard pid != 0, let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: screenPoint(normalized: point), mouseButton: .left) else { return }
        event.postToPid(pid)
    }

    func key(code: CGKeyCode, flags: CGEventFlags) {
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
