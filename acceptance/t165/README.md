# T-165: a CI-built Mac app on a real Mac (prepared, not run)

Checks a candidate from [`desktop-macos.yml`](../../.github/workflows/desktop-macos.yml) on an Apple silicon Mac, and puts both machines back as they were. **Nothing here has been run.** It runs only after the user decides it, for one named candidate; this file grants nothing.

Not changed by any step: the daily Core, its data and settings; SSH, Tailnet or firewall settings on either machine (the lab's own SSH server is an ordinary process with its own files); `/Applications` and `~/Applications`. No Release is published.

## Before

1. **The candidate.** One run of `desktop-macos.yml` on main: its run ID, commit and artifact `yuzuno-macos-arm64-<commit>-<attempt>`. Check it as [the desktop README](../../desktop/README.md#macos-desktop-core-on-another-computer) describes: `shasum -a 256 -c SHA256SUMS`, the same sums as the run's summary, `build.json`'s `sourceCommit`.
2. **The user decides** which parts run, each its own decision:
   - **A, the lab** (no person at the Mac): needs SSH from the Core host to the Mac, already set up. If it is not, setting it up is a separate decision, not part of this.
   - **B, the first open** of a browser download (a person at the Mac).
3. **Record on the Mac**, into a new folder `~/yuzuno-t165-lab/before/`:
   - which of these exist: `/Applications/Yuzuno.app`, `~/Applications/Yuzuno.app`, `~/Library/Application Support/dev.yuzuno.workspace`, `~/Library/WebKit/dev.yuzuno.workspace`, `~/Library/Caches/dev.yuzuno.workspace`;
   - `ls -la ~/.ssh` and the SHA-256 of each file in it;
   - `spctl --status`.
4. **Record on the Core host:** the SHA-256 of each file under `/etc/ssh`, and the listening ports (`ss -ltn`).

## A: the lab

Reuses the T-141 harness ([acceptance/t141](../t141/README.md)). It starts its own lab Core, lab SSH server and relays on the Core host, and its own folder on the Mac, and removes them at the end.

1. Copy the candidate's disk image to a new folder `~/yuzuno-t165-lab/dmg/` on the Mac.
2. Run the harness with `--daily-port` set to the lab Core's own port (`--core-port`, 4751 by default). Its read-only relay then fronts the lab Core, so the daily Core is never contacted:

```sh
python3 acceptance/t141/mac-desktop-lab.py --lab target/t165/lab --report target/t165/report.json \
  --core-release <a Core release folder> --mac <mac> --linux-host <this host's private address> \
  --dmg '~/yuzuno-t165-lab/dmg/Yuzuno_<version>_aarch64.dmg' \
  --expect-executable-sha256 <build.json app.executableSha256> --daily-port 4751
```

3. Keep `report.json` and its SHA-256. A failed check is reported as failed; it is not rerun until it passes.

It checks the installed bytes against `build.json`. It also checks that the app opens the Core it is given and saves it, that it reopens the saved Core without arguments, and that after the tunnel is stopped and started the open window reaches Core again. Finally it checks the tunnel script and the SSH key restrictions. It does not look at the window.

## B: the first open of a download

1. On the Mac, in Safari, sign in to GitHub and download the artifact from the run's page. Unzip it, open the disk image, and copy `Yuzuno.app` to a new folder `~/yuzuno-t165-lab/app/`, not to `/Applications`.
2. Run `xattr -p com.apple.quarantine ~/yuzuno-t165-lab/app/Yuzuno.app` and record the output.
3. Open the app, then record what macOS shows, with a screenshot.
4. If it refuses: in System Settings, Privacy & Security, choose **Open Anyway** and confirm. Record each dialog.
5. The app should show its connection page. With no Core to reach, it says Core is not reachable; that is the expected result here, since A covers connecting. Quit it.

The result says what macOS showed on that macOS version. It does not say that Gatekeeper is solved: the app is still ad hoc and not notarized.

## Rollback

On the Mac:
1. Quit the app.
2. Delete `~/yuzuno-t165-lab/` and the downloaded artifact.
3. Delete each of the app's data folders listed in Before that did not exist before.
4. Compare with `before/`: the same files exist, `~/.ssh` has the same hashes, `spctl --status` is the same.

On the Core host:
1. Check that no lab process or listener is left (`ss -ltn` as before).
2. Check that `/etc/ssh` has the same hashes as before.
3. Delete `target/t165/lab` once its report is kept.

Report any difference that remains as it is, never as "no trace". For example, Finder's `.DS_Store` files remained after T-141, and Open Anyway's approval may also leave a record in macOS's own policy database. This checklist does not remove such records.
