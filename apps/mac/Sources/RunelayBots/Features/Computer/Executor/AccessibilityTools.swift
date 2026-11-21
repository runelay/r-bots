import AppKit
import ApplicationServices

private struct ElementKey: Hashable {
    let element: AXUIElement

    static func == (lhs: ElementKey, rhs: ElementKey) -> Bool {
        CFEqual(lhs.element, rhs.element)
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(CFHash(element))
    }
}

@MainActor
private final class SessionElements {
    var byID: [String: AXUIElement] = [:]
    var ids: [ElementKey: String] = [:]
    var next = 1
}

@MainActor
final class AccessibilityTools {
    private var sessions: [String: SessionElements] = [:]
    private var sessionOrder: [String] = []
    private let nodeBudget = 600
    private let maxDepth = 30
    private let valueLimit = 200
    private let transparentRoles: Set<String> = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXUnknown", "AXLayoutItem"]

    func requireTrusted() throws {
        guard AXIsProcessTrusted() else {
            ComputerPermissionsSnapshot.promptMissing(.accessibility)
            throw ToolFailure.missing(.accessibility)
        }
    }

    func apps() -> JSONValue {
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { app -> JSONValue in
                .object([
                    "name": .string(app.localizedName ?? ""),
                    "bundleId": app.bundleIdentifier.map(JSONValue.string) ?? .null,
                    "pid": .int(Int(app.processIdentifier)),
                    "active": .bool(app.processIdentifier == frontmost),
                    "hidden": .bool(app.isHidden),
                ])
            }
        return .object([
            "frontmost": NSWorkspace.shared.frontmostApplication.map { .string($0.localizedName ?? "") } ?? .null,
            "apps": .array(apps),
        ])
    }

    func windows() -> JSONValue {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let list = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
        let windows = list.compactMap { info -> JSONValue? in
            guard (info[kCGWindowLayer as String] as? Int) == 0 else { return nil }
            let bounds = (info[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) } ?? .zero
            guard bounds.width > 1, bounds.height > 1 else { return nil }
            var object: [String: JSONValue] = [
                "windowId": .int(info[kCGWindowNumber as String] as? Int ?? 0),
                "app": .string(info[kCGWindowOwnerName as String] as? String ?? ""),
                "pid": .int(info[kCGWindowOwnerPID as String] as? Int ?? 0),
                "frame": .frame(bounds),
            ]
            if let title = info[kCGWindowName as String] as? String, !title.isEmpty {
                object["title"] = .string(title)
            }
            return .object(object)
        }
        return .object(["windows": .array(windows)])
    }

