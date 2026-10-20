# T-25 acceptance: Claude's background tasks, and stopping one

Real Claude Code (2.1.280, Haiku) with the Agent SDK Yuzuno ships (0.3.296). Nothing touches the daily Core, its data or windows. Each run gets its own directory under `~/.t25`. Run them as Jobs; their local wrappers are `target/t25/probe.sh` and `target/t25/lab.sh`.

## `probe.mjs`: what the CLI reports, without Core

Two background shells (25 s and 50 s) run in one Haiku turn, with only those commands allowed.

- **What the CLI sends:**
  - Each shell is a `local_bash` task with `is_backgrounded: true`, its Bash call's `tool_use_id`, and an id such as `b4b36jo7p`.
  - There are no `run_id`s and no `task_progress` events for shells.
  - The live set (`background_tasks_changed`) changes as tasks start and end.
- **`stopTask` on the running 50 s shell:**
  - It resolved in 3 ms.
  - `task_updated` (`killed`) and `task_notification` (`stopped`) followed in the same millisecond.
- **`stopTask` also resolved for:** the already stopped task, the completed one, and an id that never existed. The acknowledgement proves nothing.
- **The 25 s shell:** it finished with `completed` and "exit code 0". Claude then started a Turn of its own about it.

Probe Job `f7e12cac` (commit f59f98d); frames in `target/t25/probe-r1/`.

## `lab.mjs`: the candidate Core, page and Claude together

This runs a Core built from the worktree on port 4495, the packaged runtime, the built UI and headless Chromium:

1. One turn starts three background shells (alpha 30 s, beta 120 s, delta exits 3), approved in the page. The dock's **Background tasks** group lists them.
2. Beta is stopped from its card: exactly one `POST …/tasks/<beta>/stop`, then `stopped` from Claude's own report. Alpha keeps running.
3. Delta ends `failed` ("failed with exit code 3"). Alpha completes by itself after the Turn ended, while Claude runs a Turn of its own, and lands on its own call. The dock shows each end.
4. The session goes on: a new prompt is answered.
5. Stopping an ended task or an unknown id is refused, and nothing is sent.
6. Gamma (300 s) runs, then Core restarts:
   - While Claude is not connected, gamma is "Not confirmed" and cannot be stopped.
   - After reconnecting, it is no longer running and cannot be stopped. The resumed CLI reported it `stopped`: "Background shell command didn't finish before the previous session ended".
7. There were no page errors, and the page made no task requests other than the one stop.

### Results (2026-10-17)

| Run | Job | Commit | Result |
|---|---|---|---|
| r1 | `b5810288` | 0ac8c82 | Refused at the wrapper's HEAD check: the expected SHA was mistyped. No build, no model use. |
| r2 | `ff626351` | 0ac8c82 | Steps 1–3 passed. Step 4 took a Turn Claude started on its own for the prompt's reply (lab fix a8a72a5). |
| r3 | `8ceb3756` | a8a72a5 | Haiku described the shells in its own words, so a selector by command text failed. This also showed the card displayed the description, not the command (product fix dd8cc24). |
| r4 | `d162e4a6` | dd8cc24 | Steps 1–6 up to the reconnect passed. The lab expected only "unknown" after reconnecting, but the resumed CLI reported the task stopped (lab fix c242da2). |
| r5 | `2f74abaf` | c242da2 | **13/13 passed.** |

**Found in r4 and r5:** gamma's own shell process outlived the CLI. It was still running after Core stopped, and in r5 still at the end of the run, after Claude reported it stopped. The lab's cleanup ended it. Yuzuno shows what Claude reports and does not watch host processes.

## `subagent-lab.mjs`: a background sub-agent stops from its card

R1 asked whether CLI 2.1.280's running-task snapshot lists sub-agents at all. Core sends a stop only for a task listed there.

One turn starts a background sub-agent whose task is a 90 s foreground shell. Claude asked for no approval. The turn ends and the sub-agent runs on. Its card in the **Sub-agents** group then stops it:
- exactly one `POST …/tasks/<its task id>/stop`, answered 200, so the snapshot listed it;
- then `stopped` from Claude's own report;
- the session goes on.

Sub-agent lab r1: Job `63de7c79` on 4a5a1ac, **4/4 passed**.

Reports and screenshots stay local in `target/t25/`. Screenshots show the account panel, so they are not committed.
