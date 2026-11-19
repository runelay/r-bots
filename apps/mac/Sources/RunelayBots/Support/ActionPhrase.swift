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

    init(verb: String, object: String? = nil, extra: String? = nil, place: String? = nil, url: URL? = nil, app: String? = nil, bundleID: String? = nil, surface: Surface = .other, symbol: String = "sparkles") {
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
        let appPlace = target?.app.flatMap { $0.isEmpty ? nil : "no \($0)" }

        self.init(verb: call.displayName, url: url, app: target?.app, bundleID: target?.bundleID, surface: surface, symbol: call.symbol)

        switch name {
        case "browser_open", "computer_open", "desktop_open":
            if let url {
                verb = "Abrir"
                object = SiteName.bareHost(url.host() ?? url.absoluteString)
                symbol = "safari"
            } else if let app = input["app"]?.stringValue {
                verb = "Abrir"
                object = app == "terminal" ? "o terminal" : app == "browser" ? "o navegador" : app
                self.app = app == "terminal" || app == "browser" ? nil : app
                symbol = "macwindow"
            } else if let path = input["path"]?.stringValue {
                verb = "Abrir"
                object = (path as NSString).lastPathComponent
                symbol = "doc"
            }
        case "browser_snapshot":
            verb = "Ler a página"
            place = sitePlace
            symbol = "doc.text.magnifyingglass"
        case "browser_screenshot":
            verb = "Ver a página"
            place = sitePlace
            symbol = "camera"
        case "browser_click", "desktop_click", "computer_click":
            verb = "Clicar em"
            object = element ?? roleNoun ?? (surface == .browser ? "um elemento" : "um ponto da tela")
            place = surface == .browser ? sitePlace : appPlace
            symbol = "cursorarrow.click"
        case "browser_fill":
            verb = "Preencher"
            object = element ?? roleNoun ?? "um campo"
            if let value = input["text"]?.stringValue, !value.isEmpty {
                extra = "com “\(Self.clip(value, 40))”"
            }
            place = sitePlace
            symbol = "character.cursor.ibeam"
        case "desktop_type", "computer_type":
            verb = "Digitar"
            object = input["text"]?.stringValue.map { "“\(Self.clip($0, 48))”" }
            place = appPlace
            symbol = "keyboard"
        case "desktop_key", "computer_key":
            verb = "Apertar"
            object = input["combo"]?.stringValue.map(Self.prettyCombo)
            place = appPlace
            symbol = "command"
        case "desktop_scroll", "computer_scroll":
            verb = input["direction"]?.stringValue == "up" ? "Rolar para cima" : "Rolar a tela"
            place = appPlace
            symbol = "arrow.up.and.down"
        case "desktop_screenshot", "computer_screenshot":
            verb = "Olhar a tela"
            place = surface == .desktop ? "do computador" : "do Mac"
            symbol = "camera.viewfinder"
        case "computer_ui_tree":
            verb = "Ler a tela"
            place = input["app"]?.stringValue.map { "do \($0)" }
            symbol = "text.viewfinder"
        case "computer_apps":
            verb = "Ver os apps abertos"
            symbol = "square.grid.2x2"
        case "computer_windows":
            verb = "Ver as janelas abertas"
            symbol = "macwindow.on.rectangle"
        case "computer_applescript":
            verb = "Rodar uma automação no Mac"
            symbol = "applescript"
        case "shell_run":
            verb = "Rodar um comando"
            object = input["cmd"]?.stringValue.map { Self.clip($0, 48) }
            symbol = "terminal"
        case "files_list", "files_read", "files_write", "files_move", "files_rename", "files_mkdir", "files_trash":
            let verbs = ["files_list": "Ver a pasta", "files_read": "Ler", "files_write": "Salvar", "files_move": "Mover", "files_rename": "Renomear", "files_mkdir": "Criar a pasta", "files_trash": "Mandar para a Lixeira"]
            verb = verbs[name] ?? "Mexer em"
            let path = input["path"]?.stringValue ?? input["from"]?.stringValue
            object = path.map { ($0 as NSString).lastPathComponent }
            if name == "files_trash", let count = input["paths"]?.arrayValue?.count {
                object = count == 1 ? "1 item" : "\(count) itens"
            }
            symbol = "folder"
        case "record_start":
            verb = "Gravar a tela"
            symbol = "record.circle"
        case "record_stop":
            verb = "Parar a gravação"
            symbol = "stop.circle"
        case "prod_query":
            verb = "Consultar o banco de dados"
            symbol = "cylinder.split.1x2"
        default:
            if call.isDelegation {
                verb = "Pedir ajuda a"
                object = call.label?.replacingOccurrences(of: "Delegar para ", with: "") ?? call.name
                symbol = "person.2.fill"
            } else if surface == .connector {
                let tool = call.connectorTool ?? call.name
                verb = call.label.map(Self.stripPrompt) ?? Self.humanizeIdentifier(tool)
                place = call.connectorName.map { "no \(ConnectorNames.pretty($0))" }
            } else if call.name == "Bash", call.label?.hasPrefix("Rodar ") ?? true, let human = CommandPhrase.describe(input["command"]?.stringValue ?? "") {
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
        if value.hasPrefix("Posso ") {
            value = String(value.dropFirst("Posso ".count))
        }
        if value.hasSuffix("?") {
            value = String(value.dropLast())
        }
        return value.prefix(1).uppercased() + value.dropFirst()
    }

    static func quoted(in label: String?) -> String? {
        guard let label, let start = label.firstIndex(of: "“"), let end = label[label.index(after: start)...].firstIndex(of: "”") else { return nil }
        let value = String(label[label.index(after: start)..<end]).trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }

    static func roleNoun(_ role: String) -> String? {
        let key = role.lowercased().replacingOccurrences(of: "ax", with: "", options: .anchored)
        switch key {
        case "button", "popupbutton", "menubutton": return "um botão"
        case "link": return "um link"
        case "textbox", "searchbox", "textfield", "textarea", "combobox", "securetextfield": return "um campo"
        case "checkbox": return "uma caixa de seleção"
        case "radio", "radiobutton": return "uma opção"
        case "menuitem", "menubaritem": return "um item do menu"
        case "tab", "tabgroup": return "uma aba"
        case "image": return "uma imagem"
        case "row", "cell": return "um item da lista"
        case "desktop": return "um ponto da tela"
        default: return nil
        }
    }

    static func prettyCombo(_ combo: String) -> String {
        let symbols = ["cmd": "⌘", "command": "⌘", "super": "⌘", "ctrl": "⌃", "control": "⌃", "alt": "⌥", "option": "⌥", "shift": "⇧", "return": "↩", "enter": "↩", "tab": "⇥", "escape": "Esc", "esc": "Esc", "left": "←", "right": "→", "up": "↑", "down": "↓", "backspace": "⌫", "delete": "⌫", "space": "Espaço"]
        return combo.split(separator: "+").map { part in
            let key = part.trimmingCharacters(in: .whitespaces)
            return symbols[key.lowercased()] ?? key.uppercased()
        }
        .joined()
    }

    static func humanizeIdentifier(_ value: String) -> String {
        let spaced = value
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
        known[bareHost(host).lowercased()]
    }

    static func friendly(_ host: String) -> String {
        knownName(host) ?? bareHost(host)
    }

    static func placePhrase(_ host: String) -> String {
        if let name = knownName(host) {
            return "no \(name)"
        }
        return "em \(bareHost(host))"
    }
}
