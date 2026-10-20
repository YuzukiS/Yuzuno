# T-23: Claude reasoning effort, chosen and reported

A Claude Agent's settings now take a reasoning effort as well as a model. The
choice is kept apart from the effort Claude Code reports a turn actually ran at.

## Behaviour

- **Levels come from the model.** The Agent's catalog (`supportedModels()`)
  lists `supportsEffort` and `supportedEffortLevels` per model. The dialog
  offers only those levels, plus "Claude Code default". In 0.3.296 / CLI
  2.1.280, Haiku takes none.
- **The choice is saved with the model.** One save checks the pair against the
  catalog. A model switch that keeps an effort the new model doesn't list is
  refused with the reason, and nothing changes. The dialog resets the effort to
  default when you switch to such a model, and says so.
- **It applies from the next turn.** A session starts with the saved effort
  (`effort` option). Between turns Core calls the bridge's `set_effort`
  (`applyFlagSettings({effortLevel})`) next to `set_model`. A save during a
  running turn is only stored; the running turn keeps its effort.
- **What ran is reported separately.** A Stop hook reads `effort.level`, the
  actual effort of the turn after any downgrade. The bridge notes it on the
  native turn that stopped and reports it with that turn's result, once it knows
  whose turn that was. A notice turn Claude runs ahead of a queued prompt keeps
  its own report. Core stores it as `claudeRuntime.effort = {level, turnId}`. The dialog shows "Claude Code
  reported X for the latest turn" or "for an earlier turn". The Agent panel
  shows "Effort · reported". A model without effort reports nothing, so the
  last report stays with the turn it came from.
- **"Claude Code default" means Claude Code chooses.** At session start that is
  the `effortLevel` in your Claude settings if set, otherwise the model's
  default. Clearing a choice mid-session (`applyFlagSettings` with null) falls
  back to the model's default until the session restarts. The reported value
  always shows which one ran.

## Checks

- Bridge, `runtimes/claude/bridge.test.mjs`: catalog levels and the `start`
  option; `set_effort` between turns only; Stop-hook reporting for the main
  thread only.
- Core, `core/src/claude.rs`: per-model validation; start params; model and
  effort saved together, with a refused pair changing nothing; the reported
  effort kept apart from the choice.
- Web, `web/tools/ui.test.mjs`:
  - levels per model and the reset note on a model switch;
  - a refused save keeps the dialog and the choice;
  - default is sent as an explicit null;
  - a saved effort the model no longer lists is shown and blocks saving;
  - the reported value is labelled with its turn.
- Web, `web/tools/claude-effort.test.mjs`: "latest turn" comes from the
  conversation index of every turn, so it holds while an older window is open.
  A detail without an index falls back to its loaded turns.
- Live: `live.py` runs a real Claude session through a lab Core. See below.

## Live lab

```sh
python3 acceptance/claude-effort/live.py <empty lab folder>
```

The lab Core runs on port 4523 with its own data and working folders. It uses
the normal Claude login, Sonnet and Haiku, and short replies. The only tool it
approves is its own `python3 -c ... sleep`. It never touches the daily Core.
The script compares the daily Core's listener and web/dist digest, and the
digest of `~/.claude/settings.json`, before and after.

## Results (2026-10-16)

The lab ran as Yuzuno Job 6f9d1c40 with a Git guard, on commit
38bfa6bd13d345a684740fb0c57ffa0916aec7ce with no tracked changes. That commit
includes the R1 fix, which reports the effort with the turn that stopped.
- Lab Core: `target/debug` build, sha256 `fa38bb17…`.
- Bridge: `fc109d7b…`.
- Claude CLI: 2.1.280.
- Before it, the bridge tests passed 46/46.
- The receipt is `evidence/lab-3-38bfa6b.json`. All 14 checks passed.
- The same 14 checks also passed before the R1 fix, as Job ebbaa770 on ee439e0
  (`evidence/lab-2-ee439e0.json`).

| Step | Saved choice | Claude Code reported |
| --- | --- | --- |
| default | Sonnet, none | xhigh (the `effortLevel` in `~/.claude/settings.json`) |
| between turns | Sonnet, low | low |
| running turn (high saved during it) | Sonnet, high | low for that turn |
| next turn | Sonnet, high | high |
| refused: Haiku keeping high, Haiku with high, `turbo` | unchanged: Sonnet, high | 400s naming the reason |
| Haiku | Haiku, none | nothing; the last report stays with its earlier turn |
| Core restart, medium saved | Sonnet, medium | the same session resumed and ran at medium |
| cleared mid-session | Sonnet, none | high (the model's default, not xhigh) |

The daily Core's listener, its web/dist and `~/.claude/settings.json` were
unchanged. Both lab Cores exited and left no bridge.

An earlier run, Job f8074cba on 9c26d57, stopped at the Haiku step. A model
switch and an effort change in the same send were refused: the SDK echoes
`setModel` as a replayed user frame, which the bridge holds as an open turn
until the prompt claims it. ee439e0 applies the effort before the model;
`applyFlagSettings` echoes nothing, and an effort set before a switch carries
over to the new model.

## Known limits

- **Model default:** Claude Code doesn't report a model's default effort ahead
  of a turn. "Claude Code default" shows what ran only after the turn.
- **Clearing mid-session:** clearing a choice in a running session falls back
  to the model's default, not your Claude settings. A new session uses your
  settings again.
- **Downgrades:** a level Claude downgrades (for example `max` on a model
  without it) is shown as the level that ran. The catalog only offers listed
  levels, so this needs a catalog that changed after saving.
- **Remote Agents:** a remote Agent's catalog comes from its machine's Claude
  Code. Not run remotely here.
