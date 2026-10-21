# T-171: the Windows desktop starts its saved WSL Core

The lab is [`desktop/tests/start-lab.py`](../../desktop/tests/start-lab.py), with its window steps in `start-lab.mjs` and its Windows actions in `start-lab.ps1`. It runs in WSL, as a Yuzuno Job, after the lab desktop is built on Windows:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'Yuzuno\build\t171-desktop'
$env:TAURI_CONFIG = '{"identifier":"dev.yuzuno.workspace.t171lab","productName":"Yuzuno T171 Lab"}'
.\scripts\desktop.ps1 -BuildOnly
```

```sh
python3 desktop/tests/start-lab.py --run <run> --target <cargo target>/debug   # WSL_DISTRO_NAME, HOME, USER set
```

**What is its own.**
- **The Core.** A fixture release of this tree's Core: the debug `yuzuno-workspace` and `yuzuno-update-helper`, with fixture UI. It is packaged with `tools/package-release.py` and registered into a new managed folder under `/var/tmp/t171-<run>`. It runs on port 4491 with its own Workspace and working folders and a fake Codex, and `YUZUNO_SERVICE_PORTS=4492-4493` so it opens none of the daily Core's ports.
- **The desktop.** The lab build's identifier is its own, so its saved Core (`core.json`) and WebView data are too. `start-lab.ps1` runs and stops only that build.
- **Untouched:** the daily Core, the regular app and their data.
- **Afterwards:** the lab folder, its screenshots and `report.json` stay as evidence; the lab Cores and the window are stopped.

**What it checks, in order.** Each step's facts are in the report.

1. **The record.** The Core, started as the documented command does, writes `updates/launch.json` and points `updates/start` at its own helper. `/api/desktop/start-profile` names the distribution, user, folder, port and Workspace.
2. **The saved profile.** The window connects with `--core-url` and saves those, with the Workspace, in its own `core.json`.
3. **The start.** Core is stopped. The page offers **Start Core in WSL (<distribution>)** after connecting fails, and the click starts it through the real `wsl.exe`.
   - The page is busy while it starts, then opens the same Workspace.
   - The new Core is the installed release, with exactly the recorded options, in a session of its own, with the recorded environment value.
4. **After `wsl.exe` exits.** 20 s later Core still runs and answers.
5. **The window's close button** (WM_CLOSE). It leaves Core and every process of its session running.
6. **A Core that answers.** It is opened, not started again.
7. **Two starts at once from the window.** One Core; the other start is told *Core is already being started.*
8. **The window killed while its start runs.** The `wsl.exe` running it and the helper go on, Core starts, and 20 s later it still runs.
9. **A port held by another program.** Nothing is started, and the page says why.
10. **Gone from WSL.** A distribution, then an installation, that is not there: the page shows WSL's own message.

## Results (2026-10-21 UTC)

Run `r4` passed all ten steps. Lab at `bbe5ffb`; the Core and desktop code it ran are `3864134`. Setup: Windows 11, WSL2 with an Arch Linux distribution (systemd), mirrored networking; the distribution was already running.

- **The start** took 20.0 s from the click to the opened Workspace. Most of it is the debug Core checking its 1.2 GB fixture release before it listens.
- **Where the started Core runs.** It is its own session leader. Its parent is WSL's per-session `Relay` process; its cgroup is `0::/init.scope`, not the Job's. It had `YUZUNO_SERVICE_PORTS` from the record.
- **Window close.** The close button closed the window (`CloseMainWindow`, exited). Core's session had the same two processes before and 10 s after.
- **Two starts at once.** One start answered with the Workspace address, the other with *Core is already being started.* `core.log` gained one start.
- **Window killed mid-start.**
  - Before the kill: two `wsl.exe` processes, the window's child and that one's own child.
  - 3 s after: both still ran, and the helper and the new Core existed in WSL.
  - Core answered 16.2 s after the kill. Both `wsl.exe` had exited once the helper finished, and Core was still running 20 s later.
- **Port held by another program** (`python -m http.server`): *Core returned HTTP 404. Check its address and try again. Nothing was started.*
- **No such distribution:** *WSL could not run Yuzuno's start in NoSuchT171: There is no distribution with the supplied name.…*
- **No such installation:** WSL's `execvpe(…/updates/start) failed: No such file or directory`, in the same sentence.
  - Both messages then showed a doubled period and WSL's `<3>` log level. The next commit drops them; the desktop tests check that wording.

**Earlier runs.**
- **`r1`** killed the window about 2 s after the click. On Windows a connection to a closed loopback port takes about that long to be refused, so the window was still checking the port and had not yet run `wsl.exe`. Nothing started and nothing was stopped.
- **`r2`** looked for the Core 15 s after the kill, before the debug Core listened. That Core then held the port in the next step; it was stopped by its executable's path.
- **`r3`** compared a fresh window's address (`http://tauri.localhost/`) with `…/index.html` and navigated away from its own message.

None of these was a product failure.

## Not covered

- **WSL not running before the click.** The distribution was running: stopping it would stop the daily Core and its Agents. `wsl.exe` starts a stopped distribution itself; that path, and how long it takes, is unchecked.
- **WSL not installed.** Only the app's check for a missing `System32\wsl.exe` exists, unexercised.
- **A real reboot, a release build of the desktop, a CI-built Core release.** The lab used debug builds and a fixture release.
- **Agents running in the started Core.** The lab Core ran none. Closing the window was checked on the Core's whole session, where its Agents would run.
- **The regular app with the daily Core.** Its first start needs a Core release with this change, run once.
