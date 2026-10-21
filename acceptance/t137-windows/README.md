# T-137: the Windows desktop's install, upgrade and uninstall, in a disposable guest

This checks a real old Yuzuno desktop package and a real newer one. It covers:
- that the old package installs;
- that the newer one upgrades it and keeps the test connection and data;
- that nothing the product creates is named `-next`;
- what the uninstaller removes and what it leaves.

It runs only inside a disposable Windows guest, never on a daily account.

## Files

- `prepare.py` (on the host) takes explicit paths and expected package facts. It verifies the packages, then writes `params.json` and a Windows Sandbox `t137.wsb` into a new run config folder.
  - The one thing it reads from the machine it runs on is that machine's identity: MachineGuid, SMBIOS UUID and computer name, read by `guest-lib.ps1`. It records them in `params.json` only as digests salted with the run's token. It refuses if any of them cannot be read. Run it on the host that will start the guest.
  - A guest other than Windows Sandbox must be registered with `--guest-machine-guid` and `--guest-smbios-uuid`, read inside that guest beforehand. Both are recorded as digests too, and refused if either is the host's.
  - The `.wsb` turns off networking, the virtual GPU, the clipboard, audio and video input and printers, enables the protected client and caps memory.
  - It maps the installers, the harness and the run config read-only, so nothing in the guest can change the configuration a later run starts from. Only an empty results folder is writable. Nothing runs at logon.
  - It refuses a lab root that is a drive root or a user profile, a path with `.` or `..` parts, folders outside the lab root or nested in each other, and a mapped folder holding `.ssh`, `.gnupg` or `.aws`.
  - It also refuses extra files beside the packages, a wrong SHA-256, the same version for old and new (a reinstall is not an upgrade), and a config or results folder that was used before.
  - Windows Sandbox's CPU and memory are not governed by Yuzuno Core's Job budget.
- `guest-lib.ps1` decides who may run the harness, before anything is written. A username, a mapped folder or the token proves nothing, since the token is also in the host's lab folder. A run is admitted only if all of these hold, and refused if anything is missing or unclear:
  - every identity fact is present, is not a placeholder (a GUID of only zeros or Fs), and differs from the host's recorded one;
  - the machine is Windows Sandbox (`WDAGUtilityAccount` on a machine reporting `Microsoft Corporation` / `Virtual Machine`) or is the registered guest;
  - no Yuzuno install, folder or key exists yet.
  - The username and computer name come from Windows, not from environment variables.
- `guest-accept.ps1` (in the guest) runs that admission first, then the steps in `upgrade-steps.ps1`, which `identity-check.ps1` shares (below). On a refusal it exits 2 and records only the reasons and counts, no identifier or path; `result.json` is written only if the results folder already exists. Then:
  1. It checks both packages: SHA-256 and product version. It also records their Authenticode status as found and does not bypass it. It checks that the WebView2 runtime is installed. Without it, the installer would try to download it, which the offline guest cannot do, so the run stops there as a gap, not a pass.
  2. It installs the old package with `/S` and records its uninstall entry.
  3. It writes a test connection (`core.json` with `coreUrl`) and a marker into `%APPDATA%\dev.yuzuno.workspace` and `%LOCALAPPDATA%\dev.yuzuno.workspace`.
  4. It installs the new package with `/S`. The check passes only if the version changed, the install location is the same, and the seeded files are byte-identical.
  5. It checks that no folder, key or uninstall entry the product created matches `yuzuno-next`.
  6. It runs the registered uninstaller with `/S` and waits for its entry to go. It records whether the install folder is gone (the entry's `InstallLocation` without its quotes, else the uninstaller's folder) and what is left; the seeded app data is expected to remain, since the uninstaller only removes it when asked.
  - Every step goes into `result.json`, the first failure included. The exit status is 0 only if all passed, 2 if it refused to start, and 1 otherwise.
- `test_prepare.py` tests `prepare.py` on fixtures, with a fake identity reader (`python3 test_prepare.py`).
- `test_admission.py` runs `guest-lib.ps1`'s real digest and admission functions on made-up machines (`python3 test_admission.py`; it needs Windows PowerShell and is skipped without it).
  - The fixtures include the host with a valid `params.json`, the host under the sandbox account name or with every sandbox fact, the host renamed, a copy of the host, missing or placeholder identity facts, an unregistered VM and a used guest.
  - PowerShell gets the library and fixtures as commands on stdin. No script file runs, no policy changes, `guest-accept.ps1` never runs, and the host's own identity is never read.

- `test_identity.py` checks `identity-command.py`'s command and that every script parses in Windows PowerShell (`python3 test_identity.py`). The scripts are parsed from text, never run.
  - It also runs the shared name check and snapshot on made-up names and made-up folders (WSL folders reached from Windows, standing in for keys). No real place or registry key is read.
  - Neighbours like `t137old` and `t137new` are not the identity's; its own folder and key are.

