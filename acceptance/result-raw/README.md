# YN-234 B: a published result's JSON, made only when it is opened or copied

A result an Agent published with `result_publish` is read once per version and kept: up to 200 versions per window (`TurnResults.tsx`, `KEEP`).

## What the baseline did

The page kept a formatted copy of each kept read's JSON:
- `view()` made `JSON.stringify(spec, null, 2)` for every read that was drawn, and kept it beside the read;
- each card put that whole text into two React keys: the result boundary's and `ResultProvider`'s;
- the card's folded View JSON `<pre>` held it in the page, open or not.

## What it does now

The view holds a function that makes the text when it is called (`result-raw.ts`):
- **View JSON** makes it when the details open, once while they stay open, and lets it go when they fold again.
- **Copy** makes it for the copy.
- **Keys:** a card's key is its version's ID alone, since a published version never changes.
- **Error fallbacks:** the format note, load failure and render failure make it the same way when their details open.

The text is exactly `JSON.stringify(spec, null, 2)`, as before.

A table view the user set (filter, sort, selection) is still saved against the fingerprint of that text (`ResultProvider`, `view-storage.ts`). So the text is made once more only when a saved view is read back, or when a view is saved; only the fingerprint is kept.

A reply's own `yuzuno-ui` block is unchanged: its text as written, streamed or not, is drawn and keyed as before.

