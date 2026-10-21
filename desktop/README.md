# Yuzuno desktop client

Tauri is an independent native client. The intended arrangement is **Windows desktop + WSL Core**: Windows runs the window and WebView2; WSL owns Codex, repository paths, workspace SQLite, and web assets. Closing the desktop does not stop Core or its agents. The native client never starts Core, spawns Codex, opens the workspace database, or shares authentication directories across operating systems. Tauri keeps its ordinary WebView data in the desktop user's application-data directory, separate from Core's workspace database.

The same shell can run on Linux with that platform's Tauri prerequisites. Core itself has no Tauri, GTK, or WebKit dependency. Build only the desktop on the machine where the desktop should run; installing WebKit in WSL is unnecessary for a Windows desktop client.

## Windows desktop, WSL Core

In WSL, build the UI and Core, then run only Core:

```sh
cd ~/Yuzuno    # your checkout of this repository
npm --prefix web ci
npm --prefix web run build
cargo build --locked
python3 scripts/launch.py core
```

Core binds to `127.0.0.1:4317`. In ordinary WSL networking, a Windows application can reach a WSL server through `localhost`; no LAN listener or copied credentials are needed. This relies on the host's WSL networking configuration, so actual Windows-to-WSL connectivity still needs verification on the target machine. See [Microsoft's WSL networking documentation](https://learn.microsoft.com/en-us/windows/wsl/networking).

Build the native executable from **Windows PowerShell**, using a Windows checkout of this repository or the existing WSL source directory through `\\wsl.localhost\<distro>\home\<user>\Yuzuno`. Replace `<distro>` with the installed WSL distribution name (`wsl --list --quiet` lists it), and the path with your checkout's.

```powershell
Set-Location '\\wsl.localhost\<distro>\home\<user>\Yuzuno'
.\scripts\desktop.ps1
```

The script invokes Windows Cargo and writes its build output to `%LOCALAPPDATA%\Yuzuno\build\desktop` unless `CARGO_TARGET_DIR` is already set. It uses Cargo on `PATH` when available; otherwise it recognizes the dedicated Rust installation under `%LOCALAPPDATA%\Yuzuno\toolchains` and scopes that toolchain's environment to this invocation. It does not change global `PATH`, call WSL, start Core, or require `web/dist`, Node, Codex, or a workspace database on Windows. Dependencies are pinned in `desktop/Cargo.lock`.

The **build machine** needs Rust with an MSVC toolchain, the Microsoft C++ x64/x86 build tools, and a Windows SDK. The full Visual Studio IDE is unnecessary. The **runtime machine** needs WebView2; Windows 10/11 commonly already include it. This shell is plain HTML/CSS/JS plus Rust, so building or running it does not need Node, npm, or the Tauri CLI; only `-Bundle` (the installer) does. Follow the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows) for any missing dependencies.

For a release executable:

```powershell
.\scripts\desktop.ps1 -Release -BuildOnly
& "$env:LOCALAPPDATA\Yuzuno\build\desktop\release\yuzuno-desktop.exe"
```

