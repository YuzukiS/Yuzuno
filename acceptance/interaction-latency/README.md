# T-46: long-history input latency

The first correction skips automatic-read visibility work when the rendered
conversation cannot be acknowledged, and checks scroll/end visibility before
searching the whole document for dialogs. Fresh dialog, focus, dwell, rendered
watermark and retry checks remain in place. No history is removed or deferred.

## Actual daily baseline, 2026-10-15

Read-only measurements used the running release, not the candidate branch:

- Core/UI `core-20261015-304db2d`, git
  `304db2dd06804bf1cc47000f0cd2517f95692b15`, version `2026.10.15-core.1`.
  JS `index-DWAd0KEJ.js`, CSS `index-C87OHU0j.css`.
- Windows shell PID 5016, `yuzuno-lab.exe` 0.1.2; WebView2
  155.0.4283.45, renderer PID 48332. No interaction with that window.
- Lead detail: 157 turns / 6,197 items / 12,640,226 HTTP bytes in the initial
  sample; 111 ms to headers, 64 ms remaining body, 175 ms total.
  The separate Python decode took 77 ms (not browser JSON timing).
- The later isolated browser switch fetched a slightly larger live snapshot:
  12,714,726 bytes, proxy upstream headers 124 ms, complete HTTP 211 ms.
  Browser fetch-to-headers 132 ms; headers-to-`response.json()` completion
  170 ms; click-to-mounted-view plus two animation frames 1,671 ms.
  Script 859 ms, Layout 151 ms, style recalculation 151 ms, about 70k DOM nodes.
  These nested/overlapping intervals must not be added together.
- During 45 Backspace presses: 748 ms scripting, including 510 ms in the
  automatic-read MutationObserver. The CPU profile's hottest JS self-time was
  `querySelectorAll`. Its callback repeatedly scanned for dialogs before
  checking whether there was unread work. Local 10-delta/s streaming similarly
  spent 375 of 387 script milliseconds in that observer.
- Concurrent short read-only samples: Core about 10.6% of one CPU; Windows
  renderer about 15.6% of one CPU, working set 1,078 MiB/private 803 MiB.
  Windows total CPU 28%, free physical memory about 5.5 GiB. WSL load roughly
  0.30/0.56/0.82 on 32 logical CPUs, about 31 GiB available memory. Existing
  swap allocation is not evidence of active swapping.

The earlier Lead sample under other-project activity (root
`target/performance-check-20261015`) had a smaller conversation and different
events: Lead HTTP 342 ms, renderer about 104–118% of one CPU. It is observational,
not a controlled estimate of the effect of host load.

## Controlled comparison

Baseline assets were built from main
`0a0a4fbb1989c45a97ae0a9314eeea16a710f791` before this change. Candidate assets
include only the `useAutoRead` correction. Both use Chromium 153.0.8010.52,
1440×1000, the same fixture, and the same instrumentation. The main comparison
must not be presented as a deployed Windows before/after result.
The review branch subsequently integrated main `aa901e3` (T-45) without changing
this hook patch. Final build/regression checks and CI cover the integrated
candidate; the timings above retain their original `0a0a4fb` measurement base.

The fixture preserves history structure and masks text fields; it is local and
ignored, not committed. Agent A has 157 turns / 6,197 items; B uses the final two
turns for switching. About 68k nodes remain mounted in both versions, including
about 47.5k nodes inside closed tool groups. Fixture SHA-256:
`b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d`.

Normal-affinity first pair (milliseconds unless indicated):

| Operation | Baseline | Candidate | Interpretation |
| --- | ---: | ---: | --- |
| 45 Backspaces, wall | 3116 | 2628 | 16% faster; includes 33 ms pauses and protocol overhead |
| 45 Backspaces, script | 1116 | 657 | 41% less scripting |
| Auto-read mutation callback during Backspaces | 490.5 | 0.8 | Expensive scan removed when unread count is zero |
| Backspace keydown p95 | 40 | 32 | Event Timing, 45/45 events, 8 ms quantization |
| 45 Backspaces during stream, wall | 3415 | 2847 | 17% faster |
| Stream + Backspace keydown p95 | 64 | 48 | Event Timing, 45/45 events |
| 2.5 s stream, script | 529 | 296 | 44% less scripting |
| Initial long-history switch | 1622 | 1763 | No initial-mount improvement claimed |
| Renderer RSS after stream + typing, MiB | 741 | 754 | No memory reduction claimed |

Quiet fixture has no incoming events and virtually no main-thread scripting in
either version. Total renderer CPU can still include raster/compositor work.
For operations with different durations, compare CPU seconds, not only CPU %.

Controlled CPU-affinity comparison, with both versions restricted to CPU 8:

| Condition / operation | Baseline wall ms | Candidate wall ms | Baseline script ms | Candidate script ms |
| --- | ---: | ---: | ---: | ---: |
| No added worker, 45 Backspaces | 3005 | 2552 | 1234 | 784 |
| No added worker, stream + 45 Backspaces | 3427 | 3101 | 1857 | 1292 |
| Bounded contention, 45 Backspaces | 3729 | 3026 | 1898 | 1164 |
| Bounded contention, stream + 45 Backspaces | 4820 | 3675 | 2828 | 1648 |

