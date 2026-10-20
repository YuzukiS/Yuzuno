# Local Claude runtime

This is a thin NDJSON host for the official `@anthropic-ai/claude-agent-sdk`
0.3.296. The SDK launches the user's existing, unmodified Claude executable.
Yuzuno does not implement Claude's private stream-json control protocol, inference
loop, tools, session storage, or authentication.

Run in the **Core environment** (WSL for the first slice):

```sh
cd runtimes/claude
npm ci --ignore-scripts --omit=optional
node bridge.mjs
```

Optional bundled binaries are omitted because the bridge explicitly selects the
installed executable. No global CLI is installed, upgraded, or replaced. `PATH`
lookup uses filesystem checks, never a shell. The existing environment and
`CLAUDE_CONFIG_DIR` semantics are preserved; credentials are not read or returned.
The Windows GUI needs no Windows Claude login.

## Claude Code versions

The SDK's `pathToClaudeCodeExecutable` "uses the built-in executable if not
specified". SDK 0.3.296 ships Claude Code 2.1.296 that way, as the optional
`@anthropic-ai/claude-agent-sdk-<platform>` packages its `manifest.json`
lists. Development, CI and release installs all omit them
(`--omit=optional`, also in `tools/build-core-artifact.py`), and the bridge
always passes an executable, so that built-in copy never runs. What runs is
the `claude` found on the Core process's `PATH` (Core sends no
`start.executable`), with symlinks resolved. The SDK checks no CLI version; it
only sets `CLAUDE_AGENT_SDK_VERSION` for the CLI.

Each `start` result and each review's `review_start` result carries
`provenance`:

- `cli.path`, the file that runs;
- `cli.found`, the `PATH` entry that matched, before symlinks;
- `cli.source`, `path` or `explicit`;
- `cli.version`, with `cli.versionSource`: `init` when Claude Code reported it
  at initialization, else `--version`;
- `sdk.version` and `sdk.builtInCli`, read from the installed SDK's
  `package.json` and `manifest.json`;
- `compatibility`, one of:
  - `built-in`: the version the SDK ships;
  - `verified`: listed in `VERIFIED_CLI` in `bridge.mjs`, because this bridge
    has run it with this SDK in real checks;
  - `older`: older than both of those;
  - `unverified`: any other version;
  - `unknown`: no version could be read.

Nothing is refused on a version string. A feature a CLI lacks fails with that
CLI's own error, and a startup failure is followed by the CLI's path and
version and the SDK's. Core keeps `provenance` as the Agent's
`claudeRuntime.provenance`, replaced at every start and reconnect, so a
changed `PATH` shows. It is also kept on Claude review records. The Agent's
information panel shows it.

Checked so far, with SDK 0.3.296 on Linux (WSL):

- **2.1.280: verified** (`acceptance/t87`). It leaves its version out of the
  initialization result, so sessions show the version from `--version`. The
  first turn's `system/init` reports the same version. Checked:
  - start, resume and reconnect;
  - a Workspace MCP tool call, and an approval, with the bridge's Stop and
    tool hooks registered;
  - the model catalog;
  - a review.
- **2.1.296: built-in, read only.** Its `--version` was checked with an empty
  `HOME`, and its MCP limits were read statically. No session was run on it:
  that would need the user's own login and configuration.

Known differences:

