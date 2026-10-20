# T-29: slash commands and Skills in the Claude composer

Typing `/` at the very start of a Claude Agent's draft lists the commands
Claude Code itself lists for that Agent. Choosing one fills in its name;
sending is the same as before.

## Where the list comes from

- **Running session.** Claude Code's `supportedCommands()` on the Agent's live
  query (bridge op `commands`, `runtimes/claude/commands.mjs`). It follows
  every native `commands_changed` push.
- **Folder.** While no session runs (for example after Core restarts), a
  catalogue-only start of Claude Code in the Agent's folder. It sends no
  prompt and saves no session, and is reused for a minute
  (`core/src/claude_commands.rs`).
- **Labels.** `builtin` marks Claude Code's own commands. A command is marked a
  Skill only when the session's latest `system/init` lists it in `skills`.
  Before the first turn there is no init, so Skills show as *Custom*.
  Terminal-only commands named by the init are hidden. Claude Code 2.1.280
  already leaves out `exit` and `statusline` in SDK sessions.
- **Not listed** (an `unavailable` state with a reason):
  - closed Agents;
  - Agents on another machine;
  - a session that is starting or has just changed;
  - a Claude Code without `supportedCommands`.

  Nothing is ever read from disk or made up.

## Live lab

```sh
YUZUNO_LAB_CORE=<candidate Core binary> YUZUNO_LAB_WEB=<candidate web/dist> \
  python3 acceptance/t29-commands/live.py <empty lab folder>
```

One lab Core runs on port 4571 with its own data. Real Claude Code works in
`~/.t29-lab/<lab name>`, a folder with one project Skill. `probe.mjs` reads
Claude Code's own list for that folder straight from the SDK, with no prompt.
`browser.mjs` drives the composer in Chromium. Of the commands sent,
`/context` and `/reload-skills` are local to Claude Code; Claude Code passes
an unknown one to the model as text. The lab checks:
- the turn's status and native items, never the wording of a model reply;
- that the daily Core and `~/.claude/settings.json` are unchanged.

## Results

Evidence run: lab `evidence-6adac43`, Job 6ae3a69a, 2026-10-17. Scripts and
candidate were both at 6adac43 with 0 uncommitted files. The frozen Core binary's
sha256 is `82874be1…`. The same Job first passed the bridge, Core and web checks.
Result: **16 passed, 0 failed**.

| Check | Observed |
|---|---|
| Session list | `ready`, source `session`, 110 commands |
| Same as Claude Code's own list for the folder (SDK, no prompt) | 110 = 110; none missing, none extra |
| Project Skill before a turn | listed, `custom` (`skillsKnown` false) |
| Claude Code's own commands | `context` and `compact` are `builtin`; `compact` has its argument hint |
| Chromium: `/` shows the list | 110 rows |
| List placement | above the composer box (bottom 672, box top 673), inside the window |
| `/cont`, arrows | narrowed to `/context`; the arrows move the choice |
| Enter on a list item | fills in `/context `; no list after it; nothing sent |
| Slash after other text | `see /usr/bin and /co` opens nothing |
| `/context` sent | prompt exactly `/context`; items: `userMessage`, `agentMessage` (Claude Code's own table); `completed` |
| Unknown `/t29-no-such-command` | Claude Code passes it to the model as text: `userMessage`, `reasoning`, `agentMessage`, `completed` |
| After a turn's init | the project Skill is `skill` |
| `/reload-skills` | `completed`; a Skill added meanwhile is now listed (Claude Code's list changed from 110 to 108) |
| After a lab Core restart | source `folder`, 111 commands, including both lab Skills |
| Daily Core | 4317 listener, daily web/dist and `~/.claude/settings.json` unchanged |

Exploratory runs on earlier commits, kept as evidence of the fixes:
- **explore-1 (ca7a77d):** every new session was `changed`. Claude Code names its session on a hook before the first turn, and Core keeps no session id then. Fixed in 7dd9ba9.
- **explore-2:** the lab script waited for an empty `textContent`, but an empty draft shows its placeholder.
- **explore-3:** the list overlapped the composer box.
- **explore-4 (ba05c53):** the tooltip's own element carries `cm-tooltip`, so the `:has()` styles never applied. Fixed in 6adac43.

## Native /compact and /model (2026-10-20)

Typing `/` in a Codex Agent's draft offers `/compact` and `/model`, controls
Yuzuno runs itself. Codex's app-server lists no commands. A Claude Agent's list
gains `/model`. On Send, a draft that is exactly one of them is run, never
sent as a prompt:

- **Codex `/compact`.** `POST /api/agents/{id}/compact` asks Codex itself
  (`thread/compact/start`). Codex's empty answer only accepts it; the Agent
  stays uncertain until Codex's own compaction turn ends.
  - Meanwhile another `/compact` or a message is refused.
  - A lost answer stays uncertain and is never sent again.
  - Only a Codex without the method (method not found) provably ran
    nothing; the Agent is as it was. Any other error doesn't show whether
    Codex had begun, so the Agent stays uncertain, to be checked. A turn
    Codex has already reported started is never rolled back.
  - Instructions after it are refused with the draft kept.
- **Claude `/compact`.** This is Claude Code's own command, sent as a message.
  Its `compact_boundary` now shows as a Compaction item of that turn, with
  Claude Code's own token figures.
- **`/model [name]`, either Harness.** Opens the Agent's model settings with
  that model chosen. A change applies from the next turn.

`native_compact.py` checks this against the installed CLIs:

```sh
YUZUNO_LAB_CORE=<candidate Core binary> YUZUNO_LAB_WEB=<candidate web/dist> \
  python3 acceptance/t29-commands/native_compact.py <empty lab folder> [codex|claude ...]
```

It starts one lab Core on port 4572 with its own data. Each Harness gets one
tiny history turn, then one `/compact`, with no retries. It judges the turn's
status and native items, never wording.

| Run | Harness | Model calls | Result |
|---|---|---|---|
| a1, Job cc01005c, 8d63250 | Codex CLI 0.162.1 | history 1, compaction 1 | 7/7 (all checks below) |
| a1 | Claude | 0 | not started: the checkout lacked the bridge's `node_modules` |
| a2, Job cf4381c1 | Claude | 0 | not started: lab folder name reused |
| a3, Job cef4de81 | Claude Code 2.1.280 | history 1, compaction 1 | 3/4 |

Codex a1, all seven checks passed:
- the history turn completed;
- `/compact` was accepted;
- a second `/compact` at once was refused by Core without reaching Codex;
- the compaction turn carried a `contextCompaction` item;
- that turn completed;
- no prompt was sent for it;
- the Agent was idle again, after about 18 s.

Claude a3, three of four checks passed:
- **Passed:** the history turn and the `/compact` turn completed, and the
  Agent was idle again.
- **Native evidence:** the lab's journal shows Claude Code's own `compacting`
  status, then `compact_result: success`, then `compact_boundary` (manual,
  34 307 → 3 802 tokens), then `local_command: compact`.
- **Failed:** the check that the turn's record shows the compaction. Core
  then made no Item of it, so the conversation showed only the `/compact`
  input.
- **Fix:** this change adds that Item, tested with the event exactly as
  recorded there. The Claude run was not repeated.

Not covered: Agents on another machine (SSH). Their Codex may lack the
method, which is reported as such; that case is tested only with a fake
app-server.