This is a mechanism check in Linux Chromium. It is not a Windows WebView2 memory measurement (see [What this cannot show](#what-this-cannot-show)).

## Fixed setup (the 2026-11-26 run, Job 42671408)

| Part | Value |
| --- | --- |
| Baseline | `1a62182302041c11db617d6c9046435670a700de` (the dispatched `main`) |
| Candidate | `0d6b4b29cf6009ea1373a4ff3f080d70ea1fb051` |
| Builds | `vite build` of each commit's `web/` from `git archive`, the same `node_modules` (same `package-lock.json`) |
| Browser | Chromium 153.0.8010.52 (Arch), headless, 1440×1000, reduced motion, a new browser for each run |
| Host | WSL2 6.18 on a 32-thread Ryzen 9 9950X3D2; the Job held 4 CPUs (fixed) and 4 GiB |
| API | every request answered by the script, no Core |

## Workload

- 20 Turns of one conversation, each with 3 published results: Core's limit per Turn (`RESULT_LIMITS.chainsPerTurn`).
- Each result is two 100-row, 8-column tables (the Table row and column limits) of Chinese and English text.
- Its compact JSON is 62,500–63,000 UTF-8 bytes, under the 64,000-byte limit (`MAX_SPEC_BYTES`); the formatted text is about 93,000 characters.
- 60 results in all.

## Phases of each run

| Phase | What happens |
| --- | --- |
| opened | the conversation opens at its latest Turns |
| scrolled | scrolled to the first Turn and back, so every result is read and drawn once |
| away | another Agent's conversation is shown instead |
| back | this one again |

At each phase:
- **formatted copies made:** the page's `JSON.stringify` with an indent of 2, given a spec, counted from page start;
- **JSON text in the page:** in the `<pre>`s of the cards drawn;
- **JS heap:** after two forced garbage collections (CDP);
- **renderer private memory:** `/proc/<pid>/smaps_rollup` Private_Clean + Private_Dirty.

Then:
- **View JSON** on the last card drawn, timed from the click to the frame after its JSON shows;
- **Copy**, compared with `JSON.stringify(spec, null, 2)` made by the script.

`run.sh` also runs these checks:
- the typecheck of the candidate;
- `web/tools/turn-results-ui.test.mjs`, red on the baseline and green on the candidate;
- the existing tests of results, the Brief's tables and forms, on the candidate.

## Results

Median of 5 runs [min–max], baseline → candidate:

| Phase | Formatted copies made | JSON in the page's `<pre>`s | JS heap, MiB | Renderer private, MiB |
| --- | --- | --- | --- | --- |
| opened (3 cards drawn) | 12 → **0** | 281,358 chars → **0** | 27.0 [26.7–27.6] → 26.5 [25.9–28.1] | 143.7 [142.5–144.7] → 142.2 [139.4–144.6] |
| scrolled (all 60 read) | 51 [51–57] → **0** | 281,358 → **0** | 37.6 [37.0–39.4] → **34.4** [34.3–34.6] | 187.5 [183.5–192.4] → **172.2** [166.7–177.1] |
| away (no card drawn) | 51 → **0** | 0 → 0 | 24.9 [24.3–26.7] → 23.3 [23.3–24.4] | 131.1 [128.9–133.2] → **120.9** [117.5–123.0] |
| back | 51 → **0** | 281,358 → **0** | 37.4 [34.8–37.4] → 34.7 [32.1–34.8] | 185.2 [181.9–188.9] → **173.8** [167.6–174.6] |

The baseline made one formatted copy for each read it drew, which is fewer than 60: the scroll passes some Turns before their read comes back. It kept each of those copies for as long as the read was kept. The candidate made none in any phase.

Run by run (paired by order), the candidate's renderer private memory is lower by:
- 10.9–20.8 MiB after scrolling;
- 8.4–11.5 MiB with no card drawn;
- 7.7–18.4 MiB back on the conversation.

The JS heap is lower by 2.7–5.0 MiB after scrolling. When opened, with three cards drawn, both differences are within the runs' spread.

View JSON on a near-limit result:
- **Time:** 37.7 ms [36.3–39.1] → **58.8 ms** [55.2–65.3], from the click to the frame after the JSON shows. The candidate formats the text then: one copy per open.
- **Copy:** 93,786 characters, identical to `JSON.stringify(spec, null, 2)` in every run of both builds.

Tests:
- `turn-results-ui.test.mjs` fails on the baseline: a `<pre>` is already in a folded card; a formatted copy is made when the card is shown; a saved view is read back without a new copy.
- It passes on the candidate (9/9).
- The candidate typechecks.
- `intelligent-ui-states-ui`, `intelligent-ui-stream-ui`, `intelligent-ui-storage`, `intelligent-ui`, `form-answer-ui`, `clarification-ui`, `task-status-ui`, `brief-render` and `home-report-ui` pass on it.

The 2026-11-26 run's `result-raw.json` has sha256 `3937c513d211391eeb9b54c183fcc3991386d56af7281fc2a8bf23ed29cc9d15`.

An earlier run (Job 45604721, at `a0a7f698`) used results of some 45,700 bytes, because the two 100-row tables stopped at the row limit first. It showed the same pattern:
- private memory after scrolling 184.7 → 171.4 MiB;
- View JSON 33.8 → 52.8 ms;
- copies identical.

## What this cannot show

- **Not Windows WebView2 memory.** These are Linux headless Chromium figures. Private memory there is not the Windows private working set or commit that R-40 measured. The only Windows available is the user's daily PC, which runs the daily client and the R-40 monitoring, so no Windows run was made.
- **It does not subtract R-40.** R-40's natural hour is a historical record, not this workload.
- **The saving scales with what was read.** It grows with the results a window has read and drawn, at most the 200 versions kept. A conversation with few or small published results saves little.
- **Costs that remain or are added:**
  - opening View JSON now formats the text then: a few tens of ms for a near-limit result, measured above;
  - a card with a saved table view formats it once more when that view is read back.
- **Find in page no longer sees the JSON of folded cards.** Folded View JSON no longer holds the text, so the browser's find in page no longer finds text in it.

## Run it

```sh
# in a managed Job (4 CPUs fixed, 4 GiB, no swap: the JSDOM tests refuse more)
RAW_HEAD=<commit> bash acceptance/result-raw/run.sh     # RAW_REPS=5 by default
```

It writes the following to `results/yn234/result-raw/`, with their `SHA256SUMS`:
- `result-raw.json` (every run, every phase and the summary);
- the build, typecheck and test logs;
- `tests.txt`.
