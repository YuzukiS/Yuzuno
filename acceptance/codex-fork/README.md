# Explicit Codex fork after a writer conflict (T-4)

When another Codex client still owns a local session, Yuzuno cannot resume it: Codex 0.162.1 answers `thread <id> already has an active writer`, even after that client's turn has finished. This slice turns the earlier manual handoff ([session handoff](../session-handoff/README.md)) into one explicit GUI action.

## Behavior

- A resume refused with exactly that message for the Agent's own thread is recorded as a structured writer conflict (`codexHandoff.writerConflictAt`). It is cleared when Yuzuno later attaches. Nothing retries, takes the writer over, deletes a lock or stops another daemon.
- The conversation explains the ownership and offers **Try again** or **Continue in a fork…**.
- The confirmation is read-only until confirmed. It names the boundary — the latest Turn with status `completed` and when it completed — and says plainly that it creates a **new native session and a new agent** with the same folder, model, reasoning and permissions, and that the original session, its client and its entry stay open. The copy is the whole history up to that Turn ("Copies N turns"), so it can include earlier interrupted or failed Turns; later Turns (running, interrupted or failed) stay with the source. Core refuses a boundary that is not a completed Turn without calling Codex.
- **Fork and continue** calls official `thread/fork` with `lastTurnId` and explicit model, `model_reasoning_effort`, cwd and resolved permissions. Before registering, Core compares the fork's Turn IDs and statuses with the source through the boundary and checks `forkedFromId`. The new Agent keeps the name chosen in the dialog, the Project (unless archived), folder, model, effort and permission preset; copied Turns are not unread. It is connected without a prompt.
- The source Agent and native session are not changed except for a link to the continuation, shown as "This conversation continues in …".
- A closed fork Agent still exists: the link stays, marked "(closed)", **Open** goes there, and another request for the same boundary returns it. Deleting the fork Agent releases its attempt and removes the link, so the source shows the conflict again; only a new explicit fork continues it. A link or record left behind by an older Core is ignored the same way.
- An unsent draft is copied into the new Agent's composer unless it already has one. Nothing is sent.

## Retries and unknown results

Each attempt is a row in `codex_forks`, keyed by a client request ID and recorded before the native call. A unique index allows one live or completed attempt per source and boundary.

- The same request, or another click for the same boundary, returns that attempt; it never forks or registers again.
- Codex refusing the fork is a definite failure: nothing was created, and a new attempt is allowed.
- A fork whose history does not match is not registered; its native ID is reported. If the fork cannot be read back at all, nothing is concluded: the attempt stays forked and a retry checks the same fork again instead of forking twice.
- After the fork Agent is deleted, its request reports that and does not fork again; a new request does.
- A lost response stays **unconfirmed**. It is never treated as a failure and never re-sent. Codex 0.162.1 cannot locate such a fork: `thread/list` omits a fork until it has its own Turn and then reports `forkedFromId: null` (measured here with `list_probe.py`). The only way forward is the user's explicit **Fork again anyway**, which abandons that attempt; it may leave one unused native session in Codex, never a second Agent.

## Verified

Dedicated throwaway source session created by `holder.py` in the existing Codex profile (two read-only Turns, `gpt-6-astra`, low effort), held by a separate app-server as the "other client". The Lead's fork and the daily Dev sessions were not used. Isolated Core on port 4347 with its own data under `target/fork-lab`; the daily Core, data and `web/dist` were not touched.

- Real writer conflict reproduced on import + reconnect and recorded structurally.
- Read-only preview: boundary = second Turn with its real completion time; model, effort, permission preset and Project correct.
- Chromium, 8/8 (`browser.mjs`): conflict explained; dialog copy; Cancel left no fork link; a **double click sent one fork request**; the new Agent was selected with the draft copied; **no message or Turn was sent**; the source showed its continuation and kept its draft. Writes were exactly two previews and one fork. Note: the local `browser-report.json` came from a revision of `browser.mjs` before its `structuredClone` fix, so the Cancel check's detail lists the final writes (including the later fork) instead of those at Cancel time. Cancel was checked again in R2 below with a fixed script. The script's dialog strings were later updated to the R2 wording; it was not rerun.
- API (`lab.py verify`): `forkedFromId` = source; both Turn IDs and statuses identical; model/effort/permissions/Project kept; connected; 0 unread; source Agent open.
- Continuation (`lab.py continue`): one read-only Turn in the fork replied `gamma`; the source still had 2 Turns.
- Repeat (`lab.py repeat`): a new request for the same boundary returned the same Agent; still two Agents.
- Core (R1): 8 fork integration tests (fake app-server: success, refusal, lost response kept unconfirmed until an explicit fork again, history mismatch, repeated clicks, guards). UI: 5 fork tests.
- Combined with reviewed `main` `206bd98` (T-5 Machines, T-6, T-8): full Core suite serially **179 passed, 0 failed, 2 ignored**; `npm test` (all suites), session-import 17 and codex-fork 5 pass; TypeScript clean.
- Same lab database, combined binary (`lab.py combined` / `reopen`): a local machine check and the existing fork coexist; after a Core restart the check, both Agents' Project, both fork links and the Agent count persist; the fork reconnects; a new request for the same boundary still returns the same Agent.
- Read-only Chromium smoke on the combined build (`browser-combined.mjs`), 4/4 with no writes: continuation link → Open selects the fork (no conflict notice there); Machines lists the last check and both Agents.

