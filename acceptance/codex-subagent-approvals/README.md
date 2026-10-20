# T-63: a Codex sub-agent's approvals in its parent Agent

When a local Codex Agent's own sub-agent needs your approval to run a command or change files, the request now waits in the parent Agent's Pending. It says which sub-agent asks, and your answer goes back to that sub-agent's request only. Before, Core refused every request from a thread other than the Agent's own and left the error "收到其他或未知会话的请求". Permissions are unchanged: nothing is approved automatically, and the parent and child keep their own Codex settings.

## What Codex 0.162.1 sends

Two isolated protocol probes, each a lab folder and its own `codex app-server`, with approval policy `untrusted` and a read-only sandbox. Every thread was archived afterwards. They are kept under the project `target/t63/probe-1` and `probe-2`.

- A child's `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` arrive on the **parent's connection**, with the **child's** `threadId`, `turnId` and `itemId`. The request id is connection-wide (0, 1, …).
- About 5 s before that, the parent's Turn records the child: a `subAgentActivity` Item, kind `started`, with `agentThreadId` and `agentPath`. `thread/read` of the child gives `parentThreadId` = the parent.
- `serverRequest/resolved` names the child's thread and the request id.
- A command request offers `accept`, `acceptWithExecpolicyAmendment` and `cancel`; it offers no `decline`.
  - Accepting ran ALPHA's `touch alpha.txt`.
  - Refusing BETA's left no file.
- A child's file-change request names only its Item. The proposed changes (path, kind, diff) come about 100 ms earlier in the child's own `item/started` for that `fileChange` Item.
- Interrupting the parent interrupts a child that is waiting for approval about 3 s later. Codex then resolves the child's request itself.
- Other server requests in 0.162.1: `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`, `item/tool/call`, and the legacy `applyPatchApproval`/`execCommandApproval`. From a child, none of these is handled here.

## What Core does (`core/src/workspace.rs` `on_event`, `core/src/subagents.rs`)

- **The thread check stays.** An event whose thread is not the Agent's own is still refused or dropped. The only exceptions are a command or file approval, its resolution, and a `fileChange` Item's proposed changes, and only from a **direct child**: a thread that a `subAgentActivity` Item in this Agent's own stored Turns names. That is Codex's own record on the parent thread. Nothing is inferred from a path, a nickname or text. A child's own sub-agents are on the child's thread, so they never match.
- **The request** goes into the parent's Pending as usual, with `_subAgent` (thread, path, model). The parent shows **Waiting** while it waits for you.
- **The answer** goes back on the same connection to the child's request id, through the existing path:
  - a request from an older connection is refused;
  - a request already answered is not answered again;
  - only a decision the request offers is accepted.
- **Resolution** clears a pending request only when the request id and the thread both match. Another thread's resolution clears nothing, and that now also holds for the parent's own requests.
- **A reconnect** marks the child's request stale, like any other. When Codex asks again, it gets a new action token, so an answer meant for the old request never reaches the new one.
- **If Codex does not ask again:** after the reconnect or a reconcile, Core reads each stale child request's own Turn from Codex (`thread/turns/list` on the child). It drops the request only when Codex records that Turn as ended, as an ended Turn already supersedes the parent's own stale approvals. A child Turn that still runs, or a child Codex cannot read, keeps its request: stale, unanswerable and visible.
- **A child's file changes** are held in memory, out of the parent's record: 32 Items at most, 64 KiB of diff per request, cut on a character boundary. They are attached to the request as `_changes` and kept if Codex asks again after a reconnect.
- **Still refused, with an error that names the sub-agent:** a recorded child's questions, MCP elicitation, permission requests and tool calls. Their lifecycle differs and is left for later. The child's other events (its Items, output, Turn state) never enter the parent's Turns; T-60 reads them on demand.

## In the approval card (`web/src/components.tsx`)

- The card says "From sub-agent /root/alpha" and that your answer goes only to this sub-agent.
- A child's file change shows the held diffs inline, one per file, because the parent's "View proposed changes" link cannot find a child's Item. If none were held, the card says so and suggests declining unless you know what it will change.
- Cancel reads "Cancel sub-agent's turn".
- The parent's own requests look as before.

## Real lab

`target/t63/lab.py`, kept with its receipt under the project `target/t63/lab-2` and not committed. It runs a lab Core built from this branch on its own port, data folder and lab folder, with the real Codex. One Codex Agent is set to `untrusted` and a read-only sandbox. Its message asks for two sub-agents: ALPHA runs `touch alpha.txt` and BETA runs `touch beta.txt`. Every answer goes through the real HTTP API (`POST /api/requests/{id}/respond`), the same path as the button.

| Check | Result |
|---|---|
| Both children's requests in the parent's Pending | Two `item/commandExecution/requestApproval`, sources `/root/alpha` and `/root/beta`, each on a thread the parent's Turn records as its sub-agent. The parent showed **Waiting**. |
| ALPHA, allowed once | `alpha.txt` created. |
| BETA, cancelled (its request offers no decline) | No `beta.txt`; the parent's answer was `ALPHA=ALPHA-DONE BETA=BETA-DECLINED`. |
| A second answer to ALPHA's request | Refused, 400 "请求已失效或不存在". |
| After both | Nothing pending, no error on the parent, parent Turn completed. |
| The parent's own approval | Its `touch parent.txt` request has the parent's thread and no sub-agent source; allowed, and `parent.txt` was created. |
| Clean-up | All three lab threads archived. The only effects are `alpha.txt` and `parent.txt` in the lab folder. |

Only command approvals went through Core in this lab. A child's file-change approval was seen in probe 2, directly against Codex: accepted, `alpha.md` written. Core's handling of it (held diff, request, replay) is covered by the Core test, using the events the probe recorded; it was not run end to end through a lab Core.

The first run (`lab-1`) tested nothing. The lab sent an empty model with the settings, Core rejected them, and the Agent kept the default policy, so no command needed approval. The lab now takes the model from the Agent's catalog and stops if the settings are not saved.

## Checks

- **Core** (`core/src/subagent_requests_tests.rs`, with the events the probes recorded):
  - two children's requests in the parent's Pending, each answered to its own request id;
  - a repeat answer, and a decision the request does not offer, are refused;
  - a resolution only clears its own thread's request;
  - the parent's own request is unchanged;
  - a thread this Agent did not start, a child's question and a stranger's resolution are refused or ignored;
  - a child's other events stay out of the parent's Turns;
  - a reconnect: the old request is stale, the replay gets a new token, the old token cannot answer it, and nothing is sent to the old connection;
  - after a reconnect without a replay: only the request of a child Turn Codex shows as ended is dropped; a running Turn, an unreadable child and the parent's own request stay; a settle for an old connection changes nothing;
  - a child's file changes with its request, kept across a replay, a long diff cut and marked, nothing kept for a stranger.
- **Whole Core library:** 374 pass.
- **Web** (`web/tools/ui.test.mjs`): a child's command and file-change cards show their source, the inline change and the cancel label, and answer only their own request; the parent's own file-change card is unchanged. The full web suite (48 files) passes.

The yuzuno skill is unchanged: Agents use no new tool or step.
