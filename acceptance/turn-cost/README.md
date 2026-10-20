# Long-Turn cost: status, approvals and doorbells keep up (T-9)

In daily use, a long Codex or Claude Turn made Core fall tens of minutes behind its native runtime: the conversation stayed "Working" long after the native Turn ended, approvals and mailbox doorbells waited, and Core used more than a core and wrote ~15 MB/s.

## Cause (measured)

Every native event — each text delta included — read the Agent's whole record from SQLite, parsed it, applied the event, serialized it and wrote it back, often twice per event (`on_event` parsed it once just to check ownership). Records of long-lived Agents are 5–9 MB, so each event cost ~0.2–0.3 s of CPU in the debug build Core runs as. On 4317 (2026-10-13) Core handled ~3 events/s across all Agents and fell ~50 minutes behind.

The first fix (`8f392cd`, R1) deferred text deltas, but R1 review showed that with the real event mix 14–40% of events still took the full path: Claude `system` `thinking_tokens` (about one a second while thinking), Codex `hook/*`, `account/rateLimits/updated`, `turn/diff/updated`. Each also dropped the in-memory copy, so the next delta parsed the record again. The synthetic bench emitted none of these events. Measured per-operation cost on a real 6.4 MB record in the debug build: serialize 98 ms, parse 23 ms, clone 2.6 ms.

## Change

`core/src/store.rs` (most of it), `model.rs`, `claude.rs`, the event path in `workspace.rs`, and the collaboration paths.

Each native event is routed once (`store::route`, a `Route` passed through); every streamed one goes through one function, `Store::record_stream` (Codex `on_event` and Claude `claude_event` both call it), and `apply_streamed` applies it to the record held in memory. Only a short list stays synchronous, so a kind Core does not know yet never rewrites a whole record:

- **Synchronous, as before:** Turn start and end (`turn/*` other than plan and diff updates, `claude/result`), `serverRequest/*`, `error`, `thread/status/changed`, `thread/started`, `thread/compacted`, `mcpServer/*` (connection status), Claude `system` `init`, `compact_boundary` and reported permission modes. Requests and everything Core records itself are written synchronously by their own paths.
- **Ephemeral: never journaled, never the reason for a write.** Streaming output that `apply`/`project_event` keep: Codex text, reasoning, plan and command output deltas and reasoning summary part boundaries; Claude `stream_event` partials. Applied in memory and announced (≤250 ms per Agent), as Codex rollouts, opencode and the OpenHands SDK treat deltas.
- **Ignored:** streaming output nothing in the record keeps: Codex `turn/diff/updated` (the whole Turn diff so far, ~120 KB each, 83% of the journal bytes in the real Codex mix), deltas of Item kinds `apply` keeps no text for (file change output, raw reasoning text); Claude thinking-token counts and a subagent's partial stream.
- **Deferred: journaled at once, applied in memory, record written every 10 s.** Completed content (Codex `item/started` and `item/completed`, the whole Item; Claude `assistant`, each completed block, and `user` tool results), plan and token usage, Claude rate limits, and any future kind `apply` or `project_event` acts on.
- **Evidence: journaled only; the record is neither loaded, applied to nor written.** Everything `AgentDetail::acts_on` / `claude::acts_on` say changes nothing in the record: Codex hooks, `account/rateLimits/updated`, automatic approval reviews and `guardianWarning` (a review is Codex deciding a request itself; Pending only ever comes from a server request), warnings, terminal interaction; Claude status, hook, task and background-task notices, tool heartbeats, command lifecycle; and kinds Core does not know yet (`item/mcpToolCall/progress`, …). A small journal insert keeps the raw evidence (which hooks ran, what an automatic review decided) for audit. Journal replay skips them as well.

None of the non-synchronous routes counts as unread (only `turn/completed`, `request`, `runtime/error` do). Should an applied event still change what other parts of Core act on (status, error, Pending, Turn count or Turns in progress, unconfirmed messages, connection, thread or session — e.g. Claude output from another session, or a delta or Item for a Turn Core never saw start), it is journaled (if it was only streaming output), written with one synced commit and announced at once (`Watched`), so a crash cannot revert what others already acted on. An evidence-only Claude event from another session is no longer what reveals the mismatch; the next applied event does.

