# T-67: answering questions without repeated history reads

The current-main baseline still spent time in Core after the browser showed
submission feedback. Two bounded changes reduce that work: locate native Pending
owners through the existing Brief projection, and read already-recorded completion
IDs once per history reconciliation. The responder still revalidates the request
under its original locks. Missing completion records still use the existing atomic
deduplication path. No frontend, send protocol, durability or acceptance rule changed.

## Measured versions and setup

- Product baseline: `cda2392ac26458535b4a048d958be9cdf4c9c70d`, including T-77.
- Baseline driver: `4a883e30b49b235bac5d6be4bd6bb7bc41263e03` (product sources equal baseline).
- Measured fix: `cc4ef9d541304866bb2defd15c8be9bf31c2ea1e`.
- Correctness checks: `bb8f22fcb5283f627d95e20015c614270d09ec30`.
  The only source change after the measured fix is a missing foreign-key parent
  in a new unit-test fixture. Production code and browser assets are identical.
- Both browser runs used a release Core and the same production frontend built
  from the baseline, with its file hashes checked. Asset manifest SHA-256:
  `179f1f8bbca00ad91b882fe576a18914b264daa8ce2be19b56c059dd5c781412`.
- Same Linux host, Chromium, 1440×1000, reduced motion, 20px font, two CPU quota,
  affinity 8,9, 4 GiB memory, zero swap, two Tokio workers. Native protocol mock
  and temporary SQLite only; no model calls, commands or real user answers.

Each run submits one native `requestUserInput` answer, one nonblocking async
question answer, and one published Clarification form. The short fixture has two
Turns and 8,340 serialized bytes. The long fixture has 157 Turns, 11,715,604 bytes,
and eight other Agents with similarly long histories. The third fixture adds
250ms before the mock acknowledges or resolves an answer.

## Results

Milliseconds, baseline → candidate, one sample per path and fixture. Full derived
stages are in [comparison.json](comparison.json), without answer bodies.

| Fixture / path | Click → response JSON | Core HTTP handler | Click → busy DOM |
| --- | ---: | ---: | ---: |
| Short / native | 29.3 → 15.7 | 1.98 → 1.13 | 3.9 → 3.4 |
| Short / async | 28.5 → 51.7 | 10.20 → 10.37 | 8.1 → 12.7 |
| Short / form | 29.4 → 19.9 | 14.12 → 7.88 | 9.0 → 5.8 |
| Long / native | 272.7 → 43.8 | 242.40 → 32.89 | 2.6 → 2.1 |
| Long / async | 722.3 → 260.0 | 686.36 → 240.85 | 13.0 → 9.5 |
| Long / form | 625.6 → 225.8 | 608.52 → 212.65 | 7.7 → 6.3 |
| Delayed / native | 12.3 → 10.8 | 0.99 → 0.72 | 2.0 → 2.8 |
| Delayed / async | 285.9 → 280.4 | 256.07 → 260.61 | 9.7 → 9.1 |
| Delayed / form | 281.3 → 279.6 | 263.28 → 260.92 | 7.0 → 8.3 |

The long fixture's final UI change also moved earlier: native Pending disappears
at 333.0 → 84.2ms; async accepted at 728.4 → 266.3ms; form accepted at
631.5 → 228.3ms. The baseline already had T-77's small conversation DOM (650–686
nodes in the long fixture) and prompt busy feedback. The remaining measured
delay was not a reason to redo conversation virtualization.

The old and new Store read paths were also compared once on the same completed
long fixture, after browser measurements. Lookup of an absent request across
all Agents took 114.56ms with complete detail reads versus 0.15ms through Brief.
Checking already-recorded historical completions took 291.45ms using one query
per Turn versus 5.93ms in one batch. Both contrasts assert unchanged journal
sequence. They support the cause without claiming these isolated times sum
exactly to end-to-end improvement.

The delayed fixture preserves truthful status: native HTTP returns after the
response is queued, then shows "Response sent. Waiting for the harness to
confirm." and keeps Pending until native resolution. Async/form remain pending
until the mock reply. Neither path waits for a generated model answer. Each
browser run has exactly three answer POSTs, one native send per answer and zero
browser errors. Short async browser timing varied even while its Core timing
stayed at about 10ms; this is not a claim that every scenario became faster.

Claude Clarification uses its existing start/append path, not Codex's full-history
`reconcile`; the Codex timing numbers do not describe Claude performance. The
shared Pending owner lookup also applies to Claude. Existing Claude tests verify
that queued does not mean read and that an unknown start is not confirmed or
resent. Actual Codex/Claude service and model latency were not measured.

## Correctness and execution evidence

All 76 targeted checks passed at `bb8f22f`: Store/collaboration Store (38), Claude
form receipt and permission-response cases (2), Codex session import (10),
conversation interactions (16), live events (4), remote/recovery (6).
Coverage includes concurrent recovery deduplication, imported and foreign-Agent
completion IDs, read marks across restart, request removal/closure/deletion and
streamed Brief rebuilding, repeat sends, lost replies, stale requests, exact
native no-active-turn fallback, and form source/receipt validation.

| Job | Outcome and retained evidence |
| --- | --- |
| `d6fb6615-ef4e-4915-892e-fd2185bbf027` | Baseline v1 failed compiling the diagnostic test's private `Workspace::detail` call; no timing sample. Corrected to public Store reads. |
| `8c7ee346-d2ea-4175-8e0a-3c9d82f46a94` | Baseline v2 passed; `target/t67/baseline-v2/`. |
| `5a120322-025d-4a16-b09e-530610e8f951` | Release browser measurement passed; subsequent tests were 37 pass/1 fixture failure, so the overall Job failed. `target/t67/candidate-v1/{comparison.json,raw-evidence.tar.gz,profile.log,tests.log}`. |
| `1c8a42c7-701b-484f-8152-77c353ffee4e` | Corrected fixture and all 76 checks passed; `target/t67/candidate-v2/{head.txt,tests.log}`. CPU 180.60s, wall 175.56s, recorded memory peak 4 GiB (the cap), exit 0. |

Terminal receipts and original raw files are retained beside those directories
in the isolated worktree. Candidate v2 uses the ordinary test profile for
correctness; it does not rerun or replace release performance evidence.

## Reproduction and limits

The opt-in ignored integration test `question_submit_profile` runs the production
router, frontend and isolated native mock. Build `web` production assets and set
`YUZUNO_UI_DIST` to that output, `T67_OUT` to a new absolute output directory, and
`YUZUNO_RESULT_VALIDATOR` to `runtimes/result-validator/validator.mjs`. It needs
Python 3, Node, the web Playwright dependency and Chromium (override its binary
with `YUZUNO_BROWSER_BIN`). Then run under an authorized resource-limited Job:

```sh
cargo test --release --locked -p yuzuno-workspace --test question_submit_profile -- --ignored --nocapture --test-threads=1
```

`baseline.sh`, `baseline-v2.sh`, `candidate-v1.sh` and `candidate-v2.sh` preserve
the exact local Job commands; their worktree/cache paths are host-specific.
`analyze.py` derives the compact report from completed output directories.
To reproduce the original baseline, use its fixed driver commit; the current
test also measures the new Store helpers after the browser run.

These are small controlled Linux samples, not p95/SLO or Windows measurements.
Browser routing adds shared measurement overhead. Two animation frames mark a
rendering opportunity, not proof of a painted frame. Journal timestamps mark
records, not separately timed fsync calls; native reply logs occur after stdout
emission. Existing protocol reconciliation and large native history payloads
still take time. No release, daily Core change, or Agent workflow change is
included; skill documentation changes are not applicable.
