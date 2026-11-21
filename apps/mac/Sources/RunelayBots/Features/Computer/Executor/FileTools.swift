import AppKit

struct PathSandbox: Sendable {
    static var workspace: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "runelay-bots-workspace", directoryHint: .isDirectory)
    }

    let roots: [String]
    let labels: [String]

    init(allowedRoots: [String]) {
        var paths: [String] = []
        var labels: [String] = []
        for raw in allowedRoots + ["~/runelay-bots-workspace"] {
            guard let expanded = try? Self.expand(raw) else { continue }
            let resolved = URL(fileURLWithPath: expanded).resolvingSymlinksInPath().path(percentEncoded: false)
            let trimmed = resolved.count > 1 && resolved.hasSuffix("/") ? String(resolved.dropLast()) : resolved
            guard trimmed != "/", !paths.contains(trimmed) else { continue }
            paths.append(trimmed)
            labels.append(raw)
        }
        self.roots = paths
        self.labels = labels
    }

    static func expand(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ToolFailure.badArgs("Caminho vazio.") }
        guard !trimmed.split(separator: "/").contains("..") else {
            throw ToolFailure(403, code: "path_forbidden", "Caminho com \"..\" não é aceito.")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)
        let homeTrimmed = home.hasSuffix("/") ? String(home.dropLast()) : home
        if trimmed == "~" { return homeTrimmed }
        if trimmed.hasPrefix("~/") { return homeTrimmed + "/" + trimmed.dropFirst(2) }
        guard trimmed.hasPrefix("/") else {
            throw ToolFailure.badArgs("Use caminho absoluto ou começando com ~/ (recebi \"\(raw)\").")
        }
        return trimmed
    }

    func resolve(_ raw: String) throws -> URL {
        let expanded = try Self.expand(raw)
        let standardized = URL(fileURLWithPath: expanded).standardizedFileURL
        var existing = standardized
        var tail: [String] = []
        while !FileManager.default.fileExists(atPath: existing.path(percentEncoded: false)) {
            let parent = existing.deletingLastPathComponent()
            guard parent.path(percentEncoded: false) != existing.path(percentEncoded: false) else { break }
            tail.insert(existing.lastPathComponent, at: 0)
            existing = parent
        }
        var resolved = existing.resolvingSymlinksInPath()
        for component in tail {
            resolved.append(path: component)
        }
        let path = resolved.path(percentEncoded: false)
        guard roots.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) else {
            throw ToolFailure(403, code: "path_forbidden", "\(raw) está fora das pastas permitidas: \(labels.joined(separator: ", ")).")
        }
        return resolved
    }

    func isRoot(_ url: URL) -> Bool {
        roots.contains(url.path(percentEncoded: false))
    }
}

enum FileTools {
    static let listLimit = 500
    static let readLimit = 256 * 1024

