# Core memory after long conversations

On Linux with glibc, freed copies of large conversation records can remain in
the allocator's resident pages after the Store's five-second idle cache expires.
This is separate from live records, native Agent processes, and the database's
on-disk size. A high RSS alone does not establish a leak or how much is reclaimable.

The existing stream maintenance ticker now checks for a longer idle opportunity:

- The Store's held-record cache has been observed empty for at least 60 seconds.
- Only the ticker's own admission permit remains; update drain/seal is inactive.
- At least 30 seconds have elapsed since the last allocator check, and glibc
  reports at least 128 MiB of free arena space.
- After a reclaim, observed RSS must grow by another 128 MiB before checking
  those pages again. Virtual free arenas can remain large after pages are returned.

While records stay held, because an Agent keeps streaming, that idle check
never comes. The pages another Agent's released record left behind would then
stay resident for as long as the stream goes on. A slower check comes instead:

- The busy period has lasted 300 seconds. It begins with the first held record
  after the last idle check, and a short gap with none held does not end it;
  only an idle check does, whatever it finds.
- At least 300 seconds have passed since the last check of this path, and 30
  seconds since a check of either path.
- Quiet, the 128 MiB of free arena space and the 128 MiB of RSS growth are as
  for the idle check.
- Free arena space is at least what is in use (`fordblks >= uordblks`, read
  with the free space). This is a ratio of glibc's own counts. It does not
  show that the held records are small, and covers neither mmapped chunks nor
  all of RSS.

The five minutes are this path's only: the idle check is unchanged.

The check calls `malloc_trim(0)` in the existing blocking maintenance closure,
outside Store locks. It does not delete records, change cache expiry, interrupt
an Agent, or add a new background thread. Other platforms are unchanged.
One structured `Core heap maintenance` log records each attempted trim, including
its duration and RSS observations. These are concurrent observations, not an exact
accounting of bytes freed by that call.

This is advisory maintenance, not a memory limit. The ticker starts with the
first streamed event. Held records defer the check to the slower path;
long-lived admission permits defer both. Quiet is a snapshot, not mutual
exclusion: a new request, or a streamed event of an Agent whose record is held,
can arrive after it and wait for an arena the trim holds. A trim's duration in
one lab is not a bound on that wait. Reading cold histories after reclamation must fault pages
back in; the grace period avoids doing this during brief typing/thinking pauses
but does not eliminate that cost.

## Reading it on a running Core

`GET /api/diagnostics/memory` reports this process's memory when asked, and
Copy diagnostics includes it. It reads counters only: no record is cloned or
scanned, nothing is written or trimmed, and it is not part of `/api/health`
or any polling. It passes the same local and phone-entry checks as the rest of
the API. Like other requests that finish existing work, it is answered while
an update drains and refused once the update has sealed admission.

- `os`: `rssBytes`, `hwmBytes`, `anonBytes`, `fileBytes`, `shmemBytes`,
  `swapBytes` and `threads`, from the kernel's status of the process. Anonymous
  pages include thread stacks and other anonymous mappings, not only malloc's
  heap.
- `allocator`: glibc's `mallinfo2` over all arenas, with its own field names
  (`arena`, `uordblks`, `fordblks`, `hblkhd`, `hblks`). `fordblks` counts free
  space whether or not it is resident; after a trim it stays while the pages
  are gone. No difference of these counts is given as an amount that could be
  returned.
- `store.heldRecords`: parsed records held now, at most `maxHeldRecords`.
- `admission.inFlight`: permits held now; `includesThisRequest` says whether
  one is this request's own.
- `reclaim`: the policy's thresholds, whether the maintenance tick runs, what
  holds a trim back now (`waitingFor`) and the last check that passed the time
  gate, with its `path` (`idle` or `held`). `gate.nextPath` is the path a check
  would take by time alone, or null. `busyForSeconds` and
  `sinceLastHeldCheckSeconds` time the held path. Once the held path is due,
  held records are no longer listed as holding a trim back. Reading it consumes
  no check and changes no time. While a trim holds the gate, `gateBusy`
  is true and the gate is not read.

Each part is read in turn, so they are not one snapshot. On a platform where a
part can't be read it says `available: false` with a reason; no count is 0
because it is unknown.

### What the held records' stored history is made of

`GET /api/diagnostics/memory/history` answers which parts of the held Agents'
records take the most space where they are stored. Settings → Updates shows it
as a chart and a table, read only when you press Measure. It is not part of
`/api/diagnostics/memory`, Copy diagnostics, `/api/health` or any polling, and
it adds nothing to opening the Workspace.

For each Agent whose record is held now, it gives the rows and stored bytes of
its metadata row (`layout` 0 keeps the whole record there), its Turns, its
Items' own data, the previews kept for clients, and its payloads (the full
large fields of tool Items), and their total. It gives only counts, the
Agent's id and name, and whether the held record has changes its rows lack
yet (`unwrittenChanges`): no text, path, key or SQL. An Agent held without a
row says `stored: false` and adds nothing to the total.

- **Bytes as stored.** The bytes are SQLite's `octet_length` of each value,
  taken from the row's header: a value on overflow pages is not read.
  `length` of TEXT counts characters and has to read them, so it is not
  used. The test `stored_bytes_are_read_from_row_headers_not_from_the_payloads`
  counts the pages each reads.
- **Not memory.** Stored bytes are not the Rust heap a held record takes,
  String capacity, RSS or SQLite's page cache. A record with unwritten
  changes holds more than is stored.
- **Not one snapshot with the held list.** The held Agents are listed
  first, then their rows read in one read snapshot. No held record is
  copied or serialized.
- **Budget.** The reads stop after 2 s. Then, or on any error, the answer
  is `available: false` with a reason and no numbers at all: no Agent's and
  no total, never a partial sum. One measurement runs at a time, and one
  asked meanwhile is told so. Without WAL a read would share the one writer
  and hold up its writes, so it is not measured.

## While an Agent streams on

T-140 Job `459d0b2a-f9cd-4da9-aeb0-43cae468fcc6`, 2026-10-22, a lab build on
`37d0bef` (before the held path), one process per case. A synthetic Agent
with 63.5 MiB of history reconnected; a small synthetic Agent streamed through
Core's own ticker. The ticker released the large record about 5 seconds after
its last use, in both cases.

| | Idle after one delta | Small Agent streaming for 95 s |
| --- | --- | --- |
| Held records after the large one was released | 0 | 1 (the small one) |
| What held a trim back while streaming | — | `heldRecords`, at every reading |
| RSS just before the trim | 298.8 MiB | 299.3 MiB |
| Trim | 66 s after the start, to 18.2 MiB | 60 s after the small record went, to 19.2 MiB |

The idle path waited for the last held record however small it was, and the
large record's freed pages stayed resident the whole time. This is what the
held path addresses. One run per case, synthetic, not the daily Core.

### With the held path

T-140 Job `b40c9c79-df26-44dc-b26b-8e507c9e658e`, 2026-10-22, lab builds of
`0483701` before and after the held path, otherwise identical. The inputs were
the same as above, and each case ran in its own process. One run per side.

- **One delta, then idle:** both sides trimmed on the idle path at about 67
  seconds, as before.
- **A delta every 250 ms for 370 seconds, then idle, with the large record
  read again at 330 and at 465 seconds:**
  - Before, nothing was checked while the small record was held. After, a
    held-path trim came once the busy period reached 300 seconds, with the
    small record still held: 299.5 to 20.3 MiB in 23.7 ms.
  - All 1,480 deltas were applied on both sides, none missing or out of order.
    Before, p99 0.384 ms and max 4.6 ms; after, p99 0.408 ms and max 2.7 ms.
    The 12 deltas around the trim took at most 0.29 ms. One run: neither these
    figures nor the trim's duration bound the worst case.
  - The read at 330 seconds loaded in 125 ms after the trim, against 55 ms
    before, whose pages had stayed resident. That is consistent with the pages
    becoming resident again; two runs do not attribute the whole difference
    to it.
  - The RSS growth threshold is shared by both paths. That read brought RSS
    back to about 90 MiB, so the idle check after the stream stopped did not
    trim: 70 MiB above the held trim's 20.3 MiB is under 128 MiB. Before, that
    check trimmed 231 to 21 MiB. After the read at 465 seconds, the held side
    passed the threshold and trimmed to 25 MiB, while the side without it
    stayed at about 94 MiB. The threshold is a trigger: RSS grown at least
    128 MiB since the RSS observed after the last trim. It is not a bound on
    what stays resident, on RSS or on free bytes, and once RSS reaches it a
    trim still depends on the other gates, on timing and on what runs at the
    same time. Here about 70 MiB of growth did not trigger one.
