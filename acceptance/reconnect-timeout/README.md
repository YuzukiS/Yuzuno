# Recheck the same native session after a timeout (T19)

Baseline: `6673c3ef237a934fd5220cb6ce15738ec78d79bf`. Its Core/UI sources
match published core.6 (`50d766c`); the intervening changes are release tooling.
The isolated `baseline.py` probe reproduced the bug on the published binary
(SHA256 `30a9cafbb00c186fc467cae76bcf8495070049da451755579f0578693fb8f70d`).
Job `d3a064e6-2434-490c-9dc3-ec0cfa7b6526` succeeded: after 45.02 seconds,
resume returned an unknown outcome but connectionState stayed `connecting`.
A second reconnect replaced the original local process (PID 713728 → 715447).
The original task was submitted once. This confirms a current bug, not just
the old T15 report. The probe used disposable data and port 47599; it did not
touch the daily Core, credentials, working sessions or UI.

The fix retains the original native attach request, response receiver and
snapshot boundary on its connection. A later check waits for that same reply;
it sends no second resume/start, model input or fork. A timeout ends the current
bounded check and sets `connectionState: unconfirmed`; it keeps the process and
generation. A late valid reply must identify the original thread before Core
applies it and then reads fresh native state. Missing/invalid replies remain
unconfirmed. A native rejection retains its actual error. Explicit user close
and genuine disconnect retain their existing lifecycle behavior.

A failed read of an already attached thread also becomes unconfirmed, so both
local and remote recovery controls remain usable. Existing `connected` plus
`uncertain` records have a check entry too. While a check is actually in flight,
the lifecycle gate and UI busy state prevent duplicate operations. Drafts and
message receipts stay untouched; current-generation approvals keep their
transport. The production request deadline remains 45 seconds. Tests shorten
only the per-test Workspace deadline.

Claude's initialization path differs: the SDK bridge bounds initialization and
MCP registration together, closes a failed query before acknowledging readiness,
and accepts no model input until ready. Core records `disconnected` on that
failure, so retry was already available. This change does not alter Claude's
startup, settings or event handling.

Validation scripts/tests:

- `baseline.py <published-core-binary>` runs the original behavior probe once
  in a new `target/t19/baseline` directory; evidence and owned process cleanup
  are part of the same Job. It expects the original bug and is not a regression
  test for the repaired binary.
- `core/src/collaboration_admission_tests.rs` exercises real HTTP against
  deterministic native peers: repeated unknown checks, late success with active
  and completed turns, retained approvals/generation, read timeout/rejection,
  wrong identity, late native rejection and lifecycle serialization.
- `web/tools/recovery-ui.test.mjs` and `remote-ui.test.mjs` cover the recovery
  entries and retries against fixture HTTP. No real model is used by these tests.

Observed validation (2026-10-16, isolated Jobs):

- `b0b13b84-171e-4b7b-8512-613bb5e901cf`, head `4b6e68a`: all 28 Core
  checks passed (10 HTTP/admission, 11 concurrency, 2 transport, 5 empty-session).
- `ce7df757-5523-40a6-b962-81e8f1e07a62`, head `3b4f8db`: all 14 UI checks
  passed, including immediate duplicate clicks, repeated unknown results and a
  retained controlled draft. This Job then failed typecheck because the borrowed
  dependency directory lacked the baseline's CodeMirror packages.
- `d0d0dcc6-20b9-4555-9946-e44d85c5843d`, same head: installed the unchanged
  lockfile in this worktree's own `web/node_modules`; typecheck passed. The shared
  dependency directory was not modified. Core code is unchanged from `4b6e68a`.

Earlier failed runs remain in `target/t19`: a compile-time signed sequence-type
mismatch, an old native fixture without a valid `thread/read` response, and two
UI fixture issues (notice assertion scope and cross-realm error construction).
Each was corrected before its affected checks passed; failed Jobs are not
reported as successful overall. The directory retains raw logs and machine
evidence for all runs. For a fresh checkout, install the web lockfile before
running `check.sh` through a Job. These are model-free protocol/component checks,
not acceptance against live Codex/Claude accounts or an actual SSH host.

Agent tool usage is unchanged, so canonical Yuzuno skill synchronization is N/A.
Independent native review and exact-head CI remain separate delivery gates.

First candidate `b0ccda16` received native review
`3c2dd3f7-78f5-4a60-aa84-c6d866e4c01e`: no findings, all 14 changed-file diffs
delivered and no unresolved source reads. CI run `38968896684` attempt 1 passed
Web, Claude bridge and report-only lint, but Core had 13 failures at the same
shared collaboration test setup (377 passed, 6 ignored). That native fixture
also returned an empty object for `thread/read`. It now returns its existing
same-thread snapshot for reads; the production identity check remains intact.
Job `88c060ee-9d60-4e48-9d6a-bb6fe70f811d` then ran the full locked Core suite
on `e3da2d7`: 567 passed, zero failed, 10 ignored (including the existing
opt-in live/large-data checks). It completed successfully with 2 CPU, 5 GiB RAM
and no swap. The corrected candidate needs its own fixed-head review/CI;
original CI evidence and the complete local test log remain in `target/t19`.
