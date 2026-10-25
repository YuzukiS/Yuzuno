# Yuzuno for iPhone

An iPhone app that shows your Workspace: the same web UI, the same Core, the same agents. Like the [desktop app](../desktop/README.md), it is a window and nothing more. Its connection page takes your Workspace's address and checks that a Yuzuno Core answers there; the app then opens that Core's own page. Codex, the Workspace database and your agents stay on the computer that runs Core. Closing the app stops nothing.

The address must be an HTTPS origin on a host other than the iPhone, such as the Core's Tailnet address (`https://core.example.ts.net`). The iPhone itself must be on that private network. Plain HTTP is never accepted: an iPhone's `localhost` is the iPhone. How a Core is reached over HTTPS from a phone is not set up by this app (see [Install a Linux Core](../docs/independent-core.md)).

On an iPhone the app stays upright for now: turned sideways in the Simulator, the page kept the upright safe area, with nothing at the sides where the Dynamic Island is, and why is not known yet. The window shows only this app's own pages and the Core you connected to, by origin. A link to anywhere else is not opened in it: a web page or mail link opens in Safari or Mail, and any other link opens nowhere. The Core's pages get no app permissions. They can read one value the app gives every page, the version it was built as, which Settings → Runtime shows; an older app gives none. The address you connect to is saved on the iPhone and filled in at the next launch; one tap opens it, and you can change it first.

A link that opens a new window on a computer (`target="_blank"`), such as a GitHub link or an attachment, opens in Safari or Mail by the same rule, since the app opens no second window. That includes the Core's own attachments. Safari has its own cookies and storage, not the app's.

## What it is not yet

- It adds no function that the Workspace's Home Screen web app (Safari, **Add to Home Screen**) lacks. It is the native container for what may follow: photo input, sharing to Yuzuno, notifications. Notifications would need Apple's paid Developer Program.
- It is not on the App Store or TestFlight. There is no installable build for anyone's iPhone: an iPhone runs only apps signed for it.

## Build

