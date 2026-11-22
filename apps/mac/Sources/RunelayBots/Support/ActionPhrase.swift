import Foundation

struct ActionPhrase: Equatable {
    enum Surface: Equatable {
        case browser
        case desktop
        case computer
        case connector
        case other
    }

    var verb: String
    var object: String?
    var extra: String?
    var place: String?
    var url: URL?
    var app: String?
    var bundleID: String?
    var surface: Surface
    var symbol: String
    var tooltip: String?

    var host: String? { url?.host().map(SiteName.bareHost) }

    var text: AttributedString {
        var result = AttributedString(verb)
        if let object, !object.isEmpty {
            result += AttributedString(" ")
            var strong = AttributedString(object)
            strong.inlinePresentationIntent = .stronglyEmphasized
            result += strong
        }
        if let extra, !extra.isEmpty {
            result += AttributedString(" \(extra)")
        }
        if let place, !place.isEmpty {
            result += AttributedString(" \(place)")
        }
        return result
    }

    var plain: String {
        String(text.characters)
    }

    init(
        verb: String, object: String? = nil, extra: String? = nil, place: String? = nil, url: URL? = nil, app: String? = nil, bundleID: String? = nil, surface: Surface = .other,
        symbol: String = "sparkles"
    ) {
        self.verb = verb
        self.object = object
        self.extra = extra
        self.place = place
        self.url = url
        self.app = app
        self.bundleID = bundleID
        self.surface = surface
        self.symbol = symbol
    }

    static func repoParts(_ path: String) -> (name: String, parent: String?) {
        var trimmed = path
        while trimmed.count > 1 && trimmed.hasSuffix("/") { trimmed.removeLast() }
        let name = (trimmed as NSString).lastPathComponent
        let parent = (trimmed as NSString).deletingLastPathComponent
        return (name.isEmpty ? trimmed : name, parent.isEmpty ? nil : parent)
    }

