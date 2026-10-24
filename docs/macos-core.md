# macOS Core: gaps and a first slice

**A macOS Core is not supported.** This page records:
- what Core does on a Mac today, from the source of main `1cbfb66` and one source build on a Mac mini;
- what is missing;
- a proposed first slice.

The proposal is not implemented. Remote Codex Agents on a Mac over SSH are a separate feature, and they do not make a macOS Core.

## What was checked

On 2026-10-17, on a Mac mini (Apple silicon, macOS 27.0.1, 12 CPUs, 32 GiB), in a new folder `~/yuzuno-t88-macos-lab`:
- **Tools already on the Mac:**
  - Rust 1.98.1 (stable, aarch64-apple-darwin), called directly with the lab's own Cargo home and target folder;
  - Xcode 26.6 with Apple clang 21;
  - `/usr/bin/python3` 3.9.6.

  Nothing was installed; crates were downloaded into the lab's own Cargo home. No global setting, account or running process was changed.
- **Build:** `cargo build --locked --bins` of main `1cbfb66` succeeded in 30 s (debug profile, no debug info). It made an arm64 Mach-O `yuzuno-workspace` and `yuzuno-update-helper`. The only warning was that `rust-objcopy` aborted while stripping debug info, which did not stop the build.
- **Tests:** the Rust tests compiled in 26 s. They ran serially, as in CI, with the lab's own `HOME`, a short `TMPDIR` and only Node added to `PATH`: **624 passed, 23 failed, 9 ignored**.
  - **21 managed-update tests** failed because the process identity read refuses: "Managed Core updates require Linux/WSL" (`updates::tests`, `updates::notices::tests`, `updates::state::tests`).
  - **1 Jobs test** failed because the Jobs helper reads `/proc/sys/kernel/random/boot_id` (`jobs::tests::host_evidence_and_git_input_guard_regressions`).
  - **1 result-validator test** failed because it compares a canonical path with an uncanonicalized temporary folder; macOS resolves `/tmp` to `/private/tmp` (`results::tests::a_release_runs_only_its_own_validator_and_older_releases_still_verify`).
  - `tests/agent_lifecycle.rs` is compiled out on macOS (`cfg(target_os = "linux")`).
  - Three checks that a child process was reaped look for `/proc/<pid>`, so on macOS they pass without checking anything (`core/src/rpc.rs`, `core/tests/codex_session_import.rs`).

  An earlier run had 22 more failures, all caused by the lab's setup, not by macOS:
  - Node was not on `PATH`;
  - `TMPDIR` was long enough to push test socket paths past macOS's 104-byte limit, which the remote helper rightly refused;
  - the Jobs test script had not been copied.
- **A lab Core:** it ran on `127.0.0.1:4589` with its own data folder and `--codex` pointing at nothing. It was checked through its HTTP API only; the web UI was not built. No model and no Codex was started.
  - `/api/health` reported the API and storage ready.
  - `/api/updates` (what **Settings → Updates** shows) reported platform `macos-aarch64`, not managed ("development checkout").
  - The Core host check reported `Darwin`.
  - Jobs were refused (see below).
  - SIGINT stopped it cleanly.

The scripts and output are kept outside Git with the T-88 evidence. They are named in the task, not here.

## Gaps on macOS

None of these gaps stops the build. **Runtime** means the code builds but refuses or behaves differently on macOS. **Tooling** and **packaging** are outside Core's binary.

| Area | On macOS today | Kind | Code |
|---|---|---|---|
| Build | Builds. Core's only compile-time Linux gates are the glibc `mallopt` tuning, which is left out, and the process identity reader, which refuses elsewhere (see Managed updates). | none | `core/src/main.rs`, `core/Cargo.toml` |
| Workspace storage | Works: bundled SQLite, `File::try_lock` on `workspace.lock`, owner-only data folder. The default data folder is `~/Library/Application Support/yuzuno/workspace`; one an earlier build made in `~/Library/Application Support/yuzuno-next` is used where it is. | none | `core/src/store.rs`, `core/src/workspace.rs`, `core/src/data_dir.rs` |
| Browser boundary and API | Works: Core listens on 127.0.0.1 only. The SSH tunnel path is the same code as on Linux but was not tried on a Mac. | none | `core/src/main.rs`, `core/src/server.rs` |
| **Jobs** | **Refused.** The budget returns "Local managed jobs require Linux with a systemd user manager". `job_submit` fails with a Python traceback (`FileNotFoundError: 'systemctl'`), not that message. No Job runs. | runtime | `core/src/jobs/host.rs`, `core/src/jobs/host.py` |
| **Managed updates** | **Refused.** Prepare and Apply need the running Core's process identity, which is read from `/proc` ("Managed Core updates require Linux/WSL"). | runtime | `core/src/updates/state.rs` |
| Update helper | Would need fixes before updates could work. It reads `/proc/self/fd/1` so that log pruning skips its own live log; on macOS that read fails silently and the live log is not protected. It also compares `current_exe()` with release paths: on Linux that path is already resolved, on macOS it may not be. | runtime | `core/src/updates/helper.rs` |
| Packages, signing, CI | Linux x86_64 only. The build script refuses other systems, packaging names only `linux-*`, signing accepts only `linux-*`, and CI has no macOS job. | tooling | `tools/build-core-artifact.py`, `tools/package-release.py`, `tools/sign-core-release.py`, `tools/core-release.py`, `.github/workflows/ci.yml` |
| Starting and stopping Core | The Linux guide starts Core with `setsid nohup` (macOS has no `setsid`) and stops it with SIGINT. Core now takes SIGTERM, as `launchd` or a plain `kill` sends it, through the same graceful shutdown as SIGINT (T-88; tested on Linux, not yet on macOS). | runtime | `docs/independent-core.md`, `core/src/main.rs` |
| Finding Claude Code, Node, Codex, git, gh | Through Core's `PATH`. A Core started outside a login shell does not see `/opt/homebrew/bin`: the lab check without it reported "Claude Code was not found on Core's PATH". With `/opt/homebrew/bin` on `PATH`, the same check found Claude Code 2.1.267. | runtime | `core/src/machines.rs`, `core/src/claude.rs` |
| Labels | Jobs are not marked unavailable: the job tools stay advertised to Agents, and the Jobs panel shows the refusal as an error. Settings → Updates says "Linux / WSL". There is no capability list. | runtime | `core/src/collaboration_store.rs`, `web/src/Jobs.tsx`, `web/src/WorkspaceUpdates.tsx` |
| Desktop app | Windows only. On a Mac, use a browser. | packaging | `desktop/tauri.conf.json` |

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

