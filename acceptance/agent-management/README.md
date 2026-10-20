# Agent management and Claude model selection

Implemented in the main source and deployed to the original daily Workspace at
`http://localhost:4317` after the user's WSL reboot. The same five Agents and their
transcripts were preserved exactly at startup. No real daily Agent was deleted,
closed, or given a new task during acceptance.

- **Close** in the conversation header interrupts a connected active turn, waits
  for native completion and process shutdown, and keeps the Agent under **Closed**.
  Reopen retains its identity, conversation and native session.
- **Conversation actions → Delete agent…** confirms permanent deletion of this
  Workspace record and journal. Project files and native harness transcripts stay
  on the execution machine. The draft is removed only after successful deletion.
- Claude creation and existing-Agent settings use the official SDK's
  `supportedModels()` catalog. Selection is persisted and applied with `setModel()`
  before the next turn. A running turn is unchanged. Catalog probes have
  `persistSession:false`, cannot accept prompts, and close their owned processes.
- Closed Agents cannot accept sends, settings, approvals or automatic reconnects;
  they do not contribute active Catch-up or attention counts. Deletion is fenced
  against late native events. Remote stop verifies the Workspace/Agent runtime,
  instance, PID, process birth and command before sending a signal.

## Evidence

| Check | Result / evidence |
| --- | --- |
| Rust Core | 85 passed, 1 existing opt-in ignored; `core-tests-serial.log` |
| UI production bundle | 32 passed; `ui-tests.log` |
| UI supporting suites | 24 passed; `ui-supporting-tests.log` |
| Claude bridge protocol fixtures | 12 passed; `claude-bridge-tests.log` |
| Real native lifecycle | 14 checks; `native-report.json` |
| Management browser fixture | 19 checks; `browser/report.json` |
| Existing panel resize regression | 20 checks; `panel-resize/report.json` |
| Daily deployed browser smoke | `daily-browser-report.json`; read-only API traffic |
| Daily startup and session recovery | `deployment.json`, `daily-recovery.json` |

The real lifecycle checks used disposable local Codex and Claude Agents plus a
new, separately owned Mac mini Codex Agent. They verified idle close/reopen with
the same session and history, local active-turn close, deletion, original native
transcript preservation locally, and an unchanged project sentinel. Remote
transcript deletion is never requested by the helper; this run did not separately
read the remote transcript file. The remote checks did not touch older lab Agents.

Browser fixtures cover cancel, backend failures, saved drafts, reload/reopen,
closed counts, Claude catalog retry, and light/dark layouts at 20px, including
390px. A 721px header overlap was fixed and the existing two-panel resize work
was preserved. Tests do not claim native Windows WebView2/DPI verification.

An initial parallel Rust run hit an existing test's immediate lock reacquisition
during concurrent subprocess creation. The complete serial run passed; production
Workspace locking was not weakened. The obsolete UI expectation that Claude has
no settings button was replaced with a model-only dialog check. The first daily
smoke used an overly exact button-name selector that omitted the shortcut label;
its failed report is retained separately.

## Restart and resource handling

The user rebooted WSL during work. The daily database was backed up with SQLite's
backup API before startup; previous binary and UI are in `daily-pre-upgrade/`.
Dev 1 was reattached to its original Codex thread with all 13 Turn IDs retained.
Native history confirmed its last turn was interrupted; the obsolete pending
approval was cleared by reconciliation. No prompt or approval was submitted.
Other Agents reconnect when used, avoiding unnecessary idle runtimes.

Only one browser ran at a time for the final checks; Node's heap was capped.
The temporary Core on 4377 and its catalog process were stopped, and browser/test
processes were closed. The daily Core on 4317 remains running. Memory measurements
in `memory.json` describe the temporary Core tree before shutdown, not total WSL
memory or a production benchmark.

Close is not a blanket process-group kill: intentionally detached background
tools are separate from the harness runtime. An old disconnected local turn may
have an unknown result; closing never invents a successful completion. An
unconfirmed remote shutdown returns an error and retains the Agent record.
