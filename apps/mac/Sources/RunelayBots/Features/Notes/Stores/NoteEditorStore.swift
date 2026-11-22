import Foundation
import Observation

struct LinkContext: Equatable {
    var query: String
    var anchor: CGRect
}

@MainActor
@Observable
final class NoteEditorStore {
    let botID: String
    let noteID: String

    private(set) var note: Note?
    private(set) var text = ""
    private(set) var textRevision = 0
    private(set) var highlight: [ClosedRange<Int>] = []
    private(set) var highlightToken = 0
    private(set) var saving = false
    private(set) var dirty = false
    private(set) var failed: String?
    private(set) var savedAt: Date?
    private(set) var remoteEditedAt: Date?
    private(set) var backlinks: [NoteBacklink] = []
    private(set) var backlinksNext: String?
    private(set) var linkContext: LinkContext?
    private(set) var suggestions: [NoteSearchHit] = []
    var suggestionIndex = 0

    @ObservationIgnored let client: any BlocksClient
    @ObservationIgnored var insertLink: ((String) -> Void)?
    @ObservationIgnored private var baseContent = ""
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var suggestTask: Task<Void, Never>?
    @ObservationIgnored private var pendingSave = false

    let sidebar: NoteSidebarStore

    init(botID: String, noteID: String, client: any BlocksClient) {
        self.botID = botID
        self.noteID = noteID
        self.client = client
        sidebar = NoteSidebarStore.store(botID: botID, client: client)
    }

    var statusText: String {
        if failed != nil { return tr("Não consegui salvar. Tentando de novo ao editar.") }
        if saving || dirty { return tr("Salvando…") }
        if let remoteEditedAt, Date().timeIntervalSince(remoteEditedAt) < 60 { return tr("O bot acabou de editar") }
        if savedAt != nil { return tr("Salvo") }
        guard let note else { return tr("Nota") }
        return note.folder.isEmpty ? tr("Nota") : note.folder.replacingOccurrences(of: "/", with: " › ")
    }

    func load() async {
        do {
            let loaded = try await client.note(botID: botID, id: noteID)
            apply(loaded, replaceText: true)
            BlockCenter.shared.noteTitleChanged(botID: botID, id: noteID, title: loaded.title)
            ArtifactCenter.shared.retitle(ArtifactRef(botID: botID, id: noteID, title: loaded.title, kind: BlockKind.note.rawValue, version: loaded.version))
            await sidebar.reveal(folder: loaded.folder)
            await loadBacklinks()
        } catch {
            failed = error.localizedDescription
            await sidebar.load()
        }
    }

    func userEdited(_ newText: String) {
        guard newText != text else { return }
        text = newText
        dirty = true
        failed = nil
        scheduleSave()
    }

    func flush() {
        guard dirty else { return }
        saveTask?.cancel()
        let snapshot = text
        let version = note?.version
        let client = client
        let botID = botID
        let noteID = noteID
        Task {
            _ = try? await client.writeNote(botID: botID, id: noteID, content: snapshot, title: nil, baseVersion: version)
        }
        dirty = false
    }

    func remoteChanged(version: Int, change: BlockChange?) {
        guard version > (note?.version ?? 0) else { return }
        Task {
            if dirty {
                await save()
            }
            guard let latest = try? await client.note(botID: botID, id: noteID) else { return }
            if !dirty {
                apply(latest, replaceText: true)
            }
            remoteEditedAt = Date()
            if case .lines(let lines) = change {
                highlight = lines
                highlightToken += 1
            }
            await loadBacklinks()
        }
    }

    func toggledTask(line: Int, done: Bool) {
        scheduleSave(delay: .milliseconds(150))
    }

