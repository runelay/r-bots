import AppKit
import Foundation
import Observation

enum BlockRoute: Equatable {
    case files(botID: String)
    case note(botID: String, id: String)
    case sheet(botID: String, id: String)
    case agenda(botID: String)

    var botID: String {
        switch self {
        case .files(let botID), .note(let botID, _), .sheet(let botID, _), .agenda(let botID): botID
        }
    }

    var kind: String {
        switch self {
        case .files: BlockKind.filesKind
        case .note: BlockKind.note.rawValue
        case .sheet: BlockKind.sheet.rawValue
        case .agenda: BlockKind.agenda.rawValue
        }
    }

    var itemID: String {
        switch self {
        case .files: BlockKind.filesKind
        case .note(_, let id), .sheet(_, let id): id
        case .agenda: BlockKind.agendaID
        }
    }

    init?(ref: ArtifactRef) {
        switch ref.kind {
        case BlockKind.filesKind: self = .files(botID: ref.botID)
        case BlockKind.note.rawValue: self = .note(botID: ref.botID, id: ref.id)
        case BlockKind.sheet.rawValue: self = .sheet(botID: ref.botID, id: ref.id)
        case BlockKind.agenda.rawValue: self = .agenda(botID: ref.botID)
        default: return nil
        }
    }
}

@MainActor
@Observable
final class BlockCenter {
    static let shared = BlockCenter()

    private(set) var route: BlockRoute?
    private(set) var backStack: [BlockRoute] = []
    private(set) var latest: [String: Int] = [:]
    private(set) var previews: [String: BlockPreview] = [:]
    private(set) var titles: [String: String] = [:]
    private(set) var deleted: Set<String> = []
    private(set) var noteEditor: NoteEditorStore?
    private(set) var sheetEditor: SheetEditorStore?
    private(set) var agendaStore: AgendaStore?
    private(set) var filesStore: BlockFilesStore?
    private(set) var exporting = false
    private(set) var status: String?
    private(set) var listRevision = 0

    @ObservationIgnored private var botsClient: BotsClient?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var agendaFocus: (anchor: Date, mode: AgendaStore.Mode)?

    var client: any BlocksClient {
        if UserDefaults.standard.string(forKey: "blocksSource") != "fixture", let botsClient {
            return RemoteBlocksClient(client: botsClient)
        }
        return FixtureBlocksClient.shared
    }

    func previewKey(_ botID: String, _ id: String, version: Int) -> String {
        "\(botID)/\(id)#\(version)"
    }

    func preview(for ref: ArtifactRef) -> BlockPreview? {
        previews[previewKey(ref.botID, ref.id, version: ref.version)]
    }

    func isSuperseded(_ ref: ArtifactRef) -> Bool {
        (latest[key(ref.botID, ref.id)] ?? ref.version) > ref.version
    }

    func isDeleted(_ ref: ArtifactRef) -> Bool {
        deleted.contains(key(ref.botID, ref.id))
    }

    func currentTitle(_ ref: ArtifactRef) -> String {
        titles[key(ref.botID, ref.id)] ?? ref.title
    }

    func storePreview(_ preview: BlockPreview, for ref: ArtifactRef) {
        previews[previewKey(ref.botID, ref.id, version: ref.version)] = preview
    }

    func handle(_ event: BlockEvent, client botsClient: BotsClient) {
        self.botsClient = botsClient
        let itemKey = key(event.botID, event.id)
        if event.version >= (latest[itemKey] ?? 0) {
            latest[itemKey] = event.version
            titles[itemKey] = event.title
        }
        if let preview = event.preview {
            previews[previewKey(event.botID, event.id, version: event.version)] = preview
        }
        if event.action == "deleted" {
            deleted.insert(itemKey)
        } else {
            deleted.remove(itemKey)
        }
        listRevision += 1
        guard event.author == .bot else { return }
        switch event.kind {
        case .note:
            if let noteEditor, noteEditor.botID == event.botID, noteEditor.noteID == event.id {
                noteEditor.remoteChanged(version: event.version, change: event.change)
            }
        case .sheet:
            if let sheetEditor, sheetEditor.botID == event.botID, sheetEditor.sheetID == event.id {
                sheetEditor.remoteChanged(version: event.version, change: event.change)
            }
        case .agenda:
            if let agendaStore, agendaStore.botID == event.botID {
                agendaStore.remoteChanged(change: event.change)
            }
        }
    }