Observed CPU 8 occupancy rose from 70.5%/68.0% (baseline/candidate without
worker) to 87.7%/85.2% (with worker). Whole-host WSL utilization was 4.3–5.5%;
this is local scheduling contention, not an overloaded whole machine. Under
contention, stream+typing renderer CPU seconds fell from 3.24 to 2.27; keydown
p95 fell from 152 to 96 ms. Percentiles use nearest rank. The 2.5-second
stream-only phase used 834→533 ms
script and 1.39→1.18 renderer CPU seconds. Initial switch stayed costly,
2936→2851 ms; RSS was 736→742 MiB after stream+typing. Swap-out counters did
not advance within any paired run; candidate contention saw 63 swap-in pages,
so this is not evidence about behavior under substantial memory pressure.

All six fixture profiles completed without page errors or attempted HTTP
writes. The candidate contention run also passed both themes at 20 px, exact
first-turn keyboard navigation, all 157 loaded turns, independent drafts and
rapid A→B→A selection. Fourteen auto-read tests passed, including new guards
for zero-unread work and browsing away from the bottom, plus existing modal,
dwell, watermark, failures and switching coverage.
Ten existing live-detail tests passed for revisions, queued deltas and recovery.
Six focused App integration tests also passed: appearance, turn navigation,
draft/Agent isolation, modal auto-read suspension, loaded-history labels and
pending questions.

## Reproduction and evidence

Run from an isolated worktree with dependencies installed. Never replace daily
assets or restart the user's Core/window. The scripts save bounded local results
under that worktree's `target/t46/` (ignored). Raw conversation responses are not
saved; traces omit screenshots and network bodies. Only approved fixture
interactions occur, with all HTTP writes rejected by the local server.

1. `python3 acceptance/interaction-latency/sample.py` reads daily health,
   workspace, two details and a short SSE interval. It records release asset
   hashes and host/Core samples and produces the masked local fixture.
2. Run `windows-sample.ps1` in Windows PowerShell for a three-second read-only
   shell/renderer/host sample. It records process identities and versions, not
   full command lines. Save output as `target/t46/windows-sample.json`.
3. Build baseline UI in an isolated checkout and copy `web/dist` to
   `target/t46/web-base`. Build the candidate separately. Use the wrapper below
   for each build/browser/test phase. Do not run paired browser measurements
   concurrently.
4. `T46_WEB=/absolute/asset/directory node acceptance/interaction-latency/profile.mjs LABEL`
   runs switch, quiet, 45 Backspaces, scroll, stream and stream+typing. `--daily`
   instead proxies only the GET health/workspace/two-detail endpoints to the
   running Core, still in a separate browser. Other endpoints are stubbed;
   interactive-result bodies and a real remote model stream are not profiled.
5. `--acceptance` adds light/dark 20px, first-turn navigation, all-loaded-history,
   draft isolation and rapid A→B→A checks against the masked fixture.
6. For controlled host CPU contention, pin **only this acceptance command** to
   one CPU with `taskset -c 8`; compare the same baseline/candidate with and
   without `T46_CONTENTION=1`. This creates one owned, bounded worker with a
   50 ms busy / 50 ms sleep cycle on the same CPU. It stops at 90 seconds or
   runner cleanup. It does not pin, stop or modify any other project process.
   This tests one-core scheduling contention, not whole-machine saturation,
   Windows memory pressure or GPU contention. `/proc/stat` deltas record actual
   core occupancy; the duty cycle is not a guarantee of received CPU time.

Required wrapper (short TMPDIR avoids Chromium Unix-socket path limits):

```sh
/home/developer/yuzuno-next/target/heavy-slot.sh \
  systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 \
  timeout 180 env NODE_OPTIONS=--max-old-space-size=2048 \
  TMPDIR=/home/developer/yuzuno-next/target/t46-browser-tmp \
  T46_WEB=/absolute/worktree/web/dist \
  node acceptance/interaction-latency/profile.mjs fix-normal
```

Evidence files: `daily-sample.json`, `windows-sample.json`,
`daily-baseline.json`, `base-normal.json`, `fix-normal.json`, `base-pinned.json`,
`fix-pinned.json`, `base-contention.json`, `fix-contention.json`; browser runs
also save `*-trace.json` and logs. JSON has request bytes/timing, React commit
timestamps, CDP Script/Layout/style durations, Event Timing, long tasks,
observer callbacks, layout reads, renderer CPU/RSS/heap, and host swap/pressure.
Trace events also record paint durations. Instrumentation itself adds overhead;
paired runs use the same instrumentation. Two animation frames mean a paint
opportunity, not proof of physical display presentation.

## Limits and remaining work

- Running Core has no server-side queue/handler timing header. TTFB combines
  queueing, processing and loopback response setup; this run cannot separate
  them. Browser `response.json()` combines body delivery, decode/parse and
  scheduling. Python decode time is reported separately, never substituted.
- React commit times/counts locate updates, not React-only CPU cost. Linux
  Chromium traces do not prove identical behavior in Windows WebView2.
- Initial history download and all-history mounting remain substantial. This
  change neither reduces the payload nor virtualizes/caches history. Future
  mount optimization needs separate profiling and preservation of source
  links, search, history loading and scrolling behavior.
- This is a small number of bounded paired samples, not a statistical latency
  SLO or a claim that every source of the user's slowness is fixed. For another
  incident, repeat the read-only host/API sample alongside an isolated profile
  before choosing a second correction.
