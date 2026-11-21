import Foundation
import XCTest

@testable import RunelayBots

final class LaunchFixesTests: XCTestCase {
    func testSetupFailureMapsOwnerExistsAndWrongCode() {
        XCTAssertEqual(SetupFailure(status: 409, code: "setup_closed"), .ownerExists)
        XCTAssertEqual(SetupFailure(status: 403, code: "setup_token_required"), .invalidSetupToken)
        XCTAssertNil(SetupFailure(status: 400, code: nil))
        XCTAssertTrue(SetupFailure.invalidSetupToken.errorDescription?.contains("setup.token") == true)
    }

    func testRepoPartsSplitsNameAndShortParent() {
        let parts = ActionPhrase.repoParts("~/projects/demo-tarefas/")
        XCTAssertEqual(parts.name, "demo-tarefas")
        XCTAssertEqual(parts.parent, "~/projects")
        XCTAssertNil(ActionPhrase.repoParts("demo").parent)
    }

    func testNotConfiguredOnlyFor503() {
        XCTAssertTrue(BotsClient.isNotConfigured(BotsClient.ClientError.http(503, nil)))
        XCTAssertFalse(BotsClient.isNotConfigured(BotsClient.ClientError.http(500, nil)))
        XCTAssertFalse(BotsClient.isNotConfigured(BotsClient.ClientError.invalidResponse))
    }
}