The source holder and lab Core were stopped afterwards.

### R2 rework, rebased on `e94b494` (T-7)

- Core: 12 fork tests. New: the boundary is the latest completed Turn and the copy keeps an older interrupted Turn (older interrupted → completed → interrupted → running: boundary is the completed Turn, 11 copied, 2 left out); an interrupted boundary is refused without calling Codex; a fork that cannot be read back is checked again, never forked again; a closed fork stays the continuation and is returned again, a deleted one frees the source, its old request does not fork, a new request forks once; a record and link left by an older Core's delete do not block a new fork.
- Full Core suite serially, `-j 2`: **187 passed, 0 failed, 2 ignored**, no warnings. `npm test` (all suites), session-import 17 and codex-fork 5 pass (now also checking the closed and deleted notice and the prefix wording); TypeScript clean.
- Same lab and dedicated source, new build. `holder.py hold` owned the source again; `lab.py reconflict`: the reconnect was refused with the real `already has an active writer` and the conflict recorded again.
- Chromium (`browser-r2.mjs`), 7/7. The R1 fork Agent was closed through the API: the source showed "continues in Fork lab source (closed), from a Codex fork of its first 2 turns" and offered no fork. Deleted through the API: the page switched to the conflict notice without a reload and the link was gone. The dialog said "Copies 2 turns" and "History up to and including the latest completed turn, completed …". After Cancel: no fork write, no link, same Agent count. One explicit fork: the new Agent was selected, exactly one fork request, nothing sent; the deleted Agent is gone and exactly one new Agent exists. Page writes: two previews and one fork.
  - Run 1 stopped at its own Cancel check: after the dialog closed, the page sent its usual read receipt (`POST /api/agents/<source>/review`; reading waits while the dialog is open), which the check counted as a dialog write. Nothing about the fork changed. The check now allows only that receipt; run 2 resumed from run 1's state (the fork was already deleted) and passed. Both reports are kept (`browser-r2-run1-report.json`, `browser-r2-report.json`).
- `lab.py verify` on the new fork: `forkedFromId` = source; both Turn IDs and statuses identical; model, effort, permission preset and Project kept; connected; 0 unread; source Agent open. `lab.py repeat`: a new request returned the same Agent. These two steps replaced the R1 `verify` and `repeat` entries in `evidence.json`.

The holder and lab Core were stopped again; the daily Core was not touched.

## Limitations

- Rollback to a Core without this slice was not verified. Such a Core still reads these records (the `codexHandoff` field and the `codex_forks` table are additive), but it drops `codexHandoff` the next time it rewrites an Agent. The conflict notice and the visible fork links would then disappear; both Agents, their native sessions and the journal entries (`codex/writerConflict`, `codex/forkedTo`, `thread/forked`) remain.
- The raw Codex error text is still shown by the existing conversation error banner and rail summary, next to the new explanation.
- The fork keeps the source's name by default; both entries can have the same name until the user renames one.
- Remote and Claude sessions, lock removal, taking over a writer, stopping a shared daemon and migrating live sub-agents are out of scope.

## Reproduction

```sh
python3 acceptance/codex-fork/holder.py start target/fork-lab/state target/fork-lab/task   # keep running
target/debug/yuzuno-workspace --port 4347 --data-dir target/fork-lab/data --web-dir web/dist --cwd target/fork-lab/task
python3 acceptance/codex-fork/lab.py conflict && python3 acceptance/codex-fork/lab.py preview
node acceptance/codex-fork/browser.mjs        # performs the one real fork
python3 acceptance/codex-fork/lab.py verify && python3 acceptance/codex-fork/lab.py continue && python3 acceptance/codex-fork/lab.py repeat
touch target/fork-lab/state/stop              # release the source
# R2: same source, owned again; closes and deletes the R1 fork, then forks once
python3 acceptance/codex-fork/holder.py hold target/fork-lab/state target/fork-lab/task   # keep running
python3 acceptance/codex-fork/lab.py reconflict && node acceptance/codex-fork/browser-r2.mjs
python3 acceptance/codex-fork/lab.py verify && python3 acceptance/codex-fork/lab.py repeat
```

`browser.mjs`, `browser-r2.mjs` and `lab.py continue` write real state; run them once. Evidence (`evidence.json`, `browser-report.json`, screenshots) stays in the gitignored `target/fork-lab`.
