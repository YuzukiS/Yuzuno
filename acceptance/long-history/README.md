# T-51 long-history mount comparison

The first job built an isolated baseline from
`39b0b6fe7479acbd0dd3e61e47f469198922573a` and reuses the T-46 masked fixture
(`b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d`).
The fixture stays local and ignored. No live Core or user window is accessed.

`acceptance/interaction-latency/profile.mjs LABEL --switch-only` requires
explicit `T46_WEB`, `T46_OUT`, `T46_FIXTURE_SHA256` and `T46_ASSET_MANIFEST`.
The manifest pins every built file to a SHA-256 and records the source SHA,
web tree, package lock and measurement script. It is checked before serving.
This mode measures only the first B→A switch, A→B and return to A, with draft
and loaded-turn isolation checks. It retains the existing CDP/DOM/renderer
instrumentation and trace categories; no typing, streaming or contention
matrix is run. The server uses an ephemeral loopback port and refuses writes.

Submit `baseline.sh` via Jobs on T-51, under the shared
`/home/developer/yuzuno-next/target/heavy-slot.sh`, with 2000 CPU millicores,
3072 MiB memory, zero swap, 300 seconds and a 2 GiB Node heap. Jobs manages the
cgroup; the script does not create another systemd scope. Use a short disk
`TMPDIR` at `/home/developer/yuzuno-next/target/t51-tmp`.
Reports, trace and assets live under the worktree's `target/t51`; declare
`baseline.json`, `baseline-trace.json`, and `baseline-assets.json` as outputs.
Wait for Core's terminal mailbox notification instead of polling the job.

Click-to-mounted-view plus two animation frames measures a paint opportunity,
not physical screen presentation. Wall time also includes automation and
instrumentation overhead. Script/Layout timings overlap with wall time.
These bounded Chromium fixture samples do not establish Windows deployment
performance or a statistical latency SLO. Candidate comparisons must retain
the same source base, fixture, browser, instrumentation and resource limits.

## Jobs browser process limit

The first job (`d97d0e1a-320d-4146-9f9d-403d3da18ce7`) built the assets, but
Chromium crashed before any measured phase. The kernel recorded a PID-controller
fork rejection in that job's cgroup; Jobs sets `TasksMax=128`. Peak memory was
908 MiB with no recorded OOM. Keep this failed report as
`target/t51/baseline-launch-failed.json` and its kernel excerpt as
`baseline-launch-kernel.log`; it is not a performance baseline.

