import AppKit
import Carbon.HIToolbox
import CoreGraphics

@MainActor
final class InputTools {
    static let marker: Int64 = 0x52_4C_42_4F_54
    private(set) var lastSyntheticAt = Date.distantPast
    private let source = CGEventSource(stateID: .hidSystemState)

    func click(at point: CGPoint, button: String, double: Bool) async {
        let isRight = button == "right"
        let mouseButton: CGMouseButton = isRight ? .right : .left
        let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: mouseButton))
        try? await Task.sleep(for: .milliseconds(40))
        for clickState in double ? [1, 2] : [1] {
            let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
            post(down)
            let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton)
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
            post(up)
            try? await Task.sleep(for: .milliseconds(60))
        }
    }

    func scroll(at point: CGPoint?, deltaX: Double, deltaY: Double) {
        if let point {
            post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
        }
        let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(-deltaY.rounded()), wheel2: Int32(-deltaX.rounded()), wheel3: 0)
        post(event)
    }

    func drag(from start: CGPoint, to end: CGPoint) async {
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left))
        try? await Task.sleep(for: .milliseconds(40))
        post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left))
        let steps = 16
        for step in 1...steps {
            let progress = CGFloat(step) / CGFloat(steps)
            let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
            post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left))
            try? await Task.sleep(for: .milliseconds(15))
        }
        post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left))
    }

    func type(_ text: String, shouldContinue: () -> Bool) async -> Bool {
        var buffer: [UniChar] = []
        func flush() {
            guard !buffer.isEmpty else { return }
            for isDown in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
                event?.flags = []
                buffer.withUnsafeBufferPointer { pointer in
                    event?.keyboardSetUnicodeString(stringLength: pointer.count, unicodeString: pointer.baseAddress)
                }
                post(event)
            }
            buffer.removeAll()
        }
        for character in text {
            guard shouldContinue() else { return false }
            if character == "\n" || character == "\r\n" {
                flush()
                pressKey(code: CGKeyCode(kVK_Return), flags: [])
            } else if character == "\t" {
                flush()
                pressKey(code: CGKeyCode(kVK_Tab), flags: [])
            } else {
                buffer.append(contentsOf: Array(String(character).utf16))
                if buffer.count >= 16 {
                    flush()
                } else {
                    continue
                }
            }
            try? await Task.sleep(for: .milliseconds(12))
        }
        flush()
        return true
    }

    func key(_ combo: String) throws {
        let parts = combo.lowercased()
            .replacingOccurrences(of: " ", with: "")
            .split(separator: "+", omittingEmptySubsequences: false)
            .map(String.init)
        var flags: CGEventFlags = []
        var keyCode: CGKeyCode?
        for (index, part) in parts.enumerated() {
            let name = part.isEmpty && index == parts.count - 1 ? "+" : part
            if let modifier = Self.modifiers[name] {
                flags.insert(modifier)
                continue
            }
            guard keyCode == nil, let code = Self.keyCodes[name] else {
                throw ToolFailure.badArgs("Não conheço a tecla \"\(name)\" em \"\(combo)\". Use algo como cmd+l, return, esc, tab, up.")
            }
            keyCode = code
        }
        guard let keyCode else {
            throw ToolFailure.badArgs("\"\(combo)\" não tem tecla, só modificadores.")
        }
        pressKey(code: keyCode, flags: flags)
    }

    private func pressKey(code: CGKeyCode, flags: CGEventFlags) {
        for isDown in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: isDown)
            event?.flags = flags
            post(event)
        }
    }

    private func post(_ event: CGEvent?) {
        guard let event else { return }
        event.setIntegerValueField(.eventSourceUserData, value: Self.marker)
        lastSyntheticAt = Date()
        event.post(tap: .cghidEventTap)
    }

    private static let modifiers: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "super": .maskCommand,
        "shift": .maskShift,
        "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
        "ctrl": .maskControl, "control": .maskControl,
        "fn": .maskSecondaryFn,
    ]

    private static let keyCodes: [String: CGKeyCode] = {
        var map: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
            "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
            "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
            "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
            "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
            "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
            ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period,
            "/": kVK_ANSI_Slash, "\\": kVK_ANSI_Backslash, "`": kVK_ANSI_Grave, "+": kVK_ANSI_Equal,
            "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "space": kVK_Space,
            "delete": kVK_Delete, "backspace": kVK_Delete, "forwarddelete": kVK_ForwardDelete, "del": kVK_ForwardDelete,
            "esc": kVK_Escape, "escape": kVK_Escape,
            "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
            "arrowleft": kVK_LeftArrow, "arrowright": kVK_RightArrow, "arrowup": kVK_UpArrow, "arrowdown": kVK_DownArrow,
            "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown, "pgup": kVK_PageUp, "pgdown": kVK_PageDown,
            "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
            "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        ]
        map["spacebar"] = kVK_Space
        return map.mapValues { CGKeyCode($0) }
    }()
}
