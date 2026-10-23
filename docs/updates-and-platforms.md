# Updates and platform support

Which part of Yuzuno updates how, what is released, and what to try first when something looks wrong. Status on 2026-10-20, against main `08450a0`. The releases named here are the private repository's. Since 2026-10-21 the public repository publishes its own signed Core releases, starting with core.13 and core.14 ([install guide](independent-core.md)); this page is not yet updated for them. The details stay in the pages linked below.

## Two things update separately

| Part | What it contains | How it updates | Latest release |
|---|---|---|---|
| **Workspace service** | Core, the web UI and the Claude bridge, on the Linux/WSL Core host | Settings → Updates → Workspace service, in a managed installation ([Managed Workspace updates](workspace-updates.md)). A source checkout updates by building a newer checkout. | `2026.10.19-core.12` (tag `core-20261019-f5626f7`) |
| **Windows desktop app** | The native window and its connection page; it shows the web UI that Core serves | Settings → Updates → Desktop app, for a copy installed by its own installer, through a Core at a loopback address. Otherwise, run the installer by hand ([Desktop updates](../desktop/README.md#desktop-updates)). | `Yuzuno Desktop 0.2.0 for Windows` (tag `desktop-0.2.0`) |

- **What a desktop update changes:** the window draws the web UI from Core, so most of what you see changes with a **Core** update, in the browser and the desktop app alike: Home, Settings, the recovery page. A desktop update changes only the native shell: the window, the connection page, link handling and the desktop's own updater.
- **What neither update changes:** the native Codex and Claude CLIs and their sign-ins.

## What core.12 brought

core.12 contains everything merged up to `f5626f7`; its release notes in the private repository list the changes. For updating, these matter most:

- **Home stays up after a changed Sources block,** and a section that can't be drawn says so in its place.
- **A recovery page instead of a blank window.** It offers **Copy diagnostics**, which needs no developer tools ([When the window can't show the app](diagnostics.md)).
- **The new default Workspace folder** `yuzuno/workspace`. A Workspace in the older folder stays where it is until you move it with `yuzuno-workspace --move-workspace` ([Data and updates](../README.md#data-and-updates)).
- **Rolling back has a limit.** core.11 and older refuse to open a Workspace that holds settings or unfinished work they would mishandle. For example, an SSH machine added in core.12 gets strict Jobs limits by default, and core.11 then stops at start without changing anything.

Since core.12, main has changed only the release smoke test (`#164` in the private repository), not the product.

Desktop 0.2.0 is built from `faf3282` and is still the latest desktop release. Since then, main's desktop source has gained the Mac app and acceptance of Core's new health name. Desktop 0.2.0 still connects to newer Cores, including core.12, because Core keeps answering with the old name too.

## Platform support

The full matrix is in [Supported platforms](independent-core.md#supported-platforms).

- **Core:**
  - Linux x86_64 with glibc 2.35 or newer, including WSL2.
  - macOS Core is planned, not supported.
  - On Windows, Core runs in WSL2.
- **Windows desktop app:** in daily use with a Core on the same computer. Through an SSH tunnel it is untested.
  - **Blank Home:** the fix and the recovery page came with core.12, a **Core** release, not a desktop update. After installing core.12, the user reported that Home works in the Windows app; that is the user's report, not an automated check.
- **Mac desktop app:** Apple silicon, and Intel built and tested in CI only, never opened on an Intel Mac. It is built from source and signed ad hoc, without notarization, and no release exists. It is **not** supported as a public install.
  - One trial build was installed on the user's Mac and reached a WSL Core through an SSH tunnel; afterwards the app and the tunnel setup were removed again. The trial does not make it a release.
  - It never updates itself; a newer build is installed by hand ([macOS desktop](../desktop/README.md#macos-desktop-core-on-another-computer)).
- **Linux desktop app:** none. Use a browser.

## Shortest path when something is wrong

1. **See which part runs which version:** Settings → Updates in the desktop app shows the Workspace service and the Desktop app. In a browser it shows only the Workspace service.
2. **Update the Workspace service first.** In a managed installation, choose **Update to <version>**. It applies when Agents are idle.
3. **Then the desktop app:** **Check for desktop update**, then **Download and install**. If the app says it cannot update itself (it was not installed by its installer, or its Core is not at a loopback address), download the installer from the release and run it.
4. **If the window shows "Yuzuno couldn't show this screen":** use **Copy diagnostics**, then **Try again** or **Reload**. This page needs core.12 or later; core.11 shows a blank window instead.
5. **Report it** with that text, following [Contributing](../CONTRIBUTING.md). Leave out secrets and private paths.

## When a Core update cannot help

A Core update never changes how the operating system or the desktop app judges the desktop's own files:

- **The Windows installer** has no Authenticode signature, so Windows may warn when you run it by hand. A Core release does not change the installer or that warning.
- **The desktop's own updates** install only an installer that verifies against the key built into the app.
  - If an update does not verify, or the copy was not installed by its installer, a newer Core does not change that.
  - Install the release's installer by hand instead.
- **The Mac app:** macOS refuses the first open of an ad hoc signed app downloaded with a browser. Allowing this one app is described in [macOS desktop](../desktop/README.md#macos-desktop-core-on-another-computer). Core plays no part in it.