Every iOS build needs a Mac with **Xcode**; the Command Line Tools alone are not enough. Every `tauri ios` command runs only on macOS ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#ios), [CLI reference](https://v2.tauri.app/reference/cli/)). You also need the Rust iOS targets and the Tauri CLI version that `Cargo.lock` pins:

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cargo install tauri-cli --version 2.12.3 --locked
cd ios
cargo tauri ios init      # makes the Xcode project in gen/apple (not kept in the repository yet)
```

`cargo test` runs the app's own rules (the address, what the window opens and what goes to Safari or Mail) on the Mac.

### iOS Simulator

```sh
cargo tauri ios build --no-sign --target aarch64-sim
```

This builds `gen/apple/build/arm64-sim/Yuzuno.app`, unsigned, which the Simulator runs: drag it onto a running Simulator. `cargo tauri ios dev` builds and opens it in one step. The Simulator runs on the Mac and does not replicate a physical device ([Apple](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)). Your Workspace must be reachable from the Mac at the HTTPS address you enter.

The [iOS workflow](../.github/workflows/ios.yml) makes this same Simulator build on a GitHub-hosted Mac for every pull request that changes `ios/`. It checks that the packaged iPhone app is upright only, then runs the smoke test in an iPhone Simulator: the app starts, its connection page shows, and the app refuses a plain HTTP address itself. No Core is reached. The app's checksum and the commit it was built from are in the run's summary; the only upload is two screenshots of the connection page, kept for 3 days. It uses no secret and signs nothing.

#### The UI checks on a Mac

`uitests/run.sh` runs the UI checks in a Simulator of their own, on the installed iOS runtime that matches the active Xcode's Simulator SDK (it stops if there is none), and deletes that Simulator afterwards, so a Mac's other Simulators are left alone. It needs Xcode and xcodegen, and Node.js for `full` and `safari`; it installs nothing. For repeated runs in one round of checks, `YUZUNO_DEVICE=<udid>` uses a Simulator kept for the round instead, which must run that same runtime and which it does not create, shut down or delete, and `YUZUNO_DERIVED_DATA=<dir>` keeps the tests' build between runs.

```sh
uitests/run.sh smoke gen/apple/build/arm64-sim/Yuzuno.app /tmp/yuzuno-smoke
uitests/web-build.sh /tmp/yuzuno-web
YUZUNO_UI_DIST=/tmp/yuzuno-web uitests/run.sh full gen/apple/build/arm64-sim/Yuzuno.app /tmp/yuzuno-full
```

Give each run its own output directory: it gets `screenshots/`, `frames.txt` and `checks.xcresult`, and in `full` and `safari` also `phone-measure.jsonl` and `page-server.log`. `smoke` is what CI runs. `full` also turns the phone, opens the keyboard and closes it again, tries an address nothing answers, and opens Mobile Safari beside the app with the same page and the web UI on a synthetic Workspace (`web/tools/phone-fixture-server.mjs`, on the Mac's 127.0.0.1 only). `uitests/run.sh safari <out>` (with `YUZUNO_UI_DIST`) runs only the Mobile Safari part, without building or installing the app, so it shows nothing about the app itself. In Mobile Safari each page measures itself after every change, into `phone-measure.jsonl`. An exported `YUZUNO_INJECT=<file>` reaches the page server through the environment, and the server adds that script to every page it serves: the way a round measures something the fixture does not measure itself. `web-build.sh` builds `web/` from this checkout's committed files in a temporary directory, which it removes, so the checkout gets no `node_modules`. npm's cache is in that directory too, so each build downloads the packages again. These are Simulator results, not an iPhone's.

### Your own iPhone

Only you can do this, on your Mac, with your own Apple Account; nothing here is signed for you.
1. Pair the iPhone with the Mac and trust the Mac when the iPhone asks. Then turn on **Developer Mode** under **Settings → Privacy & Security**; the iPhone restarts and asks for its passcode ([Apple](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)). Do this before the rest: until it is on, Xcode does not register the device, and no development provisioning profile is made for it.
2. Open the project: `cargo tauri ios build --open`, or `cargo tauri ios dev --open`.
3. In Xcode, under **Settings → Apple Accounts**, sign in with your Apple Developer Program account or your personal Apple Account.
4. In the app target's **Signing & Capabilities**, turn on automatic signing and choose your team. The bundle identifier `dev.yuzuno.ios` may need to be changed to one of your own, since it must be unique.
5. Build it from a terminal, not from Xcode:

   ```sh
   APPLE_DEVELOPMENT_TEAM=<your team id> cargo tauri ios build --target aarch64
   ```

   Running the app from Xcode instead fails: the project's **Build Rust Code** phase needs `tauri ios dev` or `tauri ios build` to be running, and ends with `failed to read … cli-options-server.json`. The team id is the **OU** field of your development certificate, not the number in its name; `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject` prints both.
6. Install what it built, and trust the developer on the iPhone under **Settings → General → VPN & Device Management**:

   ```sh
   xcrun devicectl device install app --device <udid> gen/apple/build/arm64/Yuzuno.ipa
   ```

`tauri ios dev` serves the frontend from the Mac over the local network: an app installed that way asks for local network permission and stops working away from the Mac. `tauri ios build` packs the connection page into the app instead, so it keeps working on its own.

Signing uses a private key in your login keychain, so it has to run in your own graphical session. Over SSH on one Mac, `codesign` ended with `errSecInternalComponent` while `security` reported `User interaction is not allowed.`; installing the built app needs no keychain.

An app signed with a free personal team stops launching after about seven days. Building and installing it again from the Mac is what brings it back.

Installing on iPhones without your Mac (ad hoc or TestFlight) needs the paid Apple Developer Program ([Apple](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices), [Tauri](https://v2.tauri.app/distribute/sign/ios/)).
