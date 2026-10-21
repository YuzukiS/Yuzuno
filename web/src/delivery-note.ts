import type { AgentDetail, MessageReceipt } from "./types";

/** Where a message Codex accepted into a running Turn (turn/steer) stands:
 * Codex answers the steer at once but adds the message to the conversation
 * only when it next continues that Turn, and never if the Turn ends first
 * (Codex 0.162.1 reports neither). "waiting" while that Turn runs, "dropped"
 * once it has ended; null for any other message or a Turn not known here.
 * A preview is shown only while its message is not in the conversation. */
export function steered(receipt: MessageReceipt, detail: AgentDetail | null): "waiting" | "dropped" | null {
  if (!detail || receipt.status !== "accepted" || !receipt.input.expectedTurnId) return null;
  if ((detail.agent.harness || "codex") !== "codex") return null;
  const id = receipt.turnId || receipt.input.expectedTurnId;
  // The Turn may be outside the shown window; the index lists every Turn.
  const status =
    detail.turns.find((turn) => turn.id === id)?.status ??
    detail.conversation?.index.find((turn) => turn.id === id)?.status;
  if (status === "inProgress") return "waiting";
  return status === "completed" || status === "interrupted" || status === "failed" ? "dropped" : null;
}

/** The note on a message's delivery preview. Accepted is the harness's own
 * word, not Core's: Codex answered turn/start or turn/steer, Claude named it
 * in a turn, OpenCode stored it. Only the conversation's copy of it is still
 * on its way, except for a steer (see `steered`). */
export function deliveryNote(
  status: MessageReceipt["status"],
  harness: string | null,
  steer: "waiting" | "dropped" | null = null,
) {
  const name = harness ?? "the harness";
  if (steer === "waiting") return `Received by ${name} · added when its Turn continues`;
  if (steer === "dropped") return `Received by ${name} · not added before its Turn ended`;
  return {
    sending: "Sending…",
    queued: `Sent · waiting for ${name} to confirm`,
    accepted: harness ? `Received by ${harness} · syncing conversation` : "Sent · syncing conversation",
    rejected: "Not sent · draft kept",
    uncertain: "Delivery unconfirmed · draft kept",
    unknown: `Not confirmed by ${name} · not sent again`,
  }[status];
}