    static func list(_ call: ExecutorCall) throws -> JSONValue {
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let url = try sandbox.resolve(call.requiredString("path"))
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false), isDirectory: &isDirectory) else {
            throw ToolFailure(404, code: "not_found", "\(call.string("path") ?? "") não existe.")
        }
        guard isDirectory.boolValue else { throw ToolFailure.badArgs("\(url.path(percentEncoded: false)) não é uma pasta.") }
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey, .isHiddenKey]
        let contents: [URL]
        do {
            contents = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys)
        } catch {
            throw permissionAware(error, path: url)
        }
        let formatter = ISO8601DateFormatter()
        let sorted = contents.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        let entries = sorted.prefix(listLimit).map { item -> JSONValue in
            let values = try? item.resourceValues(forKeys: Set(keys))
            var object: [String: JSONValue] = [
                "name": .string(item.lastPathComponent),
                "type": .string(values?.isSymbolicLink == true ? "link" : (values?.isDirectory == true ? "dir" : "file")),
            ]
            if let size = values?.fileSize, values?.isDirectory != true { object["size"] = .int(size) }
            if let modified = values?.contentModificationDate { object["modified"] = .string(formatter.string(from: modified)) }
            if values?.isHidden == true { object["hidden"] = .bool(true) }
            return .object(object)
        }
        return .object([
            "path": .string(url.path(percentEncoded: false)),
            "entries": .array(Array(entries)),
            "total": .int(contents.count),
            "truncated": .bool(contents.count > listLimit),
        ])
    }

    static func read(_ call: ExecutorCall) throws -> JSONValue {
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let url = try sandbox.resolve(call.requiredString("path"))
        let path = url.path(percentEncoded: false)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            throw ToolFailure(404, code: "not_found", "\(path) não existe.")
        }
        guard !isDirectory.boolValue else { throw ToolFailure.badArgs("\(path) é uma pasta. Use files_list.") }
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        guard size <= readLimit else {
            throw ToolFailure(413, code: "too_large", "O arquivo tem \(size / 1024) KB. Só leio arquivos de texto até \(readLimit / 1024) KB.")
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw permissionAware(error, path: url)
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw ToolFailure(415, code: "binary_file", "\(url.lastPathComponent) não é um arquivo de texto.")
        }
        return .object(["path": .string(path), "size": .int(data.count), "content": .string(text)])
    }

    static func move(_ call: ExecutorCall) throws -> JSONValue {
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let source = try sandbox.resolve(call.requiredString("from"))
        var destination = try sandbox.resolve(call.requiredString("to"))
        try requireExists(source)
        guard !sandbox.isRoot(source) else { throw ToolFailure(403, code: "path_forbidden", "Não movo uma pasta permitida inteira.") }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: destination.path(percentEncoded: false), isDirectory: &isDirectory), isDirectory.boolValue {
            destination.append(path: source.lastPathComponent)
        }
        guard !FileManager.default.fileExists(atPath: destination.path(percentEncoded: false)) else {
            throw ToolFailure(409, code: "already_exists", "Já existe \(destination.path(percentEncoded: false)).")
        }
        do {
            try FileManager.default.moveItem(at: source, to: destination)
        } catch {
            throw permissionAware(error, path: source)
        }
        return .object(["from": .string(source.path(percentEncoded: false)), "to": .string(destination.path(percentEncoded: false))])
    }

    static func rename(_ call: ExecutorCall) throws -> JSONValue {
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let source = try sandbox.resolve(call.requiredString("path"))
        let name = try call.requiredString("name")
        guard !name.contains("/"), name != ".", name != ".." else { throw ToolFailure.badArgs("O novo nome não pode ter \"/\" nem ser \"..\".") }
        try requireExists(source)
        guard !sandbox.isRoot(source) else { throw ToolFailure(403, code: "path_forbidden", "Não renomeio uma pasta permitida.") }
        let destination = source.deletingLastPathComponent().appending(path: name)
        guard !FileManager.default.fileExists(atPath: destination.path(percentEncoded: false)) else {
            throw ToolFailure(409, code: "already_exists", "Já existe \(name) nessa pasta.")
        }
        do {
            try FileManager.default.moveItem(at: source, to: destination)
        } catch {
            throw permissionAware(error, path: source)
        }
        return .object(["from": .string(source.path(percentEncoded: false)), "to": .string(destination.path(percentEncoded: false))])
    }

    static func mkdir(_ call: ExecutorCall) throws -> JSONValue {
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let url = try sandbox.resolve(call.requiredString("path"))
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        } catch {
            throw permissionAware(error, path: url)
        }
        return .object(["path": .string(url.path(percentEncoded: false))])
    }

    static func trash(_ call: ExecutorCall) throws -> JSONValue {
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let raw = call.strings("paths")
        guard !raw.isEmpty else { throw ToolFailure.badArgs("Falta a lista \"paths\".") }
        let urls = try raw.map { try sandbox.resolve($0) }
        for url in urls {
            try requireExists(url)
            guard !sandbox.isRoot(url) else { throw ToolFailure(403, code: "path_forbidden", "Não mando uma pasta permitida inteira para a Lixeira.") }
        }
        var trashed: [JSONValue] = []
        for url in urls {
            var resulting: NSURL?
            do {
                try FileManager.default.trashItem(at: url, resultingItemURL: &resulting)
            } catch {
                throw permissionAware(error, path: url)
            }
            trashed.append(
                .object([
                    "path": .string(url.path(percentEncoded: false)),
                    "trashPath": (resulting as URL?).map { .string($0.path(percentEncoded: false)) } ?? .null,
                ]))
        }
        return .object(["trashed": .array(trashed)])
    }

    static func write(_ call: ExecutorCall) throws -> JSONValue {
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let url = try sandbox.resolve(call.requiredString("path"))
        guard let content = call.rawString("content") else { throw ToolFailure.badArgs("Falta o campo \"content\".") }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path(percentEncoded: false), isDirectory: &isDirectory), isDirectory.boolValue {
            throw ToolFailure.badArgs("\(url.path(percentEncoded: false)) é uma pasta.")
        }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(content.utf8).write(to: url, options: .atomic)
        } catch {
            throw permissionAware(error, path: url)
        }
        return .object(["path": .string(url.path(percentEncoded: false)), "bytes": .int(content.utf8.count)])
    }

    private static func requireExists(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else {
            throw ToolFailure(404, code: "not_found", "\(url.path(percentEncoded: false)) não existe.")
        }
    }

    private static func permissionAware(_ error: Error, path: URL) -> ToolFailure {
        let nsError = error as NSError
        if nsError.domain == NSCocoaErrorDomain, [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(nsError.code) {
            return ToolFailure(
                403, code: "permission_denied", "O macOS não deixou o r/bots acessar \(path.path(percentEncoded: false)). Libere em Ajustes do Sistema → Privacidade e Segurança → Arquivos e Pastas.")
        }
        return ToolFailure(500, code: "file_error", nsError.localizedDescription)
    }
}