- The two sides' RSS before 300 seconds differed (about 231 against 299.5 MiB)
  while no policy acted on either. That is not attributed, and no average RSS
  is compared.
- Only the first held-path check fell inside the run. The 300 seconds to the
  next one, and the other timing rules, are covered by the virtual-clock unit
  tests in `heap.rs`, not by a measurement.

### A streamed text delta

`AgentDetail::apply_at` appended an agentMessage, plan or command output
delta by copying the text so far, pushing the delta onto the copy and setting
it back. Every delta therefore allocated its message's whole length, about
twice over with the copy's growth. A long streamed message allocated in
proportion to its length squared. The delta is now pushed onto the field's
string in place. A field that is not a string still becomes the delta.

T-140 run `29a0367e-f435-4ccd-9157-a5c69c727067` (build
`a1cdd0ab-3095-46ae-8f86-b55b99dc91f0`, measure
`9927c725-6216-4fea-a17d-cb83700b95d6`), 2026-10-23: release builds of
`delta_append_lab` (on lab branches, not merged), one on main and one on this
change, the same example. Each ran twice, alternating. Each cell sent 200
deltas through `Store::record_stream` after the message had reached a given
length. Both runs of a side gave the same Rust counts, and the text read back
was the deltas in order in every cell.

| 200 deltas of 24 B (1 KiB) | Before | After |
| --- | ---: | ---: |
| After 1 MiB: allocated, averaged per delta | 2.0 (2.2) MiB | 5.9 KiB |
| The same: highest Rust live above the batch's start | 3.0 (3.8) MiB | 1.0 MiB |
| The same: median time of one call | 238–249 (30) µs | 1.0 µs |
| After 4 MiB: allocated, averaged per delta | 8.0 (8.2) MiB | 21.2 KiB |
| The same: highest Rust live above the batch's start | 12.0 (12.8) MiB | 4.0 MiB |
| The same: median time of one call | 1.10–1.15 (1.38–1.40) ms | 1.0 µs |
| The same: VmRSS rise over the batch | 8.0 (8.6) MiB | 4 (208) KiB |

What a batch allocated is divided by its 200 deltas. The highest live is one
figure for the whole batch, not a peak of each delta. Each process measured
its eight cells in one fixed order (24 B deltas from the shortest length up,
then 1 KiB), so each cell starts with the allocator as the cells before it
left it. Compare a cell before and after the change, not one cell with
another: the 1 KiB cell's 30 µs against the 24 B cell's 238–249 µs is such a
comparison.

Live Rust bytes at a batch's end had grown over its start by about the same
before and after (4.0–4.4 MiB after 4 MiB). That growth counts every live
byte in the process, the measurement's own included. It is not the record's
size, the string's capacity, which the lab did not record, or resident
memory. So this lowers allocation turnover, the batch's highest live and the
time per delta; the lab does not show it lowering what a batch adds to live
memory. These are synthetic allocator measurements in one process, not the
daily Core's RSS.

## Reproduce the isolated comparison

Use a managed Job with 2 CPU cores, 6 GiB RAM and no swap. Build the release
example, then run each mode as a fresh process:

```sh
cargo build --locked --release -p yuzuno-workspace --example core_memory_bench
target/release/examples/core_memory_bench target/memory-baseline.json baseline
target/release/examples/core_memory_bench target/memory-reclaim.json active
```

If `CARGO_TARGET_DIR` is set, use its release executable path instead. Each mode
intentionally waits through the same cache expiry, 60-second idle grace and
31-second recheck interval. This is part of the experiment, not completion polling.

The example creates eight synthetic histories, retains three copies of its
largest history, drops them, and lets the real Store expire its cache. It uses
the same two-arena setting as Core. It records Rust live allocations, glibc
allocated/free arenas, RSS and latencies. Rust counters exclude SQLite's C
allocations. Three simultaneous copies are an explicit stress scenario, not a
claim about production concurrency. No user database or model is used.

It verifies that active records, short pauses, other admission permits and
update drain defer reclaim; cooldown and unchanged RSS prevent repeated trims;
and all 23,308 items in the largest history remain readable. The direct diagnostic
trim after seeding establishes the same starting point in both modes. The final
diagnostic trim occurs only after cold-read timing. Neither is production policy.

## Recorded comparison

T-140 Job `8248a64e-039c-477d-af9b-0d587a8f88fe`, source
`3b1a0868b0f5cf7f6f692716a8a7540c7f1bd9f7`, completed on 2026-10-19.
The summary report SHA-256 is
`9c466edc3d2d831ed38645fbe941d16da1cc84da3d83e2e71f2f7510d6d03e62`.
All 74 selected release Store/admission/heap tests passed.

| Observation | Baseline | Idle reclaim |
| --- | ---: | ---: |
| RSS after cache expiry, before reclaim | 1,215.15 MiB | 1,215.16 MiB |
| RSS after the idle opportunity | 1,215.15 MiB | 9.59 MiB |
| Maximum of 100 active reads | 2.153 ms | 2.344 ms |
| Maximum of 5 following updates | 49.811 ms | 54.554 ms |
| First cold read plus commit | 241.103 ms | 378.256 ms |

The single trim took 85.636 ms. The cold read/commit measurement is one sample
per mode, and the active measurements are a small descriptive sample, not a
UI latency percentile or a performance guarantee. An earlier candidate that
trimmed while records were held was rejected after a 44.991 ms active-read spike.

This demonstrates allocator retention and a way to release it in a synthetic
workload. It does not establish that all of the observed production RSS is free,
or predict production's final RSS. No live Core was trimmed or restarted for
these experiments. Integration tests, CI and independent review belong
to the task's delivery record, separately from this frozen experiment.

## Copies per send and Turn end

The trim above releases what the allocator keeps, but RSS also depends on how
much is freed between trims. In the daily Core, RSS returned to about 3.5 GiB
within about 20 minutes of a trim that released about 4 GiB. What it keeps is
freed copies of long records. A Claude send, a Turn end and a mail delivery each
copied the whole held record several times:

- The send path read it with `detail` four or five times, where only the Agent,
  Turn statuses and pending requests are checked.
- The bridge's `result`, `brief` and `mailbox_delivery` frames used an `update`
  that copied, compared and returned the record.

They now use `send_view`, `update_meta` and `update_picking`, which read and
write the same fields. A committed change to a Turn still copies the record
once (`commit_locked`).

`core/examples/core_memory_paths.rs` measures this with a synthetic record, in
a managed Job as above:

```sh
cargo build --locked --release -p yuzuno-workspace --example core_memory_paths
target/release/examples/core_memory_paths target/paths-128.json 128 paths
target/release/examples/core_memory_paths target/cycles-current.json 64 cycles-current 24
target/release/examples/core_memory_paths target/cycles-light.json 64 cycles-light 24
```

`paths` measures each call once, cold and held. The two `cycles` modes repeat a
send, streamed deltas and a Turn end, on four threads with two arenas and no
trim. `current` makes the calls the send and Turn-end paths used to make;
`light` makes the ones they make now.

T-140 Job run `dd1342b8-e3fc-4dd0-99f1-b8d85cd4bed8`, source `90b7775`, 2026-10-20:

| Observation | Before | After |
| --- | ---: | ---: |
| Allocated per send, 128 MiB record held | 726 MiB | 146 MiB |
| Allocated per Turn end, 128 MiB record held | 1,016 MiB | 146 MiB |
| RSS after 24 cycles, 64 MiB record (73 MiB in use) | 726 MiB | 318 MiB |
| Median cycle with the record held | 160 ms | 49 ms |
| Median cycle that first reads it from its rows | 374 ms | 245 ms |

These are allocator measurements of a synthetic workload with one Agent. Production
RSS also depends on how many Agents send and end Turns at once. Rust counters
exclude SQLite's C allocations.

### A Codex Turn's start

