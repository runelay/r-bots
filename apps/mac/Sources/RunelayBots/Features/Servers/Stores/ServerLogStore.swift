import Foundation
import Observation
import SwiftUI

struct ServerLogLine: Identifiable, Equatable {
    let id: Int
    let plain: String
    let text: AttributedString
}

enum ANSIText {
    static func plain(_ raw: String) -> String {
        raw.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
    }

    static func attributed(_ raw: String) -> AttributedString {
        var result = AttributedString()
        var color: Color?
        var bold = false
        var dim = false
        var rest = Substring(raw)
        while let escape = rest.firstIndex(of: "\u{1B}") {
            append(rest[..<escape], to: &result, color: color, bold: bold, dim: dim)
            let after = rest[escape...].dropFirst()
            guard after.first == "[", let end = after.firstIndex(where: { $0.isLetter }) else {
                rest = after
                continue
            }
            let codes = after.dropFirst()[..<end].split(separator: ";").compactMap { Int($0) }
            if after[end] == "m" {
                for code in codes.isEmpty ? [0] : codes {
                    switch code {
                    case 0:
                        color = nil
                        bold = false
                        dim = false
                    case 1: bold = true
                    case 2: dim = true
                    case 22:
                        bold = false
                        dim = false
                    case 31, 91: color = Theme.danger
                    case 32, 92: color = Theme.success
                    case 33, 93: color = Theme.warning
                    case 34, 94, 36, 96: color = Theme.merged
                    case 35, 95: color = Theme.brandAccent
                    case 90, 37, 97: color = Theme.textTertiary
                    case 39: color = nil
                    default: break
                    }
                }
            }
            rest = after[after.index(after: end)...]
        }
        append(rest, to: &result, color: color, bold: bold, dim: dim)
        return result
    }

    private static func append(_ text: Substring, to result: inout AttributedString, color: Color?, bold: Bool, dim: Bool) {
        guard !text.isEmpty else { return }
        var piece = AttributedString(String(text))
        piece.foregroundColor = dim ? Theme.textTertiary : (color ?? Theme.textPrimary)
        if bold {
            piece.font = BrandFonts.mono(12, weight: .semibold)
        }
        result += piece
    }
}

@MainActor
@Observable
final class ServerLogStore {
    static let limit = 2000

    let serverID: String
    private(set) var lines: [ServerLogLine] = []
    private(set) var connected = false
    var query = ""

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var counter = 0

    init(serverID: String) {
        self.serverID = serverID
    }

    var filtered: [ServerLogLine] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return lines }
        return lines.filter { $0.plain.lowercased().contains(needle) }
    }

    var plainText: String {
        filtered.map(\.plain).joined(separator: "\n")
    }

    func start(client: BotsClient) {
        guard task == nil else { return }
        task = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let request = try client.serverLogStreamRequest(id: self.serverID)
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    AuthStore.reportUnauthorized(response)
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        self.connected = false
                        return
                    }
                    self.connected = true
                    delay = 1
                    for try await line in bytes.lines {
                        guard let data = line.data(using: .utf8), let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { continue }
                        self.apply(value)
                    }
                } catch {
                    self.connected = false
                }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 10)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        connected = false
    }

    private func apply(_ value: JSONValue) {
        switch value["type"]?.stringValue {
        case "snapshot":
            lines = []
            append(value["lines"]?.arrayValue?.compactMap(\.stringValue) ?? [])
            ServerStore.shared.applyLine(value)
        case "lines":
            append(value["lines"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        case "server":
            ServerStore.shared.applyLine(value)
        default:
            break
        }
    }

    private func append(_ raw: [String]) {
        guard !raw.isEmpty else { return }
        var next = lines
        for line in raw {
            counter += 1
            next.append(ServerLogLine(id: counter, plain: ANSIText.plain(line), text: ANSIText.attributed(line)))
        }
        if next.count > Self.limit {
            next.removeFirst(next.count - Self.limit)
        }
        lines = next
    }
}
