import Foundation
import XCTest

@testable import RunelayBots

final class DeliveryDeadlineTests: XCTestCase {
    func testReturnsValueBeforeDeadline() async throws {
        let value = try await Deadline.run(seconds: 2) { "ok" }
        XCTAssertEqual(value, "ok")
    }

    func testThrowsWhenOperationHangs() async {
        do {
            _ = try await Deadline.run(seconds: 0.1) {
                try await Task.sleep(for: .seconds(30))
                return "late"
            }
            XCTFail("expected deadline")
        } catch {
            XCTAssertEqual(error as? Deadline.Exceeded, Deadline.Exceeded())
            XCTAssertEqual(ErrorMessage.describe(error), "O servidor não respondeu a tempo.")
        }
    }

    func testStreamingSessionAllowsManyConnectionsPerHost() {
        XCTAssertGreaterThanOrEqual(HTTPSessions.streaming.configuration.httpMaximumConnectionsPerHost, 32)
    }
}
