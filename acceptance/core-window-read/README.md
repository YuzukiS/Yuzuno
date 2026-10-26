# T-81: read saved conversation bodies by window

The window detail endpoint now reads the selected bodies from healthy Rows and
borrows held history instead of cloning all of it. The complete lightweight
navigation/question/delivery index remains available. On the four-history
fixture, nine warm release HTTP samples had median latency 241.026 → 62.271 ms
for Rows and 127.154 → 33.272 ms for held records. This is isolated Linux Core
evidence, not browser latency, a p95 claim, or a Windows result.

## Candidate and reproducibility

- Task: T-81; original dispatch `d5ad362c-b661-4a23-874c-6632a72b50f8`.
- Base: `899b6565428e6d8541f0606c46ceb3e2dd42412d`.
- Baseline with benchmark only: `18bcb7eec5c5b91a670736b714003c0138c547e7`.
- Tested implementation: `585d7c3d19c1686271363733c6e306e6a8029782`.
  The evidence commit adds only this record and copies of measured JSON.
- Branch: `feat/t81-core-window-read`.
- Worktree: `/home/developer/yuzuno-next/.claude/worktrees/t81-core-window-read`.
- Compiler: `rustc 1.97.1 (8bab26f4f 2026-07-14)`, release, locked, offline.
- Both runs used Jobs with 2 CPUs, 4096 MiB, no swap, the shared max-two heavy
  slot, and Git guards. These are sequential runs on the same host; scheduler
  noise and cache state can affect their small sample sets.
- Masked T77 input SHA256:
  `b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d`.
  The private input is not committed. Reports contain measurements, not bodies.
- [Baseline manifest](baseline-manifest.json), [baseline samples](baseline-report.json),
  [candidate manifest](candidate-manifest.json), [candidate samples](candidate-report.json).

`baseline.sh` belongs to the baseline commit. `candidate.sh <new-run-name>` runs
the targeted release tests, builds `conversation_read_bench`, and creates a new
output directory. Both need a checkout of `586fd06` or earlier:
`conversation_read_bench` was removed with the session store (T-140).
Submit these scripts through the Workspace Job/heavy-slot workflow; preserve
existing output. The scripts name the local private fixture
path, and the example verifies its hash. No native harness starts. Each shape
creates a separate Store/Workspace and an ephemeral loopback server using the
production router. No daily Core database or service is used.

The source has 157 turns / 6197 items. `long` adds one live item; `long4` repeats
the history four times with distinct turn IDs, then adds one live item; `giant`
flattens the history into one turn with unique item IDs and adds a large text
item plus the live item. Performance fixtures clear Pending, message receipts
and native session identities; dedicated correctness tests cover those fields.
Destinations are latest, a middle turn, and a direct middle item. All 18 warm
HTTP response byte counts match the baseline. Byte-count equality supplements
the regression tests; it does not prove content equality on its own.

## Read path and compatibility

`Store::client_window` builds the full lightweight index inside the existing
snapshot/version retry protocol and reads the bodies selected by the existing
window algorithm. Healthy Rows use a derived `agent_window_items` cache. Missing
entries are built from authoritative item JSON; write/delete triggers invalidate
them, and conditional publication compares the original data/previews/payloads
so concurrent changes cannot publish a stale entry. A damaged cache entry is
rebuilt. The cache is not a replacement source of truth.

Held records are borrowed while the lightweight index and selected bodies are
copied. Rows read at most three additional latest-turn bodies for the existing
rail projection, reusing them when they also occur in the selected window.
Source/mailbox/question annotations use the same database read connection.
Codex question annotation was only extracted into a helper accepting an existing
connection; harness import and bridge ownership behavior do not change.

The 96-item / 256-KiB body response contract, oversized-item preview, overlapping
before/after cursors, empty turns, direct IDs, complete question/Pending metadata,
native client IDs, receipt deduplication and mailbox attribution are retained.
Full details, original text, search and full-copy paths retain their existing
semantics and full-read costs. An oversized selected item is still read/parsed
before previewing it; the response bound is not a disk-read bound.

Legacy records, damaged records, pending journal replay, and Pending that refers
to positional row keys caused by ambiguous item/turn IDs use the existing full
read. The last case preserves the old duplicate-ID payload-hydration selection.
Regression tests cover these fallback decisions; the performance fixtures do not
measure their frequency in user data. `source: fallback` byte counters are
unmeasured zeros, not evidence that fallback reads no bytes.