## Running it

1. Put the two packages (and their `.sig` files) into `<lab>\in` and a copy of this folder into `<lab>\harness`. Run `prepare.py` with a new `--config <lab>\run-N` and `--results <lab>\out-N`.
2. Open `<lab>\run-N\t137.wsb`. In the guest, run `powershell -NoProfile -File C:\t137\harness\guest-accept.ps1 -Params C:\t137\config\params.json`.
   - A fresh Windows client's default execution policy is Restricted, which refuses an unsigned script started with `-File`. The development host refused it the same way. The harness does not change or get around that policy. How the script may start in the guest (a signed script, or a policy the person sets in the disposable guest) is the owner's decision, so that line works only once that decision is made.
3. Read `<lab>\out-N\result.json`. Closing the sandbox discards the guest; the results folder stays. Each run uses a new config and results folder.

## Limits

- **Sandbox facts unconfirmed:** the facts expected of Windows Sandbox have not been seen in a real Sandbox: the account, `Microsoft Corporation` / `Virtual Machine`, and a MachineGuid different from the host's. If a real Sandbox reports otherwise, the harness refuses. The values are then to be confirmed and registered, not loosened.
- **What admission protects against:** a mistaken run on the host or on a copy of it. It does not stop someone who edits `params.json` on the host. The guest cannot edit it, since the config folder is mapped read-only.
- **Host read not run:** `prepare.py`'s real read of the host identity has not run; the tests pass given facts only.

## On an ordinary account, under a test identity

Until a guest exists, `identity-check.ps1` runs the same steps on an ordinary Windows account, under a test identity of its own: **Yuzuno T137**, `dev.yuzuno.workspace.t137`, binary `yuzuno-t137.exe`. It never installs, starts or changes the regular app or Yuzuno Lab.