A Codex `turn/started` notification, and the reply to `turn/start` applied as
it (`turn/accepted`), went through `commit_locked`, which copies the held
record whole to change one Turn. Now the record's metadata and that Turn are
copied (`Store::commit_turn`) and the event is applied to the copy.
Message receipts are then bound, restored and accepted over the held Turns in
order, with the copy in its Turn's place, as `apply` and the commit do. The
change is written in one transaction; only after it commits do the copies
replace the held metadata and that Turn, so a write that fails leaves the
record as it was. These are committed as before: a record that is not held or
is stored whole, an event without a Turn ID, a record whose Turns are not told
apart by ID, another kind applied as `turn/started`, and receipts after which
a message of another Turn would be restored. `turn/completed` is committed the
same way since (see A Codex Turn's end).

T-140 Jobs `13eb41e0-f370-4b0d-a4b7-acce70109597` (builds) and
`2ae85522-c018-4708-9f77-bda896ad98f1` (runs), 2026-10-23: release builds of
`turn_started_ab_lab` (on lab branches, not merged) on main `88c1e78` and on
this change. Two synthetic records of 100 and 168 Turns (37.9 and 63.6 MiB of
history JSON), held, were each run four times in the order before, after,
after, before, with ten calls of each kind per run:

| One call | Before | After |
| --- | ---: | ---: |
| `turn/started` of a new Turn, 37.9 MiB record: allocated | 40.0 MiB | 36–39 KiB |
| The same: Rust peak above its start | 40.0 MiB | 15–16 KiB |
| The same: median time | 5.9–7.0 ms | 2.6–2.7 ms |
| `turn/started`, 63.6 MiB record: allocated | 67.2 MiB | 63–69 KiB |
| The same: Rust peak above its start | 67.2 MiB | 27 KiB |
| The same: median time | 11.0–11.2 ms | 3.0–3.3 ms |
| `turn/accepted` of that Turn, 63.6 MiB record: allocated | 67.2 MiB | 63–64 KiB |
| The same: median time | 9.7–11.0 ms | 2.6–3.2 ms |
| `turn/completed`, unchanged, 63.6 MiB record: allocated | 67.2 MiB | 67.2 MiB |
| The same: median time | 14.3–14.7 ms | 13.9–17.2 ms |

The same runs streamed a delta into the held record every 2 ms
(`record_stream`, with the stream tick every 250 ms), for 6 seconds with no
call and for 6 seconds per kind while the process made one call every 200 ms:

| A streamed delta's p99 | Before | After |
| --- | ---: | ---: |
| No call, 37.9 MiB record | 455–461 µs | 439–468 µs |
| No call, 63.6 MiB record | 715–801 µs | 739–763 µs |
| `turn/started` every 200 ms, 37.9 MiB record | 7.2–7.5 ms | 0.98–1.2 ms |
| The same, 63.6 MiB record | 12.6–13.4 ms | 1.77–1.79 ms |
| `turn/accepted` every 200 ms, 63.6 MiB record | 12.6–13.2 ms | 2.3–2.5 ms |
| `turn/completed` every 200 ms, 63.6 MiB record | 17.1–17.5 ms | 16.6–16.7 ms |

In every run the first whole copy after the record was opened took 20.7–37.9
ms: before, the first `turn/started`'s; after, the first `turn/completed`'s,
as `turn/started` no longer copies. With the 37.9 MiB record,
`turn/completed`'s median time was higher in both runs after (9.5–9.6 ms
against 8.2–8.8 ms); with the 63.6 MiB record one run after was lower and one
higher. That is not attributed. In each window of `turn/accepted` calls the
slowest call took 22.8–32.9 ms, before and after alike (the 90th percentile
was 11–15 ms before and 3.0–4.6 ms after); that is not attributed either. What
a call allocates after the change grows with the number of Turns. These are
synthetic allocator measurements in one process, not the daily Core's RSS.

### A Codex Turn's end

A native Codex `turn/completed` went through `record_event`: `commit_locked`
copied the held record whole and compared the copy with it, once per Turn. It
now goes through `record_applied` and `Store::commit_turn`, as `turn/started`
does: the record's metadata and that Turn are copied, the event is applied to
the copies, and the receipts are bound, restored and accepted over the held
Turns with the copy in its Turn's place. Unlike `turn/started`, a completion
always runs that step. Whether the Turn was completed or imported before is
checked in the same transaction as the write, with the check `commit_locked`
makes, so a repeat is journaled as `turn/reconfirmed` and adds no unread. A
completion is compared as before where writing in place cannot be shown to
write the same: a record that is not held or is stored whole, an event without
a Turn ID, Turns not told apart by ID, and receipts after which a message of
another Turn would be restored.

T-140 run `f60bb779-f22d-4e10-9e1d-ec71614657f5`, 2026-10-23: a release build
of `turn_completed_ab_lab` (on lab branches, not merged; derived from
`turn_started_ab_lab`) on main `52a7836` and on this change. The same two
synthetic records (37.9 and 63.6 MiB of history JSON), held, were each run
four times in the order before, after, after, before. Before is main's call
(`record_event` with `apply`), after is the change's (`record_applied`); ten
calls of each kind per run. "Streamed" completes a Turn that first got twenty
16 KiB command outputs and its final message through `record_stream`, not yet
written; the completion carries the final message.

| One call | Before | After |
| --- | ---: | ---: |
| `turn/completed`, 37.9 MiB record: allocated | 41.7 MiB | 36.9 KiB |
| The same: Rust peak above its start | 41.6 MiB | 15.9 KiB |
| The same: median time | 7.7–8.8 ms | 1.9–2.1 ms |
| `turn/completed`, 63.6 MiB record: allocated | 68.9 MiB | 64.4 KiB |
| The same: Rust peak above its start | 68.8 MiB | 27.4 KiB |
| The same: median time | 13.4–13.9 ms | 2.4 ms |
| Streamed, 63.6 MiB record: allocated | 70.2 MiB | 1.33 MiB |
| The same: median time | 15.4–15.6 ms | 4.0–4.7 ms |
| The same completion again (`turn/reconfirmed`), 63.6 MiB: allocated | 69.2 MiB | 412 KiB |

| A streamed delta's p99 | Before | After |
| --- | ---: | ---: |
| No call, 37.9 MiB record | 467–471 µs | 447–452 µs |
| No call, 63.6 MiB record | 756–764 µs | 718–726 µs |
| `turn/completed` every 200 ms, 37.9 MiB record | 9.3–10.0 ms | 1.0–1.5 ms |
| The same, 63.6 MiB record | 14.8–15.3 ms | 1.58–1.61 ms |

Every run checked each Turn's status and Items, one `turn/completed` journal
row per Turn and one `turn/reconfirmed` per repeat, unread grown by the Turns
completed only, and the record read back from its rows equal to the one held.
What a completion allocates after the change grows with that Turn (the
streamed case, 1.33 MiB at both sizes), not with the record. Before, the first
completion of each run took 20.2–33.6 ms, the first whole copy after the
record was opened; after, 2.0–2.5 ms. Some single calls took 25–54 ms on both
sides at the same positions (the fourth `turn/started` with the 37.9 MiB
record, the third repeat with the 63.6 MiB one); one run after, with the 63.6
MiB record, had five more calls of 27.7–51.8 ms, the other none above 8.1 ms
besides that shared position. In the windows, the slowest call took 12.5–22.5
ms before; after, 2.8–10.9 ms, except one window with the 37.9 MiB record in
which one call took 46.2 ms and a delta 44.4 ms. None of that is attributed.
Commits that still copy a held Codex record whole, which this lab does not
make, include `error`, `thread/compacted` and an MCP server's start-up
status; a status change or a request's resolution while a message is being
sent no longer does (see below).
These are synthetic allocator measurements in one process, not the daily
Core's RSS.

### A sub-agent's event

A direct sub-agent's request, the resolution of one and its file change reach
the parent Agent's connection on the child's thread. Core finds the child
among the parent's `subAgentActivity` Items. It read them through
`Store::detail`: a copy of the whole held record, payloads included, or all
the rows of one not held, payloads included. `Store::recorded_child` now
reads those Items under the held copy's read lock, or from the rows without
payloads, as `Store::pending` does. An Item's IDs are never payloads; a path
longer than 8 KiB would be found as its preview, and it is only a label.

