# DeepSeek Harness (dsh) Agents

Core can run an Agent on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`), DeepSeek's own agent CLI, as a fourth harness beside Codex, Claude Code
and OpenCode. Core drives dsh through its Agent Client Protocol interface
(`dsh --profile acp`): JSON-RPC over the process's standard input and output,
which dsh documents for programs that control it. Each dsh Agent has a dsh
process and a folder of its own. dsh Agents run on the Core host only, with a
DeepSeek [routing key](executor-routing.md#routing-keys). The design is
YN-119 v1 (§3, §4); the code is `core/src/dsh.rs` (the process) and
`core/src/dsh_agent.rs` (the Agent).

## Installing dsh

Install dsh yourself on the Core host, as you install Codex or OpenCode:
`npm i -g @deepseek-ai/dsh@latest`. It needs Node.js 24.9 or newer. Core never
installs or updates it. Core starts the program named by `YUZUNO_DSH_BIN`,
else `dsh` on its `PATH`. A Core that the desktop app starts again keeps the
`YUZUNO_DSH_BIN` it last started with.

dsh is a developer preview, and every release so far is a pre-release. Core
reads `dsh --version` at each start and judges it by its version line
(`core/src/dsh.rs`):

| dsh | What Core does |
|---|---|
| Unreadable, or older than **0.2.2-rc.1** (`MIN`) | Refuses to start it, and says to update: `npm i -g @deepseek-ai/dsh@latest` |
| In line **0.2**, up to **0.2.2-rc.3** (`VERIFIED`) | Starts it |
| In line 0.2, newer than 0.2.2-rc.3 | Starts it, and notes that it is newer than the verified one |
| A newer line (0.3, 1.x) | Starts it only if every start check below passes, and notes that it is an unverified new line |

`/api/workspace` says whether this Core can start dsh, as
`dsh: {available, version, label}`. The web offers dsh only while `available`
is true. The Machines page (the Core host's check) and the desktop app's local
check show dsh's version where they show Codex's and Claude Code's. Reading
it (`dsh --version`) writes no file, not even under a new home. A daily
workflow, [`dsh-contract.yml`](../.github/workflows/dsh-contract.yml), checks
npm's `latest` and `next` dsh against what Core relies on.

## A dsh Agent

**Making one.** Choose **DeepSeek Harness** in the new Agent dialog, on this
Core host, with a DeepSeek routing key and a permission level. The API is
`POST /api/agents` with `harness: "dsh"`, `machineId: "local"`,
`runtimeProfile: {kind: "apiKey", keyId}` and `permissionLevel` (`ask`,
`auto` or `full`; Ask you first when none is given). A model and a reasoning
effort are optional. Without a DeepSeek key dsh doesn't start, and Core says
so: "dsh needs a DeepSeek key: Settings → Routing keys". dsh is never the
default harness for new Agents.

**Executors.** A dsh executor gets its key from a routing candidate
(`harness: "dsh"` with a DeepSeek `apiKey` credential), so a template must
follow routing to start one. A dispatch from a fixed dsh template that routing
gives no key is refused before any executor exists (`dsh_needs_key`). Routing
treats dsh as host-only, and a spend cap can't be judged for it, because dsh
reports no API spend ([Executor routing](executor-routing.md)).

**Its process and folder.** Each start runs `dsh --profile acp --patch
<overlay.yml>` in the Agent's working folder, in a process group of its own.
Core keeps `<data>/dsh/<agent>/` (mode 0700) for it:

- `home/` is dsh's `DSH_HOME` (0700). It holds dsh's sessions, and a separate
  home means your own `~/.dsh` credentials and settings never apply to it.
  Your `~/.agents` instructions and skills still do, as Claude Code's and
  Codex's user-level ones do.
- `overlay.yml` (0600) is Core's configuration patch, rewritten at each start.
- `home/AGENTS.md` (0600) is rewritten at each start too (see Workspace MCP).

dsh gets Core's environment without its `DSH_*` and `DEEPSEEK_*` variables,
plus `DSH_HOME`, `DSH_PERMISSION_MODE`, `DSH_TELEMETRY_DISABLED=1` and the
Agent's key as `DEEPSEEK_API_KEY`. The key goes to that process only, and
the commands dsh's tools run don't see it. dsh leaves credential-shaped
variables (`*KEY*`, `*PASSWORD*`, `*SECRET*`, `*TOKEN*`) out of their
environment, by name. That is dsh's own rule, and a lab probe saw a command
at Full access run without `DEEPSEEK_API_KEY` on 0.2.2-rc.3 and 0.2.2-rc.1.

**What Core sets, and checks at every start.** The overlay writes each of
these as a literal, and Core reads it back:

- uploading dsh's session log to DeepSeek off (`session-log-deepseek`), and
  its plugin inventory off (`plugin-package-inventory-deepseek`);
- telemetry off (`session-telemetry-otel`);
- the provider (`deepseek-official`) and the default model (`deepseek-flash`);
- the sandbox (`sandbox-policy`) and approval policy (`approval`) of the
  Agent's level. When the working folder is a linked Git worktree, the main
  repository's `.git` is writable too, so that a commit works.

A start runs five checks, and any one that fails refuses the start, saying
which step and row: the version; `--dump-config` shows each row patched last
by Core's overlay with Core's values, and prints nothing on stderr; each key
Core writes is in dsh's own configuration schema; `initialize` speaks ACP 1,
with MCP over HTTP and sessions that resume and close; and the session offers
a model and a reasoning effort.

**Turns.** A message is one ACP prompt. Its Turn is recorded before it is
sent, and dsh's answer ends it: `end_turn` completes it, `cancelled`
interrupts it, an error fails it. dsh doesn't stream text: each step arrives
whole. Replies, reasoning, commands (`bash`), MCP calls and dsh's other tools
appear as Items, and the context dsh reports is shown. Something dsh says
while no prompt is open, after a background task ends, appears as a Turn of
its own, completed. A Turn's end is an unread result, as Claude Code's and
Codex's are.

**One prompt at a time.** ACP takes one prompt at a time. While a Turn runs, a
new message, or one added to that Turn, is refused and the draft is kept. Mail
reaches a dsh Agent only when it is idle, as a new Turn; urgent mail waits for
the Turn to end too, as it does for OpenCode.

**Interrupting.** An interrupt sends `session/cancel`. dsh's `cancelled` ends
the Turn. Without an answer within 10 seconds, the Turn's end is unknown and
Core stops that dsh. The next message or a reconnect starts a new dsh, which
resumes the same session. Nothing is sent again.

**Reconnecting, restarting, disconnecting, deleting.**
- A reconnect, or a new Core, starts a new dsh that resumes the Agent's
  session (`session/resume`) and sets its model and effort again. A Turn the
  earlier dsh never answered is unknown, never sent again.
- You can disconnect an idle dsh Agent: Core stops its dsh, and with it
  everything its tools started, which run in dsh's process group. Nothing
  starts it again until you reconnect.
- Closing stops dsh: a running Turn is interrupted first.
- Deleting the Agent removes `<data>/dsh/<agent>/`, the folder alone and
  never what a link there names.

## Permission levels and approvals

dsh keeps three of the four [permission levels](executor-routing.md#permission-levels-yn-56):

| Level | dsh | A request to go past the sandbox |
|---|---|---|
| Ask you first (`ask`) | `workspace-write` sandbox, approval `ask` | Shown to you as a card |
| Auto-approve (`auto`) | The same sandbox | Refused by Core, asking no one. dsh has no reviewer; its tool tells the model to stop and explain |
| Full access (`full`) | `danger-full-access`, approval `never` | None: nothing is sandboxed |
| Read only | Not kept | Routing passes over dsh for it (`levelNotKept`) |

dsh's sandbox limits writing files only. Its network, its `web_fetch` tool
and MCP tools are open at every level, which is why it doesn't keep Read only.

**The card.** At Ask you first, a request to go past the sandbox is a card with
the command, the sandbox it asks for (`sandboxPermissions`), dsh's
justification and the folder. **Allow once** sends dsh's allow-once option,
**Decline** its reject-once. dsh offers no "allow for this session". The answer
goes once, only to the dsh that asked. An interrupt or a close answers an
open card `cancelled`. A card's Turn ending takes the card with it.

## Workspace MCP

Each start names the Workspace MCP to dsh in `session/new` and
`session/resume`: an HTTP server at `http://127.0.0.1:<port>/mcp/<agent>`, with
the Agent's credential as an `Authorization: Bearer` header. The credential is
only in that request on dsh's standard input. It is not in dsh's arguments,
environment, overlay or `AGENTS.md`. On dsh 0.2.2-rc.3 and 0.2.2-rc.1, dsh kept
it in no file of the Agent's folder, its compressed session included (lab
probe, `core/tests/dsh_probe.rs`).

