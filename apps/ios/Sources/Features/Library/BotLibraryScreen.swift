import SwiftUI
import WebKit

enum LibraryTab: String, CaseIterable, Identifiable {
    case artifacts
    case notes
    case sheets
    case agenda

    var id: String { rawValue }

    var title: String {
        switch self {
        case .artifacts: tr("Artefatos")
        case .notes: tr("Notas")
        case .sheets: tr("Planilhas")
        case .agenda: "Agenda"
        }
    }
}

struct BotLibraryScreen: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    @State private var tab: LibraryTab = .artifacts
    @State private var items: Loadable<[JSONValue]> = .loading

    var body: some View {
        VStack(spacing: 0) {
            Picker("Biblioteca", selection: $tab) {
                ForEach(LibraryTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.s)
            LoadingState(state: items, retry: { Task { await load() } }) { list in
                List {
                    if list.isEmpty {
                        ContentUnavailableView("Nada por aqui", systemImage: symbol, description: Text("Quando \(bot.name) criar \(tab.title.lowercased()), aparece aqui."))
                            .listRowBackground(Color.clear)
                    }
                    ForEach(Array(list.enumerated()), id: \.offset) { _, item in
                        NavigationLink {
                            destination(item)
                        } label: {
                            row(item)
                        }
                        .settingsRow()
                    }
                }
                .settingsList()
                .refreshable { await load() }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Biblioteca")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: tab) { await load() }
    }

    private var symbol: String {
        switch tab {
        case .artifacts: "doc.richtext"
        case .notes: "doc.text"
        case .sheets: "tablecells"
        case .agenda: "calendar"
        }
    }

    private func row(_ item: JSONValue) -> some View {
        HStack(spacing: Spacing.m) {
            Image(systemName: symbol)
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(item["title"]?.stringValue ?? tr("Sem título"))
                    .font(BrandFonts.sans(15, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(subtitle(item))
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
            }
        }
    }

    private func subtitle(_ item: JSONValue) -> String {
        switch tab {
        case .artifacts:
            let kind = ArtifactKindText.label(item["kind"]?.stringValue)
            let version = item["version"]?.intValue ?? 1
            return version > 1 ? "\(kind) · v\(version)" : kind
        case .notes:
            return item["excerpt"]?.stringValue ?? ""
        case .sheets:
            return RelativeText.date(item["updatedAt"]?.stringValue).map { tr("Atualizada %@", $0) } ?? ""
        case .agenda:
            let start = item["start"]?.stringValue.flatMap(ISODate.parse)
            return start?.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: LanguageStore.shared.locale)) ?? (item["start"]?.stringValue ?? "")
        }
    }

    @ViewBuilder
    private func destination(_ item: JSONValue) -> some View {
        switch tab {
        case .artifacts:
            ArtifactViewer(
                title: item["title"]?.stringValue ?? tr("Artefato"),
                path: item["url"]?.stringValue ?? "/bots/\(bot.id)/artifacts/\(item["id"]?.stringValue ?? "")/v/\(item["version"]?.intValue ?? 1).html"
            )
        case .notes:
            NoteReader(botID: bot.id, noteID: item["id"]?.stringValue ?? "", title: item["title"]?.stringValue ?? "")
        case .sheets:
            SheetReader(botID: bot.id, sheetID: item["id"]?.stringValue ?? "", title: item["title"]?.stringValue ?? "")
        case .agenda:
            AgendaEventDetail(event: item)
        }
    }

    private func load() async {
        items = .loading
        let client = model.client
        let id = BotsClient.escape(path: bot.id)
        do {
            switch tab {
            case .artifacts:
                items = .loaded(try await client.call("/bots/\(id)/artifacts").arrayValue ?? [])
            case .notes:
                items = .loaded(try await client.call("/bots/\(id)/notes?sort=updated")["items"]?.arrayValue ?? [])
            case .sheets:
                items = .loaded(try await client.call("/bots/\(id)/sheets")["items"]?.arrayValue ?? [])
            case .agenda:
                let start = Calendar.current.startOfDay(for: Date())
                let end = Calendar.current.date(byAdding: .day, value: 14, to: start) ?? start
                let format = ISO8601DateFormatter()
                format.timeZone = .current
                let query = "start=\(Self.encode(format.string(from: start)))&end=\(Self.encode(format.string(from: end)))"
                items = .loaded(try await client.call("/bots/\(id)/agenda/events?\(query)")["items"]?.arrayValue ?? [])
            }
        } catch {
            items = .failed(ErrorMessage.describe(error))
        }
    }

    private static func encode(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? text
    }
}

enum ArtifactKindText {
    static func label(_ kind: String?) -> String {
        switch kind {
        case "slides": tr("Apresentação")
        case "dashboard": "Dashboard"
        case "canvas": "Canvas"
        case "note": tr("Nota")
        case "sheet": tr("Planilha")
        default: tr("Página")
        }
    }
}

struct ArtifactViewer: View {
    @Environment(AppModel.self) private var model
    let title: String
    let path: String

    var body: some View {
        Group {
            if let url = model.client.absoluteURL(path) {
                AuthWebView(url: url)
                    .ignoresSafeArea(edges: .bottom)
            } else {
                ContentUnavailableView("Endereço inválido", systemImage: "exclamationmark.triangle")
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct AuthWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WebSession.configuration())
        Task { @MainActor in
            if let cookie = await AuthSession.shared.webCookie(for: url) {
                await WebSession.install(cookie)
            }
            var request = URLRequest(url: url)
            AuthStore.authorize(&request)
            view.load(request)
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

struct NoteReader: View {
    @Environment(AppModel.self) private var model
    let botID: String
    let noteID: String
    let title: String
    @State private var content: Loadable<String> = .loading

    var body: some View {
        LoadingState(state: content, retry: { Task { await load() } }) { text in
            ScrollView {
                MarkdownView(text: text)
                    .foregroundStyle(Theme.textPrimary)
                    .padding(Spacing.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            let note = try await model.client.call("/bots/\(BotsClient.escape(path: botID))/notes/\(BotsClient.escape(path: noteID))")
            content = .loaded(note["content"]?.stringValue ?? "")
        } catch {
            content = .failed(ErrorMessage.describe(error))
        }
    }
}

struct SheetReader: View {
    @Environment(AppModel.self) private var model
    let botID: String
    let sheetID: String
    let title: String
    @State private var grid: Loadable<[[String]]> = .loading

    var body: some View {
        LoadingState(state: grid, retry: { Task { await load() } }) { rows in
            ScrollView([.horizontal, .vertical]) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(cell)
                                    .font(index == 0 ? TypeScale.captionStrong : TypeScale.caption)
                                    .monospacedDigit()
                                    .lineLimit(1)
                                    .frame(width: 110, height: 32, alignment: .leading)
                                    .padding(.horizontal, Spacing.s)
                                    .background(index % 2 == 0 ? Theme.surface : Color.clear)
                            }
                        }
                    }
                }
                .padding(Spacing.l)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        let base = "/bots/\(BotsClient.escape(path: botID))/sheets/\(BotsClient.escape(path: sheetID))"
        do {
            let sheet = try await model.client.call(base)
            guard let tab = sheet["tabs"]?.arrayValue?.first, let tabID = tab["id"]?.stringValue else {
                grid = .loaded([])
                return
            }
            let range = try await model.client.call("\(base)/tabs/\(BotsClient.escape(path: tabID))/range?range=A1:H60")
            var cells: [String: String] = [:]
            var maxRow = 0
            var maxCol = 0
            for cell in range["cells"]?.arrayValue ?? [] {
                guard let address = cell["a"]?.stringValue, let (row, col) = Self.parse(address) else { continue }
                cells["\(row):\(col)"] = cell["display"]?.stringValue ?? cell["value"]?.stringValue ?? cell["value"]?.inlineDescription ?? ""
                maxRow = max(maxRow, row)
                maxCol = max(maxCol, col)
            }
            grid = .loaded((0...maxRow).map { row in (0...maxCol).map { col in cells["\(row):\(col)"] ?? "" } })
        } catch {
            grid = .failed(ErrorMessage.describe(error))
        }
    }

    private static func parse(_ address: String) -> (Int, Int)? {
        let letters = address.prefix { $0.isLetter }
        guard let row = Int(address.dropFirst(letters.count)), !letters.isEmpty else { return nil }
        let col = letters.uppercased().unicodeScalars.reduce(0) { $0 * 26 + Int($1.value) - 64 } - 1
        return (row - 1, col)
    }
}

struct AgendaEventDetail: View {
    let event: JSONValue

    var body: some View {
        List {
            Section {
                Text(event["title"]?.stringValue ?? "")
                    .font(BrandFonts.sans(20, weight: .semibold))
                if let start = event["start"]?.stringValue.flatMap(ISODate.parse) {
                    LabeledContent("Horário", value: start.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: LanguageStore.shared.locale)))
                }
                if let location = event["location"]?.stringValue, !location.isEmpty {
                    LabeledContent("Local", value: location)
                }
                if let meet = event["meetUrl"]?.stringValue.flatMap(URL.init(string:)) {
                    Link("Entrar na reunião", destination: meet)
                }
            }
            .settingsRow()
            if let description = event["description"]?.stringValue, !description.isEmpty {
                Section("Descrição") {
                    Text(description).font(TypeScale.rowSubtitle)
                }
                .settingsRow()
            }
        }
        .settingsList()
        .navigationBarTitleDisplayMode(.inline)
    }
}
