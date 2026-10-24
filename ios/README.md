# Yuzuno for iPhone

An iPhone app that shows your Workspace: the same web UI, the same Core, the same agents. Like the [desktop app](../desktop/README.md), it is a window and nothing more. Its connection page takes your Workspace's address and checks that a Yuzuno Core answers there; the app then opens that Core's own page. Codex, the Workspace database and your agents stay on the computer that runs Core. Closing the app stops nothing.

The address must be an HTTPS origin on a host other than the iPhone, such as the Core's Tailnet address (`https://core.example.ts.net`). The iPhone itself must be on that private network. Plain HTTP is never accepted: an iPhone's `localhost` is the iPhone. How a Core is reached over HTTPS from a phone is not set up by this app (see [Install a Linux Core](../docs/independent-core.md)).

On an iPhone the app stays upright for now: turned sideways in the Simulator, the page kept the upright safe area, with nothing at the sides where the Dynamic Island is, and why is not known yet. The window shows only this app's own pages and the Core you connected to, by origin. A link to anywhere else is not opened in it: a web page or mail link opens in Safari or Mail, and any other link opens nowhere. The Core's pages get no app permissions. The address you connect to is saved on the iPhone and filled in at the next launch; one tap opens it, and you can change it first.

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

`uitests/run.sh` runs the UI checks in a Simulator of their own, which it deletes afterwards, so a Mac's other Simulators are left alone. It needs Xcode and xcodegen, and Node.js for `full` and `safari`; it installs nothing.

```sh
uitests/run.sh smoke gen/apple/build/arm64-sim/Yuzuno.app /tmp/yuzuno-checks
uitests/web-build.sh /tmp/yuzuno-web
YUZUNO_UI_DIST=/tmp/yuzuno-web uitests/run.sh full gen/apple/build/arm64-sim/Yuzuno.app /tmp/yuzuno-checks
```

`smoke` is what CI runs. `uitests/run.sh safari <out>` (with `YUZUNO_UI_DIST`) runs only the Mobile Safari part, without building or installing the app. `full` also turns the phone, opens the keyboard, tries an address nothing answers, and opens Mobile Safari beside the app with the same page and the web UI on a synthetic Workspace (`web/tools/phone-fixture-server.mjs`, on the Mac's 127.0.0.1 only). Each page measures itself after every change; the lines are in `phone-measure.jsonl`. `web-build.sh` builds `web/` from this checkout's committed files in a temporary directory, which it removes, so the checkout gets no `node_modules`. These are Simulator results, not an iPhone's.

### Your own iPhone

Only you can do this, on your Mac, with your own Apple Account; nothing here is signed for you.
1. Open the project: `cargo tauri ios build --open`, or `cargo tauri ios dev --open`.
2. In Xcode, under **Settings → Apple Accounts**, sign in with your Apple Developer Program account or your personal Apple Account.
3. In the app target's **Signing & Capabilities**, turn on automatic signing and choose your team. The bundle identifier `dev.yuzuno.ios` may need to be changed to one of your own, since it must be unique.
4. Pair the iPhone with the Mac, choose it as the run destination, and run. Xcode registers the device and makes a development provisioning profile ([Apple](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)).
5. On the iPhone, turn on **Developer Mode** under **Settings → Privacy & Security**. The iPhone restarts and asks for its passcode ([Apple](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)).

Installing on iPhones without your Mac (ad hoc or TestFlight) needs the paid Apple Developer Program ([Apple](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices), [Tauri](https://v2.tauri.app/distribute/sign/ios/)).
