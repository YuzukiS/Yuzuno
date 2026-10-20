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
