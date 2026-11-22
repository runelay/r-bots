import AppKit
import SwiftUI
import XCTest

@testable import RunelayBots

@MainActor
final class ComposerPasteTests: XCTestCase {
    private func makeStore() throws -> ConversationStore {
        let bot = try JSONDecoder().decode(Bot.self, from: Data(#"{"id":"probe","name":"Probe"}"#.utf8))
        let client = BotsClient(baseURL: URL(string: "http://composer-paste.invalid")!)
        return ConversationStore(bot: bot, client: client, sessionId: nil)
    }

    private func textView(in view: NSView) -> ComposerNSTextView? {
        if let found = view as? ComposerNSTextView { return found }
        for child in view.subviews {
            if let found = textView(in: child) { return found }
        }
        return nil
    }

    private func putImage() {
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 8, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setData(rep?.representation(using: .png, properties: [:]), forType: .png)
    }

    private func attachments(in field: NSTextView) -> Int {
        guard let storage = field.textStorage else { return 0 }
        var count = 0
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
            if value is ComposerTokenAttachment { count += 1 }
        }
        return count
    }

    private func paste(prefix: String) throws -> (store: ConversationStore, field: ComposerNSTextView, host: HarnessHost) {
        let store = try makeStore()
        let host = HarnessHost(size: CGSize(width: 900, height: 300)) {
            ComposerView(store: store, bot: store.bot, focusToken: 0)
        }
        host.pump(0.3)
        let field = try XCTUnwrap(textView(in: host.hosting))
        host.window.makeFirstResponder(field)
        if !prefix.isEmpty {
            field.insertText(prefix, replacementRange: field.selectedRange())
            host.pump(0.2)
        }
        putImage()
        field.paste(nil)
        host.pump(0.3)
        return (store, field, host)
    }

    func testPasteImageIntoEmptyComposerKeepsChip() throws {
        let (store, field, host) = try paste(prefix: "")
        defer { host.close() }
        XCTAssertEqual(store.draftTokens.count, 1)
        XCTAssertEqual(attachments(in: field), 1)
    }

    func testPasteImageAfterTextKeepsChip() throws {
        let (store, field, host) = try paste(prefix: "x")
        defer { host.close() }
        XCTAssertEqual(store.draftTokens.count, 1)
        XCTAssertEqual(attachments(in: field), 1)
    }

    // O app real pode renderizar entre a escrita do draft e a dos tokens; esse render não pode apagar o chip
    func testRenderBetweenDraftAndTokensKeepsChip() throws {
        let (store, field, host) = try paste(prefix: "")
        defer { host.close() }
        let tokens = store.draftTokens
        XCTAssertEqual(tokens.count, 1)
        store.draftTokens = []
        host.pump(0.2)
        store.draftTokens = tokens
        host.pump(0.3)
        XCTAssertEqual(store.draftTokens.count, 1)
        XCTAssertEqual(attachments(in: field), 1)
        XCTAssertEqual(store.composerAttachments.count, 1)
    }
}
