import Foundation
import OSLog

enum BlocksLog {
    static let logger = Logger(subsystem: "runelay.bots", category: "blocks")

    static func failure(_ what: String, _ error: any Error) {
        logger.error("\(what, privacy: .public) failed: \(String(describing: error), privacy: .public)")
    }
}

enum BlocksError: LocalizedError {
    case stale(Int)
    case needsAuth(String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .stale: "Mudou enquanto você editava."
        case .needsAuth: "Essa conta precisa ser ligada de novo na runelay."
        case .message(let text): text
        }
    }
}

struct DownloadedFile: Sendable {
    let data: Data
    let fileName: String
}

protocol BlocksClient: Sendable {
    var isFixture: Bool { get }

    func notes(botID: String, folder: String?, query: String?, cursor: String?, limit: Int) async throws -> BlockPage<NoteSummary>
    func noteTree(botID: String, folder: String) async throws -> NoteTreeLevel
    func searchNotes(botID: String, query: String, titlesOnly: Bool, cursor: String?, limit: Int) async throws -> BlockPage<NoteSearchHit>
    func note(botID: String, id: String) async throws -> Note
    func resolveNote(botID: String, title: String) async throws -> Note?
    func backlinks(botID: String, id: String, cursor: String?) async throws -> BlockPage<NoteBacklink>
    func createNote(botID: String, title: String, folder: String, content: String) async throws -> Note
    func writeNote(botID: String, id: String, content: String, title: String?, baseVersion: Int?) async throws -> Note
    func patchNote(botID: String, id: String, ops: [NotePatchOp], baseVersion: Int?) async throws -> Note

    func sheets(botID: String, query: String?, cursor: String?, limit: Int) async throws -> BlockPage<SheetSummary>
    func createSheet(botID: String, title: String) async throws -> Sheet
    func sheet(botID: String, id: String) async throws -> Sheet
    func sheetRange(botID: String, sheetID: String, tabID: String, range: String) async throws -> SheetRangeResult
    func writeCells(botID: String, sheetID: String, tabID: String, cells: [(address: String, input: String)], baseVersion: Int?) async throws -> SheetWriteResult
    func formatCells(botID: String, sheetID: String, tabID: String, ranges: [String], format: CellFormat?) async throws -> SheetWriteResult
    func updateTab(botID: String, sheetID: String, tabID: String, patch: SheetTabPatch) async throws -> SheetTab
    func addTab(botID: String, sheetID: String, name: String) async throws -> SheetTab

    func agendaAccounts(botID: String) async throws -> [AgendaAccount]
    func agendaEvents(botID: String, start: Date, end: Date, accounts: [String]?) async throws -> AgendaList
    func createEvent(botID: String, draft: AgendaEventDraft) async throws -> AgendaEvent
    func deleteEvent(botID: String, id: String) async throws

    func createExport(botID: String, kind: BlockKind, id: String, format: ExportFormat, tabID: String?) async throws -> ExportJob
    func exportJob(botID: String, id: String) async throws -> ExportJob
    func download(botID: String, job: ExportJob) async throws -> DownloadedFile
}

struct RemoteBlocksClient: BlocksClient {
    let client: BotsClient

    var isFixture: Bool { false }

    func notes(botID: String, folder: String?, query: String?, cursor: String?, limit: Int) async throws -> BlockPage<NoteSummary> {
        try await get("/bots/\(botID)/notes", query: ["folder": folder, "q": query, "cursor": cursor, "limit": String(limit)])
    }

    func noteTree(botID: String, folder: String) async throws -> NoteTreeLevel {
        try await get("/bots/\(botID)/notes/tree", query: ["folder": folder])
    }

    func searchNotes(botID: String, query: String, titlesOnly: Bool, cursor: String?, limit: Int) async throws -> BlockPage<NoteSearchHit> {
        try await get("/bots/\(botID)/notes/search", query: ["q": query, "mode": titlesOnly ? "title" : "full", "cursor": cursor, "limit": String(limit)])
    }

    func note(botID: String, id: String) async throws -> Note {
        try await get("/bots/\(botID)/notes/\(Self.escape(id))")
    }

