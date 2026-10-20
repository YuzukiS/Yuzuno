# T-79 — fourth user-directed UI batch

Evidence for the batch the user directed in Dev 5's session, before the
rebase onto main. Every run below went through Yuzuno Jobs on the worktree
`ui-refine-4` at HEAD 50d766c plus the then-uncommitted T-79 diff. Lab
outputs (builds, screenshots, logs) live beside this file and are not
committed.

## What changed

1. **Jobs dock flicker.** `useConversationCi` emptied its page on every
   refresh, and an empty dock gave back its room, so the conversation jumped
   left. Jobs and CI now keep the last answer per Agent.
2. **Appearance in Settings.** A new Settings category replaces the toolbar's
   palette button and its dialog. The narrowest toolbar keeps the Settings
   button, which the palette button used to be.
3. **Jobs redesign.** Settings-style source rail, rows grouped by what they
   need (Needs attention, Running and queued, Finished), the machine budget
   as meters, cards for details. Rows wear the left dock's status marks
   (`StatusMark`). Shared parts in `web/src/JobParts.tsx`.
4. **Sub-agents in the left dock.** `SubAgentDock` under jobs and runs, with a
   card beside the dock; the in-Turn block keeps only anchors. Entries are
   generic (`DockSubAgent`) so other harnesses can add theirs (T-26).
5. **Back to latest on the turn dock**, shown only near the dock.
6. **Latest-turn indicator** at the end of a short latest Turn.
7. **User additions:**
   - A press outside Jobs closes it in the desktop app. The toolbar's window
     drag took presses that React passed up from the portalled overlay.
   - Running jobs show their time so far in the dock.
   - The conversation column is centred in the whole pane between the docks.
8. **Request pin under T-77's window.** An original request outside the
   mounted window counted as scrolled past. It now counts as below when its
   loaded Turn is not mounted, or when it comes after everything in view or
   above within a mounted Turn.

## Checks

| Run (Job) | What | Result |
| --- | --- | --- |
| check-8 e3475381, check-9 968df622 | `jobs-panel-check` (new): rail, groups, live times, marks, budget meters, Actions, Reviews, dark, 390 px, outside press, centring | 9/9; jobs-ui 24/24, subagents 7/7, subagents-ui 5/5 |
| check-7 0c95d0d0 | `window-frame-check` with the drag taking the click; `turn-dock-latest-check` (new) | pass; 4/4 |
| frame-base f79912d2 | the same frame step on old base 50d766c | fails: the bug reproduced |
| check-14 eba13a6d, check-15 aef79e07 | updates-ui, ui, updates-browser | 25/25, 84/84, 12/12 |
| check-9 968df622 | ci-browser, ci-refresh-strict | pass |
| pin-lab-12 96b4212e | full `ui-refine-check` and `pin-window-check` (new) on T-79 plus T-35's 423d075 | both pass |

`ui-refine-check` needed updates for T-77's window: the request is placed with
the mouse wheel and its geometry checked before each pin assertion, far
items are scrolled into the window before use, live updates wait for the
Agent's answer rather than for text that is not mounted, and the dock is
measured after its glide. Its assertions are unchanged.

On T-79 without T-35, far Turns do not mount (T-35's bug), so the full check
and the pin check's last step cannot complete there; T-79 ships rebased on a
main that includes T-35.

`web/tools/appearance-check.mjs` targets the daily Core by default; do not run
it in Jobs.
