import AppKit
import SwiftUI
import XCTest
@testable import RunelayBots

@MainActor
@Observable
final class HarnessTabs {
    var current: ConversationStore
    let bots: [String: Bot]

    init(current: ConversationStore, bots: [String: Bot]) {
        self.current = current
        self.bots = bots
    }
}

struct HarnessTabsView: View {
    let tabs: HarnessTabs

    var body: some View {
        let store = tabs.current
        ConversationView(store: store, bot: store.bot, focusToken: 0)
            .id(ObjectIdentifier(store))
    }
}

@MainActor
final class ConversationScrollTests: XCTestCase {
    static let size: CGSize = {
        let parts = (ProcessInfo.processInfo.environment["RB_HARNESS_SIZE"] ?? "980x820").split(separator: "x").compactMap { Double($0) }
        return parts.count == 2 ? CGSize(width: parts[0], height: parts[1]) : CGSize(width: 980, height: 820)
    }()
    var fixtures: [HarnessFixture] = []
    var bots: [String: Bot] = [:]

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["RB_HARNESS_FIXTURES"] else {
            throw XCTSkip("RB_HARNESS_FIXTURES not set")
        }
        let folder = URL(fileURLWithPath: path)
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" && $0.lastPathComponent != "bots.json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        let only = ProcessInfo.processInfo.environment["RB_HARNESS_ONLY"]
        fixtures = try files.map(HarnessFixture.load).filter { only == nil || $0.sessionID == only || $0.botID == only }
        let botData = try Data(contentsOf: folder.appending(path: "bots.json"))
        bots = Dictionary(uniqueKeysWithValues: try JSONDecoder().decode([Bot].self, from: botData).map { ($0.id, $0) })
        FixtureURLProtocol.host = "harness-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        FixtureURLProtocol.fixtures = Dictionary(uniqueKeysWithValues: fixtures.map { ($0.sessionID, $0) })
        URLProtocol.registerClass(FixtureURLProtocol.self)
    }

    override func tearDown() async throws {
        URLProtocol.unregisterClass(FixtureURLProtocol.self)
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appending(path: "runelay bots/transcripts", directoryHint: .isDirectory)
        if let support, let items = try? FileManager.default.contentsOfDirectory(at: support, includingPropertiesForKeys: nil) {
            for item in items where item.lastPathComponent.contains("harness-") {
                try? FileManager.default.removeItem(at: item)
            }
        }
    }

    private var client: BotsClient {
        BotsClient(baseURL: URL(string: "http://\(FixtureURLProtocol.host)")!)
    }

    private func makeStore(_ fixture: HarnessFixture, cached: Bool = false) throws -> ConversationStore {
        let bot = try XCTUnwrap(bots[fixture.botID])
        if cached {
            let json = try JSONDecoder().decode(JSONValue.self, from: fixture.page(before: nil, limit: TranscriptCache.pageSize))
            let page = EventsPage.parse(json)
            TranscriptCache.shared.write(CachedTranscript(lines: page.lines, total: fixture.total), server: client.baseURL, sessionID: fixture.sessionID)
        }
        return ConversationStore(bot: bot, client: client, sessionId: fixture.sessionID)
    }

    private func log(_ text: String) {
        print("[harness] \(text)")
    }

    private func openReport(_ host: HarnessHost, store: ConversationStore, label: String) -> (final: ScrollSample?, moved: CGFloat, blankFrames: Int) {
        var samples: [ScrollSample] = []
        _ = host.pump(until: { store.historySettled }, timeout: 10)
        host.pump(2.0) { samples.append($0) }
        let inked = samples.filter { $0.inkRatio > 0.01 }
        var moved: CGFloat = 0
        if let first = inked.first {
            for sample in samples where sample.time >= first.time {
                moved = max(moved, abs(sample.offset - first.offset) - abs(sample.documentHeight - first.documentHeight))
            }
        }
        let blank = samples.filter { $0.inkRatio <= 0.01 }.count
        let final = host.measure(ink: true)
        log("\(label) open entries=\(store.entries.count) final=\(final.map(String.init(describing:)) ?? "nil") moved=\(Int(moved)) blankFrames=\(blank)/\(samples.count)")
        return (final, moved, blank)
    }

    func testOpensAtBottomAndJumpReturnsToRealEnd() throws {
        var failures: [String] = []
        let modes = (ProcessInfo.processInfo.environment["RB_HARNESS_MODES"] ?? "cache,network").split(separator: ",").map(String.init)
        let pages = Int(ProcessInfo.processInfo.environment["RB_HARNESS_PAGES"] ?? "4") ?? 4
        for mode in modes {
        for fixture in fixtures {
            TranscriptCache.shared.forgetMemory()
            let store = try makeStore(fixture, cached: mode == "cache")
            let host = HarnessHost(size: Self.size) {
                ConversationView(store: store, bot: store.bot, focusToken: 0)
            }
            store.start()
            let label = "[\(mode)] \(fixture.botID)/\(fixture.sessionID.suffix(6))"
            let open = openReport(host, store: store, label: label)
            if let final = open.final {
                if final.distanceToBottom > 2 { failures.append("\(label): abriu a \(Int(final.distanceToBottom))pt do fim") }
                if final.inkRatio <= 0.01 { failures.append("\(label): abriu em branco") }
            } else {
                failures.append("\(label): sem scroll view")
            }
            if open.moved > 2 { failures.append("\(label): moveu \(Int(open.moved))pt depois de aparecer") }

            let scrollable = (open.final?.documentHeight ?? 0) > Self.size.height * 2
            if scrollable {
                for _ in 0..<pages {
                    host.scrollUp(by: 2400)
                    host.pump(0.6)
                }
                host.pump(1.0)
                let up = host.measure(ink: true)
                log("\(label) after scroll up \(up.map(String.init(describing:)) ?? "nil") entries=\(store.entries.count)")
                let pressed = host.pressJump()
                if !pressed {
                    failures.append("\(label): botão ir para o fim não apareceu")
                }
                var samples: [ScrollSample] = []
                host.pump(1.5) { samples.append($0) }
                let blank = samples.filter { $0.inkRatio <= 0.01 }
                let final = host.measure(ink: true)
                log("\(label) after jump pressed=\(pressed) final=\(final.map(String.init(describing:)) ?? "nil") blankFrames=\(blank.count)/\(samples.count)")
                for sample in samples.suffix(4) {
                    log("  \(sample)")
                }
                if let final {
                    if final.distanceToBottom > 2 { failures.append("\(label): ↓ parou a \(Int(final.distanceToBottom))pt do fim") }
                    if final.inkRatio <= 0.01 { failures.append("\(label): ↓ deixou a tela em branco") }
                }
                if blank.count > 0 { failures.append("\(label): ↓ teve \(blank.count) quadros em branco") }
            }
            store.stop()
            host.close()
        }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    private func fixture(_ botID: String) throws -> HarnessFixture {
        try XCTUnwrap(fixtures.filter { $0.botID == botID }.max { $0.fullTotal < $1.fullTotal })
    }

    private func cpuSeconds() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
    }

    func testOlderPagesKeepPositionAndJumpStaysFilled() throws {
        let botID = ProcessInfo.processInfo.environment["RB_HARNESS_BIG"] ?? "engenheiro-de-software"
        let fixture = try fixture(botID)
        let store = try makeStore(fixture, cached: true)
        let host = HarnessHost(size: Self.size) {
            ConversationView(store: store, bot: store.bot, focusToken: 0)
        }
        store.start()
        var failures: [String] = []
        _ = openReport(host, store: store, label: "older")
        guard let scroll = host.transcriptScrollView else { return XCTFail("sem scroll view") }
        for round in 0..<6 {
            let entriesBefore = store.entries.count
            host.scrollTo(y: -scroll.contentInsets.top + 120)
            host.pump(0.05)
            guard let anchor = host.topVisibleID, let before = host.viewportY(of: anchor) else {
                failures.append("rodada \(round): sem linha visível no topo")
                continue
            }
            var worst: CGFloat = 0
            host.pump(1.2) { _ in
                if let y = host.viewportY(of: anchor) {
                    worst = max(worst, abs(y - before))
                }
            }
            let after = host.viewportY(of: anchor)
            let sample = host.measure(ink: true)
            log("older round \(round) entries \(entriesBefore)→\(store.entries.count) anchor \(anchor.suffix(10)) y \(Int(before))→\(after.map { String(Int($0)) } ?? "nil") worst=\(Int(worst)) \(sample.map(String.init(describing:)) ?? "")")
            if worst > 2 { failures.append("rodada \(round): conteúdo pulou \(Int(worst))pt ao carregar antigas") }
            if (sample?.inkRatio ?? 0) <= 0.01 { failures.append("rodada \(round): em branco depois de carregar antigas") }
        }
        let steps = 150
        let start = Date()
        let cpuStart = cpuSeconds()
        for index in 0..<steps {
            host.scrollTo(y: scroll.contentView.bounds.origin.y + (index < steps / 2 ? 60 : -60))
            host.window.displayIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.001))
        }
        let perStep = Date().timeIntervalSince(start) / Double(steps) * 1000
        log("scroll step \(String(format: "%.2f", perStep))ms entries=\(store.entries.count) doc=\(Int(scroll.documentView?.frame.height ?? 0)) cpu=\(String(format: "%.2f", cpuSeconds() - cpuStart))s")
        if perStep > 16 { failures.append("rolagem lenta: \(String(format: "%.1f", perStep))ms por passo") }
        _ = host.pressJump()
        var samples: [ScrollSample] = []
        host.pump(1.5) { samples.append($0) }
        let blank = samples.filter { $0.inkRatio <= 0.01 }.count
        let final = host.measure(ink: true)
        log("older jump final=\(final.map(String.init(describing:)) ?? "nil") blank=\(blank)/\(samples.count)")
        if (final?.distanceToBottom ?? 99) > 2 { failures.append("↓ depois de antigas parou a \(Int(final?.distanceToBottom ?? -1))pt do fim") }
        if blank > 0 { failures.append("↓ depois de antigas: \(blank) quadros em branco") }
        let idleStart = cpuSeconds()
        let idleAt = Date()
        RunLoop.main.run(until: Date().addingTimeInterval(3))
        let idle = (cpuSeconds() - idleStart) / Date().timeIntervalSince(idleAt) * 100
        log("idle cpu \(String(format: "%.1f", idle))%")
        if idle > 3 { failures.append("CPU ociosa \(String(format: "%.1f", idle))%") }
        store.stop()
        host.close()
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testLiveMessagesFollowOnlyAtEnd() throws {
        var fixture = try fixture(ProcessInfo.processInfo.environment["RB_HARNESS_BIG"] ?? "engenheiro-de-software")
        fixture.withheld = 30
        FixtureURLProtocol.fixtures[fixture.sessionID] = fixture
        let store = try makeStore(fixture)
        let host = HarnessHost(size: Self.size) {
            ConversationView(store: store, bot: store.bot, focusToken: 0)
        }
        store.start()
        var failures: [String] = []
        _ = openReport(host, store: store, label: "live")
        _ = host.pump(until: { FixtureURLProtocol.streams[fixture.sessionID] != nil }, timeout: 5)
        let tail = Array(fixture.allEvents.suffix(30))
        let entries0 = store.entries.count
        FixtureURLProtocol.release(sessionID: fixture.sessionID, events: Array(tail.prefix(15)))
        host.pump(1.5)
        let atEnd = host.measure(ink: true)
        log("live at end entries \(entries0)→\(store.entries.count) \(atEnd.map(String.init(describing:)) ?? "nil")")
        if (atEnd?.distanceToBottom ?? 99) > 2 { failures.append("mensagem nova com você no fim: ficou a \(Int(atEnd?.distanceToBottom ?? -1))pt do fim") }
        guard let scroll = host.transcriptScrollView else { return XCTFail("sem scroll view") }
        host.scrollTo(y: scroll.contentView.bounds.origin.y - 1500)
        host.pump(0.5)
        let anchor = host.topVisibleID
        let before = anchor.flatMap { host.viewportY(of: $0) }
        let offset = scroll.contentView.bounds.origin.y
        let entries1 = store.entries.count
        FixtureURLProtocol.release(sessionID: fixture.sessionID, events: Array(tail.suffix(15)))
        host.pump(1.5)
        let after = anchor.flatMap { host.viewportY(of: $0) }
        log("live scrolled entries \(entries1)→\(store.entries.count) offset \(Int(offset))→\(Int(scroll.contentView.bounds.origin.y)) anchorY \(before.map { String(Int($0)) } ?? "nil")→\(after.map { String(Int($0)) } ?? "nil")")
        if let before, let after, abs(after - before) > 2 { failures.append("mensagem nova com você em cima moveu \(Int(after - before))pt") }
        if store.entries.count == entries1 { failures.append("o stream não trouxe entradas novas") }
        store.stop()
        host.close()
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testTabSwitchKeepsPosition() throws {
        guard fixtures.count >= 2 else { throw XCTSkip("needs two fixtures") }
        let ordered = fixtures.sorted { $0.total > $1.total }
        let first = try makeStore(ordered[0])
        let second = try makeStore(ordered[1])
        let tabs = HarnessTabs(current: first, bots: bots)
        let host = HarnessHost(size: Self.size) {
            HarnessTabsView(tabs: tabs)
        }
        first.start()
        second.start()
        var failures: [String] = []
        _ = openReport(host, store: first, label: "tab A")
        tabs.current = second
        _ = openReport(host, store: second, label: "tab B")
        tabs.current = first
        host.pump(1.0)
        if let back = host.measure(ink: true) {
            log("tab A back at end: \(back)")
            if back.distanceToBottom > 2 { failures.append("voltar à aba no fim parou a \(Int(back.distanceToBottom))pt do fim") }
            if back.inkRatio <= 0.01 { failures.append("voltar à aba no fim ficou em branco") }
        }
        if let scroll = host.transcriptScrollView {
            host.scrollTo(y: scroll.contentView.bounds.origin.y - 1500)
        }
        host.pump(0.8)
        let before = host.measure(ink: true)
        let anchor = host.topVisibleID
        let anchorBefore = anchor.flatMap { host.viewportY(of: $0) }
        tabs.current = second
        host.pump(1.0)
        log("saved memory \(String(describing: first.scrollMemory))")
        tabs.current = first
        host.pump(1.0)
        let after = host.measure(ink: true)
        log("tab A scrolled before=\(before.map(String.init(describing:)) ?? "nil") after=\(after.map(String.init(describing:)) ?? "nil")")
        let anchorAfter = anchor.flatMap { host.viewportY(of: $0) }
        log("tab A anchor \(anchor ?? "nil") y \(anchorBefore.map { String(Int($0)) } ?? "nil")→\(anchorAfter.map { String(Int($0)) } ?? "nil")")
        if let anchorBefore, let anchorAfter {
            if abs(anchorAfter - anchorBefore) > 2 {
                failures.append("voltar à aba rolada moveu o conteúdo \(Int(anchorAfter - anchorBefore))pt")
            }
        } else {
            failures.append("voltar à aba rolada: a linha que estava no topo não está na tela")
        }
        if let before, let after {
            if after.distanceToBottom < 24, before.distanceToBottom > 200 { failures.append("voltar à aba rolada caiu no fim") }
            if after.inkRatio <= 0.01 { failures.append("voltar à aba rolada ficou em branco") }
        }
        first.stop()
        second.stop()
        host.close()
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testScrollFrameBudget() throws {
        let botID = ProcessInfo.processInfo.environment["RB_HARNESS_BIG"] ?? "engenheiro-de-software"
        let fixture = try fixture(botID)
        let store = try makeStore(fixture, cached: true)
        let host = HarnessHost(size: Self.size) {
            ConversationView(store: store, bot: store.bot, focusToken: 0)
        }
        store.start()
        _ = openReport(host, store: store, label: "frames")
        guard let scroll = host.transcriptScrollView else { return XCTFail("sem scroll view") }
        let rounds = Int(ProcessInfo.processInfo.environment["RB_HARNESS_ROUNDS"] ?? "6") ?? 6
        for _ in 0..<rounds {
            host.scrollTo(y: -scroll.contentInsets.top + 120)
            host.pump(1.0)
        }
        _ = host.pressJump()
        host.pump(1.0)
        log("frames setup entries=\(store.entries.count) doc=\(Int(scroll.documentView?.frame.height ?? 0))")
        let step = CGFloat(Double(ProcessInfo.processInfo.environment["RB_HARNESS_STEP"] ?? "28") ?? 28)
        let count = Int(ProcessInfo.processInfo.environment["RB_HARNESS_FRAMECOUNT"] ?? "2000") ?? 2000
        var failures: [String] = []
        for (label, direction, frames) in [("cima", -1.0, count), ("baixo", 1.0, count / 2)] {
            var times: [Double] = []
            var cpu: [Double] = []
            var blank = 0
            for _ in 0..<frames {
                let start = DispatchTime.now().uptimeNanoseconds
                let cpuStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
                host.scrollTo(y: scroll.contentView.bounds.origin.y + step * direction)
                host.window.contentView?.layoutSubtreeIfNeeded()
                host.window.displayIfNeeded()
                CATransaction.flush()
                times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
                cpu.append(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - cpuStart) / 1_000_000)
                if host.inkRatio(in: scroll) <= 0.01 { blank += 1 }
                RunLoop.main.run(until: Date().addingTimeInterval(0.0005))
            }
            let sorted = times.sorted()
            let p95 = sorted[Int(Double(sorted.count - 1) * 0.95)]
            let p99 = sorted[Int(Double(sorted.count - 1) * 0.99)]
            let mean = times.reduce(0, +) / Double(times.count)
            let over = times.filter { $0 > 16.6 }.count
            let over8 = times.filter { $0 > 8.3 }.count
            log(String(format: "frames %@ n=%d mean=%.2fms p95=%.2fms p99=%.2fms worst=%.2fms >16.6ms=%d >8.3ms=%d blank=%d", label, times.count, mean, p95, p99, sorted.last ?? 0, over, over8, blank))
            let cpuSorted = cpu.sorted()
            log(String(format: "cpu %@ mean=%.2fms p95=%.2fms p99=%.2fms worst=%.2fms >8.3ms=%d", label, cpu.reduce(0, +) / Double(cpu.count), cpuSorted[Int(Double(cpuSorted.count - 1) * 0.95)], cpuSorted[Int(Double(cpuSorted.count - 1) * 0.99)], cpuSorted.last ?? 0, cpu.filter { $0 > 8.3 }.count))
            if (cpuSorted.last ?? 0) > 16.6 { failures.append(String(format: "rolando para %@: pior quadro da main thread %.1fms", label, cpuSorted.last ?? 0)) }
            if blank > 0 { failures.append("rolando para \(label): \(blank) quadros em branco") }
        }
        store.stop()
        host.close()
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }
}
