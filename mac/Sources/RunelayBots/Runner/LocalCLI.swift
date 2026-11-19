import Foundation

struct CLIResult: Sendable {
    let code: Int32
    let stdout: String
    let stderr: String
}

enum LocalCLI {
    static var home: String {
        FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)
    }

    static var searchPath: [String] {
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        let current = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return (extra + current).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func find(_ names: [String]) -> String? {
        for directory in searchPath {
            for name in names {
                let candidate = (directory as NSString).appendingPathComponent(name)
                if FileManager.default.isExecutableFile(atPath: candidate) {
                    return candidate
                }
            }
        }
        return nil
    }

    static func environment(_ extra: [String: String] = [:]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        for key in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY", "XAI_API_KEY"] {
            env.removeValue(forKey: key)
        }
        env["PATH"] = searchPath.joined(separator: ":")
        env["HOME"] = env["HOME"] ?? home
        if env["LANG"] == nil {
            env["LANG"] = "en_US.UTF-8"
        }
        return env.merging(extra) { _, new in new }
    }

    static func capture(_ bin: String, _ args: [String], timeout: Duration = .seconds(20)) async -> CLIResult {
        let process = CLIProcess()
        let lines = LineCollector()
        let timer = Task {
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            process.terminate()
        }
        let result = await process.run(bin: bin, args: args, cwd: URL(fileURLWithPath: home), environment: environment(), stdin: nil) { line in
            lines.append(line)
        }
        timer.cancel()
        return CLIResult(code: result.code, stdout: lines.text, stderr: result.stderr)
    }

    static func clean(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

final class LineCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func append(_ line: String) {
        lock.lock()
        lines.append(line)
        lock.unlock()
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return lines.joined(separator: "\n")
    }
}

final class CLIProcess: @unchecked Sendable {
    private let process = Process()
    private let lock = NSLock()
    private var terminateRequested = false
    private var stderrTail = Data()

    func terminate() {
        lock.lock()
        terminateRequested = true
        lock.unlock()
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [process] in
            if process.isRunning {
                kill(pid, SIGKILL)
            }
        }
    }

    func run(
        bin: String,
        args: [String],
        cwd: URL,
        environment: [String: String],
        stdin: String?,
        onLine: @escaping @Sendable (String) -> Void
    ) async -> (code: Int32, stderr: String) {
        process.executableURL = URL(fileURLWithPath: bin)
        process.arguments = args
        process.currentDirectoryURL = cwd
        process.environment = environment
        let output = Pipe()
        let errors = Pipe()
        let input = Pipe()
        process.standardOutput = output
        process.standardError = errors
        process.standardInput = input
        return await withCheckedContinuation { continuation in
            let group = DispatchGroup()
            group.enter()
            process.terminationHandler = { _ in group.leave() }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: (127, error.localizedDescription))
                return
            }
            lock.lock()
            let stopNow = terminateRequested
            lock.unlock()
            if stopNow {
                terminate()
            }
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                let handle = output.fileHandleForReading
                var buffer = Data()
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    buffer.append(chunk)
                    while let index = buffer.firstIndex(of: 0x0A) {
                        let line = String(decoding: buffer[buffer.startIndex..<index], as: UTF8.self)
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        buffer.removeSubrange(buffer.startIndex...index)
                        if !line.isEmpty {
                            onLine(line)
                        }
                    }
                }
                let rest = String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                if !rest.isEmpty {
                    onLine(rest)
                }
                group.leave()
            }
            group.enter()
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let handle = errors.fileHandleForReading
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    self?.appendStderr(chunk)
                }
                group.leave()
            }
            DispatchQueue.global(qos: .utility).async {
                let writer = input.fileHandleForWriting
                if let stdin, let data = stdin.data(using: .utf8), !data.isEmpty {
                    try? writer.write(contentsOf: data)
                }
                try? writer.close()
            }
            group.notify(queue: .global()) { [weak self, process] in
                let text = self?.stderrText ?? ""
                continuation.resume(returning: (process.terminationStatus, text))
            }
        }
    }

    private func appendStderr(_ chunk: Data) {
        lock.lock()
        stderrTail.append(chunk)
        if stderrTail.count > 20_000 {
            stderrTail = stderrTail.suffix(20_000)
        }
        lock.unlock()
    }

    private var stderrText: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: stderrTail, as: UTF8.self)
    }
}