T-140 Jobs `c7bae01e-70c0-4008-b2c2-62b6189e14a6` (build) and
`2c0055cb-7b44-4ea0-b3ce-875794e10465` (runs), 2026-10-23: a release build of
`subagent_child_lab` (on a lab branch, not merged) of this change, comparing
main's lookup (`Store::detail` and the same search) with the new one in one
binary. Two synthetic records of 100 and 168 Turns (37.9 and 63.6 MiB of
history JSON; 7.1 and 11.9 MB of Item row text, 32.8 and 55.1 MB of payload
text), with the child's Item in Turn 10, were each run twice, with ten
lookups of each kind per run:

| One lookup | Before | After |
| --- | ---: | ---: |
| Held, 37.9 MiB record: allocated | 40.0 MiB | 0.7 KiB |
| The same: Rust peak above its start | 40.0 MiB | 0.7 KiB |
| The same: median time | 4.2–5.3 ms | 0.13–0.15 ms |
| Held, 63.6 MiB record: allocated | 67.2 MiB | 0.7 KiB |
| The same: median time | 8.1–9.5 ms | 0.26–0.33 ms |
| Not held, 37.9 MiB record: allocated | 52.1 MiB | 36.7 MiB |
| The same: Rust peak above its start | 40.3 MiB | 19.1 MiB |
| The same: median time | 20.0–21.3 ms | 11.8–12.3 ms |
| Not held, 63.6 MiB record: allocated | 87.4 MiB | 61.8 MiB |
| The same: Rust peak above its start | 67.5 MiB | 32.1 MiB |
| The same: median time | 34.8–35.8 ms | 21.5–21.7 ms |

A record not held is still read for each such event, all of its Items
without payloads, and neither lookup holds it. How often a parent is not
held when its children's events arrive was not measured. These are synthetic
allocator measurements in one process, not the daily Core's RSS.

### A status change or resolution beside a message being sent

A Codex `thread/status/changed` or `serverRequest/resolved` changes only the
Agent and its pending requests, and is committed as its metadata (T-120).
While a message receipt was sending or uncertain, though, it was applied to
the whole record: a copy of the held record (`record_applied` for the status
change; `record_event` with `apply` for the resolution, which also compared
the copy), or, for a record not held, its rows loaded, and for the
resolution a second copy to compare with. A send's reply can still be
awaited when its Turn's status changes (how often was not measured), and a
receipt stays uncertain after a reply is lost or Core restarts, until it is
confirmed. The metadata commit lacked one step of `apply`: accepting each
receipt by the first Turn with its user message. `Store::update_meta_applied`
takes that step too: on the copy of the metadata, by the held Turns, once
nothing is to restore, and otherwise in `commit`, after its `bind`, in the
order `apply` takes them. Only such an event beside a receipt sending or
uncertain takes it, as only such an event was applied to the whole record:
otherwise the commit is the one it was, and a receipt of another state (an
unknown one, say) whose message is in a Turn is not accepted by it.

T-140 run `3c8fe870-b58b-46ce-9e56-6d361528188c` (build
`c9665670-7f71-431e-af0a-d7d8a5bae82f`, measure
`55acb284-2544-4b5c-923b-208b084803ba`), 2026-10-23: a release build of
`status_meta_lab` (on a lab branch, not merged) of this change, comparing
main's commit with the new one in one binary. Two synthetic records of 100
and 168 Turns (37.9 and 63.6 MiB of history JSON), with a receipt left
uncertain and a request stale, as opening the store leaves a receipt still
sending, were each run twice, with ten commits of each kind per phase. The
events changed nothing but the journal and the update time:

| One commit | Before | After |
| --- | ---: | ---: |
| Held, 37.9 MiB record: allocated | 40.0 MiB | 41.5–42.2 KiB |
| The same: Rust peak above its start | 40.0 MiB | 14.8–15.4 KiB |
| The same: median time | 6.7–8.0 ms | 2.0–2.4 ms |
| Held, 63.6 MiB record: allocated | 67.2 MiB | 65.9–66.6 KiB |
| The same: Rust peak above its start | 67.2 MiB | 26.5–27.1 KiB |
| The same: median time | 9.3–13.3 ms | 2.4–2.5 ms |
| A resolution, not held, 37.9 MiB record: allocated | 92.1 MiB | 52.2 MiB |
| The same: Rust peak above its start | 80.0 MiB | 40.3 MiB |
| The same: median time | 24.9–25.8 ms | 18.4–19.4 ms |
| A resolution, not held, 63.6 MiB record: allocated | 154.6 MiB | 87.4 MiB |
| The same: Rust peak above its start | 134.3 MiB | 67.5 MiB |
| The same: median time | 42.1–43.1 ms | 30.8–31.1 ms |

A status change to a record not held allocated the same before and after
(52.2 and 87.4 MiB): both load its rows, and neither keeps a copy to compare
with. Held, the new commit allocated more with 168 Turns than with 100; what
that is spent on was not broken down. Every run checked one journal row
per commit and the Agent, its request and the receipt as they were opened.
These are synthetic allocator measurements in one process, not the daily
Core's RSS.

### A Claude Turn's end

A live Claude `result` made two commits, each copying the held record whole.
- First, `update_picking` projected the result onto a copy and compared the
  copy with the record.
- Then `record_recovered_completion` journaled the ended Turn's completion
  through `record_event`, which copied and compared again, for a record whose
  Turns it does not change.

The second now commits as the metadata (`commit_meta`). That commit makes, in
its own transaction, the check `commit` makes: whether that Turn was completed
or imported before. A repeat is therefore journaled as `turn/reconfirmed` and
adds no unread.

The first is written in place through `Store::commit_turn`, as a Codex Turn's
start and end are. The record's metadata and the ended Turn are copied, the
result is projected onto the copies, and the receipts are bound over the held
Turns with the copy in its place. Only that Turn's Items that changed are
planned, found as comparing finds them (`Dirty::turn_between`). This applies
where the projection can change no other Turn: the record is held, the ended
Turn is in it, the result is not a sub-agent's, and no other Turn is in
progress. Otherwise the result is compared as before.

T-140 run `b2a21d9c-ad2b-494a-a12e-4ef243e4f553`, 2026-10-23, used release
builds of `claude_result_ab_lab` (on lab branches, not merged) on four sides,
all with the same lab patches:
- main `063d949`;
- the completion change alone;
- both changes, with every Item of the ended Turn planned;
- this change, with only the Items that changed planned.

Each side dispatched the bridge's own messages, so it ran its own production
chain. Two synthetic Claude records of 100 and 168 Turns (37.9 and 63.6 MiB of
history JSON) were each run in the order base, completion, both, this, this,
both, completion, base. Each run had ten calls of each kind, and four calls on
a record let go first (not held). Upper medians (the 6th of 10 sorted):

| One result and its completion, record held | Before | Completion change | This change |
| --- | ---: | ---: | ---: |
| 37.9 MiB record: allocated | 89.4 MiB | 44.8 MiB | 0.07 MiB |
| The same: Rust peak above its start | 44.7 MiB | 44.7 MiB | 0.02 MiB |
| The same: time | 47.9–56.0 ms | 38.9–42.1 ms | 32.3–32.5 ms |
| 63.6 MiB record: allocated | 143.9 MiB | 72.0 MiB | 0.12 MiB |
| The same: Rust peak above its start | 71.9 MiB | 71.9 MiB | 0.03 MiB |
| The same: time | 72.6–73.0 ms | 58.6–60.3 ms | 46.8–47.0 ms |
| After twenty 16 KiB messages streamed into the Turn, 63.6 MiB: allocated | 150.4 MiB | 77.6 MiB | 5.69 MiB |
| A streamed delta's p99, a result every 200 ms, 63.6 MiB | 36.6–36.7 ms | 22.1–23.8 ms | 23.2–23.5 ms |

Every run checked:
- each Turn's status and Items, and a streamed Turn's final answer;
- one `claude/result` row per dispatch and one recovered `turn/completed` per
  Turn;
- unread grown by the Turns only;
- the record read back from its rows, equal to the one held.

The completion change alone halves what the chain allocates but not its peak:
the result's copy remains. With every Item planned, a repeated result on the
streamed Turn allocated 3.6 MiB; with only those that changed, 1.9 MiB. A row
unchanged is not written either way, so the rows written do not differ.

**Not held.** A result on a record not held is compared as before; only its
completion is written as the metadata, which saves a copy of the record
loaded. The result's peak (the load and its compare) is unchanged. On both
changed sides such a result runs the same code, with the same allocation, I/O
and database size. In this lab its time depended on the earlier calls in the
same process: on how much memory they had freed and left resident for its load
to reuse. This lab does not compare it, and it is not a cost of either change.

