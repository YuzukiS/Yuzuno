# T-165: a CI-built Mac app on a real Mac (prepared, not run)

Checks a candidate from [`desktop-macos.yml`](../../.github/workflows/desktop-macos.yml) on an Apple silicon Mac. **Nothing here has been run.** Each part runs only after the user decides it, for one named candidate; this file grants nothing.

No step changes:
- the daily Core, its data or settings;
- SSH, Tailnet or firewall settings on either machine (the lab's SSH server is an ordinary process with its own files);
- `/Applications` or `~/Applications`;
- Gatekeeper: no **Open Anyway**, no removed quarantine attribute, no `spctl` change.

No Release is published.

## Both parts need

- **The candidate:** one run of `desktop-macos.yml` on main, with its run ID, commit and artifact. Check it as [the desktop README](../../desktop/README.md#macos-desktop-core-on-another-computer) describes.
- **SSH from the Core host to the Mac, already set up.** Both parts keep their records on the Core host through it. Setting it up is not part of this.
- **A clean Mac.** The record below must show no problems. Otherwise nothing runs, and the existing app or data is the user's to deal with. A copy of the app shares its data folders and defaults file with any other, because they are keyed by the bundle identifier.

**The before record, on the Core host.** It writes nothing on the Mac:

```sh
python3 acceptance/t141/mac-desktop-lab.py inspect --mac <mac> > target/t165/before.json
```

Its `problems` must be empty. It is not empty if any of these hold:
- a Yuzuno app is in `/Applications` or `~/Applications`, or is running;
- any of the app's data folders exists: `~/Library/{Application Support,WebKit,Caches,HTTPStorages}/dev.yuzuno.workspace` or `~/Library/Saved Application State/dev.yuzuno.workspace.savedState`;
- its defaults file exists: `~/Library/Preferences/dev.yuzuno.workspace.plist`;
- anything answers on the Mac's `127.0.0.1:4317`, where an app with no saved Core goes.

## A: the lab, no person at the Mac

The T-141 harness ([acceptance/t141](../t141/README.md)) runs against a lab Core of its own:

```sh
python3 acceptance/t141/mac-desktop-lab.py --lab target/t165/lab --report target/t165/report.json \
  --core-release <a Core release folder> --mac <mac> --linux-host <this host's private address> \
  --dmg-local <the candidate's .dmg> --expect-executable-sha256 <build.json app.executableSha256> \
  --daily-port 4751
```

- **What it does on the Mac:**
  - it inspects the Mac again over its own connection and refuses the same problems before writing anything there;
  - it copies the disk image over SSH into its own run folder under `~/yuzuno-t141-lab/net/`;
  - it opens the app copied out of that image, checks it, and quits it.
- **The daily Core:** `--daily-port 4751` points the read-only relay at the lab Core, so the daily Core is never contacted.
- **The order at the end:**
  1. The Mac side's state is kept in the report on the Core host.
  2. Only what this run made and nothing else changed is removed: its run folder, and the data folders and defaults file its own app created. A folder or file that changed, or that another Yuzuno app could have written, is kept and named with the reason, as is a removal that fails.
  3. A second inspect is compared with the first. A failed check is reported as failed and not rerun until it passes.
- **What it checks:** the installed bytes against `build.json`; that the app opens the Core it is given, saves it, and reopens it without arguments; that after the tunnel stops and starts the open window reaches Core again; the tunnel script; and the SSH key restrictions. It does not look at the window.
- **What it does not show:** a copy that arrives over SSH has no quarantine attribute, as a browser download would. So A does not show what a download does, and does not promise that macOS runs no check of its own.

## B-minimal: the first open of a download, a person at the Mac

It only observes the first block.

1. Take the before record (above).
2. In Safari, signed in to GitHub, download the artifact. Unzip it, open the disk image, and copy `Yuzuno.app` to a new folder `~/yuzuno-t165-lab/app/`, not to `/Applications`.
3. In Terminal, record the output of each:
   - `xattr -p com.apple.quarantine ~/yuzuno-t165-lab/app/Yuzuno.app`;
   - `spctl --assess -vv ~/yuzuno-t165-lab/app/Yuzuno.app`;
   - `syspolicy_check distribution ~/yuzuno-t165-lab/app/Yuzuno.app`. On the CI runner this also reported an "Internal Xprotect Error", which T-141's build on a Mac did not; this shows whether a Mac reports it for the candidate.
4. Double-click the app once. Take a screenshot of what macOS shows, then choose **Done**.
5. Eject the disk image. Delete `~/yuzuno-t165-lab` and the downloaded zip.
6. Take the after record (`inspect`, as before) and compare it with the before record on the Core host.

**If the app opens instead of being blocked:** quit it, and stop there. Because nothing answered on `127.0.0.1:4317`, it reached no Core. Then, on the Core host:

```sh
python3 acceptance/t141/mac-desktop-lab.py remove-new --mac <mac> --before target/t165/before.json
```

This removes the data folders and defaults file the before record shows absent, and only while no Yuzuno app runs. Without a record taken while the app ran, it cannot tell whether something else wrote to them. Then take the after record.

The result says what macOS showed on that macOS version. It does not say that Gatekeeper is solved: the app is still ad hoc and not notarized.

## Open Anyway: not in this plan

Choosing **Open Anyway** records an approval in macOS's own policy that this plan has no supported way to remove. It needs its own explicit decision as an exception. Then the app runs and writes data, with the same before record and removal as above. The same applies to removing the quarantine attribute or changing Gatekeeper.

## What may remain, for the user to decide whether to accept

**After A:**
- macOS's LaunchServices entry for the lab copy;
- system and sshd log lines, and ctimes;
- a changed modification time of the shared `$TMPDIR`. T-141 could not set it back, because utime is not permitted there.

**After B-minimal:**
- Safari's download history, and macOS's record of the download;
- `.DS_Store` files in folders Finder showed;
- a LaunchServices entry;
- possibly a note of the blocked open under Privacy & Security, for a time not known.

**After either:** if the app ran, the preferences service may still hold the defaults it wrote in memory. The defaults file is only seen absent at the second look, not proven absent later.

Any difference between the records is reported as it is, never as "no trace".