    func updateLinkContext(_ context: LinkContext?) {
        guard context != linkContext else { return }
        let queryChanged = context?.query != linkContext?.query
        linkContext = context
        guard let context else {
            suggestions = []
            suggestTask?.cancel()
            return
        }
        guard queryChanged else { return }
        suggestTask?.cancel()
        let client = client
        let botID = botID
        suggestTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            let page = try? await client.searchNotes(botID: botID, query: context.query, titlesOnly: true, cursor: nil, limit: 8)
            guard !Task.isCancelled, let self else { return }
            var items = page?.items.filter { $0.id != self.noteID } ?? []
            let trimmed = context.query.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty, !items.contains(where: { $0.title.caseInsensitiveCompare(trimmed) == .orderedSame }) {
                items.append(NoteSearchHit(id: "", title: trimmed, folder: "", snippet: nil, ranges: nil))
            }
            self.suggestions = items
            self.suggestionIndex = 0
        }
    }

    func moveSuggestion(_ delta: Int) {
        guard !suggestions.isEmpty else { return }
        suggestionIndex = (suggestionIndex + delta + suggestions.count) % suggestions.count
    }

    func acceptSuggestion(_ hit: NoteSearchHit? = nil) {
        guard let chosen = hit ?? (suggestions.indices.contains(suggestionIndex) ? suggestions[suggestionIndex] : nil) else { return }
        insertLink?(chosen.title)
        updateLinkContext(nil)
    }

    func openLink(_ title: String) {
        Task {
            flush()
            if let target = try? await client.resolveNote(botID: botID, title: title) {
                BlockCenter.shared.noteTitleChanged(botID: botID, id: target.id, title: target.title)
                BlockCenter.shared.navigate(to: .note(botID: botID, id: target.id))
            } else if let created = try? await client.createNote(botID: botID, title: title, folder: note?.folder ?? "", content: "# \(title)\n\n") {
                BlockCenter.shared.noteTitleChanged(botID: botID, id: created.id, title: created.title)
                BlockCenter.shared.navigate(to: .note(botID: botID, id: created.id))
            }
        }
    }

    func loadMoreBacklinks() async {
        guard let cursor = backlinksNext,
            let page = try? await client.backlinks(botID: botID, id: noteID, cursor: cursor)
        else { return }
        backlinks += page.items
        backlinksNext = page.nextCursor
    }

    private func loadBacklinks() async {
        guard let page = try? await client.backlinks(botID: botID, id: noteID, cursor: nil) else { return }
        backlinks = page.items
        backlinksNext = page.nextCursor
    }

    private func apply(_ loaded: Note, replaceText: Bool) {
        note = loaded
        baseContent = loaded.content
        if replaceText, loaded.content != text {
            text = loaded.content
            textRevision += 1
        }
    }

    private func scheduleSave(delay: Duration = .milliseconds(600)) {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.save()
        }
    }

    private func save() async {
        guard dirty else { return }
        if saving {
            pendingSave = true
            return
        }
        saving = true
        let snapshot = text
        do {
            let saved = try await client.writeNote(botID: botID, id: noteID, content: snapshot, title: nil, baseVersion: note?.version)
            note = saved
            baseContent = snapshot
            savedAt = Date()
            failed = nil
            if text == snapshot {
                dirty = false
            }
        } catch BlocksError.stale {
            await rebase()
        } catch {
            failed = error.localizedDescription
        }
        saving = false
        if pendingSave || dirty {
            pendingSave = false
            if dirty {
                scheduleSave(delay: .milliseconds(200))
            }
        }
    }

    private func rebase() async {
        guard let latest = try? await client.note(botID: botID, id: noteID) else { return }
        let merged = TextRebase.apply(base: baseContent, local: text, remote: latest.content)
        note = latest
        baseContent = latest.content
        if let merged {
            text = merged
            dirty = merged != latest.content
        } else {
            text = latest.content
            dirty = false
            BlockCenter.shared.flash(tr("O bot mudou o mesmo trecho; ficou a versão dele"))
        }
        textRevision += 1
        remoteEditedAt = Date()
    }
}

