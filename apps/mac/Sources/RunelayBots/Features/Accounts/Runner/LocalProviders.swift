import Foundation

typealias ProviderEmit = @Sendable (JSONValue) -> Void

struct LocalTurn: Sendable {
    let turnId: String
    let provider: String
    let model: String
    let effort: String?
    let systemPrompt: String
    let prompt: String
    let resume: String?
    let mcpURL: String?
    let mcpToken: String?
    let workKey: String

    init?(_ value: JSONValue) {
        guard let turnId = value["turnId"]?.stringValue,
            let provider = value["provider"]?.stringValue,
            let model = value["model"]?.stringValue,
            let systemPrompt = value["systemPrompt"]?.stringValue,
            let prompt = value["prompt"]?.stringValue,
            let workKey = value["workKey"]?.stringValue
        else { return nil }
        self.turnId = turnId
        self.provider = provider
        self.model = model
        self.effort = value["effort"]?.stringValue
        self.systemPrompt = systemPrompt
        self.prompt = prompt
        self.resume = value["resume"]?.stringValue
        let rawURL = value["mcp"]?["url"]?.stringValue
        self.mcpURL = rawURL.flatMap { $0.hasPrefix("/") ? McpProxy.shared.url(for: $0) : $0 }
        self.mcpToken = value["mcp"]?["token"]?.stringValue
        self.workKey = workKey
    }

    var hasMcp: Bool { mcpURL != nil && mcpToken != nil }

    var withInstructions: String {
        if resume != nil { return prompt }
        return "<instructions>\n\(systemPrompt)\n</instructions>\n\n\(prompt)"
    }
}

final class TurnHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var process: CLIProcess?
    private var stopped = false

    var cancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    func newProcess() -> CLIProcess {
        let process = CLIProcess()
        lock.lock()
        self.process = process
        let stop = stopped
        lock.unlock()
        if stop {
            process.terminate()
        }
        return process
    }

    func cancel() {
        lock.lock()
        stopped = true
        let process = self.process
        lock.unlock()
        process?.terminate()
    }
}

private final class StreamState: @unchecked Sendable {
    var partsByMessage: [String: [String]] = [:]
    var partByIndex: [String: String] = [:]
    var currentMessage = ""
    var contextTokens: Double?
    var result: [String: JSONValue]?
    var failure: String?
    var finished = false
    var index = 0
    var buffer = ""
}

enum LocalProviders {
    static let claudeModels: JSONValue = .array([
        model("claude-sonnet-5-5", "Sonnet 5.5"),
        model("claude-opus-5-5", "Opus 5.5"),
        model("claude-haiku-5-5", "Haiku 5.5"),
        model("claude-fable-5-2", "Fable 5.2"),
    ])
    static let providers = ["claude", "codex", "grok", "cursor"]
    static let binaries: [String: [String]] = [
        "claude": ["claude"],
        "codex": ["codex"],
        "grok": ["grok"],
        "cursor": ["cursor-agent", "agent"],
    ]
    static let codexDisabled = [
        "shell_tool", "unified_exec", "apps", "plugins", "browser_use", "browser_use_external", "computer_use",
        "in_app_browser", "image_generation", "multi_agent", "view_image", "tool_suggest", "skill_search", "sleep_tool",
    ]
    static let grokRemovedTools = [
        "run_terminal_cmd", "read_file", "grep", "list_dir", "search_replace", "write", "web_search", "web_fetch", "todo_write", "task", "Agent",
    ]

