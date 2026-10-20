# Web CI: one type check; keep the test files serial

T-103 keeps the dedicated CI typecheck, then calls `npm run build:bundle`.
Local `npm run build` still checks types before running that same bundle and
standalone-preview command. The runner discovers every non-hidden
`web/tools/*.test.mjs`, runs each once, reports every failure and cleans up its
process group. Browser acceptance (`*-check.mjs`, `*-browser.mjs`) remains a
separate operation. Neither assertions nor product code changed in this task.

**Decision:** do not enable two test workers. The experiment fit in memory,
but neither parallel pass was green. The production runner has no two-worker
mode. Its single Node process retains the previous 2048 MiB old-space limit;
that is not an RSS limit, so local suites still need a 3 GiB, zero-swap Job.

## Build contract

Job `b06293d1-0f14-4f13-9fa0-4eb116e7ad08`, source
`174dbcfe04dd81e4a7e1c7fa55bd37c66857453b`, used a disposable copy of Web,
identical dependencies, 2 CPU / 3 GiB / no swap and the shared heavy slot.
A Node preload recorded actual TypeScript and Vite entry-point executions.
Each case began without `tsbuildinfo`; the OS page cache was not cleared.

| Invocation | Observed entry points | Seconds | Outcome |
| --- | --- | ---: | --- |
| Old CI: typecheck, old build command | tsc, tsc, vite | 17.33 | Passed |
| New CI: typecheck, build:bundle | tsc, vite | 9.44 | Passed |
| Local build | tsc, vite | 8.95 | Passed |
| New CI with an injected TypeScript error | tsc | 7.19 | Exit 1; Vite did not start |
| Local build with that error | tsc | 7.22 | Exit 1; Vite did not start |

All 69 output files, including the standalone preview and licenses, had
identical SHA-256 hashes in the three successful cases. This is one sequential
measurement, not a promise of a fixed CI time saving. Installation and queue
wait are outside these timings. Job queue wait was 468.4 s; worker time was
106.3 s, including the separate `updates-ui` check below.

The original collector scripts and output are retained under the task
worktree's `target/t103/`: `check_build.py`, `time.py`,
`build-contract/results.json` (hashes and entry-point traces), and the per-case
logs. The Job records the explicit input hashes and frozen Git head.

## Resource/isolation audit before concurrency

The first serial audit, Job `4c09ac54-efa6-4872-9ee9-423330673740`, used
`18f69ed9e91335629d8609e4f9a8e2a028b018aa`, before T-102 was merged. It inspected
75 files: temporary writes used `mkdtemp` directories; application bundles
were read-only. Eight whole-application fixtures were reserved for exclusive
execution. The validator spawns another Node process and was also kept alone.
All other files had sampled aggregate session RSS below 1 GiB. `ui.test`
reached about 1.68 GiB; the Job's kernel cgroup peak was about 2.05 GiB.
The proposed overlapping workers each had a 768 MiB V8 old-space cap, leaving
room for native bundlers and child processes within the total 3 GiB budget.

That audit was **not** a passing full suite: 74 files passed, while
`updates-ui` rejected the omitted `YUZUNO_UI_DIST` before its assertions ran.
With the isolated path supplied, the latter passed in Job `b06293d1` (55.71 s).
The first attempted collector, Job `fbca88aa`, had exited before any tests
because `/usr/bin/time` was unavailable; the replacement used Python `wait4`
and 50 ms `/proc`/cgroup sampling. Build-contract Job `065c800b` also exited
before building because its copy helper incorrectly assumed `web/public`
existed. These setup failures are retained, not reported as test passes.

Session RSS sums can double-count shared pages and sampling can miss short
peaks. Cgroup memory includes page cache; it is not process RSS. No memory
limit, runner service or swap setting was enlarged.

## Final-source ABBA comparison

Job `a5ed9db8-0053-4f4e-985b-1b9d3fa6aae8` used the fixed candidate
`0e879a6b13b04e934949cff491c572b891ba0cb5`, which includes actual main
`ac5795558b4c9992c94b27f41088ae500edc148c`: merged T-102 waits and T-31 remote
images. Web source and test files matched that main exactly. There were 76
files; the newly discovered `job-gpu-ui` also ran alone. The experimental
scheduler and its 66-file audit list are retained in that candidate commit's
history, not in the production runner.