## Measurement boundaries

Warm timing tables below contain medians of nine samples. Baseline SQL read,
decode, full client detail, projection and serialization are timed separately;
the first two are diagnostic substeps of full detail and must not be added to
it. Candidate body selection and projection are one Store operation, so they
are reported together rather than assigned artificial separate timings.

Read byte counters count JSON strings returned to Rust and parsed there,
including record/turn metadata, item metadata and selected bodies. They are not
physical disk I/O, SQLite page traffic or the ancillary provenance/result-query
bytes. Held uses existing in-memory bodies and therefore has zero SQL body
counters while still spending CPU and allocating its complete index.

Allocation values are maximum additional live bytes measured by a process-wide
Rust allocator during the operation. They exclude SQLite C allocations. HTTP
also includes client/runtime buffers, and streaming samples include the writer.
They are neither total allocated bytes nor request RSS. Whole-process final
VmHWM was 888292 KiB baseline and 567304 KiB candidate, affected by allocator
retention across the entire benchmark; it is not a per-request comparison.

The cache is populated lazily. The first request over existing Rows reads all
uncached item JSON and writes the derived index, measured separately below.
Later item changes rebuild their entries. Complete metadata still costs
O(total items), as the long/long4 comparison shows.

## Validation and execution history

Baseline Job `2e513e5f-43e2-4791-9571-714ad83e9d92`, attempt
`d68b53b9-3034-4ae1-9c62-2410006edc85`, succeeded at
`2026-10-16T23:46:59.818Z`. Report SHA256:
`95cb2e61123810f6ae5dbf85af795d8bc26dc1bef1caec97bcf556506fcf9881`.

Candidate v5 Job `69a88362-6518-42fe-b74c-5669849f439e`, attempt
`55f274ec-7944-48fb-999a-dacccc8dd0fe`, succeeded at
`2026-10-17T00:15:33.832Z`. Report SHA256:
`b9feda58d1a97f319033dd4ded0166b221c0b0392894231b4acca28045475ebe`.
Job memory peak 2,756,210,688 bytes includes compilation; no OOM.

- Release `--lib window`: 14 passed (including three existing Claude context
  tests matched by the filter). Five new Store tests compare complete projected
  detail/conversation against the original path, covering cold/warm Rows and
  held, metadata outside the window, Unicode user excerpts, cursors/empty turns,
  duplicates and missing IDs, Pending payloads, cache invalidation/corruption,
  rewrite/stream version races, journal replay and damaged-record fallback.
- Release `--test conversation_window`: 3 passed; the private browser-fixture
  export is intentionally ignored. Tests include original/search completeness
  and mailbox start/steer provenance outside the page.
- Release `--test record_rows`: 23 passed; the opt-in real-database-copy test is
  ignored because no daily database copy was supplied.
- All three benchmark shapes completed. Logs remain under this worktree's
  `target/t81/candidate-v5-{unit,integration,build,run}.log`; baseline logs and
  every unsuccessful attempt remain alongside them.

| Attempt | Job | Head | Outcome and correction |
| --- | --- | --- | --- |
| v1 | `538545f4-caef-4b69-bf5b-e887b1f037d7` | `1e8b045` | Compile error coercing a read guard to Connection; fixed the borrow. No tests ran. |
| v2 | `101762a9-67a3-4eff-afbd-fbbce4642d5c` | `1f8ba0f` | 12/13 units passed; duplicate-ID Pending hydration differed from the original path. Added a narrow compatibility fallback. |
| v3 | `9816d1fc-d1c1-4171-8239-ce72d121bbbf` | `5b138c1` | 13/14 units passed; test incorrectly expected Rows after Store::update retained a held record. |
| v4 | `94128281-b945-43cb-8129-7a54d4cc39bb` | `3f53d2e` | 13/14 units passed; reopening also updates/holds open records. Replaced the fixture with separate freshly inserted labs. |
| v5 | `69a88362-6518-42fe-b74c-5669849f439e` | `585d7c3` | All targeted tests and benchmarks passed. |

No earlier failed run reached integration or benchmark execution. Failures were
investigated before retrying. v3/v4 were fixture errors, not product changes.
Independent native review and exact PR CI remain separate delivery evidence;
this local record does not certify either. Agent-facing tools/workflows have
not changed, so no canonical skill update applies. This source candidate has
not been installed into the daily Core.