With the Workspace MCP, `home/AGENTS.md` holds the session notice, and for a
Project's Agent the Brief check applies to, the Brief's rules: what Claude
Code gets in its system prompt and Codex in its developer instructions. The
Agent counts as connected to the Workspace once dsh has taken the session,
and a new message needs that. dsh has no Stop hook, so a Turn the Brief check
finds without an update gets one reminder Turn, as a Codex Turn does.

## Model, effort and images

- **Model and effort.** An Agent's model and reasoning effort (`off`, `low`,
  `high` or `max`) change between Turns only. A change is checked against what
  its dsh offers and set on its live session at once (`set_config_option`),
  then saved; each start sets them again. A model dsh doesn't offer is refused,
  with nothing saved. Once a session has an effort, dsh keeps one, so it can't
  go back to the provider's default.
- **Level.** A level is dsh's sandbox, fixed when dsh starts. Changing it
  starts a new dsh, which resumes the same session under it.
- **Models offered.** An Agent's models are those its dsh offers. Before it has
  a dsh, and for a new Agent (`GET /api/models?harness=dsh`), Core starts a dsh
  of its own in `<data>/dsh-catalog/`, with a placeholder key that no model is
  asked with. It reads the models offered, stops that dsh and removes its
  folder. That list is kept for 60 seconds; a read may take 20. A model is kept
  and listed by its name (`deepseek-flash`, `deepseek-v4-pro`).
