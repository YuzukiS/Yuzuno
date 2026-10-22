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
3. **The start.** Core is stopped. The page offers **Start in this computer's WSL**, not yet confirmed, after connecting fails, and the click starts it through the real `wsl.exe`. Afterwards the saved profile is confirmed.
   - The page is busy while it starts, then opens the same Workspace.
   - The new Core is the installed release, with exactly the recorded options, in a session of its own, with the recorded environment value.
   - The start stays, with a hidden `wsl.exe`, so WSL keeps the distribution running.
4. **Later.** 20 s later Core still runs and answers.
5. **The window's close button** (WM_CLOSE). It leaves Core, every process of its session, and the start with its `wsl.exe` running. Reopened (the app, not Windows), the window connects again and the profile is still confirmed.
6. **A Core that answers.** It is opened, not started again.
7. **Two starts at once from the window.** One Core; the other start is told *Core is already being started.*
8. **The window killed while its start runs.** The `wsl.exe` running it and the helper go on, Core starts, and 20 s later it still runs.
9. **A port held by another program.** Nothing is started, and the page says why.
10. **Gone from WSL.** A distribution, then an installation, that is not there: the page shows WSL's own message, and the unconfirmed profile is kept as it was.
    - **A Core that is not this computer's** (from `confirm`): a stand-in Core on a loopback port of its own says it is installed where this computer's installation recorded another port, as a tunnel to another computer could. It is offered unconfirmed; this computer's start entry refuses it; it is no longer offered, and nothing starts.
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

## The release build (2026-10-22 UTC)

This is the build that ships: `desktop.ps1 -Release -BuildOnly` under the lab identity, from `desktop/` as at `be18d2a`. Its executable is 16,076,800 bytes, SHA-256 `2565195dbdce54ff47ef702f20085d36c36791ec312c40f8466d2c18abaeca6f`. It has no console window, and it starts `wsl.exe` hidden from a GUI process. The Core fixture is a release build of main `d131662`, which contains #70's Core part.

**Run `r8`** (lab `b1bd911`) passed steps 1–10:
- **The start** took 2.4 s from the click to the opened Workspace.
- **The Core it starts** is its own session leader, a child of the start that stays. Its cgroup is `0::/init.scope`, and it has the recorded environment value.
- **The start that stays.** One helper and the hidden `wsl.exe` stayed with the Core. They were still there, along with the Core's whole session, after the window's close button had closed the window.
- **No restart.** A running Core was opened, not started again.
- **Two starts at once:** one Core, and *Core is already being started.*
- **Window killed mid-start.** The window's own `wsl.exe` was running before the kill. The Core answered 3.9 s after it and still ran 20 s later.
- **Refusals:** a held port, a missing distribution and a missing installation, each with the same messages as `r5`.

**Step 11** (the start that stays ends once no Core is left) was cut short in `r8`.
- At 01:03:55 UTC, its call into Windows failed with `WSL ERROR: UtilAcceptVsock:273: accept4 failed 110`, a timeout. WSL restarted at 01:08:17; this record does not attribute a cause.
- The lab had written its report, but the Job was later marked interrupted.
- Step 11 was then run on its own, with r8's installation. It ran the desktop's exact start command through Windows' `wsl.exe`, hidden, and the Core answered. One helper and its `wsl.exe` stayed. After the Core was stopped, they ended 124.0 s later: the 120 s grace plus one 5 s look.

**Earlier release-build runs.**
- **`r6`** found no `web/node_modules` in a new worktree, so nothing ran.
- **`r7`** passed steps 1–7, then counted the earlier start's `wsl.exe` as the new one's. It killed the window before that window had begun its start, so nothing started and nothing was stopped, as in `r1`. The lab now waits for a `wsl.exe` whose parent is that window.

## Not covered

- **WSL not running before the click.** The distribution was running: stopping it would stop the daily Core and its Agents. `wsl.exe` starts a stopped distribution itself; that path, and how long it takes, is unchecked. For the same reason, whether WSL would end the distribution without the start that stays was not observed: other `wsl.exe` clients were attached throughout.
- **WSL not installed.** Only the app's check for a missing `System32\wsl.exe` exists, unexercised.
- **A real reboot, an installed or signed desktop, a CI-built Core release.** The lab ran the desktop's builds from their build folder, under the lab identity, and a fixture release of Core.
- **Agents running in the started Core.** The lab Core ran none. Closing the window was checked on the Core's whole session, where its Agents would run.
- **The regular app with the daily Core.** Its first start needs a Core release with this change, run once.