The executable embeds the small connection page and can run without its source tree or Cargo. It fetches the actual workspace UI from Core. A bare executable is not updated in place; the installer described under [Desktop updates](#desktop-updates) is. Core is never bundled.

Every build the script starts runs in a Windows job object with a hard memory limit (`-MemoryLimitGB`, default 8): past it Windows fails the allocation, and closing the job ends every process left in it. Windows processes are outside any WSL memory limit, so this is their only bound. The script reports each build's exit status and peak memory.

## Choose a Core

Selection order is an explicit launch argument, then `YUZUNO_CORE_URL`, then the Core last connected from the connection page, then `http://127.0.0.1:4317`:

```powershell
.\scripts\desktop.ps1 -CoreUrl 'http://localhost:4321'
$env:YUZUNO_CORE_URL = 'http://localhost:4321'
.\scripts\desktop.ps1
# An existing executable needs no Rust installation:
.\scripts\desktop.ps1 -DesktopBin 'C:\Apps\Yuzuno\yuzuno-desktop.exe' -CoreUrl 'http://localhost:4321'
```

To use port 4321, launch Core separately with `python3 scripts/launch.py core --port 4321`. Direct native invocations support `--core-url URL` and `--core-url=URL` on either platform. HTTP is limited to loopback hosts; other hosts need HTTPS. Enter an origin only: no path, credentials, query, or fragment. HTTPS is an address capability, not an automatic remote deployment or authentication setup. For a Core on another computer, forward a local port over SSH and enter that loopback address; see [Install a Linux Core](../docs/independent-core.md#connect-from-another-computer).

The local connection page appears immediately using the same cream, yuzu, and leaf palette as the workspace. It checks `/api/health` with a four-second timeout before opening `/?shell=desktop`. If Core is offline or the address is wrong, the address field and retry button remain available. The **Workspace connection** button beside the connection status, or `Ctrl+,` while in the desktop workspace, returns to this page without disconnecting or stopping any agents. A Core connected from this page is saved in the app's data folder (`core.json`) and opened at the next launch that names no Core; a launch argument or `YUZUNO_CORE_URL` still comes first, and a mistaken one is shown rather than replaced by the saved Core. A saved address that is no longer valid is ignored; one that does not answer leaves the connection page open with its error and the address to change.

Native title-bar controls, a 1320 × 900 initial window, and a 940 × 650 minimum are retained. The actual GUI, events, API calls, and artifact paths all stay on the selected Core's origin. Workspace paths are paths on the Core host, so a Windows desktop connected to WSL displays Linux repository paths.

On Windows 11 the native caption, caption text, and border follow the workspace's light or dark palette. The Appearance settings also offer System, which resolves the WebView's system preference before synchronizing the native caption. The extra menu row is hidden, and the desktop toolbar is more compact; the operating system still owns dragging, resizing, minimize/maximize, accessibility, and Snap controls. Microsoft-maintained `windows-sys` bindings call [DWM's color attributes](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute); unsupported systems retain their normal caption colors. The window becomes visible only after the initial light caption and menu are configured. The embedded connection page remains light. No custom title-bar hit testing is introduced.

## macOS desktop, Core on another computer

The Mac app is a client only, as on Windows: Core, its Agents and Jobs, and the Workspace stay on the Core host (for example Linux in WSL). The Mac reaches Core through an SSH tunnel to Core's loopback port; Core is never opened to a network.

**Build** on an Apple silicon Mac with Xcode's command line tools and a rustup toolchain:

```sh
scripts/desktop-macos.sh --tools ~/Library/Caches/Yuzuno/toolchains --out ~/yuzuno-desktop-build --test
```

It builds the pinned Tauri CLI with cargo into `--tools` (nothing is installed globally), runs the desktop tests with `--test`, and writes `Yuzuno.app`, `Yuzuno_<version>_aarch64.dmg`, `Yuzuno.app.zip` and `build.json` to `--out`. `build.json` records the source commit, the tool versions, each file's SHA-256, and what `codesign`, `spctl` and `syspolicy_check` say about the app. Bundling uses `desktop/tauri.macos.conf.json`, which Tauri merges on macOS only.

**CI builds.** [`desktop-macos.yml`](../.github/workflows/desktop-macos.yml) runs the same script with `--test` on GitHub's standard Apple silicon runner (`macos-26`, arm64), with CI's pinned Rust:
- **A pull request** that changes `desktop/` or the script builds and tests it, and uploads nothing.
- **A candidate** is built only on request, and only from main after its CI has passed: `gh workflow run desktop-macos.yml --ref main`.
  - Its one artifact, `yuzuno-macos-arm64-<commit>-<attempt>`, holds the disk image, `Yuzuno.app.zip`, `build.json` and `SHA256SUMS`. It is kept 14 days, and nothing is published as a Release.
  - To check one, run `gh run download <run> -n <artifact>`, then `shasum -a 256 -c SHA256SUMS`. Compare the sums with those in the run's summary on GitHub, and check that `build.json`'s `sourceCommit` is the commit you expect.
  - The version inside is the source's (`desktop/tauri.conf.json`), not a release's. The commit and the SHA-256 identify a candidate.

**Signing.** The app is signed ad hoc: it has no Developer ID signature and is not notarized, because no Developer ID exists for this project. `codesign --verify` passes; Gatekeeper's assessment (`spctl --assess`) rejects it, and `syspolicy_check distribution` reports the ad hoc signature and the missing notarization ticket. A copy built on the Mac, or copied there without a quarantine attribute (for example over SSH), opens normally. A copy downloaded with a browser carries the quarantine attribute, and macOS refuses its first open. To allow this one app, open it once, then choose **Open Anyway** under System Settings, Privacy & Security, and confirm. That dialog has not been checked on macOS 27 yet. Leave Gatekeeper itself on.

**Install.** Open the disk image and drag `Yuzuno.app` to `/Applications` (an administrator account can write there), or to `~/Applications` for your account only. To check what you got, compare `shasum -a 256 Yuzuno.app/Contents/MacOS/yuzuno-desktop` with `app.executableSha256` in the build's `build.json`. The checked installs were copied out of the disk image into a folder of their own, not into either of these. The app keeps its saved Core in `~/Library/Application Support/dev.yuzuno.workspace/core.json`. Its other data is in `~/Library/WebKit/dev.yuzuno.workspace`, `~/Library/Caches/dev.yuzuno.workspace`, `~/Library/HTTPStorages/dev.yuzuno.workspace` and `~/Library/Saved Application State/dev.yuzuno.workspace.savedState`, and its defaults in `~/Library/Preferences/dev.yuzuno.workspace.plist`. To uninstall, quit it and delete the app, those folders and that file.

**Connect.** On the Mac, `scripts/mac-tunnel.sh start` forwards `127.0.0.1:5317` on the Mac to Core's port on the Core host, with its own key and a pinned host key (see the script's header for its settings); `stop` and `status` do what they say, asking that ssh itself through its control socket. It accepts no new or changed host key, and refuses a local port that something else already answers on. Open the app, enter `http://127.0.0.1:5317` and connect; the app remembers it. If the tunnel drops, start it again: the open window reaches Core again by itself. (That an unsent draft survives this was checked in a browser, not yet in the Mac app.) [Install a Linux Core](../docs/independent-core.md#mac-desktop-app) describes the SSH account side and what each way of authorizing the key allows.

On macOS the app has the usual menus: Yuzuno (Quit), Edit (copy and paste in the workspace's text fields), Workspace (**Connection…**, `Cmd+,`) and Window. It does not update itself; install a newer build by hand. Only Apple silicon (arm64) is built; Intel Macs are not.

**What has been checked on a Mac.** T-141 checked a package built on a Mac (`b5`, see [acceptance/t141](../acceptance/t141/README.md)). No CI-built candidate has been opened on a Mac yet; [acceptance/t165](../acceptance/t165/README.md) is the prepared check, not run.

| Behaviour | Checked | Not yet |
|---|---|---|
| Build and desktop tests | Each CI run on `macos-26`, which also records `codesign --verify` in `build.json`; T-141 on a Mac (19/19 tests) | |
| Opens the Core it is given, saves it (`core.json`), reopens it without arguments | T-141 lab, measured through a relay | A CI-built candidate |
| Tunnel stopped and started: the open window reaches Core again | T-141 lab, measured through a relay | An unsent draft surviving it, measured on a Mac (a browser was) |
| A turn in a lab Workspace: a message with an image, a command after an approval, the reply | T-141, a person at the Mac. 13 checks: 11 passed, 2 failed because the message was sent twice. The second turn was recorded; whether the approval answered exactly that request is unknown. The window, drafts and reopening are as the user reported them | A real send on the daily Core |
| The daily Workspace, read only | T-141: Core version, Workspace and page measured through the tunnel; the user's view as reported | |
| Links to web pages and mail (system browser or mail app) | The rule, in the desktop tests | Clicking one on a Mac |
| macOS menus, `Cmd+,` | No record of a check | On a Mac |
| First open of a browser download (Gatekeeper, **Open Anyway**) | `build.json` records `spctl` rejecting the app and `syspolicy_check` reporting the ad hoc signature and missing notarization. On the CI runner `syspolicy_check` also reports an "Internal Xprotect Error", which T-141's build on a Mac did not; its cause is not known | On a Mac, including whether a Mac reports that error for a CI build |
| Install to `/Applications`, uninstall | | On a Mac (the checks used a folder of their own) |
| Intel Macs | | Not built |

## Native boundary

Only the embedded local connection page receives the two `connection_info` and `connect_core` commands. `build.rs` explicitly declares all commands through `AppManifest::commands`, and the `connection` capability contains no remote origins. The commands also check the current window URL. After a successful explicit Core selection, Tauri's dynamic capability API grants only `set_appearance` and the three desktop update commands (`desktop_update_status`, `desktop_update_check`, `desktop_update_install`) to the selected origin (including its port) in the `main` WebView. The update commands take no URL, key or installer argument; each one re-checks that it was called from the `main` window on the currently selected Core. That command accepts only the `light`/`dark` enum and independently checks that the current window is `main` and its URL belongs to the currently selected Core or exact embedded connection page. Older origin grants cannot bypass that check after changing Core. The frontend cannot supply arbitrary colors or window operations. The remote workspace UI receives no filesystem, shell, process, generic window, or connection-selection native permissions. This follows [Tauri's application-command and capability model](https://v2.tauri.app/security/capabilities/).

Connection health checks use maintained `reqwest` and `url` libraries, enforce a response-size limit, do not follow redirects, and ignore environment proxies. Main-window navigation is restricted to the selected Core and the embedded connection page, and the window opens no WebView popups.

**Links to web pages and mail addresses** (`http`, `https`, `mailto`) open once in the system's default browser or mail app:
- A new-window request (a `target="_blank"` link, or Ctrl/Shift/middle-click), or a navigation away from the selected Core, is handed over by the native side through the official opener plugin.
- The plugin's own page script is turned off. That script cancels the click and asks for opener IPC, which no page is granted, so such links did nothing (T-104). No page needs opener IPC.
- Other schemes (`file:`, `javascript:`, `tel:`, app schemes) are refused.
- If the system cannot open a link, the window shows a short notice.

In-app artifact previews remain part of the workspace GUI.

The `lab-open-failure` Cargo feature makes links to a reserved `.invalid` host fail, so that notice can be checked in a real window. It is for lab builds only, never a release.

## Installer or portable ZIP (Windows)

Releases after desktop 0.2.0 offer two downloads. Desktop 0.2.0 has only the installer, with the older multi-page setup.

- **`yuzuno-desktop-windows-x86_64-setup.exe`, the installer.** It shows one page, then its progress, then opens the app. The app opens its Core as described under [Choose a Core](#choose-a-core): a first install tries `http://127.0.0.1:4317`, and its connection page asks for another address if none answers there.
  - **The page** shows the app's icon and a title, then names the folder (`%LOCALAPPDATA%\Yuzuno`, or an earlier install's), says it adds Start menu and desktop shortcuts and an Installed apps entry, and says what happens if WebView2 is missing. Its button is **Install**; there are no folder, shortcut or finish pages. `/D=<folder>` on the command line still chooses another folder.
  - **What it installs:** for your Windows account only, with the notices in `licenses\`. Windows may warn before it runs, since the installer has no Authenticode signature.
  - **Updates:** it can update itself from the app ([Desktop updates](#desktop-updates)).
  - **Uninstall:** from Installed apps. Its page can also delete the app's data.
- **`yuzuno-desktop-windows-x86_64-portable.zip`, the portable copy.** Unzip it anywhere and run `Yuzuno.exe`. Its `README.txt` says the same as this list.
  - **It does not update itself.** For a newer version, replace its files with a newer ZIP's.
  - **Its data is outside its folder:** its saved Core in `%APPDATA%\dev.yuzuno.workspace\core.json`, and the window's storage (unsent drafts) in `%LOCALAPPDATA%\dev.yuzuno.workspace`. An installed copy uses the same folders, so the two share them. Uninstalling the installed copy with its delete-data option removes them for both.
  - **It adds no Start menu entry, shortcut or Installed apps entry.** Deleting the folder removes it; its data stays until you delete those two places.
  - **It needs WebView2,** as the installed app does.

The installer's script is [`installer/installer.nsi`](installer/installer.nsi): Tauri's template for the pinned CLI, with each change marked `Yuzuno:`. A passive install (`/P`, which the in-app update runs) takes the template's steps unchanged; its window is the same progress page, whose **Show details** opens the steps. With another pinned CLI, take its template again and re-apply the marked changes.

## Desktop updates

The Windows app updates itself only when it was installed by its own NSIS installer (per user, under `%LOCALAPPDATA%\Yuzuno`), and only through the Core it is connected to at a loopback address. In the app, **Settings → Updates**, under the Workspace service, has a **Desktop app** part that shows the version, a **Check for desktop update** button and, when a newer release exists, its notes and an explicit **Download and install** button. Nothing is downloaded or installed without that click. In a browser, that part only says the app is updated from the app itself. Installing saves drafts, closes the window, runs the installer passively and reopens the new version on the same Core. Core, the Workspace service and its agents keep running.

- **Where updates come from.** Core relays GitHub Releases tagged `desktop-<semver>` from the fixed `YuzukiS/Yuzuno` repository: the public repository, which has no desktop release yet. It does so independently of Core's own release configuration or managed installation. It uses the host's existing `gh` login, so no token reaches Windows or the page. It serves only two fixed routes: `/api/updates/desktop/windows-x86_64/manifest` and `/api/updates/desktop/windows-x86_64/installer?tag=desktop-<semver>`. Only stable, published releases count, and each needs the assets `yuzuno-desktop-windows-x86_64-setup.exe` and `yuzuno-desktop-windows-x86_64-setup.exe.sig`. Core takes no repository or URL from the request. Temporary downloads use the workspace data directory; no Core release key is required. Downloads are bounded (512 MiB, 15 minutes) and run one at a time.
- **What the app trusts.** The app trusts only the update public key built into it (`plugins.updater.pubkey`), never anything from Core or the page. The official updater verifies the signature over the downloaded bytes, and `requireSignedVersion` binds the signature to the version. The app installs exactly the bytes it verified.
  - The manifest and the installer must both come from the selected Core's own origin and the fixed installer path, with no proxy and no redirects.
  - The Core must be at a loopback address (`127.0.0.1` or `localhost`). Plain HTTP is accepted only there, and the app enforces that check itself.
  - A loopback address does not prove the Core is on this computer: an SSH tunnel's local port leads to a Core on another one ([Install a Linux Core](../docs/independent-core.md#connect-from-another-computer)). The installer then comes through that Core host's `gh` sign-in, and the app still installs it only with its own signature. Updates through a tunnel are untested.
  - Switching Core discards an earlier check.
- **When it cannot update.** A copy installed some other way (a bare executable, a development build, another installer) is identified from the per-user uninstall record. So are a build without a public key, a Core at a non-loopback (HTTPS) address, and a Core older than desktop updates. Each says so and gives the manual path: download the installer and run it by hand.
- **After the restart.** The installer reopens the app with its original arguments. A Core chosen at launch (`--core-url`, `YUZUNO_CORE_URL`) is chosen again. A Core picked on the connection page is chosen again too: once through a one-time marker kept for 30 minutes, which comes before the original arguments, and after that as the saved Core.

### Building and publishing a desktop release

The installer is built with the official prebuilt Tauri CLI. It is pinned to `2.12.3` (matching `desktop/Cargo.lock`) and installed on first use under `%LOCALAPPDATA%\Yuzuno\toolchains\tauri-cli`. The global toolchain is untouched. Bundling needs Node.js; plain builds still do not.

```powershell
# Once, on the release machine; keep the private key out of the repository.
node "$env:LOCALAPPDATA\Yuzuno\toolchains\tauri-cli\2.12.3\node_modules\@tauri-apps\cli\tauri.js" signer generate --write-keys D:\keys\yuzuno-desktop.key
# Each release; set TAURI_SIGNING_PRIVATE_KEY_PASSWORD first if the key has one.
.\scripts\desktop.ps1 -Bundle -Version 0.2.0 -SigningKeyPath D:\keys\yuzuno-desktop.key -UpdatePublicKeyPath D:\keys\yuzuno-desktop.key.pub
```

**Third-party notices.** Every installer but a lab one installs them in `licenses\` beside the app: `THIRD_PARTY_NOTICES-desktop.txt`, the project's `LICENSE` and `rust-std-COPYRIGHT-library.html`.
1. **Generate them** in WSL for the Cargo.lock you bundle:

   ```sh
   cargo fetch --locked --manifest-path desktop/Cargo.toml
   python3 tools/desktop_notices.py --out desktop/licenses
   ```

   This lists the crates of a release build for `x86_64-pc-windows-msvc`, with the license texts each ships. It adds the texts recorded in [`tools/desktop-license-sources`](../tools/desktop-license-sources/README.md) for code that ships without one: Microsoft's WebView2 loader, NSIS, the `nsis_tauri_utils` plug-in and Tauri's installer script.
2. **Bundle.** `-Bundle` refuses to start if `desktop/licenses` was generated for another `Cargo.lock` or changed since. It also refuses if a file the record names in the Tauri CLI's NSIS folder (`%LOCALAPPDATA%\tauri\NSIS`: `NSIS.exe`, `COPYING`, the `nsis_tauri_utils` DLL) has another SHA-256; it checks that again after bundling. Other files in the folder are not checked. It copies the standard library's notices from the toolchain that builds the app.
3. **Check the installer** in WSL before publishing it:

   ```sh
   python3 tools/desktop_installer_check.py <the -setup.exe> --licenses desktop/licenses
   ```

   It verifies the installer's CRC, reads its compressed data, and passes only if each of the three files is stored there byte for byte.
4. **Make the portable ZIP** in WSL, from the same build, into the staged release folder:

   ```sh
   python3 tools/desktop_portable.py <the -setup.exe> --app <target>/release/yuzuno-desktop.exe \
     --licenses desktop/licenses --version <version> --out <the desktop-<version> folder>
   ```

   It refuses unless the app and the three notices are stored in the installer byte for byte, so the ZIP carries the installer's own app. It writes `yuzuno-desktop-windows-x86_64-portable.zip`. Core does not serve this file; it is a download from the release page.

The release files are staged under `<target>\release\bundle\desktop-release\desktop-<version>\`, already carrying the asset names Core expects. Publishing them as a `desktop-<version>` GitHub Release is a separate, explicit step. Every installed build verifies against the public key it was built with. Changing the key therefore needs one manual reinstall.

Without `-SigningKeyPath`, `-Bundle` makes an unsigned installer that cannot update itself. `-Lab` bundles under a separate identity (`desktop/tauri.lab.conf.json`): Yuzuno Lab, `dev.yuzuno.workspace.lab`, its own install folder, uninstall entry and WebView data. It also uses a separate build directory. A lab key and a lab install never touch the regular app.

### Update lab

`desktop/tests/update-lab.py` checks the whole path with lab-signed releases and no GitHub publishing. It starts a new managed Core under the project `target/` from a T-12 bundle of this source. That Core's `gh` is a local stand-in serving the `desktop-<version>` folders that `-Bundle -Lab` staged. The script then probes the relay routes the way the desktop calls them, and refuses foreign hosts, unknown targets, unknown tags and URL parameters.

With `--windows --serve` it drives a real Yuzuno Lab window through `desktop/tests/update-lab.ps1` and a private DevTools port:

- install signed baseline A with the old native frame, then refuse B under a wrong signature;
- select a different Core address in the connection page, type an actual unsent composer draft, and install signed B from Settings;
- prove B's native version and frameless title bar, automatic reconnection to the selected Core, and restoration of the draft;
- compare the same Lab Core PID, scripted Agent protocol process/session, UI bytes, and other Windows Yuzuno processes before and after;
- leave B installed and running, with its Lab Core available for user inspection. The script does not roll back, uninstall or erase Lab data.

The conversation uses the existing scripted Codex fixture, without a model or real native session. The GitHub transport is local; signature verification and the Windows installer/update are real. A and B must be separate implementations (for this acceptance, B includes T-44), not just two version numbers. Keep the previous signed A assets unchanged and copy them into the new isolated build's feed alongside B.

```sh
python3 desktop/tests/update-lab.py --bundle <T-12 bundle> --run-dir target/<new folder> --port 4473 \
  --feed /mnt/c/Users/<user>/AppData/Local/Yuzuno/build/<isolated>-lab/release/bundle/desktop-release \
  --windows --serve --windows-build-root 'C:\Users\<user>\AppData\Local\Yuzuno\build\<isolated>-lab\release'
```

Run the validation as a Yuzuno Job with the CPU and memory it needs: Core admits it within the machine's budget, so add no lock or wait of your own around it. A Job's cgroup limits only its Linux processes; the Windows build limits itself, because `scripts/desktop.ps1` runs every build in a Windows job object with a memory limit. Keep the Lab serving in its own supervised scope after success. Stop that scope only when inspection is finished; uninstalling or deleting the retained Lab is a separate explicit action.

## Dependencies on a new Windows build machine

Prefer the package manager already present on that machine. With WinGet, inspect the exact packages first:

```powershell
winget show --id Rustlang.Rustup --exact --source winget
winget show --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget
```

Install only missing prerequisites. For the Build Tools, pass the two explicit components; omit the broader C++ workload and `--includeRecommended`:

```powershell
$buildToolsArgs = '--passive --wait --norestart --nocache --installPath C:\BuildTools\Yuzuno --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100'
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --override $buildToolsArgs
winget install --id Rustlang.Rustup --exact --source winget
```

The package ID was verified with `winget show`; [`--override`](https://learn.microsoft.com/en-us/windows/package-manager/winget/install) passes arguments to the official installer. The [component IDs](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=vs-2022) were verified against Microsoft documentation, and these component arguments were successfully exercised using the official installer. The combined WinGet installation command was not rerun on this machine because the components were already installed. Expect Windows UAC for machine-level C++ tools; `--norestart` prevents an automatic reboot. The installer resolves required dependencies, including MSBuild. Retain an existing WebView2 runtime.

On this acceptance machine, **these prerequisites are already installed**. The C++ tools are in `C:\BuildTools\Yuzuno`; Rust is private to `%LOCALAPPDATA%\Yuzuno\toolchains` and global `PATH` was unchanged. WinGet lists the Build Tools through their Windows ARP registration (`ARP\Machine\X86\5675f0df`), but did not map this localized installation to the source package ID. Do not install another copy merely to change package-manager ownership.

## Actual native verification on 2026-10-12

The intended **Windows Tauri + independently running WSL Core** arrangement has now been exercised on the real machine:

- Windows Rust/Cargo 1.99.0, Build Tools 2022 17.14.41 (MSVC 14.44), existing WebView2 154.0.4258.62. Explicit C++ and Windows SDK components installed successfully without reboot; no Visual Studio IDE or recommended workload expansion.
- `desktop.ps1 -BuildOnly` compiled the actual Windows executable with the checked-in lockfile. Tauri 2.12.3 and tauri-build 2.7.2 are resolved. All six desktop Rust tests passed in the complete Windows build.
- A real Windows window opened the WSL Core at `http://127.0.0.1:4317/?shell=desktop`. Layout had no horizontal overflow at its default size. [Native window screenshot](../acceptance/native/native-window.png).
- The embedded connection page rejected an unreachable loopback port, retained a usable retry action, and reconnected to the real Core. The native Workspace → Connection command opened the local page. The remote Core UI's native `connection_info` request was rejected by Tauri's capability boundary. [Connection report](../acceptance/native/native-report.json), [offline screenshot](../acceptance/native/native-offline.png).
- Clicking **Copy reply** in WebView2 wrote the expected acceptance marker into the actual Windows clipboard. Clicking the delivered Markdown link previewed the file from WSL inside the native window. [Artifact screenshot](../acceptance/native/native-artifact.png).
- A real Codex command was running when the Windows window closed. Its native process exited, WSL Core stayed alive, and the same thread completed with `NATIVE_WINDOW_CLOSED_CORE_SURVIVED`. A fresh ordinary desktop window recovered the same Agent and all three turns. [Lifecycle and clipboard report](../acceptance/native/native-lifecycle-report.json), [reopened native window](../acceptance/native/native-reopened.png).
- Test-only WebView2 remote debugging was disabled for the final ordinary window; port 9333 was confirmed closed. No CDP listener is enabled by application code or normal launch scripts.

A first artifact check was interrupted because the earlier test agent's terminal host cleaned up its Core process. The native window had **not** been closed then. That failed attempt is retained in [the interruption record](../acceptance/native/test-host-interruption.json). After Core was launched in an independent OS session, the existing native window reconnected without reloading, and the lifecycle test above passed against that stable process.

Native receipts and exact installed versions are in [toolchain observations](../acceptance/native/toolchain-observations.json). To repeat connection checks, launch a **separate test window** with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`, then run `node desktop/tests/native-live.mjs` from the repository. It connects to the actual WebView2 window; it does not launch a replacement Chromium or mock Core. `desktop/tests/window.ps1` targets a specified Yuzuno process for connection, screenshot, and close checks. Close that test window afterwards and reopen normally so no debug listener remains. The [caption refresh report](../acceptance/native/chrome/RESULTS.md) records the subsequent Windows appearance and control checks.

The later [dynamic appearance report](../acceptance/native/appearance/RESULTS.md) verifies real light/dark caption changes, resolved system-theme changes, strict command boundaries, and the separate build that avoided replacing an active executable. Older native shells continue displaying the selected web theme, but need the updated executable to synchronize their native caption.

This native acceptance covers the desktop boundary and lifecycle. It does not establish unattended multi-day reliability, SSH transport behavior, multiple Claude accounts, or Catch-up summary quality; those have their own acceptance records.