The lab does not set `M_ARENA_MAX` as Core's `main` does, and two single calls
(545.9 ms and 182.8 ms) are not attributed. These are synthetic allocator
measurements in one process, not the daily Core's RSS. Several Agents ending
Turns at once was not measured.

## Claude bridge events

Five Claude bridge events still committed with `update` and discarded the copy
of the record it returns, or copied the record only to read it:

- the effort a Turn ran at (`effort`, at each Turn end when an effort is set);
- a message delivery (a message appended to a running Turn, then taken by the
  next one);
- a permission request, which also read the record with `detail`;
- a cancelled permission request;
- any other bridge event, which changes nothing.

They now use `record_event`, and the request reads the held record in place
(`peek`). The event that changes nothing uses `update_meta`. The commit itself
still copies the record once (`commit_locked`), as above.

`core_memory_paths` measures each one held, once as before and once as now:

```sh
target/release/examples/core_memory_paths target/events-128.json 128 events
```

T-140 Job run `85cba1f0-fc36-444f-88cf-dcf783d1ed5a`, source `d6e4706` plus this
change, 2026-10-21, 128 MiB synthetic record (145 MiB in use):

| Held event | Allocated before | After | Time before | After |
| --- | ---: | ---: | ---: | ---: |
| Effort applied | 290 MiB | 145 MiB | 106 ms | 42 ms |
| Message delivery | 290 MiB | 145 MiB | 93 ms | 40 ms |
| Permission request | 436 MiB | 145 MiB | 88 ms | 41 ms |
| Permission cancelled | 290 MiB | 145 MiB | 63 ms | 40 ms |
| Other bridge event | 290 MiB | 0.1 MiB | 63 ms | 4 ms |

The memory in use after each call is the same either way: these are copies
that are freed again, which the allocator may keep. As above, these are
allocator measurements of one synthetic Agent, not the daily Core's RSS.

## Opening the Workspace

When Core starts, every Agent that is not closed is marked as left by a Core
that stopped: offline and disconnected, its requests and context usage stale,
a message it was sending of unknown outcome, and an error when its newest Turn
was still running. No Turn changes.

That change is written as the metadata alone, without reading the record,
when it is provably all a whole-record commit would write:

- the record is stored as rows and its rows fit together;
- the journal has nothing to replay into it;
- no message is still being sent;
- binding and restoring its message receipts against its user messages (the
  only Items `message_content::bind` reads, picked by SQLite) would change
  nothing.

Otherwise the whole record is read, changed and committed as before. Either
way the journal row, `last_seq`, the unread count and the metadata are written
in one transaction, and the listed view is rebuilt from the rows when next read.

Before this, the whole-record commit read and parsed every open Agent's record,
payloads included, and dropped it again, so each start left about the largest
record's worth of freed memory in the allocator.

### The completion index

Whether a Turn's completion is journaled already (`completed_before`, and the
check `record_recovered_completion` makes before it writes) is looked up by
Agent and Turn ID. That lookup read every `turn/completed` row of the Agent,
and a Claude result's recovered completion journals its whole Turn, so each
lookup read about the Agent's whole history: twice for a new Claude result,
once for a repeat. A partial index with the query's own terms,
`journal_turn_completed`, now answers it; the query and what it finds are the
same with or without the index.

Opening the Workspace makes the index when it is missing, once, before any
other connection. The index build waits for no lock: it runs with no busy
timeout, so a database another connection is writing fails it at once. The
check whether the index is there runs before it with the connection's usual
busy timeout, as the rest of opening does. About 2 s is the build's time
target: a progress handler checks the time every 1000 SQLite steps, so it
bounds neither one step, nor I/O, nor the rollback, and it is no limit on
opening the Workspace as a whole. When it is stopped or fails (out of time, a
journal row that is not JSON, a full disk, a locked database), the reason is
logged, no part of the index is left, and the Workspace opens with the lookup
reading the journal as before; the next start tries again. An index that is
there is left alone and not read.

T-140 run `85a16149-5590-4f94-a0f1-d8be7a647b51`: probes around the two
lookups in a Claude result's chain (candidate `c94e426`, synthetic records of
100 and 168 Turns of about 0.38 MiB each, held) found them 86–89% of the
call's time (about 28 of 32 ms and 39 of 45 ms), each reading about all the
Agent's `turn/completed` data. Run `bd27a023-1267-4892-8b53-e61450f5daf2`
measured the index alone on synthetic journals with this host's 2 CPUs; these
are SQL timings, not a whole result's:

| Agent's turn/completed rows (journal's turn/completed data) | Lookup without | With the index | Making the index |
| --- | ---: | ---: | ---: |
| 100 (37.9 MiB) | 17.9 ms | 0.006 ms | 20 ms |
| 250 (379 MiB) | 37.2 ms | 0.006 ms | 165 ms |
| 500 (1.48 GiB) | 72.7 ms | 0.009 ms | 709 ms |

The index took 0.01–0.15 MiB. Journaling a whole-Turn completion took 0.14–0.44
ms more with it (medians of 40 each way).

## Reconnect, restart and idle writes

On core.13 (2026-10-21) the daily Core reached 5.08 GiB RSS, peak 5.46 GiB,
within about six minutes of an update restart, and stayed there. Its first
idle reclaim, 23 minutes after the start, reported 5.0 GiB of free arena space
and RSS fell from 5.08 GiB to 127 MiB. So most of that high point was freed
memory glibc kept; that observation does not account for every byte or rule
out a leak. The paths below run at such a restart and each made several copies
of a long record; how much each contributed to that high point was not measured.

- An update restart marks every open Agent restarted. `Store::open` did it with
  a compared update, loading each record with its payloads, copying it to compare
  with, and keeping each held, so opening held up to `MAX_STREAMS` whole records.
- The update then reconnects each restored session. A Codex reconnect, with the
  update's own checks, read the whole record with `detail` up to ten times
  where only the Agent, pending requests or Turn status are read, merged the resumed thread by cloning its Turns and
  Items, and had commits return copies nobody used.
- A metadata write (mail doorbell, connection state) to a record no longer held
  loaded it and kept a second copy to compare with, although the change's
  scope already names what it writes.

Those reads now use `send_view` and `update_readiness`, the merge takes the
snapshot's Turns by value, the commits use `record_event` or `update_meta`, a
record just loaded is copied only to compare a change of unknown scope, and
`Store::open` releases each record after marking it. A recovered completion
still reads the whole record, but only when a finished Turn has no journaled
completion. A committed change to a held record's Turns still copies it once.

`core/examples/core_attach_memory.rs` measures these phases with synthetic
Agents (100 Turns of 80 Items, each Item's output the same size, every Turn's
completion journaled as a live Turn leaves it) and a scripted app-server that
returns the same history on resume:

```sh
cargo build --locked --release -p yuzuno-workspace --example core_attach_memory
target/release/examples/core_attach_memory target/attach-a4.json 8 4
YUZUNO_ALLOC_SITES=1 target/release/examples/core_attach_memory target/attach-sites.json 8 1
```

The second argument is each Item's output in KiB, the third the number of
Agents, which reconnect at once. `YUZUNO_ALLOC_SITES=1` adds byte-sampled
allocation sites by source line for the reconnect phases.

T-140 Job runs `04d0effa-3d70-49ec-8d28-dd3954cf9266` (released `827bd32` with
the example), `600c6d9e-80be-41fd-bddf-5fb5ef0b3048` and
`976a49fb-af13-4f13-8dae-d26cc7c99b12` (this change, source `2827706`),
2026-10-21, 8 KiB per Item (63.5 MiB of history per Agent), release build:

| Observation | 827bd32 | This change |
| --- | ---: | ---: |
| One Agent reconnecting after the open: allocated | 2,788 MiB | 1,558 MiB |
| One Agent reconnecting after the open: peak above live | 412 MiB | 274 MiB |
| One Agent reconnecting while connected: allocated | 1,494 MiB | 948 MiB |
| Four Agents: opening, peak above live | 342 MiB | 68 MiB |
| Four Agents: records held after opening | 4 | 0 |
| Four Agents reconnecting at once: allocated | 11,151 MiB | 6,232 MiB |
| Four Agents reconnecting at once: peak above live | 1,264 MiB | 754–950 MiB |
| Four Agents reconnecting at once: process CPU | 11.1 s | 6.7–9.4 s |
| Four Agents: doorbell to each idle record, allocated | 815 MiB | 541 MiB |
| Four Agents: RSS after all phases and idle, no trim | 1,289 MiB | 782–1,013 MiB |

