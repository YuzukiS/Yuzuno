import { useState } from "react";
import { MessageContent } from "./MessageContent";
import { ImageAttachments } from "./ImageAttachments";
import { agentHarnessName } from "./machine-checks";
import { compacting, deliveryNote, sendingInTurn, steered } from "./delivery-note";
import { memo } from "react";
import type { AgentDetail } from "./types";
import type { OutgoingMessage } from "./useConversationSend";
import { langTag, strings, useLanguage } from "./i18n";
import { formAnswer, SentFormAnswer } from "./intelligent-ui/SentFormAnswer";

// The previews' own words (T-189); the message and the harness's name as they are.
const text = strings({
  you: "You",
  hideTitle: "Hides this preview only. It is not marked as sent, and nothing is sent again.",
  hide: "Hide",
}, {
  you: "你",
  hideTitle: "只隐藏这条预览。它不会被标为已发送，也不会重新发送任何内容。",
  hide: "隐藏",
});
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
  const language = useLanguage();
  const t = text(language);
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
  // A new Claude message still sending that its Turn shows is shown there.
  const inTurn = sendingInTurn(detail, agentId, messages);
  return [...pending.values()]
    .filter(
      (message) =>
        message.agentId === agentId &&
        !nativeIds.has(message.receipt.input.clientMessageId) &&
        !inTurn.has(message.receipt.input.clientMessageId) &&
        !hidden.includes(message.receipt.input.clientMessageId),
    )
    .map(({ receipt: local }) => {
      const saved = detail?.messageReceipts?.find(
        (r) => r.input.clientMessageId === local.input.clientMessageId,
      );
      const receipt = saved && saved.status !== "sending" ? saved : local;
      const steer = steered(receipt, shown);
      const status = deliveryNote(receipt.status, harness, steer, !steer && compacting(receipt, shown), language);
      const content = <MessageContent text={receipt.input.text} blocks={receipt.input.textBlocks} />;
      // Answers to a published form, as the form's questions and labels (T-9).
      const answer = formAnswer(receipt.input.text, receipt);
      return (
        <div
          className="user-message outgoing-message"
          key={receipt.input.clientMessageId}
          data-client-message-id={receipt.input.clientMessageId}
        >
          <div className="message-label" lang={langTag(language)}>
            <span className="you-avatar">Y</span>{t.you}{" "}
            <small role="status">{status}</small>
            {(receipt.status === "uncertain" || receipt.status === "unknown" || receipt.status === "rejected" || steer === "endedUnconfirmed") && (
              <button
                type="button"
                className="inline-link outgoing-hide"
                title={t.hideTitle}
                onClick={() => hide(receipt.input.clientMessageId)}
              >
                {t.hide}
              </button>
            )}
          </div>
          <div className={answer ? "user-text user-form-answer" : "user-text"}>
            {answer ? (
              <SentFormAnswer agentId={agentId} answer={answer} text={receipt.input.text}>{content}</SentFormAnswer>
            ) : content}
          </div>
          <ImageAttachments images={(receipt.input.images || []).map(id => ({ id, agentId }))} />
        </div>
      );
    });
});
