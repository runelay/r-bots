import Foundation

struct DevServerInfo: Identifiable, Equatable, Hashable, Sendable {
    enum Status: String, Sendable {
        case starting
        case running
        case exited
        case stopped

        var label: String {
            switch self {
            case .starting: tr("Subindo")
            case .running: tr("No ar")
            case .exited: tr("Caiu")
            case .stopped: tr("Parado")
            }
        }

        var isLive: Bool { self == .starting || self == .running }
    }

    let id: String
    let name: String
    let branch: String?
    let kind: String
    let command: String
    let tool: String
    let script: String?
    let profileId: String?
    let startedBy: String
    let botID: String?
    let sessionID: String?
    let envKeys: [String]
    let port: Int
    let previewPath: String?
    let status: Status
    let exitCode: Int?
    let startedAt: String?
    let cwd: String

    init?(_ value: JSONValue?) {
        guard let value, let id = value["id"]?.stringValue else { return nil }
        self.id = id
        name = value["name"]?.stringValue ?? value["workspaceId"]?.stringValue ?? "Projeto"
        branch = value["branch"]?.stringValue
        kind = value["kind"]?.stringValue ?? "workspace"
        command = value["command"]?.stringValue ?? ""
        tool = value["tool"]?.stringValue ?? "process"
        script = value["script"]?.stringValue
        profileId = value["profileId"]?.stringValue
        startedBy = value["startedBy"]?.stringValue ?? "bot"
        botID = value["botId"]?.stringValue
        sessionID = value["sessionId"]?.stringValue
        envKeys = value["envKeys"]?.arrayValue?.compactMap(\.stringValue) ?? []
        port = value["port"]?.intValue ?? 0
        previewPath = value["previewPath"]?.stringValue
        status = Status(rawValue: value["status"]?.stringValue ?? "") ?? .running
        exitCode = value["exitCode"]?.intValue
        startedAt = value["startedAt"]?.stringValue
        cwd = value["cwd"]?.stringValue ?? ""
    }

    var isMobile: Bool { tool == "expo" }

    var title: String {
        if let script, !script.isEmpty { return "\(name) · \(script)" }
        return name
    }

    var subtitle: String {
        var parts: [String] = []
        if let branch, !branch.isEmpty { parts.append(branch) }
        if !cwd.isEmpty { parts.append(cwd) }
        return parts.joined(separator: " · ")
    }

    var toolLabel: String { ServerTool.label(tool) }
}

enum ServerTool {
    static func symbol(_ tool: String) -> String {
        switch tool {
        case "vite": "bolt.fill"
        case "wrangler": "cloud.fill"
        case "expo": "iphone"
        case "next", "remix", "nuxt", "astro": "globe"
        case "storybook": "book.closed.fill"
        case "bun": "circle.hexagongrid.fill"
        case "python": "chevron.left.forwardslash.chevron.right"
        case "node", "deno": "hexagon.fill"
        default: "terminal.fill"
        }
    }

    static func label(_ tool: String) -> String {
        switch tool {
        case "vite": "Vite"
        case "wrangler": "Wrangler"
        case "expo": "Expo"
        case "next": "Next"
        case "remix": "Remix"
        case "nuxt": "Nuxt"
        case "astro": "Astro"
        case "storybook": "Storybook"
        case "bun": "Bun"
        case "deno": "Deno"
        case "python": "Python"
        case "rust": "Cargo"
        case "go": "Go"
        case "node": "Node"
        default: tr("Processo")
        }
    }
}

struct ServerProject: Identifiable, Equatable, Sendable {
    struct Worktree: Identifiable, Equatable, Sendable {
        let path: String
        let branch: String?
        let main: Bool
        var id: String { path }
    }

    let name: String
    let path: String
    let worktrees: [Worktree]
    var id: String { path }

    init?(_ value: JSONValue) {
        guard let name = value["name"]?.stringValue, let path = value["path"]?.stringValue else { return nil }
        self.name = name
        self.path = path
        worktrees =
            value["worktrees"]?.arrayValue?.compactMap { item in
                guard let path = item["path"]?.stringValue else { return nil }
                return Worktree(path: path, branch: item["branch"]?.stringValue, main: item["main"]?.boolValue ?? false)
            } ?? []
    }
}

struct ServerScript: Identifiable, Equatable, Sendable {
    let name: String
    let command: String
    let tool: String
    var id: String { name }
}

struct ProjectScripts: Equatable, Sendable {
    let manager: String
    let scripts: [ServerScript]
    let envFiles: [String]
    let envKeys: [String]
    let branch: String?

    init(_ value: JSONValue) {
        manager = value["manager"]?.stringValue ?? "npm"
        scripts =
            value["scripts"]?.arrayValue?.compactMap { item in
                guard let name = item["name"]?.stringValue else { return nil }
                return ServerScript(name: name, command: item["command"]?.stringValue ?? "", tool: item["tool"]?.stringValue ?? "process")
            } ?? []
        envFiles = value["envFiles"]?.arrayValue?.compactMap(\.stringValue) ?? []
        envKeys = value["envKeys"]?.arrayValue?.compactMap(\.stringValue) ?? []
        branch = value["branch"]?.stringValue
    }
}

struct RunProfile: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let path: String
    let cwd: String
    let script: String?
    let cmd: String?

    init?(_ value: JSONValue) {
        guard let id = value["id"]?.stringValue, let name = value["name"]?.stringValue else { return nil }
        self.id = id
        self.name = name
        path = value["path"]?.stringValue ?? ""
        cwd = value["cwd"]?.stringValue ?? ""
        script = value["script"]?.stringValue
        cmd = value["cmd"]?.stringValue
    }
}