The 827bd32 column is one run; this change's four-Agent rows are four runs,
whose peaks vary with how the concurrent reconnects overlap. Every run kept
every Turn and Item. These are synthetic allocator measurements; the daily Core's
RSS also depends on its records' sizes and how many Agents are active at once,
and is not measured here.

### Connecting, and a reconnect that fails

A Codex reconnect that starts an app-server read the whole record only for
where the Agent's runtime is, and wrote the connection state with compared
updates that returned copies nobody read. Recording a failed reconnect, for
any harness, read the whole record for the Agent's status and error and wrote
them with a compared update; a remote Agent whose machine is away is retried
with a backoff of up to 30 s and paid both each time. These now read the
listed Agent and write its fields as metadata, as do Claude's and OpenCode's
connection failures. Their ready and history writes change Turns, so they are
compared as before, only without returning a copy. A fork's attach answers
with the listed Agent. What is recorded is unchanged: the same journal
entries, a repeated error recorded once, nothing for a closed Agent, and an
attach left unanswered marked uncertain.

T-140 Job `df78bc42-54b5-46ec-a2c2-ef49c10e9dc6`, 2026-10-22, release build of
`core_attach_memory`, same tool on both sides, "before" the product code of
`27352dc`. "Allocated" is every byte the Rust allocator handed out during the
request; "peak above live" is the most the Rust heap held above what it held
when the request started. Neither is RSS, which these rows do not measure.
Each row is one process; both 8 KiB processes of a side allocated the same:

| Request | Before | After |
| --- | ---: | ---: |
| Reconnect after the open, 8 KiB per Item (63.5 MiB): allocated | 1,286 MiB | 1,014 MiB |
| Reconnect after the open, 8 KiB per Item: peak above live | 274 MiB | 274 MiB |
| Reconnect after the open, 1 KiB per Item (8.9 MiB): allocated | 260 MiB | 207 MiB |
| Reopen, 8 KiB per Item: allocated | 881 MiB | 676 MiB |
| First reconnect through the router (no view), 8 KiB per Item: allocated | 1,493 MiB | 1,288 MiB |
| Four Agents reconnecting at once after the open: allocated | 5,144 MiB | 4,055 MiB |
| Four Agents reconnecting at once after the open: peak above live | 870 MiB | 676 MiB |

Reconnects that start no app-server (while connected, and `view=summary`)
allocate the same on both sides. By the source, the first request through
the router starts one: creating the router starts the collaboration endpoint,
and the fixture's connected Agent has no MCP readiness recorded, so that
reconnect detaches it and connects again. One Agent's peaks are the same on
both sides; which step reaches them was not measured here. The four-Agent
peak is one process per side, and how the concurrent reconnects overlap
differs from run to run, so this run does not show whether the change lowers
it. A failing reconnect is covered by tests, not measured: on main its test
reads the whole record 4 times for two refused reconnects and twice for an
unanswered one, now none. These are synthetic allocator measurements, not the
daily Core's RSS.

### A native request's reply

A native request kept its reply when it arrived and returned a copy, so that
waiting for it again would not send the request again. Only an attach waits
again: a reconnect that finds its attach kept (after a timeout, a refused
write or an interrupted request) finishes it from that reply. Every other
request waited once and dropped the reply straight after, so the copy was
made only to be freed; for a reconcile's `thread/read` it is the whole
history. Those requests now take the reply instead. An attach kept copying
its reply: the copy was consumed by the record's commit, and the kept reply is
what a later reconnect finishes from if that commit fails or the request is
cancelled. It now shares the reply instead (see "An attach's reply" below).

T-140 Job `7329a312-5e9a-4a8c-821b-eeab09b3fc2c`, 2026-10-22: a lab build of
`core_reconnect_cycles` on `06c1ae1` with counting points inside the
reconnect, before and after this change; one synthetic Agent with 8 KiB per
Item (63.5 MiB of history); four runs in the order before, after, after,
before, each in a process of its own. Both runs of a side gave the same Rust
counts:

| One reconnect after the open | Before | After |
| --- | ---: | ---: |
| Allocated | 943.6 MiB | 875.2 MiB |
| Rust peak | 273.9 MiB | 273.9 MiB |
| The reconcile's read, from its reply parsed to the caller having it: allocated | 68.4 MiB | 0 |
| The same span: Rust peak | 205.5 MiB | 137.1 MiB |
| VmRSS at the end of the reconnect | 368.7–369.4 MiB | 298.9–299.8 MiB |
| RssAnon once the record is released (5 s later) | 283.1 MiB | 283.0–283.5 MiB |

The reconnect's peak is reached at its attach's commit, which this does not
change; by the source, the record held since the first write of the
reconnect, the attach's reply, its copy and the commit's copy of the held
record are all in use there. The reconcile still peaks at 205.5 MiB, in its
own commit. The RSS rows are this process at the end of a phase only, not its
highest point; why the end of the reconnect differs was not measured. The
Job is marked failed: its comparison step stopped on a check that saw
1,056 B allocated, by any thread, in run 1's process before its first
measured phase; the four runs
completed and are compared here from their reports. These are synthetic
measurements, not the daily Core's.

### An attach's reply

An attach keeps its reply, unchanged, for a reconnect that finishes it later,
and gave its commit a copy of it. While the commit loaded its working copy of
the held record, four whole histories were in use: the held record, the kept
reply, its copy and the commit's copy. The attach now shares the reply it
keeps and changes nothing in it. Its commit merges the Turns one at a time,
copying each as it goes, and an imported record's recovery page is kept
apart. A reply that only one request holds is still handed over without a
copy.

T-140 Job `f722227c-1655-4580-8210-bcd112626b52`, 2026-10-23: lab builds of
`core_reconnect_cycles` on main `0c93477` and on this change, with the points
above plus glibc's own in-use and free counts and a digest of the record's
Turns; the same synthetic Agent; four runs in the order before, after, after,
before. Both runs of a side gave the same Rust counts, and all four the same
Turns:

| One reconnect after the open | Before | After |
| --- | ---: | ---: |
| Rust peak | 273.9 MiB | 206.2 MiB |
| The attach's commit with its working copy loaded: Rust in use | 273.9 MiB | 205.5 MiB |
| The same point: glibc in use | 282.2 MiB | 211.9 MiB |
| Allocated | 875.2 MiB | 875.2 MiB |
| The reconcile's commit: Rust peak | 205.5 MiB | 205.5 MiB |
| VmHWM at the end of the reconnect | 361.3–362.0 MiB | 297.3–297.4 MiB |
| glibc free in its heaps at the end of the reconnect | 211.1–211.9 MiB | 147.4 MiB |
| RssAnon once the record is released (5 s later) | 283.0–283.5 MiB | 219.3 MiB |

The peak is still at the attach's commit, now about one Turn above the three
records in use there; the reconcile's commit reaches nearly the same. The
copy is still made, a Turn at a time, so the total allocated is essentially
unchanged.
glibc keeps what was freed for reuse, and this lab runs no trim, so the
resident rows follow the peak; what the daily Core keeps resident also
depends on its own reclaim. These are synthetic measurements, not the daily
Core's.

### The UI's reconnect

`POST /api/agents/{id}/reconnect` answers with the whole record. Every UI
caller (Check delivery, a pending question's Check, the Codex writer notice,
the recovery notice and the remote controls) drops that answer and reads the
windowed detail again. These callers now send `view=summary`. Core then
reconnects through the same admission, gate and reconcile and answers with
the Agent only. A Codex reconnect also no longer reads the record whole to
return it; a Claude or OpenCode one still reads it inside, so only its answer
gets smaller. Without a view the answer is the whole record, as before. A
Core from before `view=summary` ignores the view, and the UI does not read
its answer.

`core_attach_memory` sends the request through the router twice, once without
a view and once with `view=summary`, on one synthetic Codex Agent. Runs: T-140
Job `56adf74f-1ea9-4db1-a539-c0c1e65efb9d`, 2026-10-21, release build. Both
builds have the same tool; "before" is the product code of `f214648`. The
compared request is the second one in each process:

