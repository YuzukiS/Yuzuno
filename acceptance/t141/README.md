# T-141: the Mac desktop app, packaged, against a Core on Linux

Two steps, both run from a Linux/WSL host that can reach an authorized Mac over SSH (`<mac>` below: an SSH destination for that Mac):

1. **Build** the app on the Mac with [`scripts/desktop-macos.sh`](../../scripts/desktop-macos.sh). A Job sends this checkout's committed `desktop/` and that script to a new folder under `~/yuzuno-t141-lab/runs/<run>` on the Mac, runs it there with `--test`, and copies `build.json`, the disk image and `Yuzuno.app.zip` back. A local Job's reservation does not limit the Mac.
2. **Check the package** with `mac-desktop-lab.py`, which drives `mac-desktop-host.py` on the Mac over that SSH connection:

```sh
python3 acceptance/t141/mac-desktop-lab.py --lab target/t141/labs/<run> --report target/t141/<run>/report.json \
  --core-release ~/.local/share/yuzuno/managed-core/releases/<core release> \
  --mac <mac> --linux-host <this host's private address> \
  --dmg '~/yuzuno-t141-lab/runs/<build run>/out/Yuzuno_<version>_aarch64.dmg' \
  --expect-executable-sha256 <build.json app.executableSha256>
```

Everything it starts is its own and goes away at the end:

