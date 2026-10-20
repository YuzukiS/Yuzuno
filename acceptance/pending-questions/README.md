# Persistent question entry (T-41)

Unanswered async questions stay above the current conversation's composer while
output continues or the reader scrolls upward. The compact entry shows a question
summary, a count and previous/next controls. Both this entry and the original
question open one answer form. Original question text/options remain in history;
“Original question” returns focus to that exact turn/item without following output.

Answers use the existing send/receipt path. Sending, rejection and uncertain
transport keep the question visible; only an accepted receipt or an explicit
cancelled/expired item removes it. Reading a question or completing its turn does
not answer it. Uncertain delivery cannot be resent from the form; “Check delivery”
uses existing reconnect/refresh. Ordinary composer content remains independent.
Answer drafts are scoped by workspace, Agent, turn and item in localStorage. A
failed write keeps the in-memory draft and shows a copy-before-reload warning.

## Data boundary

The fixed pending list derives from raw Core detail, which retains its known
question items. Imported Codex history pages are read-only and are not eligible
for direct question submission: Core does not store their source items. The UI
therefore distinguishes those questions as “Historical question · answer status
unconfirmed”, excludes them from pending counts, and offers only adding a quoted
answer to the ordinary draft. It does not claim that this answers the old question.
Unloaded pages have an explicit “Earlier history has not been checked” notice;
loading remains manual. No Core change, eager history sweep or new poll was added.

`QuestionIndex` caches projections by immutable turn identity and returns a stable
question list when only ordinary output changes. It never reads message bodies.
Typing writes only that question's draft. Existing outbox data is exposed by the
send hook as a read-only input; its delivery branches are unchanged. App/components
changes only connect the entry, source navigation and shared form. T-37 result
rendering, T-21 Claude sending, native approvals and T-33 pasted text remain intact.

## Evidence — 2026-10-14

- Typecheck and isolated Vite production build passed.
- Full App UI: 61/61 passed after correcting the Agent selector in a new test.
  The six changed question cases then passed under hard resource limits,
  including a held sending response, rejection/retry, uncertain refresh,
  cross-turn drafts, Agent switching, source navigation and imported history.
- Question model: 4/4; imported-history UI: 17/17. Other 28 files passed during
  the initial full suite. That initial run was **not** green: UI exited 137 and
  the history ordering test missed a fixed-time wait; the history file passed
  unchanged in its sequential rerun. CI must independently pass the candidate.
- Seven Chromium checks passed using the production GUI with controlled HTTP
  and native-shaped SSE question/delta events. No native model or Core ran.
  Light/dark screenshots cover 1440x1000 and 390x844 at 20px; the dock stays above
  the composer and dialogs fit. Screenshots were visually inspected.
- A controlled 775ms window delivered 60 deltas and 60 answer edits: 60 draft writes,
  at most 110 UTF-16 units each, no outbox/paste-body storage reads and no detail
  or history fetches. This is fixture instrumentation, not a native benchmark.
- Final six-case UI plus browser process tree: `memory.max=3221225472`,
  `memory.swap.max=0`, peak 489684992 bytes, zero OOM events. Build plus preceding
  browser run peaked 926081024 bytes under the same limits.
- The shared test runner now gives every Node file an explicit 2GiB V8 old-heap
  limit. It is not a total process memory limit; local cgroup limits remain required.

Local evidence is under this worktree's `target/t41/`: `browser-verified/report.json`
and six screenshots, `final-targeted-bounded.log`, `build-browser-bounded.log`,
`final-ui-tests.log`, `final-session-import-tests.log`, `final-model-tests.log`,
`runner-bounded.log`, and `build-identity.json`. The browser fixture is
`web/tools/pending-questions-browser.mjs`; it requires `YUZUNO_UI_DIST` and
`YUZUNO_BROWSER_OUTPUT`, intercepts every request, and rejects the daily `web/dist`.

### Local test resource incident

The 18:03:34 EDT initial full suite used heavy-slot and timeout but omitted memory
limits. `ui.test.mjs` exited 137 after 189s; Lead's host evidence reported 16GiB swap
exhausted. The last completed case was 56. Test 57 clicked `.agent-row` (an article
with no selection handler) instead of `.agent-select`, then compared a live DOM
node with null. The failed assertion's JSDOM/React object formatting is a
code-supported allocation hypothesis; no heap/stack capture proves it. The
selector and all new DOM comparisons were corrected (boolean comparisons keep
failure diagnostics bounded). A later 61/61 pass does not prove the allocation
cause. Original logs and exact tool times remain in `memory-incident.md`,
`memory-incident-tool-evidence.json`, and `web-tests.log`; no unbounded incident
reproduction was performed.

All subsequent local validation used the two-slot wrapper plus
`systemd-run --user --scope -p MemoryMax=3G -p MemorySwapMax=0`,
`NODE_OPTIONS=--max-old-space-size=2048`, a project-disk TMPDIR and timeout.
The wrapper verified both actual cgroup files before executing; failure to set
limits must stop the run. Browser subprocesses share the scope. No daily Core,
listener, DB, user browser or other worktree was touched.
