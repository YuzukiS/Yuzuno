# Request pin and composer while a long conversation streams (T-34)

This is a bounded combination check for T-34 R2. It is not a before/after measurement series. T-18's figures in `acceptance/typing` stay as they are: they compare 0dc15cb builds, and nothing here is mixed into them.

## What runs

`lab.py` starts T-18's typing lab (`acceptance/typing/lab.py`) with these changes:
- port 4434;
- data under `target/t34/lab`;
- its own copy of the main checkout's release binary.

T-18's tools and data are not changed.

Fixture:
- "Long" has 80 finished Turns.
- There are two more Agents.
- All three stream 20 deltas/s through the fake runtime.

`combo.mjs` uses Chromium at 1440×900 on the T-34 UI build, at the default text size. It runs these checks.

**Holding Backspace, in each pin state** (hidden, shown, open). Backspace is held for 4 s over a 600-character draft. The windows check:
- deleted characters = delete input events = keydowns, and repeats = keydowns − 1;
- the pin's state is the same before and after;
- while the pin is hidden, the request stays where the reader left it;
- the stream keeps reaching the DOM;
- the composer keeps focus.

**The composer.**
- A press on the status line focuses the input, with the caret at the end.
- A press inside the text keeps the caret where it was pressed.
- A button in the box opens its dialog. A press on the dialog's overlay then leaves the draft and the selection (0–5) alone. This is the portal guard.
- Undo steps back to exactly the text before the typing, and before a held Backspace.
- The draft survives switching Agents.

## Result (the R1 fix rebased onto main e63a0a6, which has T-17 and T-18)

`status: passed`, no problems, no page errors.

| pin | deleted = keydowns | keys/s | long tasks | frame gap p95 | stream marks in DOM | request moved |
|---|---|---|---|---|---|---|
| hidden | 111 = 111 | 28.0 | 0 | 17 ms | 3,643 | 0 px |
| shown | 112 = 112 | 28.2 | 0 | 17 ms | 6,460 | follows the stream |
| open | 112 = 112 | 28.1 | 0 | 17 ms | 9,598 | follows the stream |

The same check on the fix at base effccee gave 109–111 deletions at 27.4–27.7 keys/s, also with 0 long tasks.

On an idle page this harness injects about 28 keydowns/s (T-18's `calibrate.mjs`), so these rates are at its ceiling.

Composer results:
- status-line press: caret 10/10;
- press inside the text: caret 1/10;
- after the overlay press: the draft is "first line" with the selection still [0, 5];
- undo of typed " and more": 9 steps back to "first line";
- undo of 5 Backspaces: 5 steps back to the full text;
- the draft is the same after an Agent switch.

## Found on the way (also on main effccee)

- **Back to latest can stop short while a stream grows fast.** `backToLatest` smooth-scrolls to the bottom as it was at the click. During that scroll, any scroll event more than 72 px from the bottom turns off following. When the scroll ends, the stream has grown, so the view stops a few hundred pixels short and stays there.
  - Three probes on each build, same lab: this build stopped short 1/3 times, and a main effccee build also 1/3.
  - So it is not from T-34. `combo.mjs` therefore scrolls to the end directly.
- **With Playwright-injected keys, each typed character is its own undo step.** This is the same on main effccee, and the press on the status line does not change it. The check asserts the end state, not the number of steps.

## Reproduction

```sh
(cd web && npx vite build --outDir ../target/t34/web/fix --emptyOutDir)
python3 acceptance/ui-refine/lab.py start target/t34/web/fix
node acceptance/ui-refine/combo.mjs        # report: target/t34/runs/combo.json
python3 acceptance/ui-refine/lab.py stop
```

Every step ran under a memory cap (`systemd-run --scope MemoryMax`, with a timeout). Browser runs also went through `heavy-slot.sh`.

## Limits

- The held key is simulated, as in T-18. A real keyboard's auto-repeat does not wait for the page.
- The conversation and runtimes are synthetic.
- The lab Core is the main checkout's release binary, not one built from this branch. T-34 changes no Rust.