| `view=summary` reconnect | Before | After |
| --- | ---: | ---: |
| 8 KiB per Item (63.5 MiB of history): allocated | 1,017 MiB | 811 MiB |
| 8 KiB per Item: peak above live | 206 MiB | 205 MiB |
| 8 KiB per Item: time | 435 ms | 320 ms |
| 8 KiB per Item: answer | 66.6 MB | 515 B |
| 1 KiB per Item (8.9 MiB): allocated | 205 MiB | 161 MiB |
| 1 KiB per Item: time | 111 ms | 97 ms |

The request without a view is the same in both builds: 1,628 MiB allocated for
8 KiB per Item. The first request through the router in each process allocates
about 611 MiB more than the second; what that is was not measured. The peak
comes from the reconcile, so the smaller answer does not lower it. Each row is
one process. The browser's cost of parsing the 66.6 MB answer was not measured.
These are synthetic allocator measurements, not the daily Core's RSS.

### Reopen and the open check

Reopening read the whole record twice to see whether the Agent was closed,
wrote the reopening with a compared update, and its route then answered with
only the Agent of the whole record its reconnect read once more. A Claude
reconnect read the whole record only to check that the Agent was open, and a
reconnect that returns nothing read it again at the end to drop it. These
checks now read the Agent as listed, with its project. The reopening is a
write of the Agent fields only. The reopen route answers with that Agent, the
same fields as before. Each reconnect looks up the harness the same way, no
longer through the send view, which for a record that is not held assembles
every Turn. `reopen_agent`, and every reconnect that returns the record, still
returns it whole.

T-140 Job `e29fb50c-a374-4759-a718-7ed87ad5a7b6`, 2026-10-21, release build,
same tool on both sides, "before" the product code of `78de327`. Each measured
request starts on a record an idle tick has released, and is the only one of
its kind in the process: the reopen follows a close of the Agent.

| Request | Before | After |
| --- | ---: | ---: |
| Reopen, 8 KiB per Item (63.5 MiB): allocated | 1,222 MiB | 881 MiB |
| Reopen, 8 KiB per Item: peak above live | 274 MiB | 274 MiB |
| Reopen, 8 KiB per Item: time | 587 ms | 553 ms |
| Reopen, 1 KiB per Item (8.9 MiB): allocated | 251 MiB | 184 MiB |
| `view=summary` reconnect, 8 KiB per Item: allocated | 811 MiB | 676 MiB |
| `view=summary` reconnect, 1 KiB per Item: allocated | 161 MiB | 135 MiB |

The reopen's answer is 505 bytes on both sides. Its peak comes from the
reconnect that follows, which starts the scripted Codex app-server again and
reads its history, so the peak does not change. Each row is one process.
A Claude reopen or reconnect is covered by tests here, not measured. These are
synthetic allocator measurements, not the daily Core's RSS.

### Stop, and a Claude follow-up

A Stop read the whole record to choose the harness, and then again for
Codex and Claude to find the running Turn: the Agent's open state and each
Turn's status and id are all it checks, and Claude's then sent the record it
had just written back to a caller that dropped it. A message sent to a Claude
Agent while its Turn runs (a follow-up, or an answer to a form in that Turn)
dropped the same copy. The Stop now chooses the harness from the listed Agent
and finds the Turn on the send view, held or not, and both writes are the same
commit without the copy back (`record_update`). What is asked of Codex or
Claude, how often and in which order, the generation and receipt checks, and
that an acknowledgement is not the Turn's end are as before.

Tests count whole reads per Agent: none for a Stop of a Claude Agent (a
scripted bridge, which still refuses with no running Turn or once closed) or
a Codex Agent (a scripted app-server), held or not. The copy a follow-up no
longer gets back is not counted: its write is the same `Store::record_event`
commit that `update_record` makes, which then copies the record. Neither was
measured; the commit still copies a held record before it writes, as every
commit does.

### Close while a Turn runs

Closing an Agent whose Turn is running asks the native side to interrupt it
and waits for the Turn's end. Codex is checked every 25 ms for up to 10 s,
Claude every 50 ms. Each check read the whole record, as did the checks
before it: whether the Agent was closed and which Turn was running. They read
only the Agent and each Turn's status and id, so they now read the send view;
the remote runtime close stops comes from the listed Agent. The checks, their
deadlines, the refusal when an interrupt is not confirmed and the whole record
close returns are unchanged. An OpenCode reconnect now checks openness on the
listed Agent and reads the record at the end only for a caller that uses it,
as a Claude one does.

T-140 Jobs `c2579f0c-0aa5-480b-91c8-e10817146285` (release build) and
`62bd2ea4-4a69-4cbd-a135-2d1a52e177c0` (measured alone), 2026-10-21. Same
tool on both sides, "before" the product code of `bd53845`. The scripted
Codex app-server reports the interrupted Turn's end a second after the
interrupt. The record is held throughout, since its Turn is running:

| Close while a Turn runs | Before | After |
| --- | ---: | ---: |
| 8 KiB per Item (63.5 MiB): allocated | 2,531 MiB | 209 MiB |
| 8 KiB per Item: peak above live | 205 MiB | 137 MiB |
| 8 KiB per Item: process CPU | 0.44 s | 0.11 s |
| 1 KiB per Item (8.9 MiB): allocated | 549 MiB | 72 MiB |
| 1 KiB per Item: peak above live | 41 MiB | 28 MiB |

Both sides took about 1.1 s, most of it the scripted second; both made the
same native requests and closed on Codex's interrupted end of the Turn. How
much a close allocates before grew with how long the interrupt took to
confirm. Each row is one process; a Claude close is covered by tests, not
measured. These are synthetic allocator measurements, not the daily Core's
RSS.

### The model and permission catalog

The Agent settings panel asks for `/api/agents/{id}/models` when it opens, and
again after a save or a reload; nothing polls it. Each request read the whole
record: twice for a Claude Agent (the route's harness lookup and the catalog's
open check) and four times, one after another, for a Codex Agent (the route,
the catalog's check, its read of the settings once connected, and the context
settings). The route and both catalogs now read the Agent as listed, and the
Codex catalog still reads it again once connected, for the settings the
connection may change. The context settings are read from the send view,
which has every field they use: the Agent, its pending requests, receipts,
context usage and each Turn's status. The admission, gate, connection,
permission and config requests, the rewind check and the answer are as before.

Tests count whole reads per Agent: none for the route, the Claude catalog (a
scripted bridge) or the Codex catalog (a scripted app-server), held or not.
The Claude catalog still refuses a closed Agent and one of another harness,
and the route a missing one, as before. This is a cost per opening of the
panel, not one Core pays while streaming; it was not measured separately.

### A send's harness and a Claude mailbox notice

Every message sent from the UI read the whole record only to choose its
harness's send, which then reads the send view itself. A mailbox notice into
a running Claude Turn read the whole record to check that the Agent is open
and connected and that the Turn is still in progress. The delivery around it,
and a Codex steer, check the same on the send view. The send now chooses the
harness from the listed Agent, and the notice checks the send view. Their
refusals and what they send are unchanged: a stale or ended Turn, a lost
connection, a closed Agent and a missing runtime are refused before anything
is sent, and a notice whose runtime is replaced before its acknowledgement is
unknown and not sent again.

T-140 Job `412fc7b9-4ce4-44e0-8351-96973b648602`, 2026-10-22, release build of
`core/examples/core_read_cost.rs` (kept on a lab branch, not merged), one read
per process of a synthetic 192 MiB record of 23,308 Items whose newest Turn
runs. "Held" is the record kept in memory after a write, as a streaming
Agent's is; "not held" is read from its rows:

| Read | Rust peak above live | Time |
| --- | ---: | ---: |
| Whole record (`detail`, both before), not held | 215 MiB | 196 ms |
| Whole record, held (a copy) | 209 MiB | 34 ms |
| Send view (the notice now), held | 0.2 MiB | 1.8 ms |
| Send view, not held | 138 MiB | 133 ms |
| Listed Agent (the send now), held or not | 1 KiB | under 0.01 ms |

The listed Agent was already cached in these processes. One that is not reads
the metadata, the Turn rows and the newest Turn. A send view that is not held
assembled every Turn's Items from their rows, without payloads, before
dropping them; it now keeps only what it needs (see the next section). These
are synthetic allocator measurements, not the daily Core's RSS.

### A send view of a record that is not held

