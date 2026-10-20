# Holding Backspace stays fluid while a long conversation streams (T-18)

The user reported that holding Backspace in the message box (and typing quickly in general) slowed the whole interface down: characters were deleted slowly and conversation updates lagged.

## Cause (measured)

The time did not go into React. It went into Chromium's **style recalculation**. One rule in `web/src/resizable-panels.css` showed the resize cursor while a panel was dragged:

```css
.app:has(.panel-resize-handle.is-resizing),
.app:has(.panel-resize-handle.is-resizing) * { cursor: col-resize !important; user-select: none !important; }
```

Chromium re-checks a `:has()` whenever a change inside its subject might affect it, and the trailing `*` makes such a check invalidate **every element of the app**. That happened on every keystroke and every streamed paragraph. A trace of 3 s of held Backspace (`trace.mjs`, `trace_detail.py`) shows:
- 122 style recalculations averaging 1,133 elements each (max 6,144);
- every one caused by the invalidation set of that selector (`allDescendantsMightBeInvalid`);
- 2,695 detach/re-attach pairs of the long conversation's `<details>` content.

React itself was not the problem: the conversation's Turns are already memoized and did not re-render on keystrokes. Each App render costs about 3 ms of script per keystroke (`--attribution`), and saving the draft about 0.07 ms.

## Change

- **`resizable-panels.css`:** the same cursor and no-selection rule now keys off a root class, `:root.is-resizing-panels`.
- **`ResizablePanels.tsx`:** the dragged handle sets that class while dragging and removes it when the drag ends, including on blur or when the panel hides. The page is re-styled once when a drag starts and once when it ends, never per keystroke.
- **`web/tools/style-invalidation.test.mjs`** (runs in CI): fails if any stylesheet again has a `:has()` rule that reaches every descendant.
- **`web/tools/panel-resize-check.mjs`:** now also asserts the resize cursor and no-selection during a drag, and that both are gone afterwards.

Nothing else changed: no deferred input, no slower updates, no change to drafts, the composer or SSE.

## Results

**Setup:**
- An isolated Core on port 4416 (a copy of the main release binary), with data under `target/t18`.
- A conversation of 80 finished Turns with Markdown, tables, code and tool output, plus two more Agents.
- All three Agents stream 20 deltas/s during the measurement, the open one included.
- Chromium 1440×900 at the default text size, the same for every run. Production builds, unminified (`build-web.sh`).

**Windows** (`profile.mjs`):
- idle for 10 s;
- typing 180 characters, 60 ms apart;
- holding Backspace for 10 s (repeated keydowns, `repeat=true`) over a 1,500-character draft;
- a real 20,020-character Ctrl+V paste.

Each run checks that what happened matches the input: deleted characters equal delete input events and keydowns, typed and pasted lengths match, and exactly one paste event fires. The streams must be flowing, or the run fails.

Two streaming pairs, each before → after:

| | run | idle | typing | held Backspace | paste |
|---|---|---|---|---|---|
| keys reaching the page | 1 | – | 8.1/s → 14.6/s (22.4 s → 12.4 s for 180 chars) | **11.8/s → 23.5/s** (117 → 234 deleted) | – |
| | 2 | – | 8.8/s → 15.0/s | **11.6/s → 25.2/s** (115 → 251 deleted) | – |
| style recalculation (ms) | 1 | 3,030 → 163 | 11,926 → 290 | 5,942 → 284 | 1,190 → 116 |
| | 2 | 2,656 → 172 | 10,551 → 255 | 5,973 → 278 | 1,254 → 89 |
| long tasks (count / ms) | 1 | 21 / 1,477 → 2 / 112 | 71 / 4,968 → 2 / 169 | 25 / 1,572 → 3 / 367 | 5 / 362 → 1 / 61 |
| | 2 | 16 / 926 → 0 | 45 / 2,734 → 0 | 39 / 2,385 → 0 | 9 / 538 → 0 |
| frame gap p95 / max (ms) | 2 | 33 / 50 → 17 / 17 | 50 / 100 → 17 / 17 | 83 / 133 → 17 / 33 | 50 / 83 → 17 / 17 |
| key events ≥16 ms, p95 (ms) | 2 | – | 80 → 32 | 104 → 32 | – |
| runtime emit → text in DOM, p95 (ms) | 2 | 138 → 109 | 206 → 117 | 245 → 124 | 152 → 115 |

A pair without streaming, after a lab restart had left the streams stopped, shows the same effect from keystrokes alone: held Backspace 12.2/s → 25.1/s, style 5.1 s → 0.2 s, long tasks 28 → 0.

Metric notes:
- "Text in DOM" is a mutation record, not a paint.
- The open Agent's SSE callback → DOM step stayed at p95 ~105–155 ms → ~105–117 ms.
- Runtime and page timestamps share this machine's clock.
- Event Timing only reports events of 16 ms or more, so no slow events means none were that slow, not 0 ms.

**Behavior with the fix** (`behaviors.mjs`, while streaming), all passing:
- Chinese IME composition commits into the draft;
- select-all plus one Backspace clears it;
- each Agent keeps its own draft across switching and a reload;
- Enter sends and clears only that draft.

**Also verified** after rebasing onto `main` `6714dd9`, which includes T-14:
- the CI web job locally: typecheck, build, all 25 web test files, T-14's conversation-time tests included;
- `panel-resize-check.mjs`, 20 checks.

The measurements above were taken on the same change applied to `0dc15cb`. The rebase changes neither the CSS nor the resize handle.

All builds, tests and browser runs ran under a memory cap (`systemd-run --scope MemoryMax` with a timeout). Peaks: about 0.9 GB for builds, 0.6 GB for browser runs.

## Limits

- **Measured against the harness, not a real keyboard.** The held key is simulated: each repeat keydown is injected only after the previous one was dispatched, so a busy page lowers the achieved rate. That is what the rate measures. On an idle page the loop injects about 28 keydowns/s (`calibrate.mjs`), so ~25/s is near this harness's ceiling. A real keyboard's auto-repeat is independent of the page.
- **Each keystroke still re-renders the App** (rail, inspector, about 10 closed dialogs), about 3 ms of script. Moving the draft out of App would remove that. It wasn't needed here and would touch App code other open tasks are changing.
- **Animations still re-style their few elements every frame** (the working dot, the yuzu), about 5 elements per recalculation.
- **Synthetic conversation and runtimes.** Real conversations differ in size and content; the cost removed scaled with the size of the whole app's DOM.

## Reproduction

```sh
acceptance/typing/build-web.sh base            # an unminified UI build into target/t18/web/base
python3 acceptance/typing/lab.py start target/t18/web/base   # fresh fixture; Core left running on 4416
node acceptance/typing/profile.mjs base        # or --attribution for render counts
node acceptance/typing/trace.mjs base && python3 acceptance/typing/trace_detail.py target/t18/traces/base.json
node acceptance/typing/behaviors.mjs
python3 acceptance/typing/summary.py base fix  # side by side
python3 acceptance/typing/lab.py stop
```

Use a fresh fixture (`lab.py start`) for every build compared. The lab runtime does not report finished Turns natively, so a Core restarted mid-stream leaves Turns running. Run each step in a memory-capped scope, through the heavy slot.
