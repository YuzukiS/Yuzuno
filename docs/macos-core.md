# macOS Core: status and gaps

**Releases from core.36 (`core-20261116-e227333`) on have a macOS Core package for Apple silicon,** installed by hand ([install guide](independent-core.md#install-start-and-stop-on-macos)). YN-108 builds the macOS Core in the slices [listed below](#slices-yn-108); the Mac app that installs and starts it has no release yet. This page says what Core does on a Mac at this commit and what is still missing.

Remote Codex Agents on a Mac over SSH are a separate feature, and they do not make a macOS Core.

## What is checked on every change

[`core-macos.yml`](../.github/workflows/core-macos.yml) builds Core with all its tests on GitHub's standard Apple silicon runner (`macos-26`, free for public repositories) and runs them as CI runs them on Linux, with [`core_tests.py`](../.github/scripts/core_tests.py). It runs for every pull request and push to main that changes Core, its runtimes, the Cargo files or the test runner.

- **Not run there:** tests of Linux mechanisms (cgroup, systemd, `/proc`, mount tables, pidfd, `renameat2`, file leases) are compiled for Linux only. So are the remote-Job tests that run the helper on the test machine itself as if it were a Linux machine.
- **Build in two steps:** the compilers for Core's library and its unit tests reach about 6 and 10 GiB (measured on Linux). Built at once on this runner (3 CPUs, 7 GiB), the build spent most of its 26–29 minutes compressing and swapping memory, as `vm_stat` showed (YN-235). So it builds the library, binaries, examples and integration tests first, then `--all-targets`, which has only the unit tests of the library and binaries left: the same targets, with the same dependency features, and nothing built twice.
- **Build timings:** each step runs with `cargo build --timings`, and the job's summary lists, per step, the time of each kind of Cargo unit (Core's library, its tests, each integration test binary, the dependencies the cache did not restore), how many compiled at once, and the slowest units (YN-235). A library's time is split into rustc's frontend and codegen; for a binary or a test binary, compiling and linking are one time the report cannot split. The report itself is not uploaded. The Build step's log shows `vm_stat` and the swap in use before and after the build, so a build that ran short of the runner's 7 GiB shows as page-outs, swap-outs and compressions.
- **The tests' environment there:** a short `TMPDIR`, because macOS's own (`/var/folders/…`) makes the sockets the tests create longer than macOS's 104-byte limit; and the command line tools' `/usr/bin/python3` (3.9) for the Python 3.6 check of the remote helpers, which needs a Python older than 3.13.
- **Run there, among others:**
  - SIGTERM and SIGINT stop a running Core through its own shutdown, and the Workspace opens again afterwards (`core/tests/core_signals.rs`);
  - Cores from before data roots are kept out of the Workspace ([below](#keeping-older-cores-out));
  - a Job for a registered remote machine is queued, and runs of stages and checkpoints are refused before anything is written (`core/src/jobs/platform_tests.rs`);
  - a Job on This Mac runs through the real `/usr/bin/xcode-select` and `/usr/bin/python3`, in a data folder with a space in its path, and its artifact is checked; a cancel and a timeout stop its process group (`core/src/jobs/mac_tests.rs`);
  - checks that a child process was reaped ask the kernel (ESRCH) instead of looking for `/proc/<pid>`;
  - a process's identity for managed updates (its PID, start time and executable) is read from libproc, for this test process and for a child while it runs, once it has exited and once it is reaped (`core/src/updates/state.rs`), and the managed-update tests that need it run;
  - `updates/start stop` stops a stand-in Core of a managed installation and signals nothing it cannot tie to that installation's one Core; processes are listed through libproc and their arguments read from `KERN_PROCARGS2`, the user and login shell come from the user database, and the start profile says `macos` (`core/src/updates/start.rs`). The one stop test that needs to know which process holds a port runs on Linux only.

Running them there found three things outside the tests:
- `runtimes/claude/cswap-claude` did not start under macOS's `/bin/sh` (bash 3.2), which read an apostrophe in an error message as an open quote: a claude-swap account could not run on a Mac. Fixed.
- `runtimes/claude/remote-host.mjs` did nothing and exited when the path it was started by had a symbolic link in it (on macOS, `/tmp` is one), because it compared that path with its own resolved one to tell whether it was run as a program. On any machine whose home folder or data root is reached through a link, a remote Claude Agent could not start ("exited before its socket was ready"). Fixed: both paths are resolved.
- On a Mac, the remote-Job helper did not settle an attempt whose supervisor had gone the way Linux's does: at the check where Linux's helper stops it (at its timeout, or after a cancel its command ignored), it was still unknown and held its slot. The helper timed its records of the deadline and of the first TERM with Python's `time.monotonic()`, which before Python 3.10 is each process's own clock on macOS (the command line tools' `python3` is 3.9), so no later call could read them (YN-144, Job `2c6fc88d` on a Mac). Fixed: they are timed with `CLOCK_MONOTONIC`, one clock for the boot on both systems, and say so; the two remote-Job tests run on macOS too. A record an older helper wrote names no clock: on Linux it is read as before, and on a Mac it is never applied, so such an attempt keeps its slot until it is cancelled.

History: the first source build on a Mac (T-88, 2026-10-17, main `1cbfb66`) built Core in 30 s on a Mac mini, and 23 of its tests failed there. By 2026-11-13 the tests no longer compiled on macOS (28 errors, YN-108's check of main). Running them on every change keeps that from happening again.

## Keeping older Cores out

Some Workspaces hold things a Core from before data roots would mishandle, such as a machine with its own root or a queued remote Job ([`core/src/older_cores.rs`](../core/src/older_cores.rs)). Before writing one, Core makes the Workspace lock file read-only and proves that an older Core cannot use it:
1. opening the file for writing now fails;
2. no other process holds the file open, which the kernel confirms through a write lease.

macOS has no leases, so there only the first proof is made. The read-only mode, the sync and the lock held by such writes are as on Linux. This is safe because no released Core from before data roots runs on macOS: every one was built for Linux only, and macOS packages start with core.36.

**Known limit:** suppose someone built a Core on a Mac from a commit before data roots, and it opened the lock file before this Core made it read-only. Nothing tells this Core about that open, and that older Core would take the lock once this one left.

Before YN-108, a macOS Core refused every such write. Adding a machine with Jobs limits (the default) failed, and so did a Job for a remote machine.

## Gaps on macOS

**Runtime** means the code builds but refuses or behaves differently on macOS. **Tooling** and **packaging** are outside Core's binary.

| Area | On macOS at this commit | Kind | Slice | Code |
|---|---|---|---|---|
| Build and tests | Both build; the tests run in CI ([above](#what-is-checked-on-every-change)). | none | M1 | `.github/workflows/core-macos.yml` |
| Workspace storage | Works: bundled SQLite, `File::try_lock` on `workspace.lock`, owner-only data folder. The default data folder is `~/Library/Application Support/yuzuno/workspace`; one an earlier build made in `~/Library/Application Support/yuzuno-next` is used where it is. | none | — | `core/src/store.rs`, `core/src/data_dir.rs` |
| Browser boundary and API | Works: Core listens on 127.0.0.1 only. The SSH tunnel path is the same code as on Linux but was not tried on a Mac. | none | — | `core/src/main.rs`, `core/src/server.rs` |
| Registered machines and their Jobs | Work as on Linux; older Cores are kept out as above. | none | M1 | `core/src/older_cores.rs` |
| Jobs on this Core's host | Run on **This Mac** (`machineId` `mac`; also without one, with `local`, and with `agent` for an Agent here) in **limited mode**: the helper a Mac over SSH runs, started by `/usr/bin/python3` once `xcode-select -p` names the Command Line Tools (without them nothing is run). Attempts live in `<data folder>/local-jobs`. They take this Core's Jobs budget and `maxActive`, which only queue and record them. guardGit is checked there by the same helper, with the Command Line Tools' `git`. Artifacts and outputs download through it too. A CPU range, GPUs, exclusive, services, checkpoints, pause and runs of stages are refused with why. | runtime | M2c | `core/src/jobs/remote.rs`, `core/src/jobs/host.rs` |
| **Managed updates** | **Not yet run end to end.** The running Core's process identity, which Prepare and Apply record, is read from libproc (`proc_pidinfo`, `proc_pidpath`); its start time is in microseconds since 1970, compared only on the same Mac in the same boot. The release tooling packages and signs `macos-aarch64` alongside Linux (M3b), and core.36 is the first release that carries it, so no update from one macOS release to the next has run on a Mac yet. | packaging | M3b, M4 | `core/src/updates/state.rs`, `core/src/updates/releases.rs` |
| Update helper | Works as on Linux: log pruning tells the log it writes to by the open file's device and inode, and the executable it runs as is resolved before it is compared with release paths (on macOS `current_exe()` can be the link `updates/start`). | none | M2a | `core/src/updates/helper.rs` |
| Starting and stopping Core | Works through the release's helper ([on macOS](independent-core.md#install-start-and-stop-on-macos)): `first-start` and `updates/start start` start Core in a session of its own and return; `updates/start stop` sends it SIGTERM, on which it shuts down cleanly. The start profile says `"platform":"macos"`. **Limit:** macOS cannot tell which process holds a port, so a stop takes the installation's one Core process started with that port to be the Core that answers there; on Linux it also checks that the process holds the port. The install guide's Linux start command uses the `setsid` command, which macOS lacks. | none | M2b | `core/src/updates/start.rs`, `docs/independent-core.md` |
| Finding Claude Code, Node, Codex, git, gh | Through Core's `PATH`. `first-start` gives Core the environment of the user's login shell (from the user database; `/bin/zsh` when it names none), which Core records for later starts. A Core started outside a login shell some other way does not see `/opt/homebrew/bin`: T-88's check without it reported "Claude Code was not found on Core's PATH", and found it once `/opt/homebrew/bin` was added. | runtime | M4 | `core/src/updates/setup.rs`, `core/src/machines.rs` |
| Packages and signing | Both platforms. `tools/build-core-artifact.py --platform macos-aarch64` builds the Mac inputs on an Apple silicon Mac. `tools/package-release.py` takes a bundle's platform from that platform's `build.json` (the host is still Linux) and leaves the Windows Jobs helper out of a macOS bundle; `tools/sign-core-release.py` accepts `macos-aarch64`; `tools/core-release.py` freezes one artifact per platform, requires both and publishes six assets (three each), refusing a release missing a platform. | tooling | M3a, M3b | `tools/build-core-artifact.py`, `tools/package-release.py`, `tools/sign-core-release.py`, `tools/core-release.py` |
| Labels | **Settings → Updates** names the system its Core reports: macOS or Linux / WSL. A new Job in the Jobs panel says "This Mac · macOS · limits declared only", and **Settings → Jobs** says the budget only queues and records Jobs. | none | M2c | `web/src/updates-text.ts`, `web/src/Jobs.tsx`, `web/src/JobsSettings.tsx` |
| Desktop app | The macOS app ([T-165](../desktop/README.md#macos-desktop-core-on-another-computer)) connects to a Core that runs elsewhere; it cannot install or start one on the Mac yet. | packaging | M4 | `desktop/` |

## Jobs: the Linux backend has no macOS counterpart yet

On Linux, a Job runs in its own systemd user unit, as Core's user, with cgroup v2 resource controls. Core checks that the limits took effect before starting it. For the processes in that unit's cgroup, that gives:
- a memory cap for them together, enforced by the kernel's OOM kill;
- a swap cap;
- a CPU quota;
- a cap on their processes and threads;
- tracking, and evidence of the end: Core records it when the cgroup has no processes left;
- usage accounting.

**This is resource control, not a security sandbox.** Jobs run in that user's own systemd manager and are not isolated from it. A process with the same rights can move itself to another cgroup in the user's tree by writing to `cgroup.procs` (see the kernel's [cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#processes)). Yuzuno does not guarantee that a Job cannot leave its cgroup.

The current implementation has no macOS backend. The obvious tools do not give the same hard limit for a whole group:
- Resource limits (`setrlimit`) apply to each process separately.
- Priority (`nice`, `taskpolicy`) changes scheduling but sets no quota.
- A process group lets Core signal the processes still in it, but a process can leave its group.

Whether another macOS mechanism could would need its own investigation; this page does not rule one out. **A launcher built from these tools must not be shown as the same capability.**

The user chose (YN-108) to run Jobs on a macOS Core's own host in **limited mode**, as Jobs already run on a remote Mac (YN-104): the declared CPU and memory are used to queue and are recorded, but nothing enforces them, and the Jobs pages say so. Slice M2c does this: the built-in machine `mac`, This Mac, reached without SSH by the Mac's own `/usr/bin/python3` running the same helper (`core/src/jobs/remote_job.py`). Each attempt runs in its own process group, which cancel and timeouts stop. One Job can still use the whole Mac.

The helper's data root may have spaces inside a folder name (a Mac's default data folder is under `Application Support`), not at either end of one; a data folder with other characters (non-ASCII ones, for example) is refused at the attempt's start, with the reason. A registered machine's root still allows no space (`core/src/remote.rs` `validate_root`).

## Slices (YN-108)

Each slice is its own pull request. M1, M2a, M2b, M2c, M3a and M3b are in this commit; M4 is planned.

| Slice | What it adds |
|---|---|
| M1 | Core's tests on macOS in CI, older Cores kept out on macOS, SIGTERM tested on macOS, the system named in Settings → Updates. |
| M2a | Managed updates: the running Core's process identity on macOS, and the two update helper fixes. |
| M2b | Starting and stopping a managed Core on macOS, its start profile, and a manual install guide. |
| M2c | Jobs on the Core's own host in limited mode. |
| M3a | A `macos-aarch64` release input, built and checked in CI. |
| M3b | Packaging, signing and publishing both platforms in one release. |
| M4 | The Mac desktop app downloads, verifies, installs and starts Core. |

**Not planned in YN-108:** Developer ID signing and notarization, starting Core at login, and phone access to a macOS Core. macOS is Apple silicon (arm64) only (YN-161): Intel Macs (`macos-x86_64`) are not supported.
