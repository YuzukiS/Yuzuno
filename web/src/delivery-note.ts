import { isCompacting } from "./conversation-blocks.ts";
import type { AgentDetail, MessageReceipt } from "./types";

/** Where a message Codex accepted into a running Turn (turn/steer) stands:
 * Codex answers the steer at once but adds the message to the conversation
 * only when it next continues that Turn, and may never add it if the Turn
 * ends first (Codex 0.162.1 reports neither). "waiting" while that Turn
 * runs; "endedUnconfirmed" once it has ended and the message has not been
 * seen in the conversation, which is not proof it never will be; null for
 * any other message or a Turn not known here. A preview is shown only while
 * its message is not in the conversation. */
export function steered(receipt: MessageReceipt, detail: AgentDetail | null): "waiting" | "endedUnconfirmed" | null {
  if (!detail || receipt.status !== "accepted" || !receipt.input.expectedTurnId) return null;
  if ((detail.agent.harness || "codex") !== "codex") return null;
  const id = receipt.turnId || receipt.input.expectedTurnId;
  // The Turn may be outside the shown window; the index lists every Turn.
  const status =
    detail.turns.find((turn) => turn.id === id)?.status ??
    detail.conversation?.index.find((turn) => turn.id === id)?.status;
  if (status === "inProgress") return "waiting";
  return status === "completed" || status === "interrupted" || status === "failed" ? "endedUnconfirmed" : null;
}

/** Whether the Turn a new Codex message started (turn/start) is compacting
 * the conversation: when an automatic compaction begins that Turn, Codex
 * 0.162.1 adds the message only after it (T-120). Only the receipt's own
 * Turn counts, and only as loaded here; a Turn not loaded proves nothing, so
 * the note stays as it is. A steer is `steered`'s. */
export function compacting(receipt: MessageReceipt, detail: AgentDetail | null): boolean {
  if (!detail || receipt.status !== "accepted" || receipt.input.expectedTurnId || !receipt.turnId) return false;
  if ((detail.agent.harness || "codex") !== "codex") return false;
  const turn = detail.turns.find((turn) => turn.id === receipt.turnId);
  return !!turn && isCompacting(turn);
}

/** The note on a message's delivery preview. Accepted is the harness's own
 * word, not Core's: Codex answered turn/start or turn/steer, Claude named it
 * in a turn, OpenCode stored it. Only the conversation's copy of it is still
 * on its way, except for a steer (see `steered`); while its Turn compacts
 * (see `compacting`), the note says that is what it waits on. */
export function deliveryNote(
  status: MessageReceipt["status"],
  harness: string | null,
  steer: "waiting" | "endedUnconfirmed" | null = null,
  compaction = false,
) {
  const name = harness ?? "the harness";
  if (steer === "waiting") return `Received by ${name} · added when its Turn continues`;
  if (steer === "endedUnconfirmed") return `Received by ${name} · Turn ended; message not yet confirmed in conversation`;
  if (compaction && status === "accepted") return `Received by ${name} · compacting conversation`;
  return {
    sending: "Sending…",
    queued: `Sent · waiting for ${name} to confirm`,
    accepted: harness ? `Received by ${harness} · syncing conversation` : "Sent · syncing conversation",
    rejected: "Not sent · draft kept",
    uncertain: "Delivery unconfirmed · draft kept",
    unknown: `Not confirmed by ${name} · not sent again`,
  }[status];
}
