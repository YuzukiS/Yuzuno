# Machines page and each machine's most recent check (T-5)

> Public copy: hostnames, account names and absolute machine paths below are illustrative replacements. Historical outcomes remain observations of the original private environment; these example endpoints were not contacted. Raw evidence is retained privately.

Branch `feat/machine-checks`, base `b1ede52`, with `main` 4511ee2 merged in for R2. Not merged into `main`; the daily Core on port 4317, its `web/dist` and data were not touched (same pid and hash before and after).

## What changed

- **Core** (`core/src/machines.rs`): `POST /api/machines/{id}/check` records every result, failures included, in a new `machine_checks` table kept apart from machine configuration. Each machine in `GET /api/machines` carries `lastCheck` (null if never checked). The Machines page and New agent read and write this one record. If two checks overlap, the one started later is kept. A failed connection returns 200 with `reachable: false`; an unregistered machine is still a request error.
  - **Core host**: hostname, platform and home; `codex --version` for the Codex that Core runs; `claude --version` plus the Node binary that Yuzuno's Claude bridge needs; and the default folder.
  - **SSH**: the existing helper's probe now reports reachability apart from a missing Codex or folder, which no longer fail the whole probe. Remote creation and recovery do not use `probe` and are unchanged.
- **UI**: "Machines…" in the bottom-left Workspace menu opens a page with one card per machine (Core host and each SSH machine), showing:
  - the stored check: when it ran, whether Core reached the machine, and which Harness CLIs answered `--version`. A tooltip says sign-in is not checked.
  - the default folder.
  - the agents on that machine, each with its own live state.

  Results older than one hour are labelled "May be out of date"; age never means offline. Unknown is "Not checked yet". Opening an agent closes the page and moves the window to that agent's project. New agent shows the same stored result through the same component, and can now test the Core host too. Automatic reading is paused while the page is open, and the read-only preview has no entry.

## Checks

| Check | Command | Result |
|---|---|---|
| Rust | `cargo test --locked -j 2 -- --test-threads=1` | 171/171, including 5 in `core/tests/machines.rs` (one runs the exact SSH helper locally through `python3`) |
| UI | `node web/tools/{ui,collaboration-ui,projects-ui,machines-ui,remote-ui}.test.mjs` | 46 · 10 · 14 · 3 · 6 pass |
| Isolated Core | `python3 acceptance/machine-checks/live.py run` | 8/8 |
| Browser on that Core | `node acceptance/machine-checks/live-ui.mjs` | 13/13 |

**Isolated Core** (port 4337; lab Workspace in `lab/`). The real checks returned:

- **Core host**: lab-host, Codex `codex-cli 0.162.1`, Claude Code `2.1.280`.
- **Mac mini**: probed read-only through the existing SSH configuration (`tester@192.0.2.10`). Reached `lab-mac.local`, found Codex 0.162.1 and resolved the folder. No runtime was started or stopped there.
- **Mac mini with a wrong Codex path**: reached, but Codex not found, with the helper's error.
- **`nobody@host.invalid`**: recorded failure, "Could not resolve hostname".
- **Restart**: Core was stopped and the Mac mini result aged by three hours in the lab database. After restarting, every result was still listed with its own time.

**Browser** (fresh Chromium):

- All four machines are listed. The aged Mac mini shows "3 h ago · May be out of date".
- "Reached" and "Codex not found" appear side by side for the wrong-path machine.
- The failure shows its reason, and the word "online" appears nowhere.
- Testing the Core host from the page stores a newer result for that machine only.
- New agent shows the same aged Mac mini result. Its own test then appears on the Machines page as "just now".
- Opening the lab agent from its machine closes the page.
- Dark theme with 20 px text works, and at 390 px there is no horizontal overflow.

Dark theme was checked through `data-theme`; 20 px text only from the screenshot.

Local evidence, not committed: `live-state.json`, `live-ui-result.json`, `screenshots/` (light, after a test, New agent, dark with 20 px, narrow) and `lab/`.

**Preview.** `python3 acceptance/machine-checks/live.py run`, then open <http://127.0.0.1:4337> → bottom-left menu → Machines…. Run `live.py stop` afterwards.

## R1 rework (Opus R1 FAIL on 4423694, one P2)

**Finding.** New agent no longer showed why a test failed. A failed connection is now a stored 200 result, and the compact summary hid `error` and the folder error.

**Fix.**
- The shared `LastCheck` shows the connection error, the folder error and an unavailable Harness's reason as visible, wrapping text in every layout.
- A missing, failing or timed-out CLI reads "unavailable" instead of "not found", following the review's suggestion.
- Core is unchanged.

**Tests.** Two New agent regressions (`remote-ui.test.mjs` test 5) cover an unreachable result, and a reached machine with Codex and folder errors. They fail on 4423694 and pass now.

**Merge.** `main` 4511ee2 changed only the web and docs. The one conflict was the `test` script, which now keeps both test sets. The Rust results still apply, since the Core is identical to the reviewed one.

**Results after the merge:**

| Check | Result |
|---|---|
| UI test files | ui 46, collaboration 10, projects 14, machines 3, remote 7, artifact-groups 3, intelligent-ui 13, intelligent-ui-storage 7, auto-read 12 |
| Fresh isolated-Core run (`live.py run`) | 8/8 |
| Browser (`live-ui.mjs`) | 15/15, including the two new New agent failure-reason checks (screenshot `3b-new-agent-failure-reason.png`) |

The daily Core, `web/dist` and data were unchanged.

## Limits

- A found CLI only means it answered `--version`. Sign-in, account and the Claude bridge's npm dependencies are not checked.
- Nothing runs checks in the background, by design. The one-hour label is display only.
- Out of scope: editing or deleting machines, moving an SSH target, fingerprints.
- `collaboration-ui.test.mjs` test 2 ("a background task update preserves drafts…") fails intermittently. On `main` it failed in 3 of 5 runs; this branch does not touch it.
- A load-sensitive wait in `projects-ui.test.mjs` test 1 (from T-2) is fixed here: 0 failures in 6 runs under load average about 20.