    init(call: ToolCall, target: ApprovalTarget? = nil) {
        let name = call.name.lowercased()
        let input = call.input
        let urlText = target?.url ?? input["url"]?.stringValue ?? call.output?["url"]?.stringValue
        let url = urlText.flatMap(SiteName.url(from:))
        let surface: Surface
        if call.connectorName != nil {
            surface = .connector
        } else if name.hasPrefix("browser") {
            surface = .browser
        } else if name.hasPrefix("desktop") {
            surface = .desktop
        } else if name.hasPrefix("computer") || name.hasPrefix("files") || name.hasPrefix("shell") || name.hasPrefix("record") {
            surface = .computer
        } else {
            surface = .other
        }
        let quoted = Self.quoted(in: call.label)
        let element = target.flatMap { $0.label.isEmpty ? nil : $0.label } ?? quoted
        let roleNoun = target.flatMap { Self.roleNoun($0.role) }
        let sitePlace = url.flatMap { $0.host() }.map(SiteName.placePhrase)
        let appPlace = target?.app.flatMap { $0.isEmpty ? nil : tr("no %@", $0) }

        self.init(verb: call.displayName, url: url, app: target?.app, bundleID: target?.bundleID, surface: surface, symbol: call.symbol)

        switch name {
        case "browser_open", "computer_open", "desktop_open":
            if let url {
                verb = tr("Abrir")
                object = SiteName.bareHost(url.host() ?? url.absoluteString)
                symbol = "safari"
            } else if let app = input["app"]?.stringValue {
                verb = tr("Abrir")
                object = app == "terminal" ? tr("o terminal") : app == "browser" ? tr("o navegador") : app
                self.app = app == "terminal" || app == "browser" ? nil : app
                symbol = "macwindow"
            } else if let path = input["path"]?.stringValue {
                verb = tr("Abrir")
                object = (path as NSString).lastPathComponent
                symbol = "doc"
            }
        case "browser_snapshot":
            verb = tr("Ler a página")
            place = sitePlace
            symbol = "doc.text.magnifyingglass"
        case "browser_screenshot":
            verb = tr("Ver a página")
            place = sitePlace
            symbol = "camera"
        case "browser_click", "desktop_click", "computer_click":
            verb = tr("Clicar em")
            object = element ?? roleNoun ?? (surface == .browser ? tr("um elemento") : tr("um ponto da tela"))
            place = surface == .browser ? sitePlace : appPlace
            symbol = "cursorarrow.click"
        case "browser_fill":
            verb = tr("Preencher")
            object = element ?? roleNoun ?? tr("um campo")
            if let value = input["text"]?.stringValue, !value.isEmpty {
                extra = tr("com “%@”", Self.clip(value, 40))
            }
            place = sitePlace
            symbol = "character.cursor.ibeam"
        case "desktop_type", "computer_type":
            verb = tr("Digitar")
            object = input["text"]?.stringValue.map { "“\(Self.clip($0, 48))”" }
            place = appPlace
            symbol = "keyboard"
        case "desktop_key", "computer_key":
            verb = tr("Apertar")
            object = input["combo"]?.stringValue.map(Self.prettyCombo)
            place = appPlace
            symbol = "command"
        case "desktop_scroll", "computer_scroll":
            verb = input["direction"]?.stringValue == "up" ? tr("Rolar para cima") : tr("Rolar a tela")
            place = appPlace
            symbol = "arrow.up.and.down"
        case "desktop_screenshot", "computer_screenshot":
            verb = tr("Olhar a tela")
            place = surface == .desktop ? tr("do computador") : tr("do Mac")
            symbol = "camera.viewfinder"
        case "computer_ui_tree":
            verb = tr("Ler a tela")
            place = input["app"]?.stringValue.map { tr("do %@", $0) }
            symbol = "text.viewfinder"
        case "computer_apps":
            verb = tr("Ver os apps abertos")
            symbol = "square.grid.2x2"
        case "computer_windows":
            verb = tr("Ver as janelas abertas")
            symbol = "macwindow.on.rectangle"
        case "computer_applescript":
            verb = tr("Rodar uma automação no Mac")
            symbol = "applescript"
        case "shell_run":
            verb = tr("Rodar um comando")
            object = input["cmd"]?.stringValue.map { Self.clip($0, 48) }
            symbol = "terminal"
        case "files_list", "files_read", "files_write", "files_move", "files_rename", "files_mkdir", "files_trash":
            let verbs = [
                "files_list": tr("Ver a pasta"), "files_read": tr("Ler"), "files_write": tr("Salvar"), "files_move": tr("Mover"), "files_rename": tr("Renomear"), "files_mkdir": tr("Criar a pasta"),
                "files_trash": tr("Mandar para a Lixeira"),
            ]
            verb = verbs[name] ?? tr("Mexer em")
            let path = input["path"]?.stringValue ?? input["from"]?.stringValue
            object = path.map { ($0 as NSString).lastPathComponent }
            if name == "files_trash", let count = input["paths"]?.arrayValue?.count {
                object = count == 1 ? tr("1 item") : tr("%lld itens", count)
            }
            symbol = "folder"
        case "record_start":
            verb = tr("Gravar a tela")
            symbol = "record.circle"
        case "record_stop":
            verb = tr("Parar a gravação")
            symbol = "stop.circle"
        case "prod_query":
            verb = tr("Consultar o banco de dados")
            symbol = "cylinder.split.1x2"
        default:
            if call.isDelegation {
                verb = tr("Pedir ajuda a")
                object = Self.delegateName(call)
                symbol = "person.2.fill"
            } else if surface == .connector {
                let tool = call.connectorTool ?? call.name
                verb = call.label.map(Self.stripPrompt) ?? Self.humanizeIdentifier(tool)
                place = call.connectorName.map { tr("no %@", ConnectorNames.pretty($0)) }
            } else if call.name == "Bash", Self.isPlainCommand(input), let human = CommandPhrase.describe(input["command"]?.stringValue ?? "") {
                verb = human.verb
                object = human.object
                symbol = "terminal"
            } else if let label = call.label, !label.isEmpty {
                verb = Self.stripPrompt(label)
                if let quoted {
                    let head = label.components(separatedBy: "“").first?.trimmingCharacters(in: .whitespaces) ?? label
                    verb = head
                    object = quoted
                }
            } else {
                verb = Self.humanizeIdentifier(call.name)
            }
        }
        if name.hasSuffix("workspace_add") {
            let shown = target.flatMap { $0.label.isEmpty ? nil : $0.label } ?? input["path"]?.stringValue ?? ""
            let parts = Self.repoParts(shown)
            verb = tr("Liberar o repositório")
            object = parts.name
            place = parts.parent.map { tr("em %@", $0) }
            tooltip = input["path"]?.stringValue ?? shown
            symbol = "arrow.triangle.branch"
        }
        if name.hasSuffix("add_schedule"), let cron = input["cron"]?.stringValue {
            verb = tr("Criar rotina")
            object = input["name"]?.stringValue
            extra = CronSchedule.describe(cron)
            symbol = "clock"
        }
    }

    init(approval: Approval, call: ToolCall?) {
        if let call {
            self.init(call: call, target: approval.target)
            return
        }
        let target = approval.target
        let url = target?.url.flatMap(SiteName.url(from:))
        let text = approval.prompt.isEmpty ? approval.title : approval.prompt
        self.init(verb: Self.stripPrompt(text), url: url, app: target?.app, bundleID: target?.bundleID, surface: url != nil ? .browser : .other, symbol: "hand.raised")
    }

