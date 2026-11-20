import Foundation
import XCTest
@testable import RunelayBots

final class BlocksDecodingTests: XCTestCase {
    func testDecodesCapturedRangeWithFormatWithoutType() throws {
        let json = #"""
        {"tabId":"tab_01m7vbfp1gs7475bwme94gxc54","range":"A1:D14","version":4,"cells":[{"a":"A1","r":0,"c":0,"input":"Categoria","v":"Categoria","t":"s","format":{"bold":true}},{"a":"B1","r":0,"c":1,"input":"Item","v":"Item","t":"s","format":{"bold":true}},{"a":"C1","r":0,"c":2,"input":"Por que eu gosto","v":"Por que eu gosto","t":"s","format":{"bold":true}},{"a":"D1","r":0,"c":3,"input":"Nota","v":"Nota","t":"s","format":{"bold":true}},{"a":"A2","r":1,"c":0,"input":"Trabalho","v":"Trabalho","t":"s"},{"a":"B2","r":1,"c":1,"input":"Dados bem organizados","v":"Dados bem organizados","t":"s"},{"a":"C2","r":1,"c":2,"input":"Dá pra confiar e responder rápido","v":"Dá pra confiar e responder rápido","t":"s"},{"a":"D2","r":1,"c":3,"input":"10","v":10,"t":"n"},{"a":"C14","r":13,"c":2,"input":"Média","v":"Média","t":"s","format":{"bold":true}},{"a":"D14","r":13,"c":3,"input":"=MÉDIA(D2:D13)","v":8.75,"t":"n","format":{"bold":true,"type":"number","decimals":1}}]}
        """#
        let result = try JSONDecoder().decode(SheetRangeResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.version, 4)
        XCTAssertEqual(result.cells.count, 10)
        let header = try XCTUnwrap(result.cells.first)
        XCTAssertEqual(header.format?.type, .general)
        XCTAssertEqual(header.format?.bold, true)
        XCTAssertEqual(result.cells.first { $0.a == "D2" }?.v, .number(10))
        let average = try XCTUnwrap(result.cells.first { $0.a == "D14" })
        XCTAssertEqual(average.format?.type, .number)
        XCTAssertEqual(average.format?.decimals, 1)
        XCTAssertEqual(average.v, .number(8.75))
    }

    func testDecodesCapturedSheetAndExport() throws {
        let sheet = #"""
        {"id":"sheet_01m7vbfp1dr4dmncyt20tfvq6c","title":"Coisas que eu gosto","version":4,"updatedAt":"2026-11-20T02:10:09.542Z","updatedBy":"bot","tabs":[{"id":"tab_01m7vbfp1gs7475bwme94gxc54","name":"Lista","index":0,"rowCount":14,"colCount":4,"frozenRows":1,"frozenCols":0,"colWidths":{}}]}
        """#
        let decoded = try JSONDecoder().decode(Sheet.self, from: Data(sheet.utf8))
        XCTAssertEqual(decoded.tabs.first?.rowCount, 14)
        XCTAssertEqual(decoded.tabs.first?.colWidths, [:])

        let export = #"""
        {"id":"exp_01m7vbftxrz2rcprz1avefbw6h","kind":"sheet","sourceId":"sheet_01m7vbfp1dr4dmncyt20tfvq6c","format":"xlsx","status":"ready","fileName":"Coisas que eu gosto.xlsx","size":7335,"url":"/bots/boss/exports/exp_01m7vbftxrz2rcprz1avefbw6h/file","error":null,"createdAt":"2026-11-20T02:10:11.000Z"}
        """#
        let job = try JSONDecoder().decode(ExportJob.self, from: Data(export.utf8))
        XCTAssertEqual(job.fileName, "Coisas que eu gosto.xlsx")
        XCTAssertEqual(job.size, 7335)
        XCTAssertEqual(job.url, "/bots/boss/exports/exp_01m7vbftxrz2rcprz1avefbw6h/file")
    }

    func testParsesCapturedBlockEventPreviewWithBoldHeader() throws {
        let json = #"""
        {"kind":"sheet","id":"sheet_01m7vbfp1dr4dmncyt20tfvq6c","title":"Coisas que eu gosto","version":2,"author":"bot","action":"edited","preview":{"kind":"sheet","tab":"Lista","tabs":1,"rows":[[{"v":"Categoria","t":"s","format":{"bold":true}},{"v":"Item","t":"s","format":{"bold":true}},{"v":"Por que eu gosto","t":"s","format":{"bold":true}},{"v":"Nota","t":"s","format":{"bold":true}}],[{"v":"Trabalho","t":"s"},{"v":"Dados bem organizados","t":"s"},{"v":"Dá pra confiar e responder rápido","t":"s"},{"v":10,"t":"n"}]],"rowCount":14,"colCount":4,"frozenRows":0,"colWidths":[96,96,96,96]},"changed":{"tabId":"tab_01m7vbfp1gs7475bwme94gxc54","ranges":["A1:D1","C14:D14"]},"botId":"boss","callId":"call_q2_oLHEggAY7"}
        """#
        let data = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let event = try XCTUnwrap(BlockEvent(type: "block.updated", data: data, fallbackBotID: "boss"))
        guard case .sheet(let preview) = event.preview else {
            return XCTFail("sheet preview did not decode")
        }
        XCTAssertEqual(preview.rows.count, 2)
        XCTAssertEqual(preview.rows[0][0].format?.bold, true)
        XCTAssertEqual(preview.rows[0][0].format?.type, .general)
        XCTAssertEqual(preview.rows[1][3].v, .number(10))
    }

    func testDownloadsDestinationKeepsNameAndAvoidsOverwrite() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = try DownloadsFolder.destination(for: "Coisas que eu gosto.xlsx", in: folder)
        XCTAssertEqual(first.lastPathComponent, "Coisas que eu gosto.xlsx")
        try Data([1]).write(to: first)
        let second = try DownloadsFolder.destination(for: "Coisas que eu gosto.xlsx", in: folder)
        XCTAssertEqual(second.lastPathComponent, "Coisas que eu gosto 2.xlsx")
        XCTAssertEqual(DownloadsFolder.cleanName("a/b:c.csv"), "a-b-c.csv")
    }
}
