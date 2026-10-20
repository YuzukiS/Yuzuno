# Isolated multi-agent acceptance lab

This directory is separate from the daily Core at port 4317 and `web/dist`.
The lab uses port **4327**, `core-data`, `tasks`, and `web-build-src/dist` here;
Core is built in this checkout's `target/` (or `$CARGO_TARGET_DIR`) through
`scripts/source_build.py`, and the lab runs its copy in `core-bin/`;
`start-core` refuses a copy that no longer matches the source. No Tauri window
is opened or attached to by these scripts.

From the repository root:

```sh
python3 scripts/slice-lab.py prepare
python3 scripts/slice-lab.py check-web
python3 scripts/slice-lab.py build-core
```

`prepare` records the daily Core's health and PID identity and hashes its served
`web/dist` files using read-only operations. It copies web source (excluding
generated output and environment files) and reuses the existing dependencies
through a `node_modules` symlink. `check-web` type-checks, builds, and runs the
existing UI tests in that copy. It does not install packages or contact a model.
The copied Vite config points at 4327, and Vite uses its runner config loader so
it does not write a temporary config into the shared dependency directory.

Refresh the snapshot after frontend changes, then rerun the web check:

```sh
python3 scripts/slice-lab.py snapshot
python3 scripts/slice-lab.py check-web
```

Only after the root agent is ready for real model acceptance:

```sh
python3 scripts/slice-lab.py start-core
python3 scripts/slice-lab.py status
node acceptance/multi-agent/browser-live.mjs inventory
```

The Core uses the official `codex` executable by default; override with
`start-core --codex /absolute/path/to/codex`. Core startup may launch the official
App Server for catalog access, so it is intentionally a separate explicit step.
The launcher records PID, kernel start time, and exact arguments. It will not
reuse an occupied port or stop any process whose identity differs from that record.

Browser runs are **headless and read-only** and reject any origin other than
`http://127.0.0.1:4327`. They block mutation requests and check that review state
did not change. Use `YUZUNO_BROWSER_BIN` if the installed Chrome executable needs
an explicit path. No daily Core API, Tauri/CDP attachment, approval automation,
model prompt, or SSH operation is built into the read-only runner.

For recovery, capture before the root-controlled disconnect/reconnect and compare
afterward. The comparison permits new native items while ensuring earlier ones
remain present, with no duplicate IDs or new Agent identity.

```sh
node acceptance/multi-agent/browser-live.mjs capture
node acceptance/multi-agent/browser-live.mjs compare
python3 scripts/slice-lab.py verify-daily
python3 scripts/slice-lab.py stop-core
```

The root-controlled GUI exercise is a separate explicit operation. Copy
`exercise-config.example.json` to `exercise-config.json`, set the approved Mac mini
destination, stable official Codex path and prepared acceptance cwd, choose a unique
run ID, and set `allowModelTurns` to true only when ready. Confirm the chosen model
is present in the real `/api/models` catalog first.

```sh
node acceptance/multi-agent/browser-live.mjs exercise
```

This creates two local Agents and one remote Agent through GUI controls, sends one
bounded file-writing task to each, and previews each `report.md:2` result. Turns
overlap; each writes only its own task folder. Agent IDs are recorded after every
creation in `exercise-RUN_ID-state.json`. A repeated run ID refuses to create more
Agents, so a failed/partial run can be inspected without accidentally resending work.

`exerciseControls` is false by default. If explicitly enabled, the runner adds one
remote approval test for **exactly** `/usr/bin/printf YUZUNO_APPROVAL_RUN_ID`, allowing
only that command once and only in the selected cwd; any unexpected request stops
the run without approval. It then interrupts a separate `/bin/sleep 45` turn. No
session-level approval is sent. The normal first exercise leaves those controls to
the root agent's separate recovery tests.

`reconnect` mode requires `reconnectAgentId` in the config. It clicks the real
Reconnect button only when disconnected and verifies stable thread/runtime/read
state. If automatic recovery already completed, the report explicitly says the
manual button was not exercised. No disconnect is performed by the runner.

`scenarios.json` is a plan, **not evidence that these scenarios passed**. There is
no intercepted or mocked API response. If another actor changes the daily
build or restarts its Core, `verify-daily` reports the difference without trying to
restore or alter anything.