    func open(_ ref: ArtifactRef, client botsClient: BotsClient) {
        self.botsClient = botsClient
        guard let route = BlockRoute(ref: ref) else { return }
        backStack = []
        if case .agenda(let preview) = preview(for: ref) {
            agendaFocus = (BlockDates.parse(preview.start) ?? Date(), preview.view == "day" ? .day : .week)
        }
        show(route)
    }

    func navigate(to route: BlockRoute) {
        guard route != self.route else { return }
        if let current = self.route {
            backStack.append(current)
        }
        show(route)
        ArtifactCenter.shared.retitle(ArtifactRef(botID: route.botID, id: route.itemID, title: title(for: route), kind: route.kind, version: 1))
    }

    func goBack() {
        guard let previous = backStack.popLast() else { return }
        show(previous)
        ArtifactCenter.shared.retitle(ArtifactRef(botID: previous.botID, id: previous.itemID, title: title(for: previous), kind: previous.kind, version: 1))
    }

    func close() {
        noteEditor?.flush()
        sheetEditor?.flush()
        route = nil
        backStack = []
        noteEditor = nil
        sheetEditor = nil
        agendaStore = nil
        filesStore = nil
    }

    func forgetServer() {
        close()
        latest = [:]
        previews = [:]
        titles = [:]
        deleted = []
        status = nil
        listRevision += 1
    }

    func title(for route: BlockRoute) -> String {
        switch route {
        case .files: tr("Arquivos do bot")
        case .agenda: tr("Agenda")
        case .note(let botID, let id): titles[key(botID, id)] ?? noteEditor?.note?.title ?? tr("Nota")
        case .sheet(let botID, let id): titles[key(botID, id)] ?? sheetEditor?.sheet?.title ?? tr("Planilha")
        }
    }

    func noteTitleChanged(botID: String, id: String, title: String) {
        titles[key(botID, id)] = title
    }

    func export(format: ExportFormat) {
        guard let route, !exporting else { return }
        let client = client
        let kind: BlockKind
        let id: String
        var tabID: String?
        switch route {
        case .note(_, let noteID):
            kind = .note
            id = noteID
            noteEditor?.flush()
        case .sheet(_, let sheetID):
            kind = .sheet
            id = sheetID
            tabID = sheetEditor?.tabID
        default:
            return
        }
        exporting = true
        flash(tr("Preparando o arquivo…"), sticky: true)
        Task {
            defer { exporting = false }
            do {
                var job = try await client.createExport(botID: route.botID, kind: kind, id: id, format: format, tabID: tabID)
                var waited = 0
                while job.status == "pending", waited < 60 {
                    try await Task.sleep(for: .seconds(1))
                    waited += 1
                    job = try await client.exportJob(botID: route.botID, id: job.id)
                }
                guard job.status == "ready" else {
                    BlocksLog.logger.error("export \(job.id, privacy: .public) ended as \(job.status, privacy: .public)")
                    flash(tr("Não consegui gerar o arquivo"))
                    return
                }
                let file = try await client.download(botID: route.botID, job: job)
                let url = try DownloadsFolder.save(file.data, as: file.fileName)
                DownloadsFolder.reveal(url)
                flash(tr("Salvo em Downloads"))
            } catch {
                BlocksLog.failure("export \(format.rawValue)", error)
                flash(tr("Não consegui baixar o arquivo"))
            }
        }
    }

