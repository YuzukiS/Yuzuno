# T-14 acceptance: message times, reply footer, background shells

The isolated Core runs on port 4414. It uses this checkout's build and
`web/dist`, with a lab data folder under `lab/`. Codex and Claude run real short
tasks with their normal CLI logins; no credential is copied.

**First run (2026-10-13):** on base f9bdd91, commit f239bc7. That commit is kept
on branch `checkpoint/t14-before-fe51b05`.

**Second run (2026-10-14):** after rebasing onto fe51b05 (the event-routing,
row-storage and SSE-patch trunk). The same lab data was converted to row storage
on first open, and a backup copy was kept.

The daily Core (4317) and the daily `web/dist` had the same hash before and
after each run.

```
python3 acceptance/conversation-time/live.py start
python3 acceptance/conversation-time/live.py migrated        # f239bc7's times after the row migration
python3 acceptance/conversation-time/live.py large           # Codex: a trimmed large output
python3 acceptance/conversation-time/live.py codex|claude    # a background shell; T14_SHELL overrides it
python3 acceptance/conversation-time/live.py watch codex|claude
python3 acceptance/conversation-time/live.py sse codex|claude
target/heavy-slot.sh node acceptance/conversation-time/live-ui.mjs [suffix]   # T14_STREAM=0 skips the streamed turn
python3 acceptance/conversation-time/live.py restart
python3 acceptance/conversation-time/live.py stop
```

Evidence JSON (`evidence/`), screenshots (`screenshots/`) and
`live-ui-result*.json` are git-ignored and stay local.

## Where the data comes from

Every time is taken from the event being applied: `apply_at` or
`project_event_at`, using the event's journal time, or the current time for a
streamed event, which is never journaled. Projection and journal replay never
read the clock, so a rebuilt record is the record readers saw.

| Fact | Codex | Claude |
| --- | --- | --- |
| Message time (`_yuzunoTime`, written once) | Native `item/started.startedAtMs`, else `item/completed.completedAtMs`; otherwise the event's time (`source: core`) | The event that first creates the message: its first streamed block, or the journaled completed block when the stream was lost. The prompt uses its Turn's `_yuzunoStartedAt`. |
| Turn duration | Native `Turn.durationMs` | SDK `result.duration_ms` → `_yuzunoDurationMs` |
| Turn end | Native `Turn.completedAt` (s); `_yuzunoCompletedAt` from the live `turn/completed` | `_yuzunoCompletedAt` from the live `result` |
| Shells still running | Experimental `thread/backgroundTerminals/list`, read on `turn/completed` and on a command's `item/completed` outside a running Turn | SDK `background_tasks_changed` snapshots: `local_bash` tasks that are not ambient |

Background shells live in memory only, tied to the runtime connection
generation. They are added to the detail response through a wrapper around
`client_detail`, so neither the stored record nor `AgentDetail` changes, and the
detail is still trimmed and serialized on the blocking pool.

A changed count is announced as `agent.changed`. Claude's snapshot is evidence
only, so it is announced before the route returns early. Codex terminals are
listed after the event is recorded, on the Deferred and Synchronous paths. No
timer polls.

## Results after the rebase (2026-10-14)

- **Row migration.** Every time f239bc7 had recorded read back unchanged, for
  both harnesses (`evidence/migrated.json`).
- **Codex.** Native item times and `durationMs` were recorded. The shell count
  went from 1 to 0 when the 50 s shell exited
  (`evidence/codex-shells-rebased.json`).
- **Claude.** The prompt and reply were stamped by Core and `_yuzunoDurationMs`
  came from the SDK. The shell count went from 1 to 0 at exit, 45–50 s later
  (`evidence/claude-shells-rebased*.json`).
- **SSE** (`evidence/*-sse.json`):
  - **Codex reply:** 41 `agent.delta` and only 7 `agent.changed` (Turn
    boundaries and receipts, never per delta).
  - **Claude reply:** 55 `agent.delta` and 3 `agent.changed`.
  - **Pushed items:** every `agent.item` for a message carried its
    `_yuzunoTime`. Repeated pushes of the same message kept the first time, which
    also matched the stored record.
  - **Resume:** reconnecting with `Last-Event-ID` from the middle of the run
    started with `resumed`.
- **Browser, streamed Codex reply** (`live-ui-result-rebased.json`):
  - While the reply streamed, the open page read the detail only a few times (at most 8).
  - The footer sat on the Copy reply line.
  - After dropping and restoring the network, the marks and footers were identical.
- **Browser, large output.** The trimmed `seq 1 4000` output (18.9 KB, a 4 KB
  preview) still expanded to its full text on request. Copy turn copied it in
  full.
- **Browser, appearance.** Light, dark, the 20px setting and a 520px window, for
  both agents: 16/16 checks passed (`live-ui-result-rebased-variants.json`).
  - Labels were identical after a reload.
  - Footers sat on the Copy reply line, or alone for a Turn without a reply.
  - Only the latest Turn mentioned shells.
  - Times measured 16px at the 20px setting.
  - Nothing overflowed the narrow window.
  - There were no page errors and no writes besides the read receipt.
- **Restart.** After a full Core restart all times were identical. With no
  shell record, nothing was shown, rather than a fake zero.
- **Tests:**
  - **Store-level** (`core/tests/conversation_time.rs`): a message's first
    streamed time survives its completion, a restart, a kill after a
    mid-stream write, and a kill before any write. In the last case it is timed
    by its journaled block, the same on every replay.
  - **Existing store test:** `replaying_the_journal_rebuilds_exactly_the_record_readers_saw`
    covers stamped Codex and Claude events.

## First run (f239bc7, 2026-10-13)

- Codex native times and the shell count from 1 to 0 at exit, triggered by the
  command's late `item/completed`.
- Ending the agent's app-server while a shell ran gave
  `{"state":"unknown","lastCount":1}` and the footer "shell status unknown".
- Claude's snapshot showed 1 `local_bash` task, then 0 at exit, with
  `turnId: null`.
- Restart kept every time unchanged.
- 24 screenshots.

## Limits and findings

- After a Core restart the in-memory shell record is gone. The UI shows nothing
  until the next Turn or command event.
- A Codex build without `thread/backgroundTerminals/list` makes the count
  unknown. It is hidden unless a count above zero was known earlier.
- Claude shows a count only after its CLI has sent at least one snapshot in the
  current process.
- Claude message times are Core times of the event that created the message.
  The SDK's assistant `timestamp` marks the end of a content block, so it is not
  used. A message whose streamed start was lost in a crash is timed by its
  completed block.
- **Found, not T-14's to change:** after Core restarted, a resumed Claude
  session first returned an empty 50 ms `result`. The bridge attributed it to
  the new Turn (turn c57f5d90: only the prompt, "Cooked for 0s"). The real reply
  ran with `turnId: null` and is not in the conversation.
  - A background task's completion notice also starts an unrequested model
    turn, whose reply (`result` with `turnId: null`) is likewise not shown.
  - This is bridge Turn attribution, unchanged by T-14. It has been reported to
    the Lead.
