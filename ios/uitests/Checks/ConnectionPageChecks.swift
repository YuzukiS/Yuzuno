import XCTest

/// The Yuzuno app as ios.yml installs it in this Simulator: its connection
/// page in the app's WKWebView, answered by the app's own commands. No Core
/// is reached. Then the same page in Mobile Safari, for comparison. A passing
/// check is a Simulator result, not an iPhone's.
final class ConnectionPageChecks: XCTestCase {
    private let yuzuno = XCUIApplication(bundleIdentifier: "dev.yuzuno.ios")
    private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func text(containing text: String, in app: XCUIApplication) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func message(containing text: String) -> XCUIElement {
        self.text(containing: text, in: yuzuno)
    }

    /// What the connection page shows, for a failure's message: its text
    /// and the address field's value (nothing but this app's own page).
    private func page(in app: XCUIApplication? = nil) -> String {
        let app = app ?? yuzuno
        let texts = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        let field = app.textFields.firstMatch
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
    /// prints (YUZUNO_FRAMES), with Safari's probe line when there is one.
    private func record(_ label: String, in app: XCUIApplication) {
        guard let path = ProcessInfo.processInfo.environment["YUZUNO_FRAMES"] else { return }
        let parts: [(String, XCUIElement)] = [
            ("window", app.windows.firstMatch),
            // Left-aligned at the body's padding, unlike the centred main column.
            ("wordmark", text(containing: "yuzuno", in: app)),
            ("eyebrow", text(containing: "A little room", in: app)),
            ("heading", text(containing: "Your workspace", in: app)),
            ("field", app.textFields.firstMatch),
        ]
        var lines = parts.map { name, element in "\(label) \(name): \(element.exists ? "\(element.frame)" : "missing")" }
        let probe = text(containing: "probe:", in: app)
        if probe.exists { lines.append("\(label) \(probe.label)") }
        let report = lines.joined(separator: "\n") + "\n"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data(report.utf8))
            handle.closeFile()
        } else {
            XCTAssertNoThrow(try report.write(toFile: path, atomically: true, encoding: .utf8))
        }
    }

    /// Waits until the page is drawn, not only in the accessibility tree.
    private func drawn(in app: XCUIApplication) {
        XCTAssertTrue(text(containing: "Your workspace", in: app).waitForExistence(timeout: 10), page(in: app))
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
        drawn(in: yuzuno)
        record("app portrait", in: yuzuno)
        screenshot("app-portrait")

        // The iPhone app is portrait only for now (Info.ios.plist, Lead 8305):
        // turning the phone leaves the window as it was.
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        drawn(in: yuzuno)
        record("app rotated", in: yuzuno)
        screenshot("app-rotated")
        let window = yuzuno.windows.firstMatch.frame
        XCTAssertLessThan(window.width, window.height, "the window turned: \(window)")
        XCUIDevice.shared.orientation = .portrait
        sleep(2)

        // The refusal is the app's own (core_url.rs), through connect_core.
        enter("http://core.example.ts.net")
        XCTAssertTrue(message(containing: "HTTPS address").waitForExistence(timeout: 20), page())
        screenshot("app-refused")

        // An HTTPS address nothing answers: 192.0.2.1 is a documentation
        // address (RFC 5737). The health check gives up within its 4 s, and
        // the address can be corrected. From a fresh page: a tap puts the
        // cursor where it lands, so the last address is not cleared by keys.
        freshPage()
        enter("https://192.0.2.1")
        XCTAssertTrue(message(containing: "not reachable").waitForExistence(timeout: 30), page())
        XCTAssertTrue(yuzuno.buttons["Connect"].isEnabled, page())
    }

    /// The same page in Mobile Safari, served on this Mac's 127.0.0.1 and
    /// opened by ios.yml before the tests: what WebKit gives a page there,
    /// upright and sideways, beside what the app gives it. Outside the app
    /// the page offers nothing to submit, so the keyboard is not opened here.
    func testTheSamePageInSafari() throws {
        guard ProcessInfo.processInfo.environment["YUZUNO_SAFARI"] != nil else {
            throw XCTSkip("ios.yml opens the page in Safari; not set here")
        }
        safari.activate()
        XCTAssertTrue(text(containing: "probe:", in: safari).waitForExistence(timeout: 60), page(in: safari))
        drawn(in: safari)
        record("safari portrait", in: safari)
        screenshot("safari-portrait")

        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        drawn(in: safari)
        record("safari landscape", in: safari)
        screenshot("safari-landscape")
        XCUIDevice.shared.orientation = .portrait
    }
}