**Change revision (`Agent::rev`).** One counter per Core process; every change to any Agent's record (journaled, deferred, ephemeral, read marks, Core's own updates) takes its next value, and every held record, served detail and listed Agent carries the rev of its last change (`Store::rev(id)` reads it). `record_stream` returns it (`Streamed.rev`, `urgent`), `record_event` returns it, `update` returns it in the record. Unlike `last_seq` (the durable journal position used for read receipts and unread counts, which streamed output does not move), `rev` means "this detail already contains change N", covers streamed output, and is never read back from disk (`skip_deserializing`): after a restart it starts again and clients reset. `changed_items_since(id, rev)` takes the rev captured when a native snapshot was requested and says whether an event (read marks excluded) changed the record since and which Items it reached. That evidence lives apart from held records (it survives release, eviction and failed writes), keeps at most 256 Items per Agent, and reports `complete: false` when it no longer reaches back that far, in which case reconciliation treats unfinished Items of running Turns as newer.

Also:

- **Completed content replaces streamed text.** Codex `item/completed` replaces the Item (it carries `text`, `aggregatedOutput`). Claude `assistant` blocks replace the unconfirmed streamed block (or thinking part) they complete, also when only its start was written (`confirm_text`, `confirm_thinking`); before, such a block was appended a second time.
- **A full event keeps a streaming record in memory** after its commit, so the next event does not parse it again (`update()`; `record_event()` is the same without copying the record out for callers that ignore it).
- **`detail()` never returns a record that skips an event.** It parses a row without holding the database, then checks the row's write counter: if the row was rewritten meanwhile it reads again (after two lost races it parses under the lock), and a record now held in memory wins. (R1 B2: a `turn/completed` written during the parse was skipped while `lastSeq` moved past it, so the GUI's read receipt marked it read unseen.)
- **Replay is deterministic.** Events are applied as of their journal time (`AgentDetail::apply_at`, `claude::project_event_at`): no clock reads for `_yuzunoStartedAt`, `_yuzunoCompactionStartedAt`, context usage, rate limit time or `updatedAt`. Rows of streamed output that earlier builds journaled are still replayed.
- **Writes held back by one record hold back nothing else.** Each held record is written in its own transaction; announcements and idle cleanup happen regardless. Making room (at most 8 held records) prefers a record its row already matches, writes the evicted one on its own, keeps it if that fails, and keeps its pending announcement.
- **Unsynced commits use their own connection** (`synchronous=NORMAL`) instead of toggling the main one, which stays `FULL`.
- **Listing never parses records.** Each Agent's listed view (brief) is rebuilt lazily after streamed events; the per-event ownership check reads only closed and thread (`Store::binding`). The collaboration paths (`pending_peer_deliveries`, actor and recipient lookups, `peers_list`, task dispatch) and the MCP token and authorization checks read briefs instead of parsing records; a doorbell first rules out an undeliverable wake-up from the brief.
- **Reconciliation keeps live text, and only that.** Changes after the rev captured when `thread/resume` or `thread/read` was sent count as newer, so the snapshot does not replace them with older text; output streamed before the request, and read marks, do not, so the snapshot still refreshes Turn metadata, clears a transport error and applies the native status.
- **Replacing an unused empty thread** (missing rollout) looks at what the record contains (the held copy, streamed output included), not at whether it is held.
- `Workspace::flush_event_writes()` (for T-12) writes every held record, ephemeral output included.

## Crash contract (changed on purpose)

After SIGKILL (or SIGTERM, which Core does not handle yet), completed Items and messages and every synchronous event are never lost; the partial text of an Item still streaming may be lost (or kept, if a timed write included it); nothing is repeated. A clean stop (SIGINT) writes held records, partial text included.

What comes back after a restart:

- **Codex:** reconnecting resumes the native thread (`thread/resume`; `thread/read` on reconcile) and merges its Turns and Items, so completed Items come from the native rollout as well as from the journal. Codex does not persist deltas either, so an Item cut off mid-stream has no full text anywhere. Its Turn is marked unconfirmed until the native session says otherwise.
- **Claude:** reconnecting resumes the SDK session but reads no history into Core; in-progress Turns become `outcomeUnknown`. Completed blocks journaled before the crash come back from the journal; a message cut off mid-stream keeps at most the start a timed write caught. Nothing the native session produced while Core was down is imported (unchanged by T-9). The bridge is Core's child process, so a killed Core normally ends its in-flight query too.

## Results (real event mix)