One Job built once, then ran serial / parallel / parallel / serial in that
order, under the same 2 CPU / 3 GiB / zero-swap cgroup and heavy slot. Both
modes used identical per-file heap caps and the same dependencies and build.
The serial experiment therefore isolates scheduling; it is not a timing of
the old Bash runner's uniform 2 GiB heaps. Each process started fresh, but
OS caches were left intact. A CPU quota is not a reservation of physical
cores; other work on the host was not stopped.

| Pass | Files passed/run | Execution seconds | Files/s (includes failures) | Sampled cgroup peak (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Serial 1 | 76/76 | 215.68 | 0.352 | 1584 |
| Parallel 1 | 75/76 | 189.02 | 0.402 | 1441 |
| Parallel 2 | 74/76 | 197.54 | 0.385 | 1294 |
| Serial 2 | 76/76 | 264.93 | 0.287 | 1470 |

All four passes executed the exact same 76-file set, without retries or
skips. The reported throughput counts failed files too; it is **not** a
successful-suite throughput gain. Serial results also varied substantially.
No reliable production speedup is claimed, and it is not added to the
separate typecheck saving above.

- Both parallel passes failed test 2 in `output-on-demand-ui.test.mjs`.
  One observed the tail instead of the fetched full output (line 169);
  the other attempted `querySelectorAll` on null (lines 80/167).
- Parallel 2 also failed `updates-ui.test.mjs` test 5 at line 455:
  `the full draft storage is reported`. That file was already exclusive,
  so these results alone do not prove concurrency caused every failure.
- `job-gpu-ui` passed all four times; a separately reported main-CI race in
  that file was not observed here.
- The overall Job correctly failed. No test was rerun after its failure;
  ABBA was the fixed, predeclared experiment, not retry-to-green behavior.

Queue wait: 0.47 s. Typecheck: 7.99 s; bundle: 3.31 s; these are excluded from
the table. Kernel cgroup high-water mark for the entire Job: 1,660,903,424 bytes
(about 1.55 GiB). Memory `max`, `oom` and `oom_kill` events were all zero;
at worker exit only the worker remained, with no background test processes.
Per-pass peaks are 50 ms samples, not reset kernel high-water marks.

Original scripts, full per-file logs, serial per-file memory samples and
execution-set checks remain in the task worktree:
`target/t103/compare.py`, `target/t103/comparison/results.json` and
`{serial-1,parallel-1,parallel-2,serial-2}.log` in that directory. The Job
registers these outputs and its guarded source/input hashes. The checked
source was unchanged before/after the experiment.

## Targeted checks for the delivered serial runner

Run the small process-fixture checks with:

```sh
python3 -m unittest discover --start-directory .github/scripts --pattern test_web_tests.py --verbose
```

They cover file discovery and excluded browser/hidden files, complete grouped
stdout/stderr including a missing final newline, a failing `projects-ui`
being attempted only once, later files still running, explicit filenames with
spaces, signal/timeout failure propagation, cancellation with a child that
ignores SIGTERM, cleanup after a successful parent leaves a child, invalid
configuration and empty discovery. Parallel mode is rejected explicitly.

Job `51fc1369-4e14-417f-8aa1-4a8b1b73bad8` verified the delivered serial runner
at `26dc721afd358371cfa8d4328e47fa01c65f2d6d`, with its uniform 2048 MiB heap
cap, under the same 2 CPU / 3 GiB / no-swap limit. All 35 CI script tests and
all 76 Web test files passed without retries. Script checks took 2.51 s,
typecheck 7.70 s, bundle 3.26 s, and the Web suite 219.27 s. Queue wait was
0.59 s; worker time was 232.93 s. Kernel cgroup memory peak was 1,432,592,384
bytes (about 1.33 GiB), and only the worker remained at exit. Tracked source
was unchanged before/after; logs and timings are in `target/t103/final-serial/`.
This is local runner validation before integrating subsequent main changes;
the final integrated candidate receives its own exact-head CI.

Full Web validation remains `npm run typecheck`, `npm run build:bundle`, then
`.github/scripts/web-tests.sh`, inside an isolated checkout/Job. Local runs
must set `YUZUNO_UI_DIST` to that checkout's build. Do not point these commands
at the daily application build. Exact PR-head CI and independent review are
reported separately on T-103; this note does not assert a merge or release.
