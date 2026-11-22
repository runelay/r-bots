import Foundation

enum RunnerFiles {
    private static let protectedPattern =
        #"(^|/)(\.ssh|\.gnupg|\.aws|\.claude|\.codex|\.config/gh|Library/Keychains|\.env[^/]*|\.git|\.runelay-signing|Library/Application Support/runelay bots/credentials\.bin)(/|$)"#

    static func read(path raw: String, maxBytes: Int) -> [String: JSONValue] {
        let expanded = (raw as NSString).expandingTildeInPath
        let url = URL(fileURLWithPath: expanded).standardizedFileURL.resolvingSymlinksInPath()
        let path = url.path(percentEncoded: false)
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.resolvingSymlinksInPath().path(percentEncoded: false)
        let base = home.hasSuffix("/") ? String(home.dropLast()) : home
        let roots = ["\(base)/Downloads", "\(base)/Desktop", "\(base)/Documents", "/tmp", "/private/tmp"]
        guard roots.contains(where: { path.hasPrefix($0 + "/") }) else {
            return failure(tr("%@ está fora de Downloads, Mesa, Documentos e /tmp no Mac.", path))
        }
        guard path.range(of: protectedPattern, options: .regularExpression) == nil else {
            return failure(tr("Esse arquivo é protegido."))
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            return failure(tr("Não achei %@ no Mac.", path))
        }
        guard !isDirectory.boolValue else { return failure(tr("%@ é uma pasta.", path)) }
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        guard size <= maxBytes else {
            return failure(tr("O arquivo tem %1$lld MB; o limite é %2$lld MB.", size / 1_048_576, maxBytes / 1_048_576))
        }
        guard let data = try? Data(contentsOf: url) else { return failure(tr("Não consegui ler %@ no Mac.", path)) }
        return [
            "ok": .bool(true),
            "result": .object([
                "path": .string(path),
                "name": .string(url.lastPathComponent),
                "size": .int(data.count),
                "base64": .string(data.base64EncodedString()),
            ]),
        ]
    }

    private static func failure(_ message: String) -> [String: JSONValue] {
        ["ok": .bool(false), "error": .string(message)]
    }
}
