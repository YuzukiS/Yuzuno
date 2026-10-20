# T-36 acceptance: replies stay readable when an interactive result cannot be shown

T-36 is front-end only. The checks run in headless Chromium against an isolated
production build (`dist/` here, never `web/dist`) with a mocked Core. No Core,
Agent or model was involved, and nothing was written but read receipts.

```
cd web
npx vite build --outDir ../acceptance/ui-recovery/dist --emptyOutDir
YUZUNO_UI_DIST=../acceptance/ui-recovery/dist node ../acceptance/ui-recovery/browser.mjs        # T-36, 28 checks (+1 with the private samples)
YUZUNO_UI_DIST=../acceptance/ui-recovery/dist node --experimental-strip-types tools/intelligent-ui-check.mjs   # T-8, 17 checks
```

Run each inside `target/heavy-slot.sh systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 timeout …`.

`samples/`, `dist/`, `screenshots/` and the result JSON are git-ignored and stay local.

`browser.mjs` needs no private data. Its untitled-Table reply is a built-in
fixture shaped like the real replies. When the private originals are in
`samples/daily-replies.json`, it also checks one of them.
- **No clean-checkout run yet:** every run so far had the private samples, so
  the default path without them can be read in the source but has no separate
  run receipt.
- **What `browser-result.json` records:** the run's source `HEAD`, whether
  `web/src` had uncommitted changes, and a hash of the `dist` it served. These
  identify the run. They do not prove which source the `dist` was built from.

## Real replies

On 2026-10-14, 14 replies in the daily data contained a `yuzuno-ui` block. They
were read through a read-only SQLite URI, and `samples/classify.mjs` sorted
them.
- **Before T-36:** 6 of the 14 failed, all for the same reason: a `Table`
  without `title`. Each of those replies then showed its whole JSON in place of
  the result.
- **After T-36:**
  - `Table.title` and `BarChart.title` are on an explicit display-default
    whitelist (`DISPLAY_DEFAULTS` in `spec.ts`), filled in only when the prop is
    absent. These replies now render, and the table is titled "Table".
  - An empty title, and every other missing prop (IDs, columns, rows, summary,
    Section title, sources, actions), is still rejected.

## What a reader sees

| Situation | Shown |
| --- | --- |
| Valid result | The result between the reply's Markdown; its JSON folded in the result |
| Block still being written (message not finished) | "Generating interactive result…", never partial JSON |
| Block never closed, and nothing more is coming (message finished, Turn stopped, or execution unconfirmed) | "…the reply stopped before it was complete", details folded |
| Invalid JSON, unknown component or field, broken structure | "…its format isn't valid", details folded |
| A second valid block | Only the first is shown; the rest is listed as kept below as JSON |
| Viewer chunk failed to load | "…viewer couldn't be loaded" with **Reload Yuzuno**, and **Try again** when the failure names the chunk |
| Viewer threw while rendering | "…couldn't be displayed", details folded, no retry |
| One part threw while rendering | "This part of the result couldn't be displayed." in its place; the rest shows |
| Reply only a preview (`_yuzunoTruncated.text`) with a result block | Its full text is read first ("Loading the full reply…"); it is never parsed cut off. A preview without one is never fetched, so a long history reads nothing extra |

"Details" shows the validator's `code`, `path` (e.g. `elements.table.type`)
and `reason`, the JSON exactly as sent, and **Copy result JSON**. The reply
text, Copy reply and Copy turn are never changed. No state sends a message or
asks the Agent for anything.

## Retry is a real request

Chromium keeps a failed dynamic import for its URL. Importing the same chunk
again made no network request at all; this was seen in this check before the
fix. React.lazy also keeps a rejected promise.

A retry therefore takes a new `lazy()` and imports the chunk that the failure
named (same origin, `.js` only) under `?retry=N`.
- **Proof:** in Chromium the aborted chunk was fetched a second time and the
  result rendered.
- **Reload is always offered (R1):** after an update the old chunk is gone for
  good, because the server answers its URL with `index.html` or 404, so Try
  again can only keep failing. **Reload Yuzuno** is the way to load the build
  the server now has. When the failure names no URL (WebKit's message has
  none), Reload is the only action.
- **No remount:** a component that loaded is never replaced, so results
  already shown do not remount.

## R1 fixes (2026-10-14)

- **B1:** every load failure now offers **Reload Yuzuno**, not only those that
  name no URL.
  - The browser check serves the old chunk as `index.html` (HTML) and as 404.
    In both cases Try again requested it again under `?retry=N` and still
    failed, while Reload stayed offered.
  - Reload was reached with Tab from Try again and pressed with Enter.
  - The check then served the same chunk (same `dist`, same hash) again, and
    after the reload the viewer loaded and showed the result.
  - **Not tested:** an old hash that stays gone while a second build with a new
    hash is served. That needs two builds, which this card does not set up.
  - The reply text and Copy reply were unchanged throughout.
- **Fences:** marked reads "``` yuzuno-ui" (spaces or a tab before the info
  string) as a yuzuno-ui fence. The closing check now matches both lines as
  marked does.
  - That includes not closing a fence that is followed by a tab, which marked
    does not close either.
  - The info string stays exactly `yuzuno-ui`; "yuzuno-ui extra" and
    "json yuzuno-ui" remain Markdown.

## Results (2026-10-14)

- **`browser.mjs`, last run on the R1 commit:** 29 of 29 checks passed, run with
  the private samples present. That is 28 default checks plus the optional
  private one; see `browser-result.json` for the run's identifiers.
  - Every reply stays readable while the viewer fails.
  - Format errors and unfinished blocks are local notes.
  - Ordinary code examples stay code.
  - Try again from the keyboard fetched the chunk again and rendered.
  - The real untitled Table renders.
  - Long output still expands, and Copy turn copies it whole. Copy reply is exact.
  - A streaming placeholder, then the result, then unfinished once the Turn stopped.
  - The same states after a reload and switching Agents.
  - Details open from the keyboard.
  - Light, dark, the 20 px setting and a 520 px window all fit.
  - Nothing was written, and there were no page errors.
- **`tools/intelligent-ui-check.mjs` (T-8, 17 checks):** passes. Its two
  fallback checks now expect a local note with the JSON folded.
- **Unit and UI tests:**
  - `tools/intelligent-ui.test.mjs`: 19, including fence spacing against marked.
  - `tools/intelligent-ui-states-ui.test.mjs`: 11.
    - The real `Turn` completion rule: item finished mid-Turn, interrupted,
      outcome unknown, runtime offline, waiting.
    - A chunk that never loads again keeps Reload with every real retry.
  - Six deliberate bugs were each caught: a fake retry, completion ignored, a
    preview parsed as is, details open, an extra default, and an unconfirmed
    runtime still counted as generating.

## Limits

- **Preview guard not exercised against Core.** Core never trims Agent messages
  today (`client_view::whole`), so the preview path was tested only in JSDOM.
  - It reads a reply in full only when the shown preview contains "yuzuno-ui".
    A head preview cut before its block stays a preview.
  - While it reads, the preview is shown as Markdown.
  - A full value that the item-payload cache would refetch as stale is not
    treated specially.
- **CSS recovery not tested.** The viewer chunk depends only on the loaded
  `index` chunk, and its CSS ships in the main bundle. Recovering the CSS after a
  failure was therefore not tested and is not claimed.
