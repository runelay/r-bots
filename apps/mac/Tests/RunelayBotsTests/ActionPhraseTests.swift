import Foundation
import XCTest

@testable import RunelayBots

final class ActionPhraseTests: XCTestCase {
    private func call(name: String, kind: String = "tool", label: String?, input: [String: JSONValue] = [:]) -> ToolCall {
        ToolCall(id: "c1", name: name, kind: kind, label: label, input: .object(input), status: .requested, output: nil, errorMessage: nil)
    }

    func testStripPromptDropsAskPrefixInBothLanguages() {
        XCTAssertEqual(ActionPhrase.stripPrompt("Posso abrir o terminal?"), "Abrir o terminal")
        XCTAssertEqual(ActionPhrase.stripPrompt("Can I open the terminal?"), "Open the terminal")
        XCTAssertEqual(ActionPhrase.stripPrompt("Rodar git push?\ndetalhe"), "Rodar git push")
    }

    func testDelegationNameFromEitherLabelOrStructuredTarget() {
        XCTAssertEqual(ActionPhrase.delegateName(call(name: "ana", kind: "agent", label: "Delegar para Ana")), "Ana")
        XCTAssertEqual(ActionPhrase.delegateName(call(name: "ana", kind: "agent", label: "Delegate to Ana")), "Ana")
        var linked = call(name: "ana", kind: "agent", label: "Something else")
        linked.delegation = DelegationLink(botID: "ana-id")
        XCTAssertEqual(ActionPhrase.delegateName(linked), "ana-id")
        XCTAssertEqual(ActionPhrase.delegateName(call(name: "ana", kind: "agent", label: nil, input: ["bot": .string("bia")])), "bia")
        XCTAssertEqual(ActionPhrase(call: call(name: "ana", kind: "agent", label: "Delegate to Ana")).object, "Ana")
    }

    func testBashUsesCommandPhraseOnlyWithoutDescription() {
        let english = ActionPhrase(call: call(name: "Bash", label: "Run bun test", input: ["command": .string("bun test")]))
        XCTAssertEqual(english.verb, CommandPhrase.describe("bun test")?.verb)
        let portuguese = ActionPhrase(call: call(name: "Bash", label: "Rodar bun test", input: ["command": .string("bun test")]))
        XCTAssertEqual(portuguese.verb, english.verb)
        let described = ActionPhrase(
            call: call(name: "Bash", label: "Run the server tests", input: ["command": .string("bun test"), "description": .string("Run the server tests")]))
        XCTAssertEqual(described.verb, "Run the server tests")
        XCTAssertTrue(ActionPhrase.isPlainCommand(.object(["description": .string("  ")])))
        XCTAssertFalse(ActionPhrase.isPlainCommand(.object(["description": .string("x")])))
    }

    func testCommandPhraseDescribesCommonCommands() {
        XCTAssertEqual(CommandPhrase.describe("bun test apps")?.verb, tr("Rodando os testes"))
        XCTAssertEqual(CommandPhrase.describe("cat src/app.ts")?.object, "app.ts")
        XCTAssertEqual(CommandPhrase.describe("rg 'needle' src")?.object, "needle")
        XCTAssertNil(CommandPhrase.describe("   "))
        XCTAssertNil(CommandPhrase.describe("make deploy"))
    }
}