    func flash(_ text: String, sticky: Bool = false) {
        status = text
        statusTask?.cancel()
        guard !sticky else { return }
        statusTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.status = nil
        }
    }

    private func show(_ route: BlockRoute) {
        noteEditor?.flush()
        sheetEditor?.flush()
        self.route = route
        let client = client
        switch route {
        case .files(let botID):
            noteEditor = nil
            sheetEditor = nil
            agendaStore = nil
            let store = filesStore?.botID == botID ? filesStore ?? BlockFilesStore(botID: botID, client: client) : BlockFilesStore(botID: botID, client: client)
            filesStore = store
            Task { await store.reload() }
        case .note(let botID, let id):
            sheetEditor = nil
            agendaStore = nil
            let store = NoteEditorStore(botID: botID, noteID: id, client: client)
            noteEditor = store
            Task { await store.load() }
        case .sheet(let botID, let id):
            noteEditor = nil
            agendaStore = nil
            let store = SheetEditorStore(botID: botID, sheetID: id, client: client)
            sheetEditor = store
            Task { await store.load() }
        case .agenda(let botID):
            noteEditor = nil
            sheetEditor = nil
            let focus = agendaFocus
            agendaFocus = nil
            let store = AgendaStore(botID: botID, client: client, anchor: focus?.anchor ?? Date(), mode: focus?.mode ?? .week)
            agendaStore = store
            Task { await store.load() }
        }
    }

    private func key(_ botID: String, _ id: String) -> String {
        "\(botID)/\(id)"
    }
}

@MainActor
@Observable
final class BlockFilesStore {
    enum Tab: String, CaseIterable, Identifiable {
        case notes
        case sheets
        case agenda

        var id: String { rawValue }

        var title: String {
            switch self {
            case .notes: tr("Notas")
            case .sheets: tr("Planilhas")
            case .agenda: tr("Agenda")
            }
        }
    }

    let botID: String
    var tab: Tab = .notes {
        didSet { if tab != oldValue { Task { await reload() } } }
    }
    var query = "" {
        didSet { if query != oldValue { scheduleReload() } }
    }
    private(set) var notes: [NoteSummary] = []
    private(set) var sheets: [SheetSummary] = []
    private(set) var nextCursor: String?
    private(set) var total = 0
    private(set) var loading = false
    private(set) var failed: String?

    @ObservationIgnored private let client: any BlocksClient
    @ObservationIgnored private var searchTask: Task<Void, Never>?

    init(botID: String, client: any BlocksClient) {
        self.botID = botID
        self.client = client
    }

    func reload() async {
        loading = true
        failed = nil
        defer { loading = false }
        do {
            switch tab {
            case .notes:
                let page = try await client.notes(botID: botID, folder: nil, query: query.isEmpty ? nil : query, cursor: nil, limit: 50)
                notes = page.items
                nextCursor = page.nextCursor
                total = page.total
            case .sheets:
                let page = try await client.sheets(botID: botID, query: query.isEmpty ? nil : query, cursor: nil, limit: 50)
                sheets = page.items
                nextCursor = page.nextCursor
                total = page.total
            case .agenda:
                nextCursor = nil
            }
        } catch {
            failed = error.localizedDescription
        }
    }

    func loadMore() async {
        guard let cursor = nextCursor, !loading else { return }
        loading = true
        defer { loading = false }
        switch tab {
        case .notes:
            if let page = try? await client.notes(botID: botID, folder: nil, query: query.isEmpty ? nil : query, cursor: cursor, limit: 50) {
                notes += page.items
                nextCursor = page.nextCursor
            }
        case .sheets:
            if let page = try? await client.sheets(botID: botID, query: query.isEmpty ? nil : query, cursor: cursor, limit: 50) {
                sheets += page.items
                nextCursor = page.nextCursor
            }
        case .agenda:
            break
        }
    }

    func createNote() async {
        if let note = try? await client.createNote(botID: botID, title: Self.untitled(existing: notes.map(\.title), base: tr("Nota sem título")), folder: "", content: "") {
            BlockCenter.shared.noteTitleChanged(botID: botID, id: note.id, title: note.title)
            BlockCenter.shared.navigate(to: .note(botID: botID, id: note.id))
        }
    }

    func createSheet() async {
        if let sheet = try? await client.createSheet(botID: botID, title: Self.untitled(existing: sheets.map(\.title), base: tr("Planilha sem título"))) {
            BlockCenter.shared.noteTitleChanged(botID: botID, id: sheet.id, title: sheet.title)
            BlockCenter.shared.navigate(to: .sheet(botID: botID, id: sheet.id))
        }
    }

    private func scheduleReload() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await self?.reload()
        }
    }

    private static func untitled(existing: [String], base: String) -> String {
        guard existing.contains(base) else { return base }
        var index = 2
        while existing.contains("\(base) \(index)") { index += 1 }
        return "\(base) \(index)"
    }
}
