import Foundation
import XCTest
@testable import RunelayBots

final class ScribeCommitTests: XCTestCase {
    func testReadsLanguageAndWordConfidence() throws {
        let json = try XCTUnwrap(JSONValue.parse("""
        {"message_type":"committed_transcript_with_timestamps","text":"oi tudo","language_code":"por","words":[{"text":"oi","type":"word","logprob":-0.1},{"text":" ","type":"spacing","logprob":-9},{"text":"tudo","type":"word","logprob":-0.3}]}
        """))
        let commit = ScribeCommit(json: json)
        XCTAssertEqual(commit.text, "oi tudo")
        XCTAssertEqual(commit.language, "por")
        XCTAssertEqual(try XCTUnwrap(commit.confidence), exp(-0.2), accuracy: 0.0001)
    }

    func testPlainCommitHasNoHints() throws {
        let json = try XCTUnwrap(JSONValue.parse("{\"message_type\":\"committed_transcript\",\"text\":\"oi\"}"))
        XCTAssertEqual(ScribeCommit(json: json), ScribeCommit(text: "oi"))
    }

    func testMergesSegmentsOfOneTurn() {
        let merged = ScribeCommit.merged([
            ScribeCommit(text: "a", language: "por", confidence: 0.9),
            ScribeCommit(text: "b", language: "eng", confidence: 0.3),
        ])
        XCTAssertEqual(merged?.text, "a b")
        XCTAssertNil(merged?.language)
        XCTAssertEqual(try XCTUnwrap(merged?.confidence), 0.6, accuracy: 0.0001)
        XCTAssertNil(ScribeCommit.merged([]))
    }
}