- **Images.** A message's images go to dsh after its text, each fitted as for
  OpenCode, but only to a dsh whose `initialize` says it takes images.
  Otherwise the message is refused before anything is recorded. dsh uploads an
  image to DeepSeek's Files API before the model request that names it.

## What a dsh Agent doesn't have

No rewind (dsh keeps no checkpoints Core could return to), no manual
`/compact` (dsh compacts its context by itself), no fork or session import,
no SSH machines, no sub-agent panel (only its parent's tool calls show), no
slash commands or skills picker, and no reading of spend or quota: Core
counts no spend of dsh, and shows only the context use dsh reports.

## Known limits

- `/api/workspace` waits for `dsh --version`, for at most 10 seconds, the first
  time each Core process answers it. Later answers use the reading of the last
  60 seconds, refreshed in the background.
- A model list read that runs out its 20 seconds leaves its folder under
  `<data>/dsh-catalog/`. Workspace backups don't copy that folder.
- If setting the model on a live session succeeds and setting the effort then
  fails, the session runs the new model while the Agent still says the old one,
  until its next start or change.
- A level change is saved before the new dsh starts. If that start then fails,
  the request says so although the change was saved, and the Agent is left
  disconnected.
- Workspace backups don't copy `<data>/dsh/` (dsh's own homes and sessions),
  as they don't copy OpenCode's databases.