- `--thinking-display summarized` is passed only from 2.1.280 on.
- The default limit for MCP tool descriptions and server instructions is 2048
  characters on 2.1.280. On 2.1.296 it is 4096, and a tool loaded through tool
  search keeps up to 16384. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` overrides
  both versions.

Local Claude Agents use the Core host's CLI; SSH Agents use the selected
machine's own CLI and login. Packaged Cores for other platforms (macOS, native
Windows) have not been checked. To use another Claude Code, put it first on
the execution machine's `PATH` and reconnect the Agent.

## Wire contract

Each stdin/stdout line is JSON. Stderr is diagnostic-only and uncapped; Core
drains it continuously, keeps a bounded tail, and shows that tail only to
explain a startup failure or an unexpected exit. One bridge owns one native
session. All requests require a string `id`. `start` accepts an absolute
existing working directory:

```json
{"id":"1","op":"start","cwd":"/path/to/project","model":"haiku"}
{"id":"2","op":"send","turnId":"workspace-turn-id","text":"Review the code"}
{"id":"6","op":"append","expectedTurnId":"workspace-turn-id","clientMessageId":"client-id","followUpTurnId":"next-turn-id","text":"Also check the tests"}
{"id":"7","op":"send","turnId":"turn-id","text":"What is this?","images":[{"path":"/data/input-images/agent/<sha256>.png","mediaType":"image/png","sha256":"<sha256 of the file>","bytes":48213}]}
{"id":"3","op":"respond","requestId":"bridge-issued-id","decision":"allow"}
{"id":"4","op":"interrupt"}
{"id":"8","op":"stop_task","taskId":"bownir676"}
{"id":"5","op":"close"}
```

`models` returns `{source:"claude-agent-sdk",models:[...]}` from the official
`Query.supportedModels()` method. Each row preserves the CLI's model value,
display name, description and optional resolved model ID; there is no hardcoded
Yuzuno model list. Creation-time discovery starts a separate `catalogOnly:true`
query with `persistSession:false`, sends no prompt, and closes the process after
reading the catalog. Catalog-only queries reject prompts and session resume.
An existing connected Agent uses its own query's catalog; an offline Agent uses
a temporary catalog query in its working directory without reconnecting it.

`set_model` accepts `model` as a string; an empty string restores the native
default. It calls official `Query.setModel()` only between turns and waits for
the native acknowledgement. Yuzuno saves an Agent's selection while it is busy,
then applies it before enqueuing the next message. This does not restart the
query, change the session ID, or modify Claude's native permission settings.
If the model control fails, the next message is not enqueued.

Optional `start.sessionId` resumes an existing native UUID; it does not choose a
new session's ID. Optional `start.executable` chooses an installed binary.

Core's optional `start.collaborationMcp` is registered after initialization via
the official `Query.setMcpServers()` stdin control channel. Its Bearer token is
never placed in constructor MCP options, argv, added environment variables or
a temporary file. Other SDK servers are retained, as are user settings, hooks
and tools. Initialization and registration share a 30-second ready deadline;
failure closes the query without sending a prompt. Workspace credential echoes
are masked before diagnostics are truncated, including split stderr chunks.
See [credential rotation and recovery acceptance](../../acceptance/credentials/README.md).

Responses are `{type:"response",id,result}` or `{type:"response",id,error}`.
`start` acknowledges SDK initialization and any Workspace MCP registration, without sending a model
prompt. Its result may add display-only `account` (`email`, `organization`,
`subscriptionType`, `apiProvider`; never token or key sources) and the CLI
`version`. `send` acknowledges **local enqueue**, not successful native execution;
the Core must not blindly retry after a broken connection. A second send is
rejected until the native result and any outstanding interrupt receipt settle.
`append` sends a follow-up to the running `send` turn (`expectedTurnId`) as
Claude Code takes a message typed while it works: queued with the default
priority (never `'now'`, which stops the turn), folded into the running turn
between tool rounds, or, if that turn ends first, run as the next turn, which
then is `followUpTurnId`. Several may wait at once, in order. Each follow-up is
confirmed only when a turn names its uuid (`user_message_uuids`). In a turn
started by a typed prompt, that usually happens only on the result. A turn that
names any follow-up still held is answering it, so that follow-up belongs to
that turn. A result naming any of them, even by the single
`user_message_uuid`, ends that turn.

A follow-up counts as still queued at a turn's end only on evidence. Either the
result's complete `user_message_uuids` list leaves it out, or the interrupt
receipt lists it under `still_queued`, which can arrive before or after the
result. A list at the SDK's 64-entry cap may be cut short, so it only confirms
the uuids it names.
Such follow-ups run next as one turn: the first one's `followUpTurnId`, which
the rest join. Without that evidence a follow-up claims no turn. The next native
turn is held until a frame names it, which makes that turn the follow-up's. A
missing confirmation never moves a follow-up on by itself.

`append` acknowledges local enqueue only, refuses once its turn has ended, and
returns the same answer for a repeated `clientMessageId`.
`send` and `append` may carry up to 8 `images`, each
`{path, mediaType, sha256, bytes}`. These are files Core has already checked
and fitted to Yuzuno's Claude image budget: at most 2000 px a side and
512,000 bytes. That budget follows the sizes the installed CLI gives an image
in a new prompt; it is not an API limit (see `core/src/input_images.rs`). Image data never
crosses this wire. The bridge reads each file without following links, checks its size,
type and sha256, and only then encodes it as a native `image` block. The text
block, if any, comes after the images. A message may consist of images alone.
`status` is read-only: `ready`, `sessionId`, `pendingCount`, `configuring`,
`interrupting`, `nativeTurnId` (the native turn running, if any) and `turnId`:
the `send` turn in progress, else a native turn Claude is running on its own,
else `null`. Only `turnId:null` with nothing pending means idle.

`start` with `fileCheckpointing:true` turns on Claude Code's own file
checkpoints (the SDK's `enableFileCheckpointing`). `rewind_files` with
`userMessageId` (a prompt's native uuid) and an optional `dryRun:true` returns
`Query.rewindFiles()` unchanged: `{canRewind, error?, filesChanged?,
insertions?, deletions?}` for a dry run, `{canRewind, skippedLinks}` for a real
one. It runs only between turns. Checked with CLI 2.1.280
(`acceptance/t32/probe`):
- A checkpoint covers files changed with Write, Edit and NotebookEdit (a
  `context: fork` Skill's Write was covered too). It does not cover Bash or a
  foreground sub-agent's writes; background sub-agents were not tested.
- A rewind to a message puts back every tracked file as it was at that
  message, later turns included. Files created since then are removed.
- `filesChanged` holds absolute paths.
- A rewind overwrites a change made after a dry run without saying so, and
  the dry run before and after such a change is identical. Core therefore
  checks file contents itself (`core/src/claude_checkpoints.rs`).
- Errors come back as `canRewind:false`: "File rewinding is not enabled." for
  a session without checkpoints, and "No file checkpoint found for this
  message." for an unknown uuid or a tool_use id.
- A prompt does not need to have changed files to have a checkpoint: reply-only
  prompts usually had one, with nothing to restore. Once, a reply-only prompt
  sent right after a resume had none (probe 1); in the T-32 lab run it had one.
  Whether a message has a checkpoint is therefore Claude Code's answer, not
  inferred by Core.

Notifications:

- `{type:"event",turnId,nativeTurnId?,event}` preserves the original SDK message.
  `nativeTurnId` (`native-<uuid of its first frame>`) names the native turn a
  frame belongs to; session-level frames (hooks, prompt lifecycle, task
  notices between turns) have none and `turnId:null`. Otherwise `turnId` is
  the Yuzuno turn the frame belongs to: the `send` turn when evidence says
  the native turn is that prompt's, else `nativeTurnId` itself (a turn
  Claude ran on its own, such as continuing after a background task's
  notice, or one nothing matched). Only the prompt's own result ends the
  `send` turn; never infer that every tool succeeded from a result alone.
- `{type:"permission",turnId,nativeTurnId,requestId,toolName,input,toolUseId,suggestions?,sessionPermissions}`
  exposes a pending `canUseTool` callback, sent with the turn of the tool call
  it names, after that call's frame (it waits for the frame if the callback
  comes first). `requestId` is a bridge
  UUID, scoped to this process; it is not a replayable authorization.
  `sessionPermissions` is the only list a session approval can grant (see
  `respond`). A native turn's end cancels only its own requests.
- `{type:"permission_cancelled",requestId}` revokes an unresolved callback.
- `{type:"message_delivery",clientMessageId,status,turnId,previousTurnId?}`
  reports a follow-up: `accepted` once a frame or result names its uuid (Claude
  took it off its queue; a turn started by a typed prompt names a folded
  message only on its result), in `turnId`; `next` when its turn
  (`previousTurnId`) ended first and Claude runs it as `turnId`.
- `{type:"exit",error?}` means the native stream ended.

Whose a native turn is comes only from what Claude reports, never from
timing or from what earlier turns carried; no init capability promises the
uuids below. The SDK documents the prompt's uuid (`user_message_uuid(s)`)
on a prompt turn's first reply and on its result. Any listed uuid on a
turn's own frames (not on session frames such as a /clear's
`conversation_reset`) binds the turn, and later unmarked frames keep the
binding. A prompt folded into a running notice turn takes over from its
first marked frame; the output before stays apart. A turn is Claude's own
when a frame names another uuid, when its result's `origin` is not `human`,
or when no prompt of this bridge was in flight as it began. This bridge sets
no `origin` on its prompts, so a turn nothing names counts as the prompt's
only if Claude itself reports `origin` `human` on its result. Until there is
evidence the turn's frames wait in the bridge: a missing uuid proves nothing
(a local command such as `/cost` replies without it; its result carries
it). Without evidence a turn is sent as Claude's own and never ends the
prompt's turn. It is sent before its result only when it asks for
permission (Claude waits for the answer), when its waiting output passes
1000 frames or 4 MiB, or when the runtime exits. If Claude never names the
prompt's result, its turn stays running: an interrupt acknowledgement does
not end it, but closing the Agent does. Close interrupts, waits 10 s for
Claude to confirm, then ends the connection; once the process has exited,
the turn's result is recorded as unknown (never completed) and the session
is kept for reopening. Nothing is sent again.


`respond` answers allow or deny. Approval cannot change tool input and never
persists native permission rules to settings files. `scope:"session"` on an
allow also applies the request's `sessionPermissions`: Claude's own
"don't ask again" suggestions, narrowed to `destination:"session"`. Only allow
rules, directories and accept-edits mode qualify; a command rule never also
switches the mode, and bypass/dontAsk are never applied. A deny may carry
`message` (at most 2000 bytes), which Claude reads as the reason. For
`AskUserQuestion`, send the entire original `input` plus `answers`, keyed by the
exact question text; other input fields must be unchanged. Questions and
permissions are native structured requests, not interpreted from assistant prose.

Interrupt calls the SDK's control method and keeps the session. It revokes
pending approvals. The bridge does not claim a native interrupted tool can resume
execution. Closing stdin, close, SIGTERM and SIGINT close the owned SDK query.
Core crash or SIGKILL needs the Core's process ownership mechanism; native
conversation resume remains distinct from reconnecting a running process.

`stop_task` stops one task Claude runs by its task id: a shell started with
`run_in_background`, a monitor, a workflow, an MCP task, or a sub-agent. It calls
the SDK's `Query.stopTask()` and leaves the turn and every other task running.
CLI 2.1.280 acknowledges a stop of any id, whether running, already ended or never
seen (acceptance/t25/probe.mjs). So the acknowledgement says nothing; the task's
own `task_notification` with status `stopped` does. Core asks only for a task that
the connection's latest `background_tasks_changed` snapshot lists. The bridge does
not declare `perTaskStopAffordance`, so an interrupt still stops background tasks
as it did before.

Core keeps each such task on the call that started it (`backgroundTask`; a
sub-agent keeps `subAgent`), from Claude's task events:
- What is recorded: its status, its description, a summary when it ends, and the
  output file.
- A shell reports its start and its end, but no progress.
- An end after the turn ended still lands on its call.
- A task still running when the runtime ends becomes unknown. A resumed session
  may then report it ended itself: CLI 2.1.280 reported "Background shell command
  didn't finish before the previous session ended" as `stopped`.
- That report is about Claude's tracking, not the process. In the T-25 lab, the
  shell's own process was still running after Core restarted and Claude reported
  it stopped. Yuzuno shows what Claude reports and does not watch host processes.

The default configuration explicitly selects `permissionMode:"default"`, the
native Claude Code system-prompt preset, partial streaming messages, persistence,
and `settingSources:["user","project","local"]`. It passes
`--thinking-display summarized` so enabled thinking is shown as a summary; it
never sets `thinking`, because `{type:"adaptive"}` would override a user who
turned thinking off (checked with CLI 2.1.280, including `MAX_THINKING_TOKENS=0`).
Native config may pre-approve tools; `canUseTool` only receives calls that
reach native manual approval.
The UI must describe this as native Claude permissions, not Codex sandbox modes.

## On another machine (SSH)

A Claude Agent can run on a saved remote machine (Machines). The bridge is the
same; only its transport differs.

1. **Install.** Core uploads this runtime directory (its `.mjs` modules, package
   manifests and installed `node_modules`; no tests, no `.bin` links, no SDK
   platform CLI optional packages) as one archive. The bridge uses the remote
   machine's existing CLI, so Core's native CLI binaries are not transferred.
   This exclusion matches SDK 0.3.296's eight optional platform packages;
   dependency upgrades that change that layout need another archive check.
   It lands in `<data root>/claude-runtime/<sha256>/` on that machine
   (the machine's data root, `~/.yuzuno` unless the machine names another),
   unpacked privately and only once per content. Nothing global
   changes there: no npm, Node or Claude Code install, and no account. No
   credentials are sent.
2. **Run.** For each Agent, the remote helper starts `remote-host.mjs` from
   that directory, detached, in `<data root>/claude/<key>/` (owner-only,
   with a lock, and a PID checked by its start time). The host runs one
   `bridge.mjs` with the machine's own Node and its installed, logged-in Claude
   Code. Core reaches the host's private Unix socket through `ssh … python3`,
   which joins the session's stdin and stdout to the socket. Over that
   session the bridge protocol is exactly the local one. Workspace MCP comes
   through Core's existing reverse forward for that machine, as for a remote
   Codex.
   - Node and Claude Code are looked for in the data root's `bin` and
     `tools/*/bin` first, then on the SSH session's `PATH`, then in
     `~/.local/bin`, where Claude Code installs itself and which only login
     shells add. A direct bridge (the model catalog) runs with the PATH the
     helper resolved this way.
   - On a machine marked `contained`, the host and a direct bridge run with
     `CLAUDE_CONFIG_DIR`, `TMPDIR` and the XDG folders in private folders under
     the data root (`claude-config`, `tmp`, `xdg/*`), with the autoupdater off,
     so nothing of the session is written to that account's `~/.claude`. They
     are made when Claude is first installed or started there; a machine check
     before that creates nothing and does not run the CLI. Its Claude Code then
     needs its own login there; Core copies no credentials.
     No Codex Agent runs on such a machine, since Codex keeps its sessions in
     `~/.codex`. Without `contained`, the CLI's own login and folders are used,
     as before.
3. **Disconnects.** Closing the GUI does nothing: Core holds the SSH session.
   When the SSH session ends (network, Core stopped):
   - The turn that was running goes on on that machine.
   - An approval it is waiting for, or asks for later, is denied ("Yuzuno
     lost its connection …; not approved"), never allowed, so the turn can
     end.
   - If the bridge counts an approval it has not announced, which the host
     cannot name to deny, the host interrupts the turn once.
   - The bridge's frames meanwhile are not kept.
   - Core marks the turn's outcome unknown and says so.
   - Once the bridge is idle, the host closes it and exits.

   While that turn still runs, reconnecting is refused: two queries must never
   write one native session. After it ends, reconnecting starts a fresh host
   and bridge that resumes the **same native session**. Core then adds what
   Claude saved meanwhile (the late result) from that session's history. This
   is recovered history, not an event-by-event replay.
4. **Logs.** The host logs lifecycle events only (`host.log`: attached,
   detached, denied, stopping), never protocol content. The bridge's stderr
   tail is kept in `bridge.stderr` there.
5. **Login.** The CLI uses its own login on that machine, as SSH sessions see
   it. The machine check runs `claude auth status --json` there (no model
   call) and keeps only `loggedIn` and the method's name. When it reports "not
   logged in", the check says so.

   One possible reason is a login kept in the macOS Keychain, which an SSH
   session may not be able to read. Claude Code's
   [authentication guide](https://code.claude.com/docs/en/authentication)
   says that a login made where the Keychain is locked (such as in an SSH
   session) is stored in `~/.claude/.credentials.json` instead. It also lists
   the other methods: `claude setup-token` with `CLAUDE_CODE_OAUTH_TOKEN`, an
   `apiKeyHelper`, or an API key.

   Which method, and where its secret lives on that machine, is the user's
   choice. Yuzuno does not copy, unlock or configure any of them.

Remote images use the same native image blocks and per-image budget as local
Claude. Core retains the original for drafts and conversation previews and
copies the bounded send file over the existing authenticated SSH destination.
A failed transfer preserves the draft. Lost native submission receipts stay
unknown and are never automatically resent. Copies remain available while the
Agent exists, including after close and resume; deleting the Agent cleans only
its managed copies after the remote runtime is confirmed stopped. Cleanup waits
up to ten seconds for a closing host; if it cannot confirm this, it leaves the
closed Agent available for a later delete retry.
Core records the cleanup obligation durably before starting image transfer;
cancellation or a missing receipt retains it. Closed Agents with only uploaded
drafts and no transfer obligation can be deleted without SSH.
The remote cache is limited to 256 MiB per Agent. Identical send copies reuse
their path across reconnects. A full cache rejects new content without deleting
files that a resumed conversation might need.

Not supported on a remote machine in this slice:
- slash-command listing and MCP status;
- importing saved sessions;
- live re-attach to a turn after its SSH session ended.

## Evidence and references (checked 2026-10-12)

- [Official streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode):
  use a persistent async input iterator for conversation, approvals and interrupt.
- [Approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input):
  `canUseTool` covers approvals and `AskUserQuestion`; TypeScript provides an
  abort signal. We revoke pending UI actions when that signal fires.
- [Native session resume](https://code.claude.com/docs/en/agent-sdk/sessions):
  retain the exact native session ID and let Claude manage its transcript.
- [Official quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart):
  explicitly supports a separately installed binary using
  `pathToClaudeCodeExecutable`.
- [Published TypeScript package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk):
  0.3.296 published October 9; the installed `sdk.d.ts` is the exact API contract
  used here. The stable `query` API is used, not the removed V2 preview.
- [Official TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript):
  model discovery and changes reuse `Query.supportedModels()` and
  `Query.setModel(model?)`. The installed 0.3.296 declarations and implementation
  confirm that discovery reads initialization metadata and does not send an
  inference request. Available rows reflect the installed CLI, provider and
  account environment; listing a model is not a guarantee of remaining quota.
- [Official TypeScript repository](https://github.com/anthropics/claude-agent-sdk-typescript)
  and [Python repository](https://github.com/anthropics/claude-agent-sdk-python):
  both maintained. TypeScript was selected because it integrates naturally with
  the existing Node toolchain and exposes cancellation directly. The Python
  wrapper is MIT; the TypeScript package is governed by Anthropic's terms, so it
  is used as an official dependency, not copied into Rust.
- [Current subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):
  the October 7 update retains subscription-limit usage for SDK, print mode and
  third-party apps. We do not silently switch to API credits or billing.
- [Authentication boundaries](https://code.claude.com/docs/en/legal-and-compliance):
  distinguish an end user signing into their own unmodified Claude binary from
  developers collecting or relaying subscription credentials. The former is the
  personal local integration here. Yuzuno does not provide its own Claude OAuth
  flow or intermediate tokens. The SDK overview still contains a broader warning
  about offering third-party login; this implementation intentionally keeps the
  official installed binary and user-owned login boundary.
- [Open-source implementation comparison](../../docs/claude-reuse.md): maintained
  ACP and Happy integrations reinforce reuse of the official SDK. Their remote
  sync systems and credential-adjacent adaptations are outside this slice.

## Checks

`npm test` exercises turn ownership, initialization failure cleanup, late
approval rejection, immutable approval input, question answers and the race
between a native result and an outstanding interrupt acknowledgement. It also
covers native model metadata, catalog-only persistence/prompt boundaries,
between-turn model changes and pending/failed model control requests.

The isolated 2026-10-12 model-discovery check is recorded in
[`claude-model-catalog.json`](../../acceptance/agent-management/claude-model-catalog.json).
It returned five native catalog entries without a prompt, then confirmed the
bridge and all observed owned children exited. It did not access the daily Core
or send a model task.

`node live-smoke.mjs` is an **opt-in real model test** using the existing WSL
login. It uses Haiku, limits each query process to $1 accounting, disables
filesystem settings for the test, and writes only beneath
`acceptance/claude/runtime-task`. It verifies an actual Write approval, native
question answer, interrupt, process close, and native session resume. It saves
`results.json` and raw protocol evidence there. It never accesses the daily Core,
user GUI, shared root build outputs or existing native sessions.

The 2026-10-12 real run passed with installed Claude Code **2.1.280** and SDK
**0.3.296**. The interrupted turn reported `terminal_reason:"aborted_tools"` and
`subtype:"error_during_execution"`; its native session remained resumable. An
earlier fixture assumed a benign `sleep` would ask for permission. Native Claude
correctly auto-approved it, so the revised fixture explicitly requests Bash and
Write approval through SDK settings. Both the initial failed assumption and the
passing run are retained in the isolated evidence folder.
