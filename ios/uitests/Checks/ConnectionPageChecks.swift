import XCTest

/// The Yuzuno app as ios.yml installs it in this Simulator: its connection
/// page in the app's WKWebView, answered by the app's own commands. No Core
/// is reached. A passing check is a Simulator result, not an iPhone's.
final class ConnectionPageChecks: XCTestCase {
    private let yuzuno = XCUIApplication(bundleIdentifier: "dev.yuzuno.ios")

    override func setUp() {
        continueAfterFailure = false
    }

    private func message(containing text: String) -> XCUIElement {
        yuzuno.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func enter(_ address: String) {
        let field = yuzuno.textFields.firstMatch
        field.tap()
        field.clearAndType(address)
        yuzuno.buttons["Connect"].tap()
    }

    func testTheConnectionPageAnswersThroughTheApp() {
        yuzuno.launch()
        // A fresh install has no saved Workspace, and the page found the app's bridge.
        XCTAssertTrue(message(containing: "Enter your workspace address").waitForExistence(timeout: 60))
        XCTAssertTrue(yuzuno.textFields.firstMatch.exists, "the address field")

        // The refusal is the app's own (core_url.rs), through connect_core.
        enter("http://core.example.ts.net")
        XCTAssertTrue(message(containing: "HTTPS address").waitForExistence(timeout: 20))

        // An HTTPS address nothing answers: 192.0.2.1 is a documentation
        // address (RFC 5737). The health check gives up within its 4 s, and
        // the address can be corrected.
        enter("https://192.0.2.1")
        XCTAssertTrue(message(containing: "not reachable").waitForExistence(timeout: 30))
        XCTAssertTrue(yuzuno.buttons["Connect"].isEnabled)
    }
}

private extension XCUIElement {
    func clearAndType(_ text: String) {
        if let value = value as? String, !value.isEmpty, value != placeholderValue {
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        typeText(text)
    }
}