    func resolveNote(botID: String, title: String) async throws -> Note? {
        do {
            let note: Note = try await get("/bots/\(botID)/notes/resolve", query: ["title": title])
            return note
        } catch BotsClient.ClientError.http(404, _) {
            return nil
        }
    }

    func backlinks(botID: String, id: String, cursor: String?) async throws -> BlockPage<NoteBacklink> {
        try await get("/bots/\(botID)/notes/\(Self.escape(id))/backlinks", query: ["cursor": cursor])
    }

    func createNote(botID: String, title: String, folder: String, content: String) async throws -> Note {
        try await send("POST", "/bots/\(botID)/notes", body: .object(["title": .string(title), "folder": .string(folder), "content": .string(content)]))
    }

    func writeNote(botID: String, id: String, content: String, title: String?, baseVersion: Int?) async throws -> Note {
        var body: [String: JSONValue] = ["content": .string(content)]
        if let title { body["title"] = .string(title) }
        if let baseVersion { body["baseVersion"] = .number(Double(baseVersion)) }
        return try await send("PUT", "/bots/\(botID)/notes/\(Self.escape(id))", body: .object(body))
    }

    func patchNote(botID: String, id: String, ops: [NotePatchOp], baseVersion: Int?) async throws -> Note {
        var body: [String: JSONValue] = ["ops": .array(ops.map(\.json))]
        if let baseVersion { body["baseVersion"] = .number(Double(baseVersion)) }
        return try await send("PATCH", "/bots/\(botID)/notes/\(Self.escape(id))", body: .object(body))
    }

    func sheets(botID: String, query: String?, cursor: String?, limit: Int) async throws -> BlockPage<SheetSummary> {
        try await get("/bots/\(botID)/sheets", query: ["q": query, "cursor": cursor, "limit": String(limit)])
    }

    func createSheet(botID: String, title: String) async throws -> Sheet {
        try await send("POST", "/bots/\(botID)/sheets", body: .object(["title": .string(title)]))
    }

    func sheet(botID: String, id: String) async throws -> Sheet {
        try await get("/bots/\(botID)/sheets/\(Self.escape(id))")
    }

    func sheetRange(botID: String, sheetID: String, tabID: String, range: String) async throws -> SheetRangeResult {
        try await get("/bots/\(botID)/sheets/\(Self.escape(sheetID))/tabs/\(Self.escape(tabID))/range", query: ["range": range])
    }

    func writeCells(botID: String, sheetID: String, tabID: String, cells: [(address: String, input: String)], baseVersion: Int?) async throws -> SheetWriteResult {
        var body: [String: JSONValue] = [
            "cells": .array(cells.map { .object(["a": .string($0.address), "input": .string($0.input)]) })
        ]
        if let baseVersion { body["baseVersion"] = .number(Double(baseVersion)) }
        return try await send("POST", "/bots/\(botID)/sheets/\(Self.escape(sheetID))/tabs/\(Self.escape(tabID))/cells", body: .object(body))
    }

    func formatCells(botID: String, sheetID: String, tabID: String, ranges: [String], format: CellFormat?) async throws -> SheetWriteResult {
        let formatValue: JSONValue = format.flatMap { try? JSONEncoder().encode($0) }.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
        return try await send(
            "POST",
            "/bots/\(botID)/sheets/\(Self.escape(sheetID))/tabs/\(Self.escape(tabID))/format",
            body: .object(["ranges": .array(ranges.map(JSONValue.string)), "format": formatValue])
        )
    }

    func updateTab(botID: String, sheetID: String, tabID: String, patch: SheetTabPatch) async throws -> SheetTab {
        var body: [String: JSONValue] = [:]
        if let name = patch.name { body["name"] = .string(name) }
        if let rows = patch.frozenRows { body["frozenRows"] = .number(Double(rows)) }
        if let cols = patch.frozenCols { body["frozenCols"] = .number(Double(cols)) }
        if let widths = patch.colWidths { body["colWidths"] = .object(widths.mapValues { .number($0) }) }
        return try await send("PATCH", "/bots/\(botID)/sheets/\(Self.escape(sheetID))/tabs/\(Self.escape(tabID))", body: .object(body))
    }

