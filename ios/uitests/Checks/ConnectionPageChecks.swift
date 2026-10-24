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

    /// What the connection page shows, for a failure's message: its text
    /// and the address field's value (nothing but this app's own page).
    private func page() -> String {
        let texts = yuzuno.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        let field = yuzuno.textFields.firstMatch
        let value = field.exists ? String(describing: field.value ?? "") : "(no field)"
        return "page: \(texts.joined(separator: " | ")); field: \(value)"
    }

    /// The app launched afresh: its page with an empty field, as no address
    /// was ever connected here.
    private func freshPage() {
        yuzuno.terminate()
        yuzuno.launch()
        XCTAssertTrue(message(containing: "Enter your workspace address").waitForExistence(timeout: 60), page())
    }

    /// Saves the screen as <name>.png where ios.yml asks (YUZUNO_SCREENSHOTS);
    /// nothing elsewhere. Only the connection page is ever on screen here.
    private func screenshot(_ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["YUZUNO_SCREENSHOTS"] else { return }
        let file = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
        XCTAssertNoThrow(try XCUIScreen.main.screenshot().pngRepresentation.write(to: file))
    }

    /// Writes where the page's parts are, in points, to the file ios.yml
    /// prints (YUZUNO_FRAMES): how the safe area is applied, as numbers.
    private func frames(_ orientation: String) {
        guard let path = ProcessInfo.processInfo.environment["YUZUNO_FRAMES"] else { return }
        let parts: [(String, XCUIElement)] = [
            ("window", yuzuno.windows.firstMatch),
            ("eyebrow", message(containing: "A little room")),
            ("heading", message(containing: "Your workspace")),
            ("field", yuzuno.textFields.firstMatch),
        ]
        let lines = parts.map { name, element in "\(orientation) \(name): \(element.exists ? "\(element.frame)" : "missing")" }
        let text = lines.joined(separator: "\n") + "\n"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            handle.closeFile()
        } else {
            XCTAssertNoThrow(try text.write(toFile: path, atomically: true, encoding: .utf8))
        }
    }

    /// Waits until the page is drawn, not only in the accessibility tree.
    private func drawn() {
        XCTAssertTrue(message(containing: "Your workspace").waitForExistence(timeout: 10), page())
        sleep(2)
    }

    /// Types into the empty field and connects.
    private func enter(_ address: String) {
        let field = yuzuno.textFields.firstMatch
        field.tap()
        field.typeText(address)
        yuzuno.buttons["Connect"].tap()
    }

    func testTheConnectionPageAnswersThroughTheApp() {
        // A fresh install has no saved Workspace, and the page found the app's bridge.
        freshPage()
        XCTAssertTrue(yuzuno.textFields.firstMatch.exists, page())
        drawn()
        frames("portrait")
        screenshot("connection-portrait")

        // The safe area in landscape: the notch is then at a side.
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(yuzuno.textFields.firstMatch.waitForExistence(timeout: 10), page())
        drawn()
        frames("landscape")
        screenshot("connection-landscape")
        XCUIDevice.shared.orientation = .portrait
        sleep(2)

        // The refusal is the app's own (core_url.rs), through connect_core.
        enter("http://core.example.ts.net")
        XCTAssertTrue(message(containing: "HTTPS address").waitForExistence(timeout: 20), page())
        screenshot("connection-refused")

        // An HTTPS address nothing answers: 192.0.2.1 is a documentation
        // address (RFC 5737). The health check gives up within its 4 s, and
        // the address can be corrected. From a fresh page: a tap puts the
        // cursor where it lands, so the last address is not cleared by keys.
        freshPage()
        enter("https://192.0.2.1")
        XCTAssertTrue(message(containing: "not reachable").waitForExistence(timeout: 30), page())
        XCTAssertTrue(yuzuno.buttons["Connect"].isEnabled, page())
    }
}