**What it shows, and what it does not.** It shows that an installer built from the old template (0.2.0's sources) upgrades to one built from the current template under the same identity: the install folder stays, a test connection and markers in both app data folders are kept, nothing is named `-next`, and it records what the uninstaller leaves. It does not show the real 0.2.0 package, the regular identity, or Authenticode and SmartScreen on a real asset. The new candidate also carries no notices. Those need the guest above.

**Candidates.** Both are unreleased local builds: never signed with the updater key, never uploaded, used only in the lab folder. Each is built as a Windows Job running the pinned Tauri CLI directly (no PowerShell script), in a copy of `desktop/`:

    node <Tauri CLI 2.12.3>\tauri.js build --bundles nsis --ci --config <lab>\config\t137-identity.json --config <lab>\config\t137-v020.json -- --locked

- old: `desktop/` of `faf3282`, the commit of release `desktop-0.2.0` in the development repository, with `t137-v020.json`;
- new: `desktop/` of this repository's `main` when the check is prepared, with `t137-v021.json`.

The three configs in `<lab>\config`, one line each, give the identity (which also turns off updater artifacts) and the two versions:

- `t137-identity.json`: `{"productName":"Yuzuno T137","mainBinaryName":"yuzuno-t137","identifier":"dev.yuzuno.workspace.t137","bundle":{"createUpdaterArtifacts":false}}`
- `t137-v020.json`: `{"version":"0.2.0"}`
- `t137-v021.json`: `{"version":"0.2.1"}`

The build needs `CARGO_HOME`, `RUSTUP_HOME` and `PATH` for the Rust toolchain, and `CARGO_TARGET_DIR` inside the copy.

**Running it.** `identity-command.py` writes the Windows Job's argv: Windows PowerShell with one `-Command`, made of lines setting the five inputs, then `upgrade-steps.ps1` and `identity-check.ps1` as they are. No script file runs and the execution policy is not changed. Submit it as a Windows Job (`machineId` `windows`) with `cwd` the lab folder and `--out` a new empty folder, then read `report.json` there.

- **Before anything,** it refuses (exit 2) unless nothing of the test identity exists: no uninstall entry, install folder, data folder, shortcut, key or process.
  - It goes by the identity's **exact** names, ignoring case as Windows does: `Yuzuno T137`, `dev.yuzuno.workspace.t137` and `Yuzuno T137.lnk`. A neighbour such as `dev.yuzuno.workspace.t137old` is not the identity's. It is neither a reason to refuse nor ever removed, and it counts among the other folders that must stay as they were.
  - The guest's check still counts anything named like yuzuno.
- **No Core is used.** Before anything is installed, it sets the identity's Core to `http://127.0.0.1:1/`, where nothing listens. Both installs are silent and start no process, and it checks that.
- **What it writes:**
  - `%LOCALAPPDATA%\Yuzuno T137`;
  - both `dev.yuzuno.workspace.t137` data folders;
  - the uninstall entry `Yuzuno T137` and the key `HKCU\Software\yuzuno\Yuzuno T137`;
  - the two `Yuzuno T137.lnk` shortcuts.
- **Cleanup, whatever happened:** it removes exactly those, by name, and checks that nothing of the identity is left. The other Yuzuno uninstall entries, folders and keys must be as they were. It never removes `HKCU\Software\yuzuno` itself.
- **Not removed:** the lab folder, and the shared caches the builds use (the Rust toolchain's registry cache and Tauri's NSIS cache). Delete the lab folder when the check is done.

## Status (2026-10-21), on an ordinary account

**Run once with the user's approval** (Home), with `identity-check.ps1` as of `e44b942`:

- **First attempt** (Windows Job 31aa0f1c): exited at its own pre-check (exit 2), so nothing was installed or removed.
  - Its name match was a pattern, and it took two leftover folders from earlier T-137 runs for the identity: `%LOCALAPPDATA%\dev.yuzuno.workspace.t137old` and `…t137new`, holding only WebView2 data.
  - The user chose to delete those two folders and run once more.
  - The pre-check now goes by exact names, so neighbours like these no longer stop a run.
- **Second attempt** (Windows Job 7c7ec6e4, 03:48:49–03:48:56Z): **passed**.
  - The old package installed silently and recorded its `InstallLocation` (`%LOCALAPPDATA%\Yuzuno T137`), so the no-process check had a folder to check. No process ran.
  - The upgrade kept that location and left the test connection and both markers byte-identical.
  - Nothing it created is named `-next`.
  - The silent uninstall removed the entry, the install folder and both shortcuts. It left both data folders and `HKCU\Software\yuzuno\Yuzuno T137`, which upstream keeps unless "delete app data" is chosen.
  - Cleanup removed those, and the other Yuzuno entries, folders and keys were unchanged.
  - `report.json` sha256 `ef83c09bd0231dc5b39c20b57b44ad5c7de6e1614cf0115b5e19877a4cb1f972`.
- **What this does not show:** it covers the template upgrade under the test identity only, not the real 0.2.0 package or identity, Authenticode or SmartScreen.

- **Old candidate:** `Yuzuno T137_0.2.0_x64-setup.exe`, 3,740,203 bytes, SHA-256 `4bb38a788f097e579020c3ec2f4a70388d755da05afecf3184472dd423fd2fa6`. Built by Windows Job 1423cf30 from `desktop/` of `faf3282` (tree `18989177`).
- **New candidate:** `Yuzuno T137_0.2.1_x64-setup.exe`, 3,762,821 bytes, SHA-256 `1031611739f7056a68be68592a07b989b5a48c018d9782ea0fc95006e3e60753`. Built by Windows Job 895ece2a from `desktop/` of `3c13e27` (tree `0ff7fc20`, installer template `9e829b8a`).
- **Both:** product name Yuzuno T137 with versions 0.2.0 and 0.2.1, Authenticode NotSigned, no updater signature, kept in the lab folder only.
- **Account, read before anything:** the regular Yuzuno 0.2.0 and Yuzuno Lab 0.1.2 are installed per user. Nothing of `Yuzuno T137` exists. A `HKCU\Software\yuzuno\Yuzuno T148` key left by T-148's check is not this check's to remove.

## Status (2026-10-19)

**Not run:** there was no isolated Windows environment and no newer package.

- **Windows Sandbox:** not installed on the development host. Enabling it is an optional Windows feature that needs administrator rights, and that was not authorized.
- **Hyper-V:** an existing VM could not be listed or used without elevation, and no other disposable VM exists.
- **Old package:** release `desktop-0.2.0`, `yuzuno-desktop-windows-x86_64-setup.exe`, SHA-256 `c2fbb4f68df399d9786c9de888ee34cc0aa3b5929af8a8c603688b9b4792d4de`.
  - It is an NSIS installer: a PE32 stub with product version 0.2.0 and product name Yuzuno.
  - It has no Authenticode signature; the `.sig` beside it is the Tauri updater signature.
- **New package:** none newer than 0.2.0 exists.
  - A local build would do: an unreleased candidate with a higher version and the real app identity (`scripts/desktop.ps1 -Bundle -Version`).
  - It is not a release and must not be presented as one, and it is never signed with the production updater key. The upgrade over an install needs no updater signature.
  - A real signed update chain waits for a later authorised official package.
  - None was built, because no guest exists to run it.
- **Names:** the sources of 0.2.0 and of current main agree. The product name is `Yuzuno`, the identifier `dev.yuzuno.workspace`, the binary `yuzuno-desktop`, and the NSIS install is per user, so the installer's names never held `-next`. The desktop's one `-next` is the compatibility value it accepts in older Cores' health answer.

So the install, the upgrade (and its data retention) and the uninstall are unverified until both a disposable guest and a real newer package exist. Nothing here was run on the host beyond reading package facts.
