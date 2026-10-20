# T-148: one-page installer, passive update and portable ZIP on Windows

`install-check.ps1` checks the installer and the portable ZIP in a test identity of their own: **Yuzuno T148**, `dev.yuzuno.workspace.t148`, binary `yuzuno-t148.exe`. That identity is a Tauri config passed to the build, not part of the repository. The regular app and Yuzuno Lab are never touched.

**How it runs.** The script's text is the `-Command` of a Windows Job (`powershell.exe -NoProfile -NonInteractive -Command <text>`), after lines that set its inputs: `$T148Out` (a new folder), `$T148InstallerA` (the first version), `$T148InstallerB` (a newer one, with the same notices) and `$T148PortableZip`. No script file runs, and the execution policy is not changed. Windows Jobs take at most 16 KiB of argv in total, so the script stays below that.

**No Core is used.** A new install opens `http://127.0.0.1:4317` by default, which on this PC is the daily Core. So before the app first starts, and again before the portable copy runs, the check saves the identity's Core as `http://127.0.0.1:1`, where nothing listens (`%APPDATA%\dev.yuzuno.workspace.t148\core.json`). The app then opens its connection page. After each screenshot of the app, the check confirms that none of its processes, the WebView2 ones included, has a connection to port 4317.

**What it does,** stopping at the first failed check:

1. **Before anything,** it refuses to start unless the test identity is absent: no uninstall entry, install folder, shortcut, data folder or process. It records the regular app's and Yuzuno Lab's uninstall entries and the other Yuzuno processes.
2. **The first install, interactively.** It starts installer A as a user would, captures the one page and reads its text: the button must say Install and the text must name the install folder. It then presses Install, captures the progress page and waits for the installer to exit. The installed app must open by itself. Then it checks the uninstall entry, the files (the notices included) and both shortcuts.
3. **The in-app update's installer run.** It runs installer B the way the updater does (`/P /UPDATE /R /ARGS`). The update must finish by itself and reopen the app. The version must change in place, keeping the entry and the shortcuts.
4. **The Installed apps entry's uninstaller** (`/S`). It must remove the entry, the install folder and both shortcuts.
5. **The portable copy.** It removes the identity's data, unzips the ZIP and runs its app. The app must open, add no entry, install folder or shortcut, and keep its data in the folder its README names.
6. **Cleanup, whatever happened.** It removes everything the run added and checks that nothing of the test identity is left. The regular app's and Yuzuno Lab's entries and processes must be unchanged.

The installer's and the app's windows appear on the desktop while it runs. Each screenshot is of the process's largest visible window. Each run writes `report.json` and the screenshots to `$T148Out`.