    func addTab(botID: String, sheetID: String, name: String) async throws -> SheetTab {
        try await send("POST", "/bots/\(botID)/sheets/\(Self.escape(sheetID))/tabs", body: .object(["name": .string(name)]))
    }

    func agendaAccounts(botID: String) async throws -> [AgendaAccount] {
        try await get("/bots/\(botID)/agenda/accounts")
    }

    func agendaEvents(botID: String, start: Date, end: Date, accounts: [String]?) async throws -> AgendaList {
        try await get(
            "/bots/\(botID)/agenda/events",
            query: [
                "start": BlockDates.string(start),
                "end": BlockDates.string(end),
                "accounts": accounts?.joined(separator: ","),
            ])
    }

    func createEvent(botID: String, draft: AgendaEventDraft) async throws -> AgendaEvent {
        var body: [String: JSONValue] = [
            "accountId": .string(draft.accountId),
            "title": .string(draft.title),
            "start": .string(draft.allDay ? BlockDates.dayString(draft.start) : BlockDates.string(draft.start)),
            "end": .string(draft.allDay ? BlockDates.dayString(draft.end) : BlockDates.string(draft.end)),
            "allDay": .bool(draft.allDay),
            "meet": .bool(draft.meet),
        ]
        if let location = draft.location { body["location"] = .string(location) }
        if let description = draft.description { body["description"] = .string(description) }
        return try await send("POST", "/bots/\(botID)/agenda/events", body: .object(body))
    }

    func deleteEvent(botID: String, id: String) async throws {
        let _: JSONValue = try await send("DELETE", "/bots/\(botID)/agenda/events/\(Self.escape(id))", body: nil)
    }

    func createExport(botID: String, kind: BlockKind, id: String, format: ExportFormat, tabID: String?) async throws -> ExportJob {
        var body: [String: JSONValue] = ["kind": .string(kind.rawValue), "id": .string(id), "format": .string(format.rawValue)]
        if let tabID { body["tabId"] = .string(tabID) }
        return try await send("POST", "/bots/\(botID)/exports", body: .object(body))
    }

    func exportJob(botID: String, id: String) async throws -> ExportJob {
        try await get("/bots/\(botID)/exports/\(Self.escape(id))")
    }

    func download(botID: String, job: ExportJob) async throws -> DownloadedFile {
        guard let path = job.url else { throw BlocksError.message("O arquivo ainda não está pronto.") }
        var request = try client.request(path: path)
        request.timeoutInterval = 120
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            BlocksLog.failure("download \(path)", error)
            throw BlocksError.message("Não consegui baixar o arquivo.")
        }
        AuthStore.reportUnauthorized(response)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            BlocksLog.logger.error("download \(path, privacy: .public) returned HTTP \(status)")
            throw BlocksError.message("Não consegui baixar o arquivo.")
        }
        return DownloadedFile(data: data, fileName: job.fileName)
    }

    private func get<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }.sorted { $0.name < $1.name }
        let request = try client.request(path: path, query: items)
        return try await perform(request)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: JSONValue?) async throws -> T {
        var request = try client.request(path: path)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return try await perform(request)
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let label = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            BlocksLog.failure(label, error)
            throw BlocksError.message("Não consegui falar com o servidor.")
        }
        AuthStore.reportUnauthorized(response)
        guard let http = response as? HTTPURLResponse else { throw BotsClient.ClientError.invalidResponse }
        if http.statusCode == 409, let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            if value["code"]?.stringValue == "stale" {
                throw BlocksError.stale(value["version"]?.intValue ?? 0)
            }
            if value["code"]?.stringValue == "needs_auth" {
                throw BlocksError.needsAuth(value["accountId"]?.stringValue ?? "")
            }
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue
            BlocksLog.logger.error("\(label, privacy: .public) returned HTTP \(http.statusCode)")
            throw BotsClient.ClientError.http(http.statusCode, message)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            BlocksLog.failure("decode \(T.self) from \(label)", error)
            throw BlocksError.message("Não consegui ler a resposta do servidor.")
        }
    }

    private static func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? component
    }
}
