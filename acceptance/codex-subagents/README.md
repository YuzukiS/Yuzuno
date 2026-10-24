# T-60: Codex sub-agents in their parent Turn

When a local Codex Agent starts its own native sub-agents, its parent Turn shows them as one small group, **Sub-agents · N**. Each row gives the child's name and its last known state. Opening a row reads that child's details from Codex. The group is read only: it creates, stops and takes over nothing.

## What Codex 0.162.1 provides

These facts come from the installed CLI. The App Server schema was generated both as the stable surface and with `--experimental`, and `ThreadItem` is identical in both. `multi_agent` is stable and on by default. Three real probe Turns then each started two sub-agents, ALPHA answering at once and BETA sleeping first.

- **Parent Turn Items, `subAgentActivity`:**
  - `kind: "started"` carries the call ID, `agentThreadId`, `agentPath` (`/root/alpha`), model and effort.
  - `kind: "completed"` (id `subagent-completed-<child turn id>`) arrives when that child's Turn ends.
  - `interacted` and `interrupted` also exist.
  - An Item's own `item/started` and `item/completed` events are one fact, not the child finishing.
  - Core already stores these Items in the parent Turn.
- **Child metadata, `thread/read`:**
  - the thread status (`active`, `idle`, `notLoaded`, `systemError`; idle is not a result);
  - `parentThreadId`;
  - `source.subAgent.thread_spawn`: parent, depth, path, nickname, role.
- **The child's latest Turn, `thread/turns/list` (summary):** its status (`inProgress`, `completed`, `failed`, `interrupted`) and its final answer.
- **Not provided:**
  - The goal the parent gave a child appears nowhere, so the details say so. The list uses Codex's nickname and path.
  - `thread/items/list` returns "not supported yet".
  - Ephemeral threads refuse Turn reads. Core's Agent threads are persisted.
- **Gap, tracked in T-63:** child-thread events arrive on the parent's connection and Core drops them as another thread's. A child's approval request is refused. That is unchanged here.

## What Yuzuno does

- **List** (`web/src/subagents.ts`, `SubAgentPanels.tsx`): one row per `agentThreadId`, in start order, de-duplicated by Item id. The state is the last activity kind:
  - started (status to confirm), ended, or interrupted;
  - `interacted` never changes it;
  - a parent Turn that ended without an ending leaves the child **unknown**.

  Success or failure is never read from the list. It comes from the child's own Turn status in its details.
- **Details** (`GET /api/agents/{id}/subagents/{threadId}`, `core/src/subagents.rs`): read only when a row is opened, or with **Read again**.
  - A thread is read only if Codex names this Agent's thread as its parent. That covers children in the stored Turns and those shown from earlier native history pages, which Core does not store.
  - It reads through the Agent's own connection, or the existing read-only session when the Agent is not connected.
  - It returns a small snapshot: thread status, latest Turn status and error, final answer (cut like other long fields), nickname, role, depth, path, model and thread ID.
  - Nothing is written, polled or copied per delta.
- The child's answer stays in its row and is never mixed into the Agent's reply. Each native Item keeps its `item-<id>` anchor.

## Real acceptance

The receipt, `target/t60/lab-1/receipt.json` (a generated result, so not committed), comes from a lab Core built from this source, on port 4474 with its own data folder. It drove one real Codex Agent and one message asking for two sub-agents in parallel.

| Step | Result |
|---|---|
| 10 s, one child ended, one not | ALPHA: `idle`, Turn `completed`, answer `ALPHA`. BETA: `active`, Turn `inProgress`, no answer. Both read live. |
| Parent Turn ended (59 s) | Both `completed` with their own answers. The Agent's reply was `ALPHA=ALPHA BETA=BETA`. No error on the Agent. |
| A thread ID that is not this Agent's child | Refused (400). The lab ran on 3af05d9, which refused it as unrecorded; since R1, Codex's own parent record decides. |
| Core restarted | All four activities still stored. Both details read from Codex history (Agent not connected), same Turns and answers. |
| Cleanup | All three lab threads archived. |

The probe transcripts and schemas stay under the project `target/t60/`.

## Checks

- **Core** (`core/src/subagents.rs`, scripted Codex):
  - a recorded child is read live with its state and answer;
  - a child only an earlier history page shows is read;
  - unknown, foreign-parent and malformed IDs are refused;
  - offline reads use history;
  - a long answer is cut.
- **Web:**
  - `subagents.test.mjs` covers rows, de-duplication, interacted after completion, missing ending, interrupted, status names and block placement;
  - `subagents-ui.test.mjs` runs the real Turn in JSDOM: two children, nothing read before opening, separate details, a failed child Turn, a read error and Read again, and no section without sub-agents.