@MainActor
final class ShellRunner {
    private var running: [ObjectIdentifier: Process] = [:]
    let timeout: Duration = .seconds(150)
    let outputLimit = 100 * 1024

    func run(_ call: ExecutorCall) async throws -> JSONValue {
        let command = try call.requiredString("cmd")
        if command.range(of: #"(^|[\s;&|(])sudo\b"#, options: .regularExpression) != nil {
            throw ToolFailure(403, code: "forbidden", "Não rodo sudo.")
        }
        let sandbox = PathSandbox(allowedRoots: call.allowedRoots)
        let cwd = try sandbox.resolve(call.string("cwd") ?? "~/runelay-bots-workspace")
        if cwd.path(percentEncoded: false) == PathSandbox.workspace.resolvingSymlinksInPath().path(percentEncoded: false) {
            try? FileManager.default.createDirectory(at: cwd, withIntermediateDirectories: true)
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwd.path(percentEncoded: false), isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ToolFailure(404, code: "not_found", "A pasta \(cwd.path(percentEncoded: false)) não existe.")
        }
        let temp = FileManager.default.temporaryDirectory.appending(path: "runelay-shell-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        let stdoutURL = temp.appending(path: "stdout")
        let stderrURL = temp.appending(path: "stderr")
        FileManager.default.createFile(atPath: stdoutURL.path(percentEncoded: false), contents: nil)
        FileManager.default.createFile(atPath: stderrURL.path(percentEncoded: false), contents: nil)
        let stdout = try FileHandle(forWritingTo: stdoutURL)
        let stderr = try FileHandle(forWritingTo: stderrURL)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", command]
        process.currentDirectoryURL = cwd
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = stderr
        let started = Date()
        let waiter = ProcessWaiter()
        process.terminationHandler = { finished in
            waiter.finish(finished.terminationStatus)
        }
        do {
            try process.run()
        } catch {
            throw ToolFailure(500, code: "shell_failed", "Não deu para rodar o comando: \(error.localizedDescription)")
        }
        let id = ObjectIdentifier(process)
        running[id] = process
        let limit = timeout
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: limit)
            if self?.running[id] != nil, process.isRunning {
                process.terminate()
            }
        }
        let exitCode = await waiter.wait()
        running.removeValue(forKey: ObjectIdentifier(process))
        try? stdout.close()
        try? stderr.close()
        let elapsed = Date().timeIntervalSince(started)
        return .object([
            "exitCode": .int(Int(exitCode)),
            "stdout": .string(tail(of: stdoutURL)),
            "stderr": .string(tail(of: stderrURL)),
            "cwd": .string(cwd.path(percentEncoded: false)),
            "seconds": .number((elapsed * 10).rounded() / 10),
            "timedOut": .bool(process.terminationReason == .uncaughtSignal && elapsed >= 149),
        ])
    }

    func terminateAll() {
        for process in running.values where process.isRunning {
            process.terminate()
        }
    }

    private func tail(of url: URL) -> String {
        guard let data = try? Data(contentsOf: url) else { return "" }
        let slice = data.count > outputLimit ? data.suffix(outputLimit) : data
        let text = String(decoding: slice, as: UTF8.self)
        return data.count > outputLimit ? "…" + text : text
    }
}

private final class ProcessWaiter: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int32?
    private var continuation: CheckedContinuation<Int32, Never>?

    func finish(_ value: Int32) {
        lock.lock()
        if let continuation {
            self.continuation = nil
            lock.unlock()
            continuation.resume(returning: value)
            return
        }
        status = value
        lock.unlock()
    }

    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let status {
                lock.unlock()
                continuation.resume(returning: status)
                return
            }
            self.continuation = continuation
            lock.unlock()
        }
    }
}