`mix.py` extracts native event sequences from a copy of the daily database (4317 had been stopped; the copy lives under `acceptance/turn-cost/data/`, ignored by git): the last 3000 native events of Dev 1 (Codex, journal seq 213764–243274: 1288 message deltas, 606 output deltas, 255+255 Items, 146+146 hooks, 97 diffs, 95 rate limits, 94 token usage, 5 status changes, 12 automatic reviews, 1 terminal interaction) and Dev 2 (Claude, seq 236597–243889: 2163 stream events, 788 thinking counts, 27 assistant, 16 user, 5 status notices, 1 rate limit). Requests, Turn boundaries and what Core records itself are left out; the replay runs inside one Turn of its own and ends with one approval. The journal's own times are Core's, which had fallen behind, so replays run as a burst or at a fixed rate.

`bench.py --mix N:A:R` makes the scripted runtimes replay the first N events (`--harness mixed` alternates Codex and Claude Agents, Codex first). Records are built to ~6.2 MB first through Core's own event path (`--warmup 40:150`). `--ui-poll --ui-read` fetches the Workspace and the first Agent every 160 ms like the open GUI and sends its read receipt; `--mail` sends the first Agent urgent and normal mail and times both doorbells. Same debug build profile Core runs as. Binaries: `f9bdd91` (main before T-9), `8f392cd` (R1), `cd3f8f1` (this change; `08d721b` adds the follow-ups, compared below).