About 40 callers read the send view: sends, steers, the close waits that poll
it every 25 or 50 ms, deliveries and reconnects. For a record not held in
memory, it assembled every Item from its rows, with the previews of its large
fields, and then dropped all but the async questions. It is now read in the
same reader, snapshot and version loop. The Turn rows come first, then one
cursor over the Item rows in key order, a Turn's rows together. Each Turn is
assembled and checked exactly as before, by the same code, and only the async
questions and the large Items a pending request names are kept.
`whole_referenced` then makes the named Items whole as before.

Wherever this read could differ, it gives way to the old one, in the same
snapshot and with the same stand-in and error: a record stored whole, journal
rows `restore` would apply to Turns or Items, a replay that is not metadata
only, anything that does not assemble or fails, and a record known to be
damaged. The view is unchanged. Tests compare it with the old read, case by
case, in two stores.

T-140 Job `69e8518f-67cb-4229-872a-7f3fba72ca9e`, 2026-10-22, release builds of
`core/examples/core_read_cost.rs` (on lab branches, not merged), "before" the
product code of `2cbde4e`. One seeded synthetic image (192 MiB, 23,308 Items,
234 Turns of 100 Items, the newest running) was copied for each read, which
ran alone in a fresh process:

| Send view, record not held | Before | After |
| --- | ---: | ---: |
| Rust peak above live | 137.5 MiB | 1.5 MiB |
| RSS after the read (from 11.6 MiB) | 108.6 MiB | 11.7 MiB |
| Time | 140 ms | 64 ms |
| Read through syscalls (rchar) | 98.7 MiB | 98.6 MiB |

A held record's send view (0.2 MiB, 1.8 ms) and a whole read (`detail`) were
the same on both sides. The previews are still read and checked, so the bytes
read stay the same. The peak follows the largest Turn, so a record with one
very large Turn still reads that Turn whole. These are synthetic allocator
measurements, not the daily Core's RSS.

### A whole read's payloads

A record read with its payloads (`detail`, a Turn or an Item read whole)
copied every payload row's JSON text into a String and parsed it later, when
its Item was filled: a copy of all its large fields, made only to be freed.
Each payload is now parsed where SQLite gives its text. A value that is not
text is the same read error as before, and text that is not JSON makes the
record damaged with the same cause, where the Item is filled. Fields up to
`client_view::TRIM_ABOVE` stay in their Item rows, which are read as before,
and so are the conversation window's reads.

T-140 Job `9fbff673-26af-4e9b-8146-3ba60abf681e`, 2026-10-22, release builds of
`core_cold_read` (on lab branches, not merged), "before" the product code of
`c08ba95`. Each of two seeded synthetic records was copied for each process,
in the order before, after, after, before; each process read it whole three
times. Both runs of a side gave the same Rust counts, and every read the same
Turns:

| One whole read, first in its process | Before | After |
| --- | ---: | ---: |
| 100 Turns of 40 Items, each output 16 KiB (4,000 payload rows, 62.5 MiB of their text): allocated | 138.9 MiB | 75.3 MiB |
| The same: Rust peak | 66.9 MiB | 66.1 MiB |
| The same: held once read | 65.5 MiB | 65.5 MiB |
| 100 Turns of 80 Items, each output 8 KiB (no payload rows): allocated | 135.2 MiB | 135.2 MiB |

RSS after the load was within 1 MiB on both sides (79.2 and 78.1–78.2 MiB from
11.1–11.3 MiB), and the load took 54–59 ms before and 51–55 ms after (later
reads 34–39 and 28–31 ms); these are single small samples. Where a record's
large fields are in its Item rows, as in the second record, nothing changes.
These are synthetic allocator measurements, not the daily Core's RSS.

## The live-event ring

Core keeps its latest live messages for clients that reconnect
(`events::RING_EVENTS`, 10,000 of them, and `RING_BYTES`, 32 MiB), and queues
for each client what it has not read yet (`SUBSCRIBER_BYTES`, 16 MiB). These
limits count each message's length. A message is encoded into a string that
doubles as it grows, and the ring kept that string as it was: in the lab
below it held 1.5 to 1.6 times the bytes it counted. Each message is now
shrunk to its length before it is kept. The ring keeps the same messages.

T-140 Jobs `32026f1b-10dc-48bb-8ae0-3162b9ee63f3` (before) and
`45cc4144-9561-4b06-8ec5-e3d28e505823` (after, two runs), 2026-10-23: release
builds of `events_ring_slack` (on lab branches, not merged) on main `41952ef`
and on this change. Three synthetic mixes of 20,000 messages went through
`Events::publish`, each leaving 10,000 in the ring, under 32 MiB. Both runs of
the change gave the same counts:

| The ring after 20,000 messages | Before | After |
| --- | ---: | ---: |
| Mostly streamed text: bytes counted | 5.2 MiB | 5.2 MiB |
| The same: Rust heap the ring holds | 8.4 MiB | 5.8 MiB |
| Mostly tool outputs: bytes counted | 25.3 MiB | 25.3 MiB |
| The same: Rust heap the ring holds | 41.9 MiB | 25.9 MiB |
| Mixed: bytes counted | 11.9 MiB | 11.9 MiB |
| The same: Rust heap the ring holds | 19.3 MiB | 12.5 MiB |

What the ring now holds beyond the bytes it counts is its 10,000 entries
and their slots (0.6 MiB). Shrinking is one more allocator call for each message; the lab
did not time `publish` itself. Whether the reserved bytes were resident
depends on the allocator, so RSS may fall by less. These are synthetic
allocator measurements, not the daily Core's RSS.

## A conversation search

A search of an Agent's saved messages (`/api/agents/{id}/conversation/search`)
read the record as the detail API gives it: a held record copied whole,
payloads included, and one stored as rows read with all its Items. The
search itself reads only user and assistant messages and stops at 50
results. Now a held record's messages, only what the search reads of them,
are copied under its read lock and searched after it: a streamed event waits
for that copy, not for a copy of the record or for the search. A record
stored as rows is searched from the conversation window's index and its
messages' rows, read one at a time until there are 50 results. The index
builds and keeps an entry for each Item it has none for, as a window read
does, so the first search after the record changed still reads those Items'
rows. A damaged record, one stored whole, one with journaled changes its
rows lack, and a blank or too long query are searched as before. The
results are the same.

T-140 run `c44da464-b65a-40e9-92b0-4903d3402e57`, 2026-10-23: release builds
of `conversation_search_lab` (on lab branches, not merged) on main
`21d8394` and on this change. One synthetic record of 100 Turns, each a
user message, 30 tool outputs and two assistant messages (6.8 MiB of Item
row text, 31.3 MiB of payload row text), was searched in four runs in the
order before, after, after, before. Every search found the same results:

| One search | Before | After |
| --- | ---: | ---: |
| Not held, once the index is built, a word found nowhere: allocated | 37.1 MiB | 4.3 MiB |
| The same: Rust peak | 19.1 MiB | 2.6 MiB |
| The same: time | 11.3–15.8 ms | 5.2–7.6 ms |
| Not held, the first search after the record changed: allocated | 36.8 MiB | 41.1 MiB |
| The same: Rust peak | 19.1 MiB | 3.8 MiB |
| The same: time | 21.2–22.3 ms | 39.7–44.8 ms |
| Held, a word found nowhere: allocated | 51.4 MiB | 1.0 MiB |
| The same: Rust peak | 40.0 MiB | 0.6 MiB |
| The same: time | 8.4–10.6 ms | 0.3–0.6 ms |

The same runs streamed a delta into the held record every 2 ms for 12
seconds, as Core applies one (`record_stream`, with the stream tick every
250 ms), alone and while the process searched back to back:

| A streamed delta | Before | After |
| --- | ---: | ---: |
| Alone: p50 | 198–200 µs | 222–227 µs |
| Alone: p99 | 457–568 µs | 458–543 µs |
| While searching: p50 | 228–254 µs | 348–370 µs |
| While searching: p90 | 2.3–3.0 ms | 0.49–0.52 ms |
| While searching: p99 | 3.9–4.3 ms | 0.66–0.69 ms |
| Searches in those 12 seconds | 1,212–1,330 | 27,253–27,699 |

The first search after a change builds the index's missing entries and
writes them, as a window read would, and takes longer than before. Alone,
a delta's p50 was higher in both runs after; that is not attributed. While
searching, the process searched about 20 times as often after, and a delta's
p50 was higher too. These are synthetic allocator measurements in one
process, not the daily Core's RSS.