    static var dataDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "runelay-bots/runner/data", directoryHint: .isDirectory)
    }

    static func model(_ id: String, _ label: String) -> JSONValue {
        .object(["id": .string(id), "label": .string(label)])
    }

    static func done(_ ok: Bool, _ message: String? = nil) -> JSONValue {
        var object: [String: JSONValue] = ["type": .string("done"), "ok": .bool(ok)]
        if let message { object["message"] = .string(message) }
        return .object(object)
    }

    static func text(_ part: String, _ text: String, delta: Bool = false) -> JSONValue {
        .object(["type": .string(delta ? "text.delta" : "text"), "part": .string(part), "text": .string(text)])
    }

    static func session(_ id: String) -> JSONValue {
        .object(["type": .string("session"), "id": .string(id)])
    }

    static func usage(input: Double, output: Double, cacheRead: Double, cacheWrite: Double, context: Double?) -> JSONValue {
        .object([
            "type": .string("usage"),
            "usage": .object([
                "inputTokens": .number(input),
                "outputTokens": .number(output),
                "cacheReadTokens": .number(cacheRead),
                "cacheWriteTokens": .number(cacheWrite),
            ]),
            "contextTokens": context.map(JSONValue.number) ?? .null,
        ])
    }

    static func tail(_ stderr: String, fallback: String) -> String {
        let lines = stderr.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").suffix(3).joined(separator: " ")
        return lines.isEmpty ? fallback : lines
    }

    static func number(_ source: [String: JSONValue]?, _ keys: String...) -> Double {
        guard let source else { return 0 }
        for key in keys {
            if let value = source[key]?.doubleValue { return value }
        }
        return 0
    }

    static func readUsage(_ raw: JSONValue?) -> JSONValue? {
        guard let source = raw?.objectValue else { return nil }
        let input = number(source, "inputTokens", "input_tokens", "prompt_tokens")
        let output = number(source, "outputTokens", "output_tokens", "completion_tokens")
        let cacheRead = number(source, "cacheReadTokens", "cache_read_input_tokens", "cached_input_tokens", "cacheReadInputTokens")
        let cacheWrite = number(source, "cacheWriteTokens", "cache_creation_input_tokens", "cacheCreationInputTokens")
        guard input + output + cacheRead + cacheWrite > 0 else { return nil }
        return usage(input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite, context: nil)
    }

    static func toml(_ value: String) -> String {
        let data = (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    static func jsonString(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return String(decoding: (try? encoder.encode(value)) ?? Data("{}".utf8), as: UTF8.self)
    }

    static func writePrivate(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path(percentEncoded: false))
    }

    static func workDirectory(for key: String) throws -> URL {
        let safe = key.replacingOccurrences(of: "[^A-Za-z0-9_/-]", with: "_", options: .regularExpression)
        let url = dataDirectory.appending(path: "work").appending(path: safe, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func runTurn(_ turn: LocalTurn, handle: TurnHandle, emit: @escaping ProviderEmit) async {
        do {
            let workDir = try workDirectory(for: turn.workKey)
            switch turn.provider {
            case "claude": await runClaude(turn, workDir: workDir, handle: handle, emit: emit)
            case "codex": await runCodex(turn, workDir: workDir, handle: handle, emit: emit)
            case "cursor": try await runCursor(turn, workDir: workDir, handle: handle, emit: emit)
            default: try await runGrok(turn, workDir: workDir, handle: handle, emit: emit)
            }
        } catch {
            emit(done(false, handle.cancelled ? "cancelled" : error.localizedDescription))
        }
    }

    static func runClaude(_ turn: LocalTurn, workDir: URL, handle: TurnHandle, emit: @escaping ProviderEmit) async {
        guard let bin = LocalCLI.find(["claude"]) else { return emit(done(false, "Claude Code não está instalado.")) }
        var servers: [String: JSONValue] = [:]
        if let url = turn.mcpURL, let token = turn.mcpToken {
            servers["bots"] = .object([
                "type": .string("http"),
                "url": .string(url),
                "headers": .object(["Authorization": .string("Bearer \(token)")]),
            ])
        }
        let configURL = workDir.appending(path: ".mcp-bots.json")
        do {
            try writePrivate(jsonString(.object(["mcpServers": .object(servers)])), to: configURL)
        } catch {
            return emit(done(false, "Não deu para gravar a configuração MCP: \(error.localizedDescription)"))
        }
        var args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", turn.model]
        if let effort = turn.effort { args += ["--effort", effort] }
        args += [
            "--system-prompt", turn.systemPrompt,
            "--permission-mode", "dontAsk",
            "--setting-sources", "",
            "--settings", #"{"disableClaudeAiConnectors":true}"#,
            "--strict-mcp-config",
            "--mcp-config", configURL.path(percentEncoded: false),
        ]
        if let resume = turn.resume { args += ["--resume", resume] }
        if turn.hasMcp { args += ["--allowedTools", "mcp__bots"] }
        args += ["--tools", ""]
        let env = LocalCLI.environment(["CLAUDE_AGENT_SDK_CLIENT_APP": "runelay-bots/3.0.0", "MCP_TOOL_TIMEOUT": "900000"])
        let state = StreamState()
        let result = await handle.newProcess().run(bin: bin, args: args, cwd: workDir, environment: env, stdin: turn.prompt) { line in
            guard let message = JSONValue.parse(line)?.objectValue else { return }
            let type = message["type"]?.stringValue ?? ""
            if type == "system", message["subtype"]?.stringValue == "init", let id = message["session_id"]?.stringValue {
                emit(session(id))
                return
            }
            if type == "result" {
                state.result = message
                return
            }
            if type == "stream_event" {
                if let parent = message["parent_tool_use_id"], !parent.isNull { return }
                guard let event = message["event"]?.objectValue else { return }
                let eventType = event["type"]?.stringValue ?? ""
                let index = event["index"]?.intValue ?? 0
                if eventType == "message_start" {
                    state.currentMessage = event["message"]?["id"]?.stringValue ?? String(Date().timeIntervalSince1970)
                    if let usage = event["message"]?["usage"]?.objectValue {
                        state.contextTokens = number(usage, "input_tokens") + number(usage, "cache_read_input_tokens") + number(usage, "cache_creation_input_tokens")
                    }
                } else if eventType == "content_block_start", event["content_block"]?["type"]?.stringValue == "text" {
                    let part = "\(state.currentMessage):\(index)"
                    state.partByIndex[part] = part
                    state.partsByMessage[state.currentMessage, default: []].append(part)
                } else if eventType == "content_block_delta", event["delta"]?["type"]?.stringValue == "text_delta" {
                    if let part = state.partByIndex["\(state.currentMessage):\(index)"] {
                        emit(text(part, event["delta"]?["text"]?.stringValue ?? "", delta: true))
                    }
                }
                return
            }
            if type == "assistant" {
                if let parent = message["parent_tool_use_id"], !parent.isNull { return }
                let id = message["message"]?["id"]?.stringValue ?? state.currentMessage
                for block in message["message"]?["content"]?.arrayValue ?? [] where block["type"]?.stringValue == "text" {
                    var queue = state.partsByMessage[id] ?? []
                    let part = queue.isEmpty ? "\(id):\(UUID().uuidString.prefix(6))" : queue.removeFirst()
                    state.partsByMessage[id] = queue
                    emit(text(part, block["text"]?.stringValue ?? ""))
                }
            }
        }
        guard let final = state.result else {
            return emit(done(false, handle.cancelled ? "cancelled" : tail(result.stderr, fallback: "O modelo não respondeu.")))
        }
        if let usage = final["usage"]?.objectValue {
            emit(
                Self.usage(
                    input: number(usage, "input_tokens"),
                    output: number(usage, "output_tokens"),
                    cacheRead: number(usage, "cache_read_input_tokens"),
                    cacheWrite: number(usage, "cache_creation_input_tokens"),
                    context: state.contextTokens
                ))
        }
        if let id = final["session_id"]?.stringValue { emit(session(id)) }
        if handle.cancelled { return emit(done(false, "cancelled")) }
        if final["is_error"]?.boolValue == true {
            let errors = (final["errors"]?.arrayValue ?? []).compactMap(\.stringValue).joined(separator: " ")
            return emit(done(false, errors.isEmpty ? (final["result"]?.stringValue ?? "Falha no Claude.") : errors))
        }
        emit(done(true))
    }

    static func runCodex(_ turn: LocalTurn, workDir: URL, handle: TurnHandle, emit: @escaping ProviderEmit) async {
        guard let bin = LocalCLI.find(["codex"]) else { return emit(done(false, "Codex CLI não está instalado.")) }
        let cwd = workDir.path(percentEncoded: false)
        var options = [
            "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
            "-s", "read-only", "-C", cwd, "-m", turn.model,
            "-c", #"approval_policy="never""#,
            "-c", #"web_search="disabled""#,
            "-c", "project_doc_max_bytes=0",
            "-c", "developer_instructions=\(toml(turn.systemPrompt))",
        ]
        if let effort = turn.effort { options += ["-c", "model_reasoning_effort=\(toml(effort))"] }
        options += codexDisabled.flatMap { ["--disable", $0] }
        if let url = turn.mcpURL, turn.mcpToken != nil {
            options += [
                "-c", "mcp_servers.bots.url=\(toml(url))",
                "-c", #"mcp_servers.bots.bearer_token_env_var="RUNELAY_MCP_TOKEN""#,
                "-c", "mcp_servers.bots.tool_timeout_sec=900",
                "-c", #"mcp_servers.bots.default_tools_approval_mode="approve""#,
            ]
        }
        let args = ["exec"] + options + (turn.resume.map { ["resume", $0] } ?? []) + ["-"]
        let env = LocalCLI.environment(turn.mcpToken.map { ["RUNELAY_MCP_TOKEN": $0] } ?? [:])
        let state = StreamState()
        let result = await handle.newProcess().run(bin: bin, args: args, cwd: workDir, environment: env, stdin: turn.prompt) { line in
            guard let event = JSONValue.parse(line)?.objectValue else { return }
            let type = event["type"]?.stringValue ?? ""
            if type == "thread.started", let id = event["thread_id"]?.stringValue {
                emit(session(id))
            } else if type == "item.started" || type == "item.completed" {
                guard let item = event["item"]?.objectValue else { return }
                let itemType = item["type"]?.stringValue ?? ""
                let id = item["id"]?.stringValue ?? String(Date().timeIntervalSince1970)
                if type == "item.completed", itemType == "agent_message", let message = item["text"]?.stringValue, !message.isEmpty {
                    emit(text(id, message))
                }
                if itemType == "command_execution" {
                    let input: JSONValue = .object(["command": .string(item["command"]?.stringValue ?? "")])
                    if type == "item.started" {
                        emit(.object(["type": .string("tool"), "id": .string(id), "name": .string("Bash"), "phase": .string("start"), "input": input]))
                    } else {
                        let exitCode = item["exit_code"] ?? .null
                        let outputText = String((item["aggregated_output"]?.stringValue ?? "").suffix(4000))
                        emit(
                            .object([
                                "type": .string("tool"), "id": .string(id), "name": .string("Bash"), "phase": .string("end"), "input": input,
                                "output": .object(["output": .string(outputText), "exitCode": exitCode]),
                                "ok": .bool((exitCode.doubleValue ?? 0) == 0),
                            ]))
                    }
                } else if itemType == "file_change", type == "item.completed" {
                    let files = (item["changes"]?.arrayValue ?? []).map { JSONValue.string($0["path"]?.stringValue ?? "") }
                    let input: JSONValue = .object(["files": .array(files)])
                    let status = item["status"]?.stringValue ?? "completed"
                    emit(.object(["type": .string("tool"), "id": .string(id), "name": .string("Edit"), "phase": .string("start"), "input": input]))
                    emit(
                        .object([
                            "type": .string("tool"), "id": .string(id), "name": .string("Edit"), "phase": .string("end"), "input": input,
                            "output": .object(["status": .string(status)]), "ok": .bool(status != "failed"),
                        ]))
                }
            } else if type == "turn.completed" {
                state.finished = true
                let usage = event["usage"]?.objectValue
                let cached = number(usage, "cached_input_tokens")
                emit(Self.usage(input: max(0, number(usage, "input_tokens") - cached), output: number(usage, "output_tokens"), cacheRead: cached, cacheWrite: 0, context: nil))
            } else if type == "turn.failed" {
                state.failure = event["error"]?["message"]?.stringValue ?? "Falha no Codex."
            } else if type == "error" {
                state.failure = event["message"]?.stringValue ?? "Falha no Codex."
            }
        }
        if handle.cancelled { return emit(done(false, "cancelled")) }
        if state.failure != nil || result.code != 0 || !state.finished {
            return emit(done(false, state.failure ?? tail(result.stderr, fallback: "Codex saiu com código \(result.code).")))
        }
        emit(done(true))
    }

    static func runCursor(_ turn: LocalTurn, workDir: URL, handle: TurnHandle, emit: @escaping ProviderEmit) async throws {
        guard let bin = LocalCLI.find(["cursor-agent", "agent"]) else { return emit(done(false, "cursor-agent não está instalado.")) }
        var servers: [String: JSONValue] = [:]
        if let url = turn.mcpURL, let token = turn.mcpToken {
            servers["bots"] = .object(["url": .string(url), "headers": .object(["Authorization": .string("Bearer \(token)")])])
        }
        try writePrivate(jsonString(.object(["mcpServers": .object(servers)])), to: workDir.appending(path: ".cursor/mcp.json"))
        var args = [
            "-p", "--output-format", "stream-json", "--trust", "--approve-mcps", "--sandbox", "enabled",
            "--workspace", workDir.path(percentEncoded: false), "--model", turn.model,
        ]
        if let resume = turn.resume { args += ["--resume", resume] }
        args.append(turn.withInstructions)
        let state = StreamState()
        let result = await handle.newProcess().run(bin: bin, args: args, cwd: workDir, environment: LocalCLI.environment(), stdin: nil) { line in
            guard let event = JSONValue.parse(line)?.objectValue else { return }
            let type = event["type"]?.stringValue ?? ""
            if let id = event["session_id"]?.stringValue, type == "system" || type == "result" { emit(session(id)) }
            if type == "assistant" {
                let content = event["message"]?["content"]?.arrayValue ?? []
                let message = content.filter { $0["type"]?.stringValue == "text" }.map { $0["text"]?.stringValue ?? "" }.joined()
                if !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    emit(text("cursor-\(state.index)", message))
                    state.index += 1
                }
            } else if type == "result" {
                state.finished = true
                if let usage = readUsage(event["usage"]) { emit(usage) }
                if event["is_error"]?.boolValue == true || event["subtype"]?.stringValue == "error" {
                    state.failure = event["result"]?.stringValue ?? event["error"]?.stringValue ?? "Falha no Cursor."
                }
            } else if type == "error" {
                state.failure = event["message"]?.stringValue ?? event["error"]?.stringValue ?? "Falha no Cursor."
            }
        }
        if handle.cancelled { return emit(done(false, "cancelled")) }
        if state.failure != nil || result.code != 0 || !state.finished {
            return emit(done(false, state.failure ?? tail(result.stderr, fallback: "cursor-agent saiu com código \(result.code).")))
        }
        emit(done(true))
    }

    static func grokText(_ event: [String: JSONValue]) -> String {
        for key in ["text", "delta", "content"] {
            if let value = event[key]?.stringValue { return value }
        }
        if let content = event["message"]?["content"] {
            if let value = content.stringValue { return value }
            if let blocks = content.arrayValue {
                return blocks.filter { $0["type"]?.stringValue == "text" }.map { $0["text"]?.stringValue ?? "" }.joined()
            }
        }
        return ""
    }

    static func runGrok(_ turn: LocalTurn, workDir: URL, handle: TurnHandle, emit: @escaping ProviderEmit) async throws {
        guard let bin = LocalCLI.find(["grok"]) else { return emit(done(false, "Grok CLI não está instalado.")) }
        var config = ""
        if let url = turn.mcpURL, let token = turn.mcpToken {
            config = "[mcp_servers.bots]\nurl = \(toml(url))\nheaders = { Authorization = \(toml("Bearer \(token)")) }\ntool_timeout_sec = 900\n"
        }
        try writePrivate(config, to: workDir.appending(path: ".grok/config.toml"))
        let sessionId = turn.resume ?? UUID().uuidString.lowercased()
        var args = [
            "-p", turn.prompt, "--output-format", "streaming-json", "--cwd", workDir.path(percentEncoded: false),
            "-m", turn.model, "--system-prompt-override", turn.systemPrompt,
            "--disallowed-tools", grokRemovedTools.joined(separator: ","),
            "--disable-web-search", "--no-subagents", "--always-approve",
        ]
        if let effort = turn.effort { args += ["--effort", effort] }
        args += turn.resume.map { ["--resume", $0] } ?? ["--session-id", sessionId]
        emit(session(sessionId))
        let state = StreamState()
        let flush: @Sendable () -> Void = {
            if !state.buffer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                emit(text("grok-\(state.index)", state.buffer))
            }
            state.buffer = ""
            state.index += 1
        }
        let result = await handle.newProcess().run(bin: bin, args: args, cwd: workDir, environment: LocalCLI.environment(), stdin: nil) { line in
            guard let event = JSONValue.parse(line)?.objectValue else { return }
            let type = event["type"]?.stringValue ?? ""
            let lowered = type.lowercased()
            if lowered.contains("delta"), !lowered.contains("thinking"), !lowered.contains("reasoning") {
                let chunk = grokText(event)
                if !chunk.isEmpty {
                    state.buffer += chunk
                    emit(text("grok-\(state.index)", chunk, delta: true))
                }
            } else if lowered.contains("tool") {
                flush()
            } else if type == "assistant" || type == "message" {
                let message = grokText(event)
                if !message.isEmpty, state.buffer.isEmpty {
                    emit(text("grok-\(state.index)", message))
                    state.index += 1
                } else {
                    flush()
                }
            } else if type == "result" || type == "done" || type == "end" {
                state.finished = true
                flush()
                if let usage = readUsage(event["usage"]) { emit(usage) }
                if event["is_error"]?.boolValue == true { state.failure = event["result"]?.stringValue ?? "Falha no Grok." }
            } else if type == "error" {
                state.failure = event["message"]?.stringValue ?? event["error"]?.stringValue ?? "Falha no Grok."
            }
        }
        flush()
        if handle.cancelled { return emit(done(false, "cancelled")) }
        if state.failure != nil || result.code != 0 {
            return emit(done(false, state.failure ?? tail(result.stderr, fallback: "grok saiu com código \(result.code).")))
        }
        if !state.finished {
            emit(.object(["type": .string("warning"), "message": .string("Grok terminou sem evento de resultado.")]))
        }
        emit(done(true))
    }

    static func probeAll() async -> JSONValue {
        let results = await withTaskGroup(of: (Int, JSONValue).self) { group in
            for (index, provider) in providers.enumerated() {
                group.addTask { (index, await probe(provider)) }
            }
            var collected: [(Int, JSONValue)] = []
            for await item in group {
                collected.append(item)
            }
            return collected.sorted { $0.0 < $1.0 }.map(\.1)
        }
        return .array(results)
    }

    static func account(_ provider: String, _ status: String, _ detail: String, _ models: JSONValue) -> JSONValue {
        .object(["provider": .string(provider), "status": .string(status), "detail": .string(detail), "models": models])
    }

    static func probe(_ provider: String) async -> JSONValue {
        guard let bin = LocalCLI.find(binaries[provider] ?? [provider]) else {
            return account(provider, "missing", "CLI não instalada nesta máquina.", .array([]))
        }
        switch provider {
        case "claude":
            let result = await LocalCLI.capture(bin, ["auth", "status"])
            if let status = JSONValue.parse(result.stdout), status["loggedIn"]?.boolValue == true {
                let detail = [status["email"]?.stringValue, status["subscriptionType"]?.stringValue].compactMap { $0 }.joined(separator: " · ")
                return account(provider, "ready", detail, claudeModels)
            }
            let detail = String(LocalCLI.clean(result.stderr.isEmpty ? result.stdout : result.stderr).prefix(200))
            return account(provider, "logged_out", detail.isEmpty ? "Sem login no Claude Code." : detail, claudeModels)
        case "codex":
            let status = await LocalCLI.capture(bin, ["login", "status"])
            let text = LocalCLI.clean("\(status.stdout)\n\(status.stderr)")
            var models: [JSONValue] = [model("gpt-5.6-sol", "GPT-5.6-Sol")]
            let catalog = await LocalCLI.capture(bin, ["debug", "models"])
            let listed = (JSONValue.parse(catalog.stdout)?["models"]?.arrayValue ?? [])
                .filter { $0["visibility"]?.stringValue == "list" }
                .compactMap { item -> JSONValue? in
                    guard let slug = item["slug"]?.stringValue else { return nil }
                    return model(slug, item["display_name"]?.stringValue ?? slug)
                }
            if !listed.isEmpty { models = listed }
            let ready = status.code == 0 && text.range(of: "logged in", options: .caseInsensitive) != nil
            return account(provider, ready ? "ready" : "logged_out", text.split(separator: "\n").first.map(String.init) ?? "", .array(models))
        case "cursor":
            let status = await LocalCLI.capture(bin, ["status"], timeout: .seconds(60))
            var text = LocalCLI.clean("\(status.stdout)\n\(status.stderr)")
            if text.isEmpty { text = "cursor-agent status não respondeu (código \(status.code))." }
            let ready = text.range(of: "logged in", options: .caseInsensitive) != nil && text.range(of: "not logged in", options: .caseInsensitive) == nil
            var models: [JSONValue] = [model("auto", "Auto")]
            if ready {
                let list = await LocalCLI.capture(bin, ["models"], timeout: .seconds(30))
                let parsed = matches(LocalCLI.clean(list.stdout), pattern: #"^([a-z0-9][\w.\-\[\]=,]*)\s+-\s+(.+)$"#).map { groups in
                    model(
                        groups[0],
                        groups[1].replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).replacingOccurrences(of: "\u{200B}", with: "").trimmingCharacters(in: .whitespaces))
                }
                if !parsed.isEmpty { models = parsed }
            }
            let detail = text.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init) ?? ""
            return account(provider, ready ? "ready" : "logged_out", detail, .array(models))
        default:
            let list = await LocalCLI.capture(bin, ["models"], timeout: .seconds(30))
            let text = LocalCLI.clean("\(list.stdout)\n\(list.stderr)")
            let models = matches(text, pattern: #"^\s*[*-]\s+([\w.\-]+)"#).map { model($0[0], $0[0]) }
            let loggedOut = text.range(of: "not authenticated|not logged in", options: [.regularExpression, .caseInsensitive]) != nil
            return account(
                provider,
                loggedOut ? "logged_out" : "ready",
                loggedOut ? "Grok sem login (rode grok login no Mac)." : "",
                .array(models.isEmpty ? [model("grok-4.6", "grok-4.6")] : models)
            )
        }
    }

    static func matches(_ text: String, pattern: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        return text.split(separator: "\n").compactMap { line in
            let line = String(line)
            let range = NSRange(line.startIndex..., in: line)
            guard let match = regex.firstMatch(in: line, range: range) else { return nil }
            return (1..<match.numberOfRanges).compactMap { index in
                Range(match.range(at: index), in: line).map { String(line[$0]) }
            }
        }
    }
}