    func tree(appQuery: String?, session: String) throws -> JSONValue {
        try requireTrusted()
        let app = try resolveApp(appQuery)
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 1.5)
        let store = elements(for: session)
        var budget = nodeBudget
        var windows = children(of: root, attribute: kAXWindowsAttribute)
        if let focused = copyElement(root, kAXFocusedWindowAttribute) {
            windows.removeAll { CFEqual($0, focused) }
            windows.insert(focused, at: 0)
        }
        var nodes: [JSONValue] = []
        for window in windows where budget > 0 {
            nodes.append(contentsOf: walk(window, depth: 0, budget: &budget, store: store))
        }
        var result: [String: JSONValue] = [
            "app": .string(app.localizedName ?? ""),
            "bundleId": app.bundleIdentifier.map(JSONValue.string) ?? .null,
            "pid": .int(Int(app.processIdentifier)),
            "windows": .array(nodes),
            "nodeCount": .int(nodeBudget - budget),
            "truncated": .bool(budget <= 0),
        ]
        if let focused = copyElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) {
            result["focusedElementId"] = .string(identifier(for: focused, store: store))
        }
        if windows.isEmpty {
            result["note"] = .string("O app não tem janela aberta ou não expõe acessibilidade.")
        }
        return .object(result)
    }

    func element(_ id: String, session: String) throws -> AXUIElement {
        guard let element = sessions[session]?.byID[id] else {
            throw ToolFailure(404, code: "element_not_found", "O elemento \(id) não existe nesta sessão. Rode computer_ui_tree de novo.")
        }
        return element
    }

    func frame(of element: AXUIElement) -> CGRect? {
        guard let positionValue = copyValue(element, kAXPositionAttribute), let sizeValue = copyValue(element, kAXSizeAttribute) else { return nil }
        guard CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        return CGRect(origin: point, size: size)
    }

    func press(_ element: AXUIElement) -> Bool {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let actions = names as? [String], actions.contains(kAXPressAction) else { return false }
        return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }

    func focusedIsSecure() -> Bool {
        guard AXIsProcessTrusted(), let focused = copyElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) else { return false }
        let role = copyValue(focused, kAXRoleAttribute) as? String
        let subrole = copyValue(focused, kAXSubroleAttribute) as? String
        return role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    func focusedFrame() -> CGRect? {
        guard AXIsProcessTrusted(), let focused = copyElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) else { return nil }
        return frame(of: focused).flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
    }

    func isSecure(_ element: AXUIElement) -> Bool {
        let role = copyValue(element, kAXRoleAttribute) as? String
        let subrole = copyValue(element, kAXSubroleAttribute) as? String
        return role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    func resolveApp(_ query: String?) throws -> NSRunningApplication {
        guard let query, !query.isEmpty else {
            guard let app = NSWorkspace.shared.frontmostApplication else {
                throw ToolFailure(404, code: "app_not_found", "Nenhum app em primeiro plano.")
            }
            return app
        }
        let lowered = query.lowercased()
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
        if let exact = running.first(where: { $0.bundleIdentifier?.lowercased() == lowered || $0.localizedName?.lowercased() == lowered }) {
            return exact
        }
        if let partial = running.first(where: { ($0.localizedName?.lowercased().contains(lowered) ?? false) }) {
            return partial
        }
        throw ToolFailure(404, code: "app_not_found", "O app \"\(query)\" não está aberto.")
    }

    private func elements(for session: String) -> SessionElements {
        if let store = sessions[session] {
            return store
        }
        let store = SessionElements()
        sessions[session] = store
        sessionOrder.append(session)
        if sessionOrder.count > 20 {
            sessions.removeValue(forKey: sessionOrder.removeFirst())
        }
        return store
    }

    private func identifier(for element: AXUIElement, store: SessionElements) -> String {
        let key = ElementKey(element: element)
        if let id = store.ids[key] {
            return id
        }
        let id = "e\(store.next)"
        store.next += 1
        store.ids[key] = id
        store.byID[id] = element
        return id
    }

    private func walk(_ element: AXUIElement, depth: Int, budget: inout Int, store: SessionElements) -> [JSONValue] {
        guard budget > 0, depth <= maxDepth else { return [] }
        let attributes = [
            kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
            kAXChildrenAttribute, kAXIdentifierAttribute, kAXPlaceholderValueAttribute,
        ]
        var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
            let values = raw as? [AnyObject], values.count == attributes.count
        else { return [] }
        func value(_ index: Int) -> AnyObject? {
            let item = values[index]
            if CFGetTypeID(item) == AXValueGetTypeID(), AXValueGetType(item as! AXValue) == .axError {
                return nil
            }
            return item
        }
        let role = value(0) as? String ?? "AXUnknown"
        let subrole = value(1) as? String
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        let title = clean(value(2))
        let text = secure ? nil : clean(value(3))
        let description = clean(value(4))
        let placeholder = clean(value(11))
        let childElements = (value(9) as? [AXUIElement]) ?? []
        let isTransparent = transparentRoles.contains(role) && title == nil && text == nil && description == nil && !childElements.isEmpty

        var childNodes: [JSONValue] = []
        for child in childElements {
            guard budget > 0 else { break }
            childNodes.append(contentsOf: walk(child, depth: depth + 1, budget: &budget, store: store))
        }
        if isTransparent {
            return childNodes
        }
        budget -= 1
        var node: [String: JSONValue] = [
            "id": .string(identifier(for: element, store: store)),
            "role": .string(role),
        ]
        if let subrole { node["subrole"] = .string(subrole) }
        if let title { node["title"] = .string(title) }
        if let text { node["value"] = .string(text) }
        if let description { node["description"] = .string(description) }
        if let placeholder { node["placeholder"] = .string(placeholder) }
        if let identifier = clean(value(10)) { node["identifier"] = .string(identifier) }
        if let positionValue = value(5), let sizeValue = value(6),
            CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID()
        {
            var point = CGPoint.zero
            var size = CGSize.zero
            AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
            AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
            node["frame"] = .frame(CGRect(origin: point, size: size))
        }
        if (value(7) as? Bool) == false { node["enabled"] = .bool(false) }
        if (value(8) as? Bool) == true { node["focused"] = .bool(true) }
        if secure { node["secure"] = .bool(true) }
        if !childNodes.isEmpty { node["children"] = .array(childNodes) }
        return [.object(node)]
    }

    private func clean(_ value: AnyObject?) -> String? {
        let text: String?
        switch value {
        case let string as String: text = string
        case let number as NSNumber: text = number.stringValue
        case let url as URL: text = url.absoluteString
        case let attributed as NSAttributedString: text = attributed.string
        default: text = nil
        }
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed.count > valueLimit ? String(trimmed.prefix(valueLimit)) + "…" : trimmed
    }

    private func copyValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    private func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = copyValue(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private func children(of element: AXUIElement, attribute: String) -> [AXUIElement] {
        (copyValue(element, attribute) as? [AXUIElement]) ?? []
    }
}