## Warm HTTP (ms)

| Shape / source | Latest baseline → candidate | Middle baseline → candidate | Direct baseline → candidate |
| --- | ---: | ---: | ---: |
| long / Rows | 57.777 → 17.136 | 49.618 → 16.314 | 50.808 → 16.287 |
| long / held | 26.621 → 9.398 | 26.817 → 8.986 | 26.313 → 8.951 |
| long4 / Rows | 241.026 → 62.271 | 227.192 → 58.451 | 247.580 → 57.830 |
| long4 / held | 127.154 → 33.272 | 119.739 → 33.156 | 118.653 → 33.422 |
| giant / Rows | 43.356 → 15.621 | 43.439 → 12.255 | 42.268 → 13.535 |
| giant / held | 24.705 → 7.792 | 22.793 → 5.711 | 24.308 → 8.229 |

## Warm Rows JSON reads (bytes)

| Shape | Baseline all JSON | Candidate complete metadata | Latest body / items | Middle body / items | Direct body / items |
| --- | ---: | ---: | ---: | ---: | ---: |
| long | 12,570,027 | 736,519 | 210,379 / 96 | 196,419 / 99 | 194,503 / 99 |
| long4 | 50,279,940 | 2,945,836 | 210,379 / 96 | 142,534 / 99 | 133,540 / 99 |
| giant | 13,538,525 | 755,045 | 1,161,509 / 97 | 143,007 / 98 | 163,636 / 99 |

All warm samples rebuilt zero cache entries. The latest body reads are identical
for long and long4; complete metadata grows by about four times. The giant latest
window reads the oversized item before previewing it. Its full HTTP response
may also exceed 256 KiB because the complete metadata is outside the body bound.

## First index build (one Store call per shape)

| Shape | ms | Item JSON read for build | Items built | Rust peak added bytes | Cache JSON bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| long | 70.874 | 12,531,638 | 6,198 | 22,131,344 | 698,130 |
| long4 | 333.368 | 50,126,393 | 24,789 | 87,138,974 | 2,792,289 |
| giant | 69.159 | 13,537,218 | 6,199 | 24,509,039 | 753,738 |

These single cold Store timings include index publication and selected bodies.
They are a separate cost, not directly comparable to a warm HTTP stage. Cache
JSON bytes exclude SQLite table/index overhead.

## Latest-window stage costs and allocation

| Shape / source | Baseline full client detail ms | Baseline projection ms | Candidate read + projection ms | Baseline HTTP Rust peak bytes | Candidate HTTP Rust peak bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| long / Rows | 39.099 | 8.704 | 13.492 | 31,388,668 | 7,083,694 |
| long / held | 18.045 | 6.817 | 5.973 | 31,071,070 | 6,468,991 |
| long4 / Rows | 174.018 | 60.568 | 55.206 | 124,011,850 | 26,775,004 |
| long4 / held | 80.509 | 42.300 | 28.767 | 122,714,476 | 24,306,154 |
| giant / Rows | 34.366 | 7.297 | 11.787 | 33,608,352 | 8,558,355 |
| giant / held | 15.515 | 6.198 | 4.748 | 31,523,996 | 6,922,523 |

The long4 baseline Rows SQL/decode medians were 58.621/81.105 ms. The baseline
held clone alone took 50.325 ms and added 117.91 MB of live Rust allocation.
Latest-window serialization was below 1 ms for every source/shape in both runs.
Detailed component timings, every sample and response size are in the JSON.

## Concurrent stream observation

A writer appends a small bounded delta about every 25 ms while nine latest-window
HTTP requests run. The stream phase ends when those requests finish.

| Shape | HTTP median ms, baseline → candidate | Writer count | Writer median ms | Writer max ms |
| --- | ---: | ---: | ---: | ---: |
| long | 26.924 → 9.286 | 9 → 4 | 3.153 → 6.653 | 13.642 → 8.499 |
| long4 | 124.093 → 33.765 | 24 → 10 | 13.074 → 11.233 | 61.398 → 16.389 |
| giant | 23.881 → 7.449 | 8 → 3 | 2.969 → 2.570 | 13.457 → 4.882 |

Faster HTTP shortens the observation and produces fewer writer samples. In the
long case the observed writer median increased, with only four candidate samples.
This is an exploratory interference check, not matched-duration throughput,
p95 latency or proof that all stream workloads improve. The held read lock is
still held while copying complete metadata and projecting the window.
