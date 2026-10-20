# Global panel latency (T-68)

Opening Settings or Appearance over a long conversation previously caused
document-wide layout/style work during Radix focus and scroll-lock changes.
The candidate keeps the body's containing block and scrollbar custom property
stable, and isolates the application root beneath full-screen portal overlays.
Settings polling now lives in `WorkspaceUpdatesHost`; only reload-banner changes
notify `App`. `OutgoingMessages` skips unchanged props rather than rescanning
native message IDs on unrelated root updates.

## Fixed comparison

- Baseline: `b4640ad811c76dedff69383eb6c35c398782e094`.
- Candidate: the five product/test files identified in
  `target/t68/candidate-v1-assets.json`, with tracked web diff SHA-256
  `21157a685823ddfc9635b463aeb08cf7c53b3b6271501f896f66650fdfe7442c`.
  After measurement, only the `memo` import's location was moved to avoid an
  overlapping import added by T-65; the implementation is otherwise identical.
- Same masked agent fixture: 157 turns / 6,197 items versus its final two turns;
  22,933 versus 471 DOM nodes. Fixture SHA-256:
  `b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d`.
- Production builds with source maps; Chromium 153.0.8010.52, Node 26.11.1,
  1440 × 1000, light theme, 20px text, reduced motion, no CPU throttling.
- Durable Jobs use the shared heavy slot, 2 CPU, 3,072 MiB RAM, zero swap,
  2,048 MiB Node heap, 512 tasks, and bounded timeouts. Browser affinity is 8,9.

Times below measure click to visible, focused dialog plus two animation frames,
and Escape to removed dialog plus two frames. They are presentation-opportunity
proxies, not physical screen latency. Each cell is one bounded observation.

| History / action | Open before → after (ms) | Close before → after (ms) |
| --- | ---: | ---: |
| Long / Settings first | 248.1 → 53.8 | 415.2 → 101.5 |
| Long / Settings reopen | 220.9 → 42.9 | 419.0 → 90.0 |
| Long / Appearance | 208.4 → 80.6 | 459.6 → 52.6 |
| Long / Settings with 10 Hz stream | 279.0 → 92.4 | 399.0 → 63.4 |
| Short / Settings first | 57.0 → 111.4 | 51.5 → 43.6 |
| Short / Settings reopen | 99.7 → 78.6 | 50.8 → 36.1 |
| Short / Appearance | 58.7 → 106.5 | 46.6 → 41.1 |
| Short / Settings with 10 Hz stream | 100.1 → 114.3 | 47.3 → 32.7 |

Across the four long-history actions, trace opening Layout totals fell from
139–158ms to 1.5–6.1ms, and closing UpdateLayoutTree totals from 287–311ms to
6.4–9.9ms. Diagnostic variants had separated body style changes and pointer-event
inheritance; removing backdrop blur did not remove the expensive work. The
candidate retains the blur. Quiet Settings-held Script time was 8.3 → 6.4ms
over 1.9 seconds; streaming-held Script time did not improve.

## Verification and retained evidence

Baseline Job `611cc1e8-6cf7-4ee1-82c2-a0c5fbad2f95` and candidate Job
`dfa53c2e-a7be-442c-9c6a-06959e84b095` passed all eight profile cases without
unexpected API requests, writes, external traffic or page errors. The candidate
also passed 29 existing update/auto-read tests and 12 browser check groups.
The added browser check places a background button at an extreme z-index:
the portal overlay remains the hit target and dismissing it never clicks through.
Existing checks cover keyboard trapping, drafts, update/cancel/reconnect/reload,
and light/dark 20px layouts at desktop, short and narrow sizes.

Original reports, traces, CPU profiles, source/asset manifests, screenshots and
Job receipts remain under the owner's `target/t68/`; generated results and the
masked session fixture are intentionally not committed. `result.json` in this
acceptance folder is an ignored local comparison with report hashes.

The scripts preserve existing outputs rather than overwriting them. `baseline.sh`
requires the pinned clean baseline and the retained T-51 fixture/dependencies.
`candidate.sh` builds the first candidate, profiles it and runs focused/browser
checks. `sample.sh` requires explicit `T68_ASSETS` and `T68_OUT`; `profile.mjs`
supports `baseline` (eight cases) and `modal-diagnostic` (four isolated variants).
Run them only through the bounded Job and shared heavy-slot wrapper. The harness
serves loopback mock data and does not connect to the daily Core or user window.

## Limits

These are Linux headless Chromium samples, not Windows WebView2 or deployed UI
measurements. Short-history opening samples sometimes increased; no stable
short-history or statistical speedup is claimed. CPU/trace instrumentation adds
overhead. React instrumentation records root commit timestamps, not component
render counts. Synthetic GET responses and streams do not establish real Core
or network performance. Original published-result bodies were absent from the
masked fixture and receive identical small synthetic results in both builds.
All final synthetic stream deltas remained visible. Escape did not return focus
to the opener in either build; that existing behavior is recorded, not fixed here.
