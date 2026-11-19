import AppKit
import ApplicationServices
import CoreGraphics

enum ComputerPermission: String, CaseIterable, Identifiable, Sendable {
    case accessibility
    case screenRecording
    case automation

    var id: String { rawValue }

    var title: String {
        switch self {
        case .accessibility: "Acessibilidade"
        case .screenRecording: "Gravação de Tela"
        case .automation: "Automação"
        }
    }

    var detail: String {
        switch self {
        case .accessibility: "Ler a tela dos apps, clicar e digitar."
        case .screenRecording: "Tirar print e gravar a tela."
        case .automation: "Rodar AppleScript no Finder, Safari e outros apps."
        }
    }

    var settingsURL: URL {
        let anchor = switch self {
        case .accessibility: "Privacy_Accessibility"
        case .screenRecording: "Privacy_ScreenCapture"
        case .automation: "Privacy_Automation"
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }
}

struct ComputerPermissionsSnapshot: Equatable, Sendable {
    var accessibility = false
    var screenRecording = false
    var automation = false

    func isGranted(_ permission: ComputerPermission) -> Bool {
        switch permission {
        case .accessibility: accessibility
        case .screenRecording: screenRecording
        case .automation: automation
        }
    }

    var json: JSONValue {
        .object([
            "accessibility": .bool(accessibility),
            "screenRecording": .bool(screenRecording),
            "automation": .bool(automation),
        ])
    }

    static func current() -> ComputerPermissionsSnapshot {
        ComputerPermissionsSnapshot(
            accessibility: AXIsProcessTrusted(),
            screenRecording: CGPreflightScreenCaptureAccess(),
            automation: automationStatus(ask: false) == noErr
        )
    }

    static func automationStatus(ask: Bool) -> OSStatus {
        var target = AEAddressDesc()
        let bundleID = "com.apple.finder"
        let created = bundleID.withCString { pointer in
            AECreateDesc(DescType(typeApplicationBundleID), pointer, strlen(pointer), &target)
        }
        guard created == noErr else { return OSStatus(created) }
        defer { AEDisposeDesc(&target) }
        return AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
    }

    nonisolated(unsafe) private static var registered: Set<String> = []

    static func registerOnce(_ permission: ComputerPermission) {
        let key = "\(permission)"
        guard !registered.contains(key) else { return }
        registered.insert(key)
        switch permission {
        case .accessibility:
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        case .screenRecording:
            _ = CGRequestScreenCaptureAccess()
        case .automation:
            break
        }
    }

    static func request(_ permission: ComputerPermission) async {
        switch permission {
        case .accessibility:
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        case .screenRecording:
            _ = CGRequestScreenCaptureAccess()
        case .automation:
            await Task.detached {
                _ = automationStatus(ask: true)
            }.value
        }
        NSWorkspace.shared.open(permission.settingsURL)
    }
}
