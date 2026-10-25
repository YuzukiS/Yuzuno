import XCTest

/// The Yuzuno app as run.sh installs it in a Simulator of its own: its
/// connection page in the app's WKWebView, answered by the app's own
/// commands. No Core is reached. On a Mac (run.sh full), also measured, and
/// Mobile Safari beside it with the same page and the web UI on a synthetic
/// Workspace; run.sh safari opens only Mobile Safari's part. A passing check
/// is a Simulator result, not an iPhone's.
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

    /// What the page shows, for a failure's message.
    ///
    /// One snapshot, and nothing resolved by position in it. Reading every
    /// static text by index (allElementsBoundByIndex) asks for element N of a
    /// collection that a long conversation changes between the snapshot and
    /// the read: the read then fails with "No matches found for Element at
    /// index N". Because this runs only to describe an assertion that has
    /// already failed, that second failure replaced the first one and hid
    /// which assertion broke.
    private func page(in app: XCUIApplication? = nil) -> String {
        let app = app ?? yuzuno
        let tree = app.debugDescription
        // The whole tree beside the screenshots, since a page of this size is
        // longer than a failure message can carry and the part that explains a
        // failure is often past any prefix of it.
        if let directory = ProcessInfo.processInfo.environment["YUZUNO_SCREENSHOTS"] {
            let stamp = ISO8601DateFormatter().string(from: Date())
                .replacingOccurrences(of: ":", with: "")
            let file = URL(fileURLWithPath: directory)
                .appendingPathComponent("tree-\(stamp).txt")
            try? tree.write(to: file, atomically: true, encoding: .utf8)
        }
        return "page: " + tree.prefix(4000)
    }

    /// Safari's composer: the text view the page gives the label
    /// "Message Mori".
    ///
    /// Read from the accessibility tree of this page on a Mac, not assumed:
    /// `TextView, label: 'Message Mori', placeholderValue: 'A task, a
    /// question, a new idea for Mori…'`. Matching every descendant of the
    /// tree instead (`descendants(matching: .any)`) did not resolve within
    /// 30 s on a conversation of 1408 turns. The label matters as much as the
    /// type: the only other text element of the window is Safari's own
    /// address bar (`TextField, label: 'Address'`), which a query by type
    /// alone would take instead.
    private func composer(in app: XCUIApplication) -> XCUIElement {
        app.textViews["Message Mori"]
    }

    /// The app launched afresh: its page with an empty field, as no address
    /// was ever connected here.
    private func freshPage() {
        yuzuno.terminate()
        yuzuno.launch()
        XCTAssertTrue(message(containing: "Enter your workspace address").waitForExistence(timeout: 60), page())
    }

    /// Saves the screen as <name>.png where run.sh asks (YUZUNO_SCREENSHOTS);
    /// nothing elsewhere. Its time goes in the frames file, to set it beside
    /// the pages' own measurements (their "at").
    private func screenshot(_ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["YUZUNO_SCREENSHOTS"] else { return }
        let file = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
        XCTAssertNoThrow(try XCUIScreen.main.screenshot().pngRepresentation.write(to: file))
        note("screenshot \(name).png at \(ISO8601DateFormatter().string(from: Date()))")
    }

    /// One line in the frames file run.sh prints (YUZUNO_FRAMES).
    private func note(_ line: String) {
        guard let path = ProcessInfo.processInfo.environment["YUZUNO_FRAMES"] else { return }
        let data = Data((line + "\n").utf8)
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            handle.closeFile()
        } else {
            XCTAssertNoThrow(try data.write(to: URL(fileURLWithPath: path)))
        }
    }

    /// Writes where the page's parts are, in points, as the accessibility
    /// tree sees them, to the file run.sh prints (YUZUNO_FRAMES).
    private func record(_ label: String, in app: XCUIApplication) {
        guard ProcessInfo.processInfo.environment["YUZUNO_FRAMES"] != nil else { return }
        let parts: [(String, XCUIElement)] = [
            ("window", app.windows.firstMatch),
            // Left-aligned at the body's padding, unlike the centred main column.
            ("wordmark", text(containing: "yuzuno", in: app)),
            ("eyebrow", text(containing: "A little room", in: app)),
            ("heading", text(containing: "Your workspace", in: app)),
            ("field", app.textFields.firstMatch),
        ]
        for (name, element) in parts {
            note("\(label) \(name): \(element.exists ? "\(element.frame)" : "missing")")
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

    /// Every run, CI's smoke included (run.sh smoke): the app starts, shows
    /// its connection page in its WKWebView, and refuses a plain HTTP address
    /// itself (core_url.rs, through connect_core).
    func testLaunchAndTheAppsOwnRefusal() {
        // A fresh install has no saved Workspace, and the page found the app's bridge.
        freshPage()
        XCTAssertTrue(yuzuno.textFields.firstMatch.exists, page())
        drawn(in: yuzuno)
        screenshot("app-portrait")
        enter("http://core.example.ts.net")
        XCTAssertTrue(message(containing: "HTTPS address").waitForExistence(timeout: 20), page())
        screenshot("app-refused")
    }

    /// On a Mac with Xcode (run.sh full): where the page's parts are upright,
    /// with the phone turned (the iPhone app stays upright, Info.ios.plist),
    /// with the keyboard open and closed again, and an address nothing answers.
    func testTheAppMeasured() throws {
        guard ProcessInfo.processInfo.environment["YUZUNO_EXPLORE"] != nil else {
            throw XCTSkip("run.sh full only")
        }
        freshPage()
        drawn(in: yuzuno)
        record("app portrait", in: yuzuno)

        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        drawn(in: yuzuno)
        record("app rotated", in: yuzuno)
        screenshot("app-rotated")
        let window = yuzuno.windows.firstMatch.frame
        XCTAssertLessThan(window.width, window.height, "the window turned: \(window)")
        XCUIDevice.shared.orientation = .portrait
        sleep(2)

        enter("http://core.example.ts.net")
        XCTAssertTrue(message(containing: "HTTPS address").waitForExistence(timeout: 20), page())
        record("app keyboard", in: yuzuno)
        screenshot("app-keyboard")
        // The keyboard closed again with its bar's Done: the status bar's
        // backdrop follows the visual viewport back (connection.js) and
        // covers nothing of the page.
        let done = yuzuno.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "no Done on the keyboard's bar; \(page())")
        done.tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: yuzuno.keyboards.firstMatch)
        wait(for: [closed], timeout: 10)
        sleep(2)
        record("app keyboard closed", in: yuzuno)
        screenshot("app-keyboard-closed")

        // An HTTPS address nothing answers: 192.0.2.1 is a documentation
        // address (RFC 5737). The health check gives up within its 4 s, and
        // the address can be corrected. From a fresh page: a tap puts the
        // cursor where it lands, so the last address is not cleared by keys.
        freshPage()
        enter("https://192.0.2.1")
        XCTAssertTrue(message(containing: "not reachable").waitForExistence(timeout: 30), page())
        XCTAssertTrue(yuzuno.buttons["Connect"].isEnabled, page())
    }

    /// The pages measure themselves after each change, and again 2 s and 6 s
    /// later (web/tools/phone-measure.js): wait past that.
    private func settle() {
        sleep(7)
    }

    private func turn(_ orientation: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = orientation
        settle()
    }

    /// A first-run sheet a fresh Simulator's Safari may show.
    private func pastFirstRun() {
        for label in ["Continue", "Not Now"] where safari.buttons[label].exists {
            safari.buttons[label].tap()
        }
    }

    /// Mobile Safari in the same Simulator, beside the app (run.sh full) or
    /// alone (run.sh safari): the same connection page, then the web UI on a
    /// synthetic Workspace, both served on this Mac's 127.0.0.1 by
    /// web/tools/phone-fixture-server.mjs (no Core, no account). Upright and
    /// sideways, the composer with the keyboard open, and the Settings dialog.
    /// The pages measure themselves, into run.sh's phone-measure.jsonl.
    /// Outside the app the connection page offers nothing to submit, so the
    /// keyboard is opened in the web UI only.
    func testThePagesInSafari() throws {
        guard let base = ProcessInfo.processInfo.environment["YUZUNO_SAFARI"], let root = URL(string: base) else {
            throw XCTSkip("run.sh full or safari only: they serve Safari's pages")
        }
        safari.open(URL(string: "connection/", relativeTo: root)!.absoluteURL)
        pastFirstRun()
        XCTAssertTrue(text(containing: "Your workspace", in: safari).waitForExistence(timeout: 60), page(in: safari))
        settle()
        record("safari connection portrait", in: safari)
        screenshot("safari-connection-portrait")
        turn(.landscapeLeft)
        record("safari connection landscape", in: safari)
        screenshot("safari-connection-landscape")
        turn(.portrait)

        safari.open(root)
        // The agent list's "Open Mori" is there when the app opens on the
        // list, and not when it opens in that conversation already, as it
        // does on the conversation fixtures: this page answered with Mori's
        // turns and its composer and no such button, and waiting 60 s for one
        // failed the check before anything of the conversation was looked at.
        // Take the button when it is there; otherwise the conversation that
        // is open is the one to measure. Which of those happened is carried
        // into the failure below: a list too slow to draw the button within
        // the wait leaves the same "no composer" as a page that never had
        // one, and that reads as the wrong cause.
        let mori = safari.buttons["Open Mori"]
        let listed = mori.waitForExistence(timeout: 20)
        if listed {
            mori.tap()
        }
        let opened = listed ? "tapped Open Mori" : "no Open Mori within 20 s: a conversation was expected to be open already, or the list was slower than that"
        let composer = composer(in: safari)
        XCTAssertTrue(composer.waitForExistence(timeout: 30),
                      "no composer in the conversation (\(opened)); \(page(in: safari))")
        settle()
        screenshot("safari-web-portrait")
        turn(.landscapeLeft)
        screenshot("safari-web-landscape")
        turn(.portrait)

        composer.tap()
        XCTAssertTrue(safari.keyboards.firstMatch.waitForExistence(timeout: 10), "no keyboard; \(page(in: safari))")
        settle()
        screenshot("safari-web-keyboard")
        // Sideways with the keyboard still open. The turn used to be followed
        // straight away by the turn back, so this state was never on a
        // screenshot, and nothing measured it while it was on screen.
        turn(.landscapeLeft)
        screenshot("safari-web-keyboard-landscape")
        turn(.portrait)
        // Upright again with the keyboard still open: run 40061280002, with
        // web/ from before #150, measured the composer below what could be
        // seen here for about 6 s.
        screenshot("safari-web-keyboard-upright-again")
        // What that screenshot's name claims, read here and asserted at the
        // end. setUp keeps continueAfterFailure false, so an assertion here
        // would end the test before the states after it were ever reached or
        // photographed; reading now and asserting last keeps each observation
        // at its own moment and still collects the rest.
        let send = safari.buttons["Send message"]
        let keys = safari.keyboards.firstMatch
        // isHittable is not the check to make here: XCUITest reported Send
        // hittable in the same round in which the page measured it below the
        // visual viewport, so it would pass while Send sat under the
        // keyboard. What the keyboard covers is asked of the frames instead.
        // Not the keyboard's frame on its own: measured upright again, Send
        // was 86 points above it and still under Safari's own bar over the
        // keyboard, the one Done sits in, which is what the page sees as the
        // bottom of its visual viewport. Both are asked about.
        let keyboardFrame = keys.exists ? keys.frame : .null
        let bar = safari.buttons["Done"]
        let barFrame = bar.exists ? bar.frame : .null
        let sendFrame = send.exists ? send.frame : .null
        let covered = sendFrame.intersects(keyboardFrame) || sendFrame.intersects(barFrame)
            || (barFrame != .null && sendFrame.maxY > barFrame.minY)
        let upright = (
            keyboard: keys.exists,
            composer: composer.isHittable,
            send: send.exists,
            sendClear: send.exists && keys.exists && !covered,
            frames: "Send \(sendFrame), keyboard \(keyboardFrame), Done \(barFrame)"
        )
        note("safari keyboard upright again: \(upright.frames)")
        // The keyboard bar's Done ends editing; the page measures the focus
        // leaving. It has to be there: passing over it silently left the
        // keyboard up for everything after it.
        let done = safari.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10),
                      "no Done on the keyboard's bar; \(page(in: safari))")
        done.tap()
        settle()

        let settings = safari.buttons["Settings and updates"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10), page(in: safari))
        settings.tap()
        settle()
        screenshot("safari-web-dialog")
        turn(.landscapeLeft)
        turn(.portrait)
        // Closed again: the dialog used to stay open to the end, so every
        // measurement after it opened read the dialog over the composer, and
        // none read the conversation it goes back to. Closed by the dialog's
        // own close button: Escape needs a hardware keyboard, which a
        // Simulator's Safari has none of here.
        let close = safari.buttons["Close dialog"]
        XCTAssertTrue(close.waitForExistence(timeout: 10),
                      "no Close dialog in the Settings dialog; \(page(in: safari))")
        close.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 20),
                      "no composer after the dialog closed; \(page(in: safari))")
        settle()
        screenshot("safari-web-dialog-closed")

        // Upright again with the keyboard open, asserted now that every state
        // has been reached and photographed; the screenshot on its own
        // asserted nothing. These failed when they were written, on web/
        // before #187 (3b5fc72): the composer grew taller than the short
        // shell left room for and Send went under the bar the keyboard puts
        // over the page. Since #187 they pass, measured on an iOS Simulator
        // as Send (333, 372, 44, 44), clear of Done (343, 488, 38, 38). They
        // stay plain assertions, with no expected failure around them: that
        // defect coming back is a failure, not something to record as known.
        XCTAssertTrue(upright.keyboard, "the keyboard closed on the way back to upright")
        XCTAssertTrue(upright.composer, "no composer to reach with the keyboard up, upright again")
        XCTAssertTrue(upright.send, "no Send with the keyboard up, upright again")
        XCTAssertTrue(upright.sendClear,
                      "Send is under what the keyboard puts over the page, upright again: \(upright.frames)")
    }
}