Measured back to back in one heavy slot (a second slot may have run another agent's heavy phase meanwhile; the host was shared). 300 real events per Agent unless noted; `f9bdd91` writes the record for every event (~8.7 MiB of disk per event here), so its real-mix runs are bounded to 300 events.

| run | events | wall s | Core CPU s | peak RSS MiB | written MiB disk / all | journal rows / MiB | stream lag p50/max s | approval s | Turn end s | doorbell urgent/normal s | GUI fetch list/agent p50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Codex, 1 Agent · f9bdd91 | 305 | 57.3 | 55.3 | 144 | 2654 / 2567 | 311 / 3.5 | 24.76 / 46.40 | 45.56 | 0.07 | 10.01 / 1.12 | – / – |
| Codex, 1 Agent · 8f392cd | 305 | 19.7 | 15.0 | 130 | 478 / 478 | 311 / 3.5 | 8.91 / 13.74 | 12.83 | 0.08 | 1.57 / 1.14 | – / – |
| Codex, 1 Agent · cd3f8f1 | 305 | 2.2 | 1.4 | 100 | 107 / 107 | 161 / 0.3 | 0.63 / 0.63 | 0.01 | 0.00 | 0.57 / 0.58 | – / – |
| Claude, 1 Agent · f9bdd91 | 303 | 44.0 | 44.1 | 146 | 1154 / 1153 | 311 / 0.1 | 20.09 / 34.58 | 34.76 | 0.18 | 9.65 / 0.80 | – / – |
| Claude, 1 Agent · 8f392cd | 303 | 15.7 | 16.1 | 132 | 113 / 113 | 312 / 0.1 | 10.17 / 14.28 | 14.28 | 0.19 | 1.03 / 0.80 | – / – |
| Claude, 1 Agent · cd3f8f1 | 303 | 1.2 | 1.5 | 107 | 96 / 96 | 14 / 0.0 | 0.00 / 0.00 | 0.01 | 0.13 | 0.34 / 0.66 | – / – |
| 3 Agents + GUI, 3×100 · f9bdd91 | 310 | 70.4 | 85.1 | 195 | 2072 / 2611 | 417 / 2.0 | 26.63 / 65.95 | 66.60 | 0.51 | 3.10 / 1.37 | 0.14 / 0.35 |
| 3 Agents + GUI, 3×100 · 8f392cd | 310 | 16.9 | 20.4 | 185 | 405 / 523 | 348 / 2.0 | 11.98 / 13.74 | 13.74 | 0.45 | 1.58 / 0.77 | 0.23 / 0.39 |
| 3 Agents + GUI, 3×100 · cd3f8f1 | 310 | 3.0 | 4.1 | 169 | 253 / 301 | 113 / 0.1 | 0.83 / 0.97 | 0.98 | 0.22 | 0.50 / 0.36 | 0.00 / 0.26 |
| 3 Agents + GUI, 3×1500 at 30/s each · 8f392cd | 4510 | 174.6 | 198.7 | 288 | 7776 / 8946 | 4745 / 24.1 | 16.81 / 86.33 | 16.81 | 0.51 | 2.12 / 1.01 | 0.20 / 0.38 |
| 3 Agents + GUI, 3×1500 at 30/s each · cd3f8f1 | 4510 | 52.8 | 39.5 | 220 | 459 / 2334 | 1145 / 1.8 | 0.00 / 0.89 | 0.40 | 0.25 | 0.33 / 0.40 | 0.00 / 0.15 |
| 3 Agents + GUI, 3×3000 · cd3f8f1 | 9010 | 6.0 | 9.0 | 250 | 444 / 581 | 2116 / 3.6 | 0.41 / 1.08 | 1.07 | 0.28 | 0.46 / 0.48 | 0.00 / 0.17 |

Larger runs, measured earlier while heavy phases still ran one at a time (`426d97b` is this change before the record write interval went from 3 s to 10 s):

| run | events | wall s | Core CPU s | peak RSS MiB | written MiB disk / all | journal rows / MiB | stream lag p50/max s | approval s | Turn end s | doorbell urgent/normal s | GUI fetch list/agent p50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Codex, 1000 · 8f392cd | 1005 | 29.6 | 30.1 | 137 | 937 / 936 | 1013 / 8.8 | 8.22 / 10.44 | 8.34 | 0.08 | 0.56 / 0.87 | – / – |
| Codex, 1000 · cd3f8f1 | 1005 | 1.2 | 1.6 | 128 | 118 / 118 | 341 / 0.5 | 0.01 / 0.36 | 0.00 | 0.00 | 0.35 / 0.38 | – / – |
| Codex, 3000 · cd3f8f1 | 3005 | 2.5 | 2.7 | 140 | 205 / 205 | 1022 / 1.5 | 0.02 / 0.54 | 0.42 | 0.00 | 0.52 / 0.48 | – / – |
| Claude, 1000 · 8f392cd | 1003 | 73.4 | 57.0 | 120 | 3052 / 3050 | 1011 / 0.4 | 14.12 / 51.35 | 45.99 | 0.21 | 0.90 / 0.89 | – / – |
| Claude, 1000 · cd3f8f1 | 1003 | 1.3 | 1.4 | 96 | 97 / 97 | 22 / 0.1 | 0.01 / 0.01 | 0.00 | 0.15 | 0.31 / 0.67 | – / – |
| Claude, 3000 · cd3f8f1 | 3003 | 1.1 | 1.5 | 108 | 87 / 87 | 60 / 0.6 | 0.01 / 0.12 | 0.01 | 0.00 | 0.41 / 0.71 | – / – |
| 3 Agents + GUI, 3×300 · 8f392cd | 910 | 45.5 | 53.4 | 207 | 1012 / 1370 | 988 / 7.1 | 22.29 / 38.95 | 31.14 | 0.46 | 2.05 / 0.93 | 0.20 / 0.35 |
| 3 Agents + GUI, 3×300 · cd3f8f1 | 910 | 3.0 | 4.2 | 189 | 273 / 321 | 337 / 0.6 | 0.96 / 1.09 | 0.96 | 0.25 | 0.23 / 0.38 | 0.02 / 0.27 |
| 3 Agents + GUI, 3×150 at 30/s each · f9bdd91 | 460 | 115.4 | 139.0 | 226 | 2442 / 3249 | 612 / 4.7 | 42.47 / 105.31 | 105.93 | 1.14 | 3.96 / 1.31 | 0.14 / 0.35 |
| 3 Agents + GUI, 3×150 at 30/s each · cd3f8f1 | 460 | 7.2 | 6.7 | 194 | 279 / 469 | 214 / 0.2 | 0.00 / 0.93 | 0.61 | 0.26 | 0.45 / 0.60 | 0.00 / 0.15 |
| 3 Agents + GUI, 3×1500 at 30/s each · 426d97b (3 s writes) | 4510 | 52.5 | 42.3 | 299 | 645 / 2416 | 1138 / 1.8 | 0.00 / 0.86 | 0.40 | 0.26 | 0.21 / 0.72 | 0.00 / 0.16 |
| 3 Agents, no GUI, 3×1500 at 30/s each · 426d97b (3 s writes) | 4510 | 52.3 | 8.3 | 188 | 637 / 637 | 1019 / 1.8 | 0.00 / 0.80 | 0.31 | 0.31 | 0.32 / 0.79 | – / – |
| 3 Agents, no GUI, 3×1500 at 30/s each · cd3f8f1 | 4510 | 52.5 | 6.1 | 182 | 426 / 426 | 1018 / 1.8 | 0.00 / 0.73 | 0.29 | 0.13 | 0.21 / 0.50 | – / – |

How to read these:

- events: runtime events of the measured Turns. Written MiB: "disk" is what Core sent to storage; "all" also counts HTTP responses (with the GUI polling, mostly the 6 MB detail it fetches).
- Stream lag: emit to journal time of every journaled event emitted during the stream. Deltas are no longer journaled; Core handles each Agent's events strictly in order, so the journaled events between them carry the same backlog. For `f9bdd91` and `8f392cd` the deltas themselves are included.
- Approval: the approval comes after the stream, so it shows how far behind Core was. Turn end is measured after the backlog cleared. Doorbells: urgent = posted to steered into the running Turn; normal = the native Turn ended to the doorbell starting a new one.
- The 3-Agent burst rows start three Turns at once; each Turn start is five synchronous record writes, which is most of their stream lag.

Follow-up `08d721b` (evidence-only kinds, change revisions; see Change), back to back with `cd3f8f1` in one heavy slot:

| run | events | wall s | Core CPU s | peak RSS MiB | written MiB disk / all | journal rows / MiB | stream lag p50/max s | approval s | Turn end s | doorbell urgent/normal s | GUI fetch list/agent p50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Codex 3000 · cd3f8f1 | 3005 | 2.5 | 2.9 | 165 | 204 / 204 | 1022 / 1.5 | 0.04 / 0.38 | 0.49 | 0.00 | 0.23 / 0.45 | – / – |
| Codex 3000 · 08d721b | 3005 | 2.6 | 2.7 | 117 | 191 / 191 | 1021 / 1.5 | 0.03 / 0.48 | 0.47 | 0.00 | 0.52 / 0.50 | – / – |
| Claude 3000 · cd3f8f1 | 3003 | 1.3 | 1.7 | 113 | 123 / 123 | 60 / 0.6 | 0.01 / 0.15 | 0.00 | 0.12 | 0.16 / 0.66 | – / – |
| Claude 3000 · 08d721b | 3003 | 1.2 | 1.5 | 128 | 87 / 87 | 61 / 0.6 | 0.01 / 0.01 | 0.01 | 0.13 | 0.31 / 0.59 | – / – |
| 3 Agents + GUI, 3×1500 at 30/s · cd3f8f1 | 4510 | 53.2 | 42.1 | 242 | 458 / 2115 | 1133 / 1.8 | 0.00 / 0.93 | 0.40 | 0.76 | 0.21 / 0.69 | 0.00 / 0.17 |
| 3 Agents + GUI, 3×1500 at 30/s · 08d721b | 4510 | 52.8 | 41.6 | 270 | 446 / 2151 | 1137 / 1.8 | 0.00 / 0.88 | 0.23 | 0.12 | 0.38 / 0.51 | 0.00 / 0.16 |
| 3 Agents + GUI, 3×3000 · cd3f8f1 | 9010 | 6.8 | 10.0 | 226 | 457 / 566 | 2110 / 3.6 | 0.54 / 1.37 | 1.25 | 0.14 | 0.48 / 0.57 | 0.00 / 0.24 |
| 3 Agents + GUI, 3×3000 · 08d721b | 9010 | 6.3 | 9.3 | 246 | 418 / 521 | 2111 / 3.6 | 0.14 / 1.23 | 1.30 | 0.32 | 0.34 / 0.45 | 0.01 / 0.23 |

The routing change moves no headline number beyond run-to-run noise on this shared host; what it removes (loading and dirtying a record for hook, rate-limit and notice events) is a small share of these runs.

## Results (synthetic)

The R1 synthetic replay (1000 message deltas, 100 output deltas or tool calls, one approval; 3 Agents: 300/30/1 each; paced: 150/15/1 at 30 events/s), for `cd3f8f1`, all with `--mail`, the 3-Agent run with `--ui-poll`. The R1 table had `f9bdd91` at 243–278 s wall and 13–15 GB written for these bursts, and `8f392cd` at 2.3–8.6 s wall with a 3-Agent stream lag of 2.30 / 2.74 s.

| run | events | wall s | Core CPU s | peak RSS MiB | written MiB disk / all | journal rows / MiB | stream lag p50/max s | approval s | Turn end s | doorbell urgent/normal s | GUI fetch list/agent p50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Codex, 1 Agent, burst | 1109 | 1.2 | 1.6 | 95 | 111 / 111 | 17 / 0.2 | 0.00 / 0.38 | 0.00 | 0.01 | 0.33 / 0.36 | – / – |
| Claude, 1 Agent, burst | 1205 | 1.4 | 1.6 | 119 | 93 / 93 | 213 / 0.6 | 0.01 / 0.02 | 0.02 | 0.14 | 0.34 / 0.69 | – / – |
| Codex, 3 Agents + GUI, burst | 1013 | 4.2 | 4.9 | 214 | 290 / 346 | 42 / 0.2 | 0.44 / 1.74 | 0.63 | 0.36 | 0.41 / 0.86 | 0.06 / 0.30 |
| Codex, paced 30 events/s | 174 | 6.3 | 1.6 | 98 | 120 / 120 | 16 / 0.0 | 0.00 / 0.37 | 0.00 | 0.00 | 0.33 / 0.42 | – / – |

## Optimized build (for comparison only)

The same commit built with `--release`, back to back with the debug build:

| run | events | wall s | Core CPU s | peak RSS MiB | written MiB disk / all | journal rows / MiB | stream lag p50/max s | approval s | Turn end s | doorbell urgent/normal s | GUI fetch list/agent p50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 3 Agents + GUI, 3×1500 at 30/s each · debug | 4510 | 52.8 | 39.5 | 220 | 459 / 2334 | 1145 / 1.8 | 0.00 / 0.89 | 0.40 | 0.25 | 0.33 / 0.40 | 0.00 / 0.15 |
| 3 Agents + GUI, 3×1500 at 30/s each · release | 4510 | 51.1 | 3.3 | 194 | 482 / 2454 | 1152 / 1.8 | 0.00 / 0.15 | 0.05 | 0.04 | 0.15 / 0.21 | 0.00 / 0.05 |
| 3 Agents + GUI, 3×3000 burst · debug | 9010 | 6.0 | 9.0 | 250 | 444 / 581 | 2116 / 3.6 | 0.41 / 1.08 | 1.07 | 0.28 | 0.46 / 0.48 | 0.00 / 0.17 |
| 3 Agents + GUI, 3×3000 burst · release | 9010 | 1.5 | 1.4 | 208 | 458 / 544 | 2107 / 3.6 | 0.09 / 0.27 | 0.29 | 0.05 | 0.24 / 0.21 | 0.00 / 0.06 |

Core's CPU for three Agents streaming at 30 events/s with the GUI open drops from 75% of a core to 6%; serializing JSON (records and the detail the GUI fetches) is most of what a debug build spends.

## Other checks

- **Core tests** (`cargo test -p yuzuno-workspace -- --test-threads=1`, at `08d721b`): 217 passed, 0 failed, 2 ignored. New or changed:
  - `tests/stream_writes.rs` (22): the route of every known kind, and that an unknown kind is evidence, never a full rewrite; that the Codex kinds kept as evidence change nothing `apply` would keep; evidence journaled without loading, holding or dirtying a record; a streamed event (Item, delta or Claude output from another session) that creates a Turn or changes status is journaled, written and announced at once; an unused thread can be replaced while its record is held, a used one not; every change takes a rev (deltas included, read marks too but not as events), snapshots compare against the rev captured at the request, and the evidence outlives eviction; Item evidence is bounded and says when it no longer reaches back; deltas visible and announced but never journaled or written by themselves; completed content journaled and written on the cadence; a completed Codex Item and a completed Claude message replace the partial text a mid-stream write left, after a simulated kill; a streaming record stays in memory after a full event (the next delta does not read the row: the test makes the row unparseable); read marks while streaming; close writes held content; after a kill, journaled content and read marks survive, partial text may not, rows of deltas earlier builds journaled are still replayed; failed journal and record writes; one record that cannot be written holds back no other Agent; bounded memory with every evicted Agent still announced; a record that cannot be evicted holds back no other Agent; briefs follow every write.
  - `store.rs` unit tests (4): a Turn end written while `detail()` parsed the row is not skipped, and a row rewritten and released meanwhile is read again (both fail against the R1 `detail()`); replaying the journal rebuilds exactly the record readers saw (fails if replay reads the clock); only the second connection runs unsynced.
  - `claude.rs`: completed blocks replace partial streamed text and thinking instead of repeating it (fails with the R1 `confirm_text`); a completed block never lands in an empty streamed block by prefix; the SDK events routed as evidence change nothing `project_event` keeps.
  - `workspace.rs`: a snapshot requested before trimmed evidence keeps the unfinished Items of a running Turn; the existing snapshot tests now take `Changes`.
- **SIGKILL** (`kill.py`, Codex and Claude, rerun at `08d721b`): Core killed 0.50–0.51 s after msg-2 completed. The record at the kill held msg-2 partially (the timed write had caught it mid-stream); no delta was journaled. After restart, the API detail and the written record held msg-1 and msg-2 complete and exactly once; msg-3 (still streaming) was absent; the restart added only `workspace/restarted`; the Agent showed offline with "execution not confirmed". Passed for both.
- **Clean stop** (ad hoc, not scripted): SIGINT 2 s into msg-2 of the same script; the written record held msg-2's streamed text as the API had shown it (693 characters), before any timed write.
- **Real native, minimal** (`native.py`, rerun at `08d721b`): one read-only Turn through the real Codex app-server and one through the real Claude SDK bridge. Both completed and went idle; the answers ("gamma", "delta") matched in the API, the written record and after a Core restart; no delta was journaled, completed content was (`item/started` 2, `item/completed` 2; `claude/assistant` 1); the record's `lastSeq` covers every journaled event it applies (Codex 53 = journal top; Claude 44, followed only by an evidence-only `claude/command_lifecycle` at 45).

## Limits

- **Full writes still cost the record's size.** A Turn start is five synchronous writes (`message/requested`, `turn/requested`, `turn/started`, `turn/accepted`, `message/receipt`), each ~0.13 s for a 6 MB record in the debug build, almost all of it serializing JSON (98 ms). With three Agents starting at once that is the ~1 s stream lag of the 3-Agent bursts. A streaming Agent also writes its record every 10 s while journaled events arrive (at 3 s, the paced 3-Agent run without GUI used 8.3 CPU s and 637 MiB of disk in 52 s; at 10 s, 6.1 s and 426 MiB). Shrinking records (keeping only recent Turns) or an optimized build would cut each write.
- **The open GUI fetches the selected Agent's whole detail** after each announcement, and Core serializes 6 MB for each fetch (outside its locks). In the paced 3-Agent run that was ~1.9 GB of responses and ~33 of Core's 39.5 CPU seconds (6.1 s without the GUI). Delta push and trimmed detail responses are separate work.
- **Crash contract:** see above. Partial text of an Item still streaming is not durable by design; SIGTERM is not handled yet (T-12 should call `flush_event_writes`).
- **Durability window:** a power loss or OS crash (not a Core crash) can lose deferred events committed since the last synced commit. Turn ends, requests and sends are synced as before.
- **Synthetic runtimes and a shared host.** Approvals are answered by a poller (≤0.2 s). Absolute numbers depend on the machine; other agents worked on this host throughout, and for the back-to-back table a second heavy slot may have run another agent's heavy phase at the same time.
- The real-mix replay moves every event into one Turn and skips the window's own Turn starts and ends, requests and Core's own records.

## Reproduction

```sh
# a copy of the daily database, never the live file
sqlite3 -readonly acceptance/live/core-data/workspace.sqlite ".backup acceptance/turn-cost/data/snapshot.sqlite"
python3 acceptance/turn-cost/mix.py --db acceptance/turn-cost/data/snapshot.sqlite --count 3000
python3 acceptance/turn-cost/bench.py --label NAME --core BIN --harness codex|claude|mixed --agents N \
    --warmup 40:150 (--mix EVENTS:APPROVALS:RATE | --run DELTAS:OUTPUTS:APPROVALS:RATE) [--ui-poll [--ui-read]] [--mail]
python3 acceptance/turn-cost/kill.py --core BIN       # SIGKILL mid-stream, Codex and Claude
python3 acceptance/turn-cost/native.py --core BIN     # real Codex and Claude, one tiny Turn each
python3 acceptance/turn-cost/compare.py LABEL...      # the tables above
```

Run each heavy phase (build, tests, a bench, kill or native run) through `/home/developer/yuzuno-next/target/heavy-slot.sh <cmd>`, and run the binaries a comparison needs back to back inside one call. Results go to `target/turn-cost/runs/<label>/result.json` (not committed).
