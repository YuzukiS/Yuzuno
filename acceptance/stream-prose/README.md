# YN-234: a long reply's appends, before and after ProseBlocks

Core streams an Agent's reply as `agent.delta` events. `detail-sync.ts` applies them in batches, one about every 100 ms, and each batch gives the reply's Prose its new text.

**Before**, each batch drew the whole reply again:
- marked read all of it;
- DOMPurify sanitized all of it;
- the conversation's HTML for it was replaced, and a selection in it was lost.

**Now**, an Agent's reply that is still being written when it is first shown goes to `web/src/prose-blocks.ts`. Blocks that more text can no longer change keep their nodes, and only the last ones are read and drawn again. What it shows at every step is exactly what Prose shows for the whole text.

This is a mechanism check in Linux Chromium. It is not a Windows WebView2 CPU measurement (see [What this cannot show](#what-this-cannot-show)).

## Fixed setup (the 2026-11-26 run, Job b6c952ce)

| Part | Value |
| --- | --- |
| Baseline | `9281e954794759598cb683d42a8ee7db6a9a7132` (the dispatched `main`) |
| Candidate | `5c5ddc5c86a45ea1afd35df7cd45d463849f0643` (this README adds nothing else) |
| Builds | `vite build` of each `web/`, from `git archive` of each commit under `.tmp/`, the same `node_modules` (same `package-lock.json`) |
| Browser | Chromium 153.0.8010.52 (Arch), headless, GPU disabled, 1440×1000, motion as by default (words fade in), a new browser for each run |
| Host | WSL2 6.18 on a 32-thread Ryzen 9 9950X3D2; the Job held 4 CPUs (fixed) and 4 GiB |
| API | every request answered by the script, no Core |

## Workload

One Agent's conversation, its Turn running, its reply already some text long. Then 30 appends, each sent as `agent.delta` once the last one shows. The same inputs go to both builds (`inputs.mjs`):

| Reply | Already shown | Appended | What the appends write |
| --- | ---: | ---: | --- |
| `long-160` | 14,238 chars: 160 paragraphs of the earlier measurement's Chinese paragraph (bold, italic, a link, inline code) | 643 | more such paragraphs |
| `long-16` | 1,422 chars: 16 such paragraphs | 643 | the same |
| `mixed-14k` | 14,423 chars: headings, paragraphs, nested and ordered lists, tables, fenced code, quotes | 283 | a paragraph, a list, an ordered list, a table, a fence left open over several appends, a quote |
| `short` | 2 chars | 83 | a short reply of three paragraphs and a list |

Runs alternate baseline and candidate (ABBA): 5 runs per build and reply, 150 appends per build and reply in all.

## What is measured

- **Per append:** the renderer main thread's time (CDP `Performance.getMetrics` TaskDuration, also Script, Layout and RecalcStyle), from the send to two frames after the batch is shown. The window is 160 ms, the batch's own 100 ms wait included. Waiting is not main-thread time, but timers and animations in the same window are. So each run also times 5 windows of the same length with nothing sent ("idle").
- **Re-opening mid-stream:** away to another Agent and back while the reply is still being written, from the click to two frames after. The reply is drawn anew in both builds.
- **Probe run** (one per build and reply, not timed):
  - the prose's top-level nodes removed per append;
  - whether the first paragraph is the same element after the 30 appends;
  - a selection made in it;
  - its position on screen, the reader having scrolled up to it.
- **Final HTML:** at the end the reply completes and its Turn ends, as Core says so. The prose's HTML, without the spans of words still fading in, is compared across builds and runs, and with the same reply opened again (drawn whole).

`run.sh` also runs two checks:
- `web/tools/stream-prose-ui.test.mjs`, the CI regression test in the real app in JSDOM: red on the baseline, green on the candidate;
- `differential.mjs`, the candidate's own `prose-blocks.ts` and `prose-html.ts`, bundled by Vite as the app is, in a blank Chromium page. It streams the samples and 4,000 random documents of `web/tools/prose-blocks-corpus.mjs` and the four replies above, cut in many ways, and at every step compares the HTML with Prose's for the text so far.

## Results

Per append, main-thread time in ms over 150 appends per build (idle: the same window with nothing sent):

| Reply | Build | p50 | p90 | p95 | Script p50 | Layout p50 | Style p50 | Idle p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `long-160` | baseline | 50.6 | 63.4 | 66.2 | 21.9 | 4.9 | 8.8 | 8.3 |
| | candidate | **24.9** | **30.8** | **32.8** | 7.9 | 1.3 | 3.7 | 8.1 |
| `mixed-14k` | baseline | 65.5 | 78.2 | 87.2 | 28.8 | 8.4 | 11.9 | 4.5 |
| | candidate | **30.2** | **38.1** | **41.2** | 9.6 | 1.5 | 4.1 | 6.0 |
| `long-16` | baseline | 25.6 | 32.2 | 35.0 | 10.4 | 1.7 | 4.0 | 3.4 |
| | candidate | **21.6** | **25.4** | **28.2** | 7.7 | 1.1 | 3.3 | 3.4 |
| `short` | baseline | 18.5 | 22.7 | 25.0 | 7.4 | 1.1 | 2.6 | 3.4 |
| | candidate | 17.9 | 21.9 | 23.6 | 7.1 | 1.0 | 2.5 | 3.6 |

Run by run (paired by order), the candidate's median per append is lower by:
- 21.1–32.6 ms for `long-160`;
- 32.6–36.3 ms for `mixed-14k`;
- 1.5–8.2 ms for `long-16`;
- 0.1–1.3 ms for `short`.

The candidate's cost hardly grows with the reply: 21.6 ms at 16 paragraphs and 24.9 ms at 160, against 25.6 and 50.6 ms before. What is left is the rest of the batch, the same for both: the event, the detail, React's render of the conversation, the frames.

What else the runs show:

| | baseline | candidate |
| --- | --- | --- |
| top-level nodes replaced per append, p50 (`long-160` / `mixed-14k` / `long-16` / `short`) | 329 / 476 / 41 / 7 | 2 / 2 / 2 / 2 |
| first paragraph the same element after 30 appends (long replies) | no | yes |
| a word selected in it, after 30 appends | lost | still selected |
| its position on screen | unchanged | unchanged |
| re-opening mid-stream, p50 [min–max] ms, `long-160` | 95.8 [83.3–114.7] | 93.1 [79.7–115.4] |
| the same, `mixed-14k` | 96.6 [83.0–102.9] | 100.3 [90.6–106.4] |
| the same, `long-16` | 82.7 [66.5–97.8] | 63.8 [59.2–65.8] |
| the same, `short` | 61.8 [52.6–71.8] | 57.3 [49.9–62.8] |
| final HTML: the same in every run of both builds, and as when opened again | yes, all four replies | yes, all four replies |
| words still fading at the end (`long-160` / `mixed-14k` / `long-16` / `short`) | 4 / 2 / 4 / 1 | 4 / 2 / 4 / 1 |

Re-opening a reply mid-stream draws it from the start in both builds. Their ranges overlap for every reply, so no difference is shown there.

The checks:
- `stream-prose-ui.test.mjs`:
  - **fails** on the baseline (the first paragraph is not the same element);
  - passes on the candidate (all 3 tests).
- `differential.mjs`: 4,414 streams, 196,854 steps, 0 differences from Prose's HTML; finishing a reply drew nothing again in any of them.

## What this cannot show

- **Not Windows WebView2 CPU or RAM.** These are Linux headless Chromium figures with the GPU disabled. On the user's Windows client the absolute numbers will differ. The only Windows available here is the user's daily PC, which runs the daily client and the R-40 monitoring, so no Windows run was made.
- **It saves on long replies only.** The cost per append was the whole reply's; now it is about its last blocks'. A short reply, or the first blocks of any reply, cost what they did.
- **Some replies keep the old cost.**
  - Raw HTML, link reference definitions or a carriage return anywhere in a reply: it is read whole each time, as before.
  - One long list, or one long code block, is a single block. It is drawn again whole on each append while it is the last block.
  - A block is only settled before a line at the margin that is not a list item. Text that does not start such a line after an empty line (a list item, an indented block) stays open until one does.
- **Only an Agent's reply in the conversation.** Prose elsewhere (history, Home, the board, files) is drawn whole as before, and so is a reply first shown after it was complete.
- **The workload is synthetic.** Real replies mix more kinds of block, and a real conversation holds more Turns, which the rest of each batch also costs.

## Run it

```sh
# in a managed Job (4 CPUs fixed, 4 GiB, no swap: the JSDOM test refuses more);
# without TMPDIR under the worktree: Chromium's socket path must stay short
PROSE_HEAD=<commit> acceptance/stream-prose/run.sh      # PROSE_REPS=5 PROSE_DOCS=4000 by default
```

It writes the following to `results/yn234/stream-prose/`, with their `SHA256SUMS`:
- `stream-prose.json` (every run, the probe runs and the summary);
- `differential.json`;
- the build, test and profile logs;
- `tests.txt`.

The 2026-11-26 run's files have these sha256:
- `stream-prose.json`: `ffaae064cb757cda10d969a81e4e343e3469bde3c77af60b4538199d758c6640`;
- `differential.json`: `5fa969606f29fa77793bab543e38a474f53f3d1e60bd77e9779178e66fd15dc7`.