The adjusted sample uses `sample.sh`, reusing those exact hashed assets and
restricting this process tree to CPUs 8 and 9 with `LP_NUM_THREADS=2`. Chromium
[uses Linux CPU affinity when sizing its processor count](https://chromium.googlesource.com/chromium/src/+/HEAD/base/system/sys_info_posix.cc),
and [Mesa documents the rendering-thread override](https://docs.mesa3d.org/envvars.html#envvar-LP_NUM_THREADS).
Both baseline and candidate must use this same configuration and `/usr/bin/node`.
No Jobs limit or daily process is changed. The report records Node/browser,
affinity, actual measurement-script hash and cgroup PID/memory events. The asset
manifest's script hash remains the one present when the assets were built.

The adjusted job (`b8da1913-3527-49ed-95a7-168c682b4ea4`) also failed before
any measured phase, at `Tracing.start`. Its report confirms affinity `8-9`,
Node `v26.11.1`, `LP_NUM_THREADS=2`, PID peak 128 and PID rejection events
increasing from 0 to 134. Memory max/oom/oom_kill events all stayed zero;
systemd recorded a 399 MiB peak. Chromium stderr contains 133 failed
`pthread_create` calls and a zygote fork failure. The executable reports
Chromium `153.0.8010.52` (Arch Linux); `/dev/shm` had 20 GiB free, and
Playwright already supplied `--disable-dev-shm-usage`.

Retained evidence: `baseline-2cpu.json`, `baseline-2cpu-job.json`,
`baseline-2cpu-job.log`, and `baseline-2cpu-kernel.log`. Neither failed attempt
is a performance baseline. Further parameter trials stopped pending T-53.

## Valid baseline and candidate preparation

T-53's frozen, isolated patched host completed the one replacement capture
with a finite 512-task limit. Its SHA-256 is
`fd024a323d2980da70423924cb190020049e34da139039ecc509642da7e0e9ce`.
The daily Core still has its original 128-task limit. Both valid paired samples
must use this exact host, CPUs 8–9, two CPUs, 3072 MiB memory, zero swap, a
300-second timeout, Node `v26.11.1`, Chromium `153.0.8010.52`, and the same
fixture and measurement script. No baseline rebuild or recapture is needed.

`target/t51/t53-baseline-512.json` and `t53-baseline-512-trace.json` retain the
successful baseline. The measurement-script SHA-256 is
`5f9687ec2adbabf74e9c342fe796bcd36ddd8c965cd72c987d8741e51f24398d`.
First switch took 1389.5 ms to mounted view plus two animation frames:
677.536 ms Script, 314.322 ms Layout, 68,677 DOM nodes, including 47,514 inside
closed tool groups. Return to the long conversation took 1249.3 ms. The PID
peak was 138, with rejection events unchanged at zero; A→B→A draft checks
passed, and there were no UI errors or write requests. This remains a bounded
Chromium sample, not evidence of deployed Windows performance.

`check.sh` builds candidate assets and runs the affected UI, output expansion,
and auto-read tests through ordinary Jobs. It freezes successful assets in
`target/t51/web-candidate`, records every asset hash in `candidate-assets.json`,
and records the product patch separately from the unchanged base HEAD. The
candidate browser captures reused T-53's frozen host, not the daily Core's
128-task limit.

## Candidate evidence

The candidate defers the rows of never-inspected, closed tool groups. Their
summary and counts remain present. First inspection retains the mounted rows,
including nested disclosure and expanded output state, for that mounted turn.
Original-source targets and pending file-approval targets mount immediately.
Inspecting history records its motion snapshot without replaying arrival
animations. This does not virtualize messages or discard loaded conversation
data; inspecting all groups can still grow DOM and memory.

Product patch SHA-256:
`1ee35308a977a20a1880f8a85f565bb4e057c7856314afe942c1bb1af484c5ee`.
Candidate asset manifest SHA-256:
`72820f82d61a4072ba131732822d99ed7f9e6c5399bbbc2b8140fad620094abe`.
The manifest records base HEAD separately from this product patch.

The build and 16 affected UI tests passed in Job
`9a198ff3-30a2-4da3-be97-08435e552477`. One payload test initially failed
because added disclosure waits exhausted its 400 ms wall-clock throttle.
Its corrected isolated clock checks no refetch at 399 ms and one at 400 ms.
Job `e49e80a7-e7b8-441b-b907-d5991ed45725` passed all six payload tests and
14 auto-read tests, reusing the verified successful build and UI evidence.
The original failed TAP is retained; it is not counted as a passing run.

The initial candidate sample reduced DOM and memory, but switching was slower
than the earlier baseline: first switch 1389.5 → 1642.9 ms, return
1249.3 → 2249.7 ms. Host CPU pressure also differed. Keep those results
in `comparison-first.json`, `candidate-512.json`, and its trace; do not select
only the subsequent faster samples.

Lead authorized one bounded follow-up, serial baseline → candidate → candidate
→ baseline, reusing the exact assets, fixture, profile, host and limits. All
four samples succeeded, with no UI errors, writes, PID rejections or remaining
owned units. The temporary development-work coordination was released as soon
as capture ended. That manual coordination approach was subsequently withdrawn;
future work uses the Jobs queue, not requests to pause other developers.

| Sample, in execution order | First switch (ms) | Return to long (ms) | First Script (ms) | First Layout (ms) | First heap (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline 1 | 2066.8 | 1634.8 | 1033.890 | 479.703 | 55.955 |
| Candidate 1 | 1949.2 | 1228.4 | 748.487 | 376.125 | 35.228 |
| Candidate 2 | 1332.9 | 1089.8 | 513.702 | 250.850 | 34.697 |
| Baseline 2 | 1724.3 | 3029.6 | 889.318 | 364.489 | 55.950 |

First-switch DOM consistently falls from 68,677 to 21,163 nodes (69.2% fewer),
including 47,514 to zero descendants inside unopened tool groups. First active
renderer RSS falls from 481,136–481,368 to 363,916–365,988 KiB. On returning,
heap falls from 133.741–134.016 to 68.388–68.587 MiB. These are sampled process
and heap values, not retained-memory or leak guarantees.

Switching-speed improvement remains unconfirmed: first-switch ranges overlap
(baseline 1724–2067 ms; candidate 1333–1949 ms), and host CPU pressure
`some avg10` remains 2.08–5.52 despite the coordinated window. Both candidate
return samples are faster, but the last baseline varies substantially. There
is no stable latency guarantee, statistical SLO or deployed Windows claim.
No additional performance batch was run after this bounded follow-up.

Full phase/pressure/memory evidence is in `target/t51/comparison-abba.json`;
each `abba-*.json` retains its original instrumentation and trace. Host receipts,
PID counters, logs and cleanup evidence are under
`target/t51-paired/<sample>/browser-run.json` and its adjacent attempt directory.

## Final source navigation and behavior checks

Real Chromium checks exposed a source-navigation problem that JSDOM did not:
the cited tool row mounted, but the native `::details-content` subtree was still
hidden when `scrollIntoView` and `focus` ran. Waiting two frames alone did not
fix it, and `getAnimations()` did not expose that pseudo-element transition.
The final implementation temporarily disables disclosure motion and makes
the ancestor's content visible during a source jump, then restores normal
manual disclosure motion. Selecting another Agent cancels the deferred focus
and removes the temporary attributes.

Job `757d745f-14bc-4285-8954-5c6cea3fc929` passed the final production build
and five focused checks: existing catch-up navigation and missing-source
fallback, deferred tool source mounting, cancellation on Agent change, and
pending file-approval target availability. Its asset manifest is
`target/t51/final-v3-assets.json`, SHA-256
`c240275646082fb2edef22bd723fc2e3639f20903d78c81185667655d8bc43bb`;
product patch SHA-256 is
`10ddcdd21e39d5f6c9207cfdf9b4845d2dc7cf67bdc08bb0382a8b67121d7d72`.
These final assets include the source-navigation fix added after the six
performance samples. They were behavior-tested, not performance-sampled.
The performance figures above apply only to the earlier pinned candidate.

`web/tools/tool-motion-check.mjs --history-only` passed all four final scenarios
in `target/t51/behavior-v5/report.json`: light/dark themes, 20 px text, and
1440/720 px widths. Checks cover native keyboard expansion, retained nested
disclosure state, reading anchor, no replayed arrival animation, draft and
A→B→A isolation, and turn navigation. At the wide width, the inspector's
source link also focuses the cited tool inside the reading pane and restores
the ordinary 300 ms opening transition. Narrow layouts hide that inspector;
the narrow cases cover history and keyboard navigation. Screenshots are beside
the report. There were no page errors or API writes.

The fixed isolated host's receipt is
`target/t51-behavior-host/history-v5/browser-run.json`: success, PID peak 131,
zero PID rejections, memory peak 461,139,968 bytes, and owned units empty.
The earlier nine live-motion, following-scroll, manual-disclosure, reduced-motion
and theme checks passed against the measured candidate before the added source
check failed; that full run remains recorded as failed in `behavior/report.json`.
The passing final history subset is recorded separately, not substituted into
the earlier report.

Failed source runs (`behavior-v2` through `behavior-v4`) and explicit diagnosis
reports (`source-diagnosis`, `source-detailed`, `source-css`) remain under
`target/t51`. Diagnosis runs intentionally fail and are not passing acceptance.
All their isolated host receipts retain cleanup evidence. The one-shot build
and sample scripts here describe the retained baseline/candidate snapshots;
do not overwrite them with the final source-navigation assets.

Independent review of `e0cec226` found that the new measurement branches
hid the composer locator from the existing `--acceptance` section. The
follow-up moves that locator into their enclosing scope; application code,
assets and recorded samples are unchanged. The measured script above remains
available at that commit and as `target/t51/measured-profile.mjs` with SHA-256
`5f9687ec2adbabf74e9c342fe796bcd36ddd8c965cd72c987d8741e51f24398d`.
The corrected script has a different hash and is not substituted for the
script recorded by those samples. Scope validation checks the reported
unbound references before/after without executing a new performance batch.
Job `9f18a72b-f746-4933-9cb2-da078c1a0caa` passed syntax and lexical-scope
validation: all ten composer references remain; four unbound references
become zero. Corrected profile SHA-256:
`d808127df60b9d4a0c2fc67632c439450531668f6e9929fdb87828f95a984f60`.

CI run `38816265515`, attempt 1, on `e0cec226` passed Core, bridge, Web
type checking and build, but failed two of the 44 Web test files. Their
collaboration-order and streamed-output cases read tool rows before inspecting
the initially closed group. The follow-up makes that interaction explicit,
asserts the closed rows are absent, and retains the original ordering,
authorship, copy, exactly-once output and fetch-count assertions. Job
`25366ed3-88f3-4807-b6d1-33b53226d5f5` ran both complete files: all 12 tests
passed, with PID peak 52, zero PID rejections and memory peak 1,022,357,504
bytes. Logs remain in `target/t51/ci-e0-web.log` and
`target/t51/ci-tool-inspection-tests.log`. This local result does not replace
CI on the final pushed commit; application assets and performance samples are
unchanged.
