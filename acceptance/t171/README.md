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

`--desktop-build release` runs the release build instead (`desktop.ps1 -Release -BuildOnly`, same identity): the one that ships, with no console window. The report records which build ran and its SHA-256.

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
   - The start stays, with a hidden `wsl.exe`, so WSL keeps the distribution running.
4. **Later.** 20 s later Core still runs and answers.
5. **The window's close button** (WM_CLOSE). It leaves Core, every process of its session, and the start with its `wsl.exe` running.
6. **A Core that answers.** It is opened, not started again.
7. **Two starts at once from the window.** One Core; the other start is told *Core is already being started.*
8. **The window killed while its start runs.** The `wsl.exe` running it and the helper go on, Core starts, and 20 s later it still runs.
9. **A port held by another program.** Nothing is started, and the page says why.
10. **Gone from WSL.** A distribution, then an installation, that is not there: the page shows WSL's own message.
11. **Once no Core is left,** the start that stayed ends within its two-minute grace, and its `wsl.exe` with it.

## Results (2026-10-21 UTC)

Run `r5` passed all eleven steps. Lab and code at `15b1f2f`. Setup: Windows 11, WSL2 with an Arch Linux distribution (systemd), mirrored networking; the distribution was already running.

- **The start** took 21.8 s from the click to the opened Workspace. Most of it is the debug Core checking its 1.2 GB fixture release before it listens.
- **Where the started Core runs.** It is its own session leader, a child of the start that stays. Its cgroup is `0::/init.scope`, not the Job's. It had `YUZUNO_SERVICE_PORTS` from the record.
- **The start that stays.** One helper, and the `wsl.exe` the window ran (with that `wsl.exe`'s own child), kept running while Core ran. They were still there after the window's close button had closed the window: the window exited, and Core's session had the same two processes before and 10 s after.
- **Two starts at once.** One start answered with the Workspace address, the other with *Core is already being started.* `core.log` gained one start.
- **Window killed mid-start.**
  - 3 s after the kill, that start's helper and its new Core existed in WSL.
  - Core answered 18.9 s after the kill and still ran 20 s later.
  - That start found the first one still staying (its Core had been stopped seconds before), so it ended, its `wsl.exe` with it. One start stayed for both.
- **Port held by another program** (`python -m http.server`): *Core returned HTTP 404. Check its address and try again. Nothing was started.*
- **No such distribution:** *WSL could not run Yuzuno's start in NoSuchT171: There is no distribution with the supplied name. Start Core in WSL yourself, or check that the distribution and installation still exist.*
- **No such installation:** WSL's own `execvpe(…/updates/start) failed: No such file or directory`, in the same sentence.
- **After the last Core.** The start that stayed, and its `wsl.exe`, ended 104.8 s after the last step: within two minutes of the port last holding the lab's Core.

**Earlier runs.**
- **`r4`** (`bbe5ffb`, before the start stayed) passed its ten steps. There `wsl.exe` ended as soon as Core answered. Review round 1 then pointed out that WSL may end a distribution no `wsl.exe` is attached to, which is why the start now stays.
- **`r1`** killed the window about 2 s after the click. On Windows a connection to a closed loopback port takes about that long to be refused, so the window was still checking the port and had not yet run `wsl.exe`. Nothing started and nothing was stopped.
- **`r2`** looked for the Core 15 s after the kill, before the debug Core listened. That Core then held the port in the next step; it was stopped by its executable's path.
- **`r3`** compared a fresh window's address (`http://tauri.localhost/`) with `…/index.html` and navigated away from its own message.

None of these was a product failure.

## Not covered

- **WSL not running before the click.** The distribution was running: stopping it would stop the daily Core and its Agents. `wsl.exe` starts a stopped distribution itself; that path, and how long it takes, is unchecked. For the same reason, whether WSL would end the distribution without the start that stays was not observed: other `wsl.exe` clients were attached throughout.
- **WSL not installed.** Only the app's check for a missing `System32\wsl.exe` exists, unexercised.
- **A real reboot, a release build of the desktop, a CI-built Core release.** The lab used debug builds and a fixture release.
- **Agents running in the started Core.** The lab Core ran none. Closing the window was checked on the Core's whole session, where its Agents would run.
- **The regular app with the daily Core.** Its first start needs a Core release with this change, run once.
