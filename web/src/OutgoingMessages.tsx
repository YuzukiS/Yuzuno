import { useState } from "react";
import { MessageContent } from "./MessageContent";
import { ImageAttachments } from "./ImageAttachments";
import { agentHarnessName } from "./machine-checks";
import { compacting, deliveryNote, steered } from "./delivery-note";
import { memo } from "react";
import type { AgentDetail } from "./types";
import type { OutgoingMessage } from "./useConversationSend";
import "./outgoing-messages.css";

// Previews the user hid. Hiding is not delivery: the receipt and the kept
// draft's message id stay, and nothing is sent again.
const hiddenKey = "yuzuno.hiddenDeliveries";
function loadHidden(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(hiddenKey) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// This is a delivery preview, not a fabricated native Turn or a read receipt.
// Native client IDs replace it as soon as the actual message reaches the UI.
export const OutgoingMessages = memo(function OutgoingMessages({
  agentId,
  messages,
  detail,
}: {
  agentId: string;
  messages: OutgoingMessage[];
  detail: AgentDetail | null;
}) {
  const [hidden, setHidden] = useState(loadHidden);
  const hide = (id: string) =>
    setHidden((current) => {
      const next = [...current.filter((h) => h !== id), id].slice(-200);
      try {
        localStorage.setItem(hiddenKey, JSON.stringify(next));
      } catch {
        /* Hidden for this page only. */
      }
      return next;
    });
  const nativeIds = new Set(
    detail?.turns.flatMap((turn) =>
      turn.items
        .filter((item) => item.type === "userMessage")
        .map((item) => item.clientId),
    ),
  );
  for (const id of detail?.conversation?.nativeClientIds || []) nativeIds.add(id);
  // The harness whose own evidence each state reports; unnamed until this
  // Agent's detail is shown.
  const shown = detail?.agent.id === agentId ? detail : null;
  const harness = shown ? agentHarnessName(shown.agent) : null;
  const pending = new Map((detail?.messageReceipts || [])
    .filter(r => !r.binding && (r.status === "sending" || r.status === "uncertain" || r.status === "queued" || (r.status === "accepted" && r.input.textBlocks !== undefined)))
    .map(receipt => [receipt.input.clientMessageId, { agentId, receipt }]));
  for (const message of messages) if (message.agentId === agentId) pending.set(message.receipt.input.clientMessageId, message);
  return [...pending.values()]
    .filter(
      (message) =>
        message.agentId === agentId &&
        !nativeIds.has(message.receipt.input.clientMessageId) &&
        !hidden.includes(message.receipt.input.clientMessageId),
    )
    .map(({ receipt: local }) => {
      const saved = detail?.messageReceipts?.find(
        (r) => r.input.clientMessageId === local.input.clientMessageId,
      );
      const receipt = saved && saved.status !== "sending" ? saved : local;
      const steer = steered(receipt, shown);
      const status = deliveryNote(receipt.status, harness, steer, !steer && compacting(receipt, shown));
      return (
        <div
          className="user-message outgoing-message"
          key={receipt.input.clientMessageId}
          data-client-message-id={receipt.input.clientMessageId}
        >
          <div className="message-label">
            <span className="you-avatar">Y</span>You{" "}
            <small role="status">{status}</small>
            {(receipt.status === "uncertain" || receipt.status === "unknown" || receipt.status === "rejected" || steer === "endedUnconfirmed") && (
              <button
                type="button"
                className="inline-link outgoing-hide"
                title="Hides this preview only. It is not marked as sent, and nothing is sent again."
                onClick={() => hide(receipt.input.clientMessageId)}
              >
                Hide
              </button>
            )}
          </div>
          <div className="user-text"><MessageContent text={receipt.input.text} blocks={receipt.input.textBlocks} /></div>
          <ImageAttachments images={(receipt.input.images || []).map(id => ({ id, agentId }))} />
        </div>
      );
    });
});
