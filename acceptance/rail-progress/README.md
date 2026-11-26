# YN-234 A: rail rows left alone when another Agent's progress arrives

Streamed progress reaches the rail in batches, at most every 250 ms (YN-199). Before this change each batch redrew every rail row: App built each row's handlers anew on every render, and `AgentRailRow` was not memoized. Now:
- `AgentRailRow` is `memo` with React's own comparison of each prop;
- App gives every row the same handlers on every render (`useSteadyActions`, and refs to the latest `openFromList` and `goHome`);
- `onSelect` takes the Agent's ID.

Progress for one Agent replaces only that Agent's entry (`applyProgress`), so every other row gets equal props and is skipped. A row still draws again for its own changes and for its own stores: Jobs, CI, waits, its PR, the minute clock and the language.

This is a mechanism check in Linux Chromium. It is not a Windows WebView2 CPU measurement (see [What this cannot show](#what-this-cannot-show)).

## Fixed setup (the 2026-11-26 run, Job c7ca4c7a)

| Part | Value |
| --- | --- |
| Baseline | `1a62182302041c11db617d6c9046435670a700de` (the dispatched `main`) |
| Candidate | `9b79d3101f3736f8e3860d2cf66435ea0510e936` |
| Builds | `vite build` of each `web/`, the same `node_modules` (same `package-lock.json`); the base is `git archive` under `.tmp/` |
| Browser | Chromium 153.0.8010.52 (Arch), headless, 1440×1000, reduced motion, a new browser for each run |
| Host | WSL2 6.18 on a 32-thread Ryzen 9 9950X3D2; the Job held 4 CPUs (fixed) and 4 GiB. Another 4-CPU Job of this task ran part of the time; runs alternate baseline/candidate (ABBA), so it is shared alike. |
| API | every request answered by the script, no Core |

## Workload

- **Entry:** the rail beside a Project's page, opened by its Home link (`#/home?w=…&p=p1`).
- **Rows:** 1 row, or 50 rows in two Projects (grouped, as Settings has it by default).
- **Loads:** quiet; one Agent streaming; or five at once.
- **Cadence:** each streaming Agent's `agent.progress` entry comes 250–310 ms after its last. Core sends one at most every 250 ms, and the same fixed jitter is used for every build. Each entry carries a new line of text.
- **Window:** 10 s per run, 5 runs per build and load.

## What is measured

- **Rows drawn:** a separate probe pass reads React's DevTools hook on each commit. A row counts as drawn when its fiber is new in that commit's tree and React marked it `PerformedWork`. It is the renderer's own count, not a counter in the product.
- **Main thread:** CDP `Performance.getMetrics` TaskDuration of the page's renderer main thread, in ms per second.
- **Process CPU:** the renderer and GPU processes, from `/proc`, as % of one core.
- **Progress delay:** from an entry's arrival to its text showing in its row (MutationObserver), and to the frame after.

`run.sh` also runs `web/tools/rail-rows-ui.test.mjs`, the CI regression test of the same count in the real app in JSDOM: red on the baseline, green on the candidate. It also runs the existing tests of the rail's rows on the candidate.

## Results

Rows drawn other than the streaming Agents' own, in one 10 s window:

| Load | Baseline | Candidate |
| --- | ---: | ---: |
| 50 rows, one streaming | 1,764 (49 rows × 36 batches) | 0 |
| 50 rows, five streaming | 1,620 (45 rows × 36 batches) | 0 |
| 1 row, quiet or streaming; 50 rows quiet | 0 | 0 |

Median of 5 runs [min–max]:

| Load | Renderer CPU, % of a core | Main thread, ms/s | Progress shown, p50 / p95 ms |
| --- | --- | --- | --- |
| 50 rows, one streaming | 6.80 [6.54–7.09] → **4.51** [4.42–4.69] | 35.8 [34.8–37.1] → **23.5** [23.3–24.0] | 259 / 261 → 255 / 257 |
| 50 rows, five streaming | 7.36 [7.09–7.64] → **5.43** [5.16–5.52] | 40.1 [39.7–41.3] → **29.0** [28.9–31.3] | 192 / 260 → 182 / 257 |
| 1 row, one streaming | 3.41 [3.31–3.51] → 3.31 [3.14–3.31] | 19.2 [18.4–19.5] → 18.9 [18.7–19.4] | 255 / 256 → 255 / 256 |
| 50 rows, quiet | 0.09 [0.09–0.18] → 0.18 [0.09–0.18] | 0.7 → 0.6 | no entries |
| 1 row, quiet | 0.09 → 0.09 | 0.6 → 0.6 | no entries |

Run by run (paired by order), the candidate's renderer CPU is lower by:
- 2.03–2.40 points with 50 rows and one Agent streaming;
- 1.76–2.12 points with five streaming.

With one row or a quiet list, the difference stays within the 0.09-point resolution of `/proc`'s clock ticks. The GPU process stays at 0.37–0.55% in every streaming case for both builds, and 0–0.18% when quiet.

The progress delay is the batch's own 250 ms wait plus a frame, and is unchanged. The candidate's shown time is not later than the baseline's at p50 or p95.

The behaviour checks (`rail-rows-ui.test.mjs`) pass on the candidate:
- selection marks only the two rows involved;
- needs-you status and the held shell call reach their row with the batch;
- language redraws every row;
- the attention order moves a waiting row up;
- a row's actions from the keyboard act on the selection as it is now, which a stale handler would get wrong.

The batching and hidden-page tests in `live-events-ui.test.mjs` pass unchanged.

## What this cannot show

- **Not Windows WebView2 CPU or RAM.** These are Linux headless Chromium figures, with an emulated GPU process and reduced motion. On the user's Windows client:
  - the absolute numbers will differ;
  - the ring animations are left running there (option C, not chosen).

  The only Windows available here is the user's daily PC, which runs the daily client and the R-40 monitoring, so no Windows run was made.
- **It does not subtract R-40.** R-40's natural hour is a historical record, not this workload.
- **A quiet rail saves nothing.** With no progress events nothing is drawn either way, so a window left idle (R-40's occluded time) saves nothing from this change.
- **Full list reads still redraw every row.** A read of the whole Agent list (`agent.changed`, a reset) gives every row a new entry, so every row is drawn as before; that path is not in scope.
- **The workload is synthetic.** A real rail's rows hold more (executors, PRs, waits), so each row drawn costs more or less than here.

## Run it

```sh
# in a managed Job (4 CPUs fixed, 4 GiB, no swap: the JSDOM tests refuse more)
acceptance/rail-progress/run.sh            # RAIL_REPS=5 RAIL_SECONDS=10 by default
```

It writes the following to `results/yn234/rail-progress/`, with their `SHA256SUMS`:
- `rail-progress.json` (every run, the probe pass and the summary);
- the build and test logs;
- `tests.txt`.

The 2026-11-26 run's `rail-progress.json` has sha256 `14b807cafcdc41ce2526c33b3ee6931998085c209131ed4f9745e4e878948bcc`.