    static func stripPrompt(_ text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let newline = value.firstIndex(of: "\n") {
            value = String(value[..<newline])
        }
        if let prefix = askPrefixes.first(where: { value.hasPrefix($0) }) {
            value = String(value.dropFirst(prefix.count))
        }
        if value.hasSuffix("?") {
            value = String(value.dropLast())
        }
        return value.prefix(1).uppercased() + value.dropFirst()
    }

    static let askPrefixes = ["Posso ", "Can I "]
    static let delegatePrefixes = ["Delegar para ", "Delegate to "]

    static func delegateName(_ call: ToolCall) -> String {
        if let label = call.label, let prefix = delegatePrefixes.first(where: { label.hasPrefix($0) }) {
            let name = label.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { return name }
        }
        return call.delegation?.botID ?? call.input["bot"]?.stringValue ?? call.name
    }

    static func isPlainCommand(_ input: JSONValue) -> Bool {
        (input["description"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func quoted(in label: String?) -> String? {
        guard let label, let start = label.firstIndex(of: "“"), let end = label[label.index(after: start)...].firstIndex(of: "”") else { return nil }
        let value = String(label[label.index(after: start)..<end]).trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }

    static func roleNoun(_ role: String) -> String? {
        let key = role.lowercased().replacingOccurrences(of: "ax", with: "", options: .anchored)
        switch key {
        case "button", "popupbutton", "menubutton": return tr("um botão")
        case "link": return tr("um link")
        case "textbox", "searchbox", "textfield", "textarea", "combobox", "securetextfield": return tr("um campo")
        case "checkbox": return tr("uma caixa de seleção")
        case "radio", "radiobutton": return tr("uma opção")
        case "menuitem", "menubaritem": return tr("um item do menu")
        case "tab", "tabgroup": return tr("uma aba")
        case "image": return tr("uma imagem")
        case "row", "cell": return tr("um item da lista")
        case "desktop": return tr("um ponto da tela")
        default: return nil
        }
    }

    static func prettyCombo(_ combo: String) -> String {
        let symbols = [
            "cmd": "⌘", "command": "⌘", "super": "⌘", "ctrl": "⌃", "control": "⌃", "alt": "⌥", "option": "⌥", "shift": "⇧", "return": "↩", "enter": "↩", "tab": "⇥", "escape": "Esc", "esc": "Esc",
            "left": "←", "right": "→", "up": "↑", "down": "↓", "backspace": "⌫", "delete": "⌫", "space": tr("Espaço"),
        ]
        return combo.split(separator: "+").map { part in
            let key = part.trimmingCharacters(in: .whitespaces)
            return symbols[key.lowercased()] ?? key.uppercased()
        }
        .joined()
    }

    static func humanizeIdentifier(_ value: String) -> String {
        let spaced =
            value
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: ".", with: " ")
            .trimmingCharacters(in: .whitespaces)
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }

    static func clip(_ value: String, _ limit: Int) -> String {
        let clean = value.replacingOccurrences(of: "\n", with: " ")
        return clean.count > limit ? String(clean.prefix(limit - 1)) + "…" : clean
    }
}

enum SiteName {
    private static let known: [String: String] = [
        "mail.google.com": "Gmail",
        "docs.google.com": "Google Docs",
        "drive.google.com": "Google Drive",
        "calendar.google.com": "Google Agenda",
        "sheets.google.com": "Google Planilhas",
        "meet.google.com": "Google Meet",
        "google.com": "Google",
        "github.com": "GitHub",
        "linear.app": "Linear",
        "x.com": "X",
        "twitter.com": "X",
        "linkedin.com": "LinkedIn",
        "youtube.com": "YouTube",
        "instagram.com": "Instagram",
        "facebook.com": "Facebook",
        "notion.so": "Notion",
        "app.slack.com": "Slack",
        "slack.com": "Slack",
        "web.whatsapp.com": "WhatsApp",
        "figma.com": "Figma",
        "vercel.com": "Vercel",
        "supabase.com": "Supabase",
    ]

    static func url(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != "about:blank" else { return nil }
        if let url = URL(string: trimmed), url.scheme != nil, url.host() != nil {
            return url
        }
        return URL(string: "https://\(trimmed)").flatMap { $0.host() != nil ? $0 : nil }
    }

    static func bareHost(_ host: String) -> String {
        host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    static func knownName(_ host: String) -> String? {
        known[bareHost(host).lowercased()].map { tr($0) }
    }

    static func friendly(_ host: String) -> String {
        knownName(host) ?? bareHost(host)
    }

    static func placePhrase(_ host: String) -> String {
        if let name = knownName(host) {
            return tr("no %@", name)
        }
        return tr("em %@", bareHost(host))
    }
}