enum TextRebase {
    static func apply(base: String, local: String, remote: String) -> String? {
        let baseChars = Array(base.utf16)
        let localChars = Array(local.utf16)
        var prefix = 0
        while prefix < baseChars.count, prefix < localChars.count, baseChars[prefix] == localChars[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < baseChars.count - prefix, suffix < localChars.count - prefix,
            baseChars[baseChars.count - 1 - suffix] == localChars[localChars.count - 1 - suffix]
        { suffix += 1 }
        let removed = String(utf16CodeUnits: Array(baseChars[prefix..<(baseChars.count - suffix)]), count: baseChars.count - suffix - prefix)
        let inserted = String(utf16CodeUnits: Array(localChars[prefix..<(localChars.count - suffix)]), count: localChars.count - suffix - prefix)
        let before = String(utf16CodeUnits: Array(baseChars[max(0, prefix - 24)..<prefix]), count: prefix - max(0, prefix - 24))
        let remoteNS = remote as NSString
        let anchor = before + removed
        let found = anchor.isEmpty ? NSRange(location: 0, length: 0) : remoteNS.range(of: anchor)
        guard found.location != NSNotFound else { return nil }
        let replaceRange = NSRange(location: found.location + (before as NSString).length, length: (removed as NSString).length)
        return remoteNS.replacingCharacters(in: replaceRange, with: inserted)
    }
}

@MainActor
@Observable
final class NoteSidebarStore {
    let botID: String
    private(set) var levels: [String: NoteTreeLevel] = [:]
    private(set) var expanded: Set<String>
    private(set) var results: [NoteSearchHit] = []
    private(set) var searching = false
    private(set) var revealRevision = 0
    var query = "" {
        didSet { if query != oldValue { scheduleSearch() } }
    }

    @ObservationIgnored private var client: any BlocksClient
    @ObservationIgnored private var searchTask: Task<Void, Never>?

    private static var stores: [String: NoteSidebarStore] = [:]

    static func store(botID: String, client: any BlocksClient) -> NoteSidebarStore {
        if let cached = stores[botID] {
            cached.client = client
            return cached
        }
        let created = NoteSidebarStore(botID: botID, client: client)
        stores[botID] = created
        return created
    }

    private var expandedKey: String { "notes.tree.expanded.\(botID)" }

    init(botID: String, client: any BlocksClient) {
        self.botID = botID
        self.client = client
        let stored = UserDefaults.standard.stringArray(forKey: "notes.tree.expanded.\(botID)") ?? []
        expanded = Set(stored).union([""])
    }

    func load() async {
        await loadLevel("")
    }

    func reveal(folder: String) async {
        var path: [String] = [""]
        var current = ""
        for part in folder.split(separator: "/") {
            current = current.isEmpty ? String(part) : current + "/" + part
            path.append(current)
        }
        expanded.formUnion(path)
        persist()
        for level in path {
            await loadLevel(level)
        }
        revealRevision += 1
        for level in expanded where !path.contains(level) && levels[level] == nil {
            await loadLevel(level)
        }
    }

    func toggle(_ folder: String) {
        if expanded.contains(folder) {
            expanded.remove(folder)
        } else {
            expanded.insert(folder)
            if levels[folder] == nil {
                Task { await loadLevel(folder) }
            }
        }
        persist()
    }

    func reload() async {
        for folder in expanded {
            await loadLevel(folder)
        }
    }

    private func persist() {
        UserDefaults.standard.set(Array(expanded.subtracting([""])).sorted(), forKey: expandedKey)
    }

    private func loadLevel(_ folder: String) async {
        if let level = try? await client.noteTree(botID: botID, folder: folder) {
            levels[folder] = level
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            results = []
            searching = false
            return
        }
        searching = true
        let client = client
        let botID = botID
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(220))
            guard !Task.isCancelled else { return }
            let page = try? await client.searchNotes(botID: botID, query: trimmed, titlesOnly: false, cursor: nil, limit: 30)
            guard !Task.isCancelled, let self else { return }
            self.results = page?.items ?? []
            self.searching = false
        }
    }
}