Whether another macOS mechanism could would need its own investigation; this page does not rule one out. A Mac launcher built from these tools could offer timeouts, cancellation of a process group, lower priority and a queue, but not hard limits for the group. **It must not be shown as the same capability.**

The first slice therefore leaves Jobs unavailable on macOS. A later "not resource-limited" mode would be a separate, opt-in product decision with its own label.

## Proposed first slice

**A Core built from source on Apple silicon, without Jobs and managed updates.** This needs the Lead's and the user's agreement before any code is written.

**In scope:**
1. **Jobs reported as unavailable on macOS:**
   - Core refuses Jobs with one clear reason before running the Python helper, so the traceback goes away.
   - The Jobs panel shows "Not available on this Core" with that reason, instead of an error.
   - Agents get the same clean refusal.

   Linux behaviour does not change.
2. **SIGTERM handled like Ctrl-C,** so `kill` or a service manager stops Core gracefully. Done for every Unix build (T-88, `core/tests/core_signals.rs` on Linux); still to be run on a Mac.
3. **Tests that pass on macOS:**
   - the 22 Linux-only update and Jobs tests are gated to Linux;
   - the result-validator test compares canonical paths;
   - the three `/proc/<pid>` checks get a macOS equivalent, or are marked Linux-only.
4. **A macOS section in the install guide:**
   - prerequisites (Xcode Command Line Tools, Rust, Node 20 or newer for Claude Code);
   - build;
   - starting Core in a terminal with an explicit `PATH` including `/opt/homebrew/bin`;
   - the data folder, and how to stop Core;
   - what is unavailable.

   Updating a source build means pulling and rebuilding.

**Not in scope:**
- managed updates, release packages, signing or notarization;
- a `launchd` service;
- Jobs in any form;
- a macOS desktop app;
- Codex acceptance.

**Acceptance**, on the Mac mini, in a new folder with its own port and data:
- the guide's commands build Core from a clean checkout;
- `cargo test` passes;
- Core starts, and a browser on the Mac opens it;
- a Claude Code Agent answers one real turn and an approval is granted in the page;
- closing and reopening the page keeps history and the draft;
- the Jobs panel says Jobs are unavailable, with the reason, and an Agent's `job_submit` gets the same refusal with no process started;
- **Settings → Updates** says updates are off for this Core;
- SIGTERM stops Core and it starts again on the same Workspace.

Optional: a Windows browser connects through an SSH tunnel, as on Linux.

The real turn needs Claude Code to be signed in for the session that starts Core. On the Mac mini, `claude auth status` run over SSH reported not logged in. A Core started from the Mac's own Terminal may be able to use a login kept in the Keychain. This is not yet verified.

**Decisions for the user:**
- **CI for macOS:** GitHub-hosted macOS runners are billed. The Mac mini as a self-hosted runner would run pull-request code on a personal machine.
- **Whether a source build is enough** for a public alpha, or a package is needed.

## Later slices

Each would become its own product task once designed.

**Managed updates and packages on macOS:**
- process identity through `proc_pidinfo`/`proc_pidpath` (this needs `libc` for Apple targets);
- the update helper fixes listed above;
- a `macos-aarch64` package, with `otool` checks in place of the glibc and ELF checks;
- a minimum macOS version;
- signing;
- a start method that survives an update (a `launchd` agent or a documented foreground start);
- deciding whether Gatekeeper signing or notarization is needed for downloaded binaries.

**Jobs on macOS:** stay unavailable, or an opt-in mode clearly labelled "not resource-limited". Never presented as Linux's hard limits.

**A macOS desktop app:** a Tauri app bundle and an updater target on both the app and Core sides.
