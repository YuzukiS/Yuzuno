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

The check calls `malloc_trim(0)` in the existing blocking maintenance closure,
outside Store locks. It does not delete records, change cache expiry, interrupt
an Agent, or add a new background thread. Other platforms are unchanged.
One structured `Core heap maintenance` log records each attempted trim, including
its duration and RSS observations. These are concurrent observations, not an exact
accounting of bytes freed by that call.

This is advisory maintenance, not a memory limit. The ticker starts with the
first streamed event. Continuous activity or long-lived admission permits may
defer reclamation. A new request can arrive after the idle snapshot and overlap
the allocator's locks. Reading cold histories after reclamation must fault pages
back in; the grace period avoids doing this during brief typing/thinking pauses
but does not eliminate that cost.

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