- **A lab Core** (the release's binary and UI, a new data folder, loopback only) and a relay in front of it that records each request line and user agent, so the app's requests are told from the lab's own checks.
- **A lab SSH server** on the private address, made from this host's own `/etc/ssh/sshd_config` and `sshd_config.d` plus [`scripts/sshd-yuzuno-tunnel.conf`](../../scripts/sshd-yuzuno-tunnel.conf). Only what a server run by an ordinary user needs is changed, and each change is recorded in the report: its ports, address, host key and files; no PAM; `StrictModes` off. Its keys are made on the Mac (only their public halves leave it). One port stands for this host's own SSH port, where the key line alone restricts its key (option A in [the guide](../../docs/independent-core.md#mac-desktop-app)); the other is the drop-in's port of its own (option B). Both key lines name the Mac's address in `from=`. This host's `AuthorizedKeysCommand` is replaced by a marked one (`/usr/bin/echo` of a restricted key line) that supplies a key found nowhere else.
- **A read-only relay** in front of the Core on `--daily-port`: it answers anything but GET/HEAD/OPTIONS with 403 itself, so that Core receives no write.
- **On the Mac**, a new folder under `~/yuzuno-t141-lab/net/`: the keys, a pinned host key, `scripts/mac-tunnel.sh` as sent, and the app copied out of the disk image (`--dmg-local` copies a disk image from this host into that folder over SSH).
  - **Before anything is written there**, a read-only inspect, kept in the report, and the Mac side itself refuse a Mac with a Yuzuno app installed or running, any of the app's data folders or its defaults file, or anything answering on its `127.0.0.1:4317`. A copy would share that data: it is keyed by the bundle identifier.
  - **At the end**, the Mac side's state is kept in the report first. Then only what this run made and nothing changed since is removed: the folder, its parents if the run made them and they are empty, and the data folders and defaults file its own app created. Anything else is kept and named with the reason, as is a removal that fails. A second inspect is compared with the first.
  - [`test_mac_desktop_host.py`](test_mac_desktop_host.py) checks these rules on a fake home folder, without a Mac.

It checks, in order:

- **The drop-in on this host's own settings**, with `sshd -T` on unchanged copies of them: with it, `sshd -t` passes and the existing port's effective settings are the same but for the new listener; its own port has each of the drop-in's settings.
- **Sessions and forwards** with each key on its port: commands and shells run the forced command (its own exit status, 1), sftp is refused; `-L` to another TCP port and to a Unix socket is refused; `-L` to Core works. On the key-only port `-R` (TCP and Unix socket) works, which is recorded as that option's boundary; on the dedicated port it is refused. The key only the marked command supplies signs in on the key-only port, to its forced command.
- **`scripts/mac-tunnel.sh` where it can go wrong**, on the dedicated port: a leftover process ID file (the earlier script's) naming an unrelated process; another service already answering on the local port like a Core; a second Core for the same local port; two starts at once; state a tunnel left without `stop`; a state folder too long for the control socket, or one others can open. `--tunnel-script <file> --tunnel-checks-only` runs these against another version of the script and stops there.
- **The package**: the executable copied out of the disk image is the one `build.json` names, and `codesign --verify` passes.
- **The app**: started with `--core-url`, it checks Core and opens its Workspace, and saves that Core; `mac-tunnel.sh stop` and `status` work, and after the tunnel is started again the open window reaches Core by itself; quit and started without arguments, it opens the saved Core.
- **The daily Workspace**, read-only: the app opens it and sends nothing but reads.
- **Refusals last**: a wrong host key, an unknown key, a key whose line names another address, each key on the other port, and on the dedicated port the key only the marked command supplies are refused, each for its own reason (`Host key verification failed`, `Permission denied`). OpenSSH holds off a client after failed logins; the lab server exempts the Mac's address from that (`PerSourcePenaltyExemptList`), recorded with its other lab-only lines.

Nobody looks at the window. What it shows, sending a message, approvals and drafts need a person at the Mac (or GUI access) and are not checked here.

## Results (2026-10-19 UTC)

The package and lab of the final round. The packaged sources (`desktop/` but its README, `scripts/desktop-macos.sh`) are the same at `ad0fd65` and at the head that ran the lab, so `b5` is the package for both.

| What | Job | Source | Result |
|---|---|---|---|
| Mac build `b5` | `4c22b1a1-af85-45f9-bcb7-5105b03d7b56` | `ad0fd65058db3e4c253070789574b03a98919df6` | desktop tests 19/19 on the Mac; package below |
| Lab `n6r` (red), earlier script | `02c8b12a-5f17-434e-ad81-03d11493b2d5` | `0c0eaf015d9f0170e1cde16461266e1e818970fe`, `scripts/mac-tunnel.sh` of `5756b64` | 20/27, 15:42:08–15:42:47; the 7 `mac-tunnel.sh` checks fail, as expected |
| Lab `n6` | same Job, after `n6r` | `0c0eaf0` | 38/38 checks, 15:42:47–15:43:44 |
| Windows regression `w4` | `1b02b994-b35b-4b68-b59c-1d7aad13fdee` | `48b291cc55b0843fee50ab0b27e70bf760a4717e` | Windows' own cargo (1.99.0): desktop tests 19/19 and a release build. The desktop's Rust sources have not changed since; the one later change Windows also packages, the connection page's hint text, is covered by `desktop/tests/connection.test.mjs` in CI. |

- **Mac**: macOS 27.0.1 (26A434), Apple M6 (arm64), Xcode 26.6, rustc 1.98.1, tauri-cli 2.12.3, OpenSSH 10.3p1 client.
- **Linux**: Arch on WSL2 (mirrored networking), OpenSSH 10.6p1 server; lab Core = the binary and UI of `core-20261018-6f29d20` (core.11), daily Core = core.11 on port 4317. The Mac reached the Linux host over a private (Tailscale) network, from the address its key lines name.
- **Package**: `dev.yuzuno.workspace`, Yuzuno 0.1.0, arm64 only, signed ad hoc (`flags=0x10002(adhoc,runtime)`, no Team ID), not notarized. `spctl --assess`: rejected; `syspolicy_check distribution`: ad hoc signature, notarization ticket missing.

| Artifact | SHA-256 |
|---|---|
| `Yuzuno_0.1.0_aarch64.dmg` (5382563 bytes) | `ef11af00fc8393e9eb0cf09347effc970313c159332c11e6f60a690ae0659adc` |
| `Yuzuno.app.zip` | `a43e000ca092179587649923e222d163064c05f8b8a0ebfe194f7b7b6957e6e5` |
| `Contents/MacOS/yuzuno-desktop` | `8cf06a2e59a442f6722d65edf4b23647d1330f1fd5e21f006e9e85fcff3aa287` |
| `build.json` (b5) | `bce72b1597960bf50e9461f15c68b49ca49f897c8e7d2fc86fb0c08f3aa50a28` |
| `report.json` (n6) | `7a9678cf29a85164024066813c59b43875a64699598dbf820a72d82874b59c26` |
| `report.json` (n6r) | `7d185e4f714759543654ac4ac0156a9cc91976ae71609aac67785d27be0f975b` |
| `scripts/mac-tunnel.sh` as run in n6 | `d197106ad8dbc3bbd96e96b33e017a43dd60d8c4d82631aa392746fb14104304` |
| `scripts/mac-tunnel.sh` of `5756b64`, as run in n6r | `a4f484fd9b562225f022eae49b486779bc3aea0604223a70be6e493ffedb87b9` |

**The drop-in on this host's settings.** With it added at `sshd_config.d`'s place (this host's `sshd_config` includes that folder before its own `AuthorizedKeysFile` and `Subsystem` lines), the existing port's `sshd -T` output gained exactly `Port 2223`, `ListenAddress 0.0.0.0:2223` and `ListenAddress [::]:2223` and lost nothing. On the dedicated port, the marked `AuthorizedKeysCommand`'s key was refused, and the server logged `AuthorizedKeysCommand path is not absolute` (how sshd 10.6 treats `none` in a `Match` block) instead of running it; on the other port the same key signed in, to its forced command.

**The tunnel script.** Against the earlier script (`n6r`), the checks fail where the bugs are: its `stop` killed the unrelated process its leftover process ID file named; with another service answering on the local port it printed `Tunnel up` and its health check got that service's answer (on macOS its ssh even bound the port beside that service); it took a second Core on the same port for `Already running`; and of two starts at once both printed `Tunnel up` while one ssh ran (in `n5r`, timing let the second find it running instead). It has no state folder, so those checks fail too. With this checkout's script (`n6`) all pass: the unrelated process keeps running, `start` refuses the taken port and the second Core, the second of two starts stops at once with 75, and the state left behind is only the lock file.

**What the app requested**, from the relays (by user agent): through the lab tunnel, 41 requests, all GET: its native health check at each of the two launches and 39 WebKit requests, including `/?shell=desktop`, `/api/workspace`, `/api/home`, `/api/events`, `/api/jobs/live` and `/api/updates`; after the tunnel came back, `/api/events`, `/api/jobs/budget`, `/api/ci/live` and `/api/jobs/live` from the window that stayed open. Through the read-only relay it opened the account's existing Workspace (core.11) and sent 62 requests, all GET (one native health check, 61 WebKit); none was refused, because none was a write.

**Earlier runs**, kept as they ran:
- `n1` failed in the harness (a relative `AuthorizedKeysFile`, and failed logins checked first, after which sshd refused the rest).
- In `n2` the app exited at launch: a build without an update key panicked (fixed in `25d74b8`).
- In `n3` it stayed open but blank: its own navigation rule refused macOS's first page, `tauri://localhost` (fixed in `d7f122c`). `n3`'s reconnection check also passed on `mac-tunnel.sh`'s own `curl`; the relay has recorded user agents since `48b291c`.
- `n4` (`bd22d903`, `48b291c`, package `b4` `27c79261…`) passed its 28 checks, before the tunnel script's rewrite and the drop-in.
- `n5` (`60d48b34`, `979a4bd`) passed everything but the last refusals: after four failed logins in a row the server held the Mac off, so two of them were refused for that instead (fixed in `0c0eaf0`).

The lab reports, logs and builds stay under `target/t141/` on the Linux host and `~/yuzuno-t141-lab/` on the Mac (not in Git).
