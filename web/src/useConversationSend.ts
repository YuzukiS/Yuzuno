import { sameMessageImages } from "./image-input";
import { useEffect, useRef, useState } from "react";
import { HttpError, post } from "./api";
import type {
  AgentDetail,
  MessageInput,
  MessageReceipt,
  QuestionSource,
} from "./types";

const storageKey = "yuzuno.outbox";
export type OutgoingMessage = { agentId: string; receipt: MessageReceipt };
function load(): Record<string, MessageInput> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

// Retain the same client id after an HTTP failure, including across a reload.
// Core owns durable delivery receipts and never re-sends an uncertain input.
export function useConversationSend(
  agentId: string,
  turnId: string | null,
  refresh: () => void,
  harness?: "codex" | "claude" | "opencode",
  detail?: AgentDetail | null,
) {
  // A failed send may contain a large paste. Load its retry record once,
  // rather than parsing the full body again on every composer keystroke.
  const [outbox] = useState(() => ({ current: load() }));
  const inFlight = useRef(new Set<string>());
  const [sendingFor, setSendingFor] = useState<string[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>([]);
  // Once a native message is observed, discard its delivery preview. Keeping
  // it hidden only while its Turn is loaded would resurrect it after paging.
  const synchronized = useRef(new Set<string>());
  useEffect(() => {
    if (!detail || detail.agent.id !== agentId) return;
    const ids = new Set<string>(detail.conversation?.nativeClientIds || []);
    for (const id of ids) synchronized.current.add(`${agentId}:${id}`);
    for (const turn of detail.turns) {
      for (const item of turn.items) {
        if (item.type === "userMessage" && typeof item.clientId === "string") {
          ids.add(item.clientId);
          synchronized.current.add(`${agentId}:${item.clientId}`);
        }
      }
    }
    if (!ids.size) return;
    setOutgoing((messages) => {
      const remaining = messages.filter(
        (message) =>
          message.agentId !== agentId ||
          !ids.has(message.receipt.input.clientMessageId),
      );
      return remaining.length === messages.length ? messages : remaining;
    });
  }, [agentId, detail]);
  const showReceipt = (receipt: MessageReceipt) =>
    setOutgoing((messages) => {
      if (
        synchronized.current.has(`${agentId}:${receipt.input.clientMessageId}`)
      )
        return messages;
      const next = { agentId, receipt };
      const index = messages.findIndex(
        (m) =>
          m.agentId === agentId &&
          m.receipt.input.clientMessageId === receipt.input.clientMessageId,
      );
      return index < 0
        ? [...messages, next]
        : messages.map((m, i) => (i === index ? next : m));
    });
  const persist = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(outbox.current));
    } catch {
      /* In-memory retry protection still applies. */
    }
  };
  async function submit(text: string, question: QuestionSource | null = null, images: readonly string[] = [], clarification?: MessageInput["clarification"], textBlocks?: MessageInput["textBlocks"]) {
    if (images.length && (harness !== "codex" && harness !== "claude")) throw new Error("Images are supported by Codex and Claude Agents.");
    // Covers both the composer and answers to nonblocking model questions.
    // Native pending approvals use their own respond endpoint and stay usable.
    if (detail?.collaboration?.ready === false)
      throw new Error(detail.collaboration.error || "Reconnect to confirm the workspace collaboration connection. Your text is kept.");
    if (inFlight.current.has(agentId))
      throw new Error("A message is already being sent.");
    if (harness === "claude" && question)
      throw new Error("Claude answers in the conversation; reply with a new message.");
    const key = `${agentId}:${clarification ? `form:${clarification.resultId}:${clarification.formId}` : question ? `${question.turnId}:${question.itemId}` : "composer"}`;
    // A message whose delivery became unknown is never sent again; sending
    // the same text after that is a new message with its own id.
    const kept = outbox.current[key];
    const previous = detail?.messageReceipts?.some(
      (r) => r.input.clientMessageId === kept?.clientMessageId && r.status === "unknown",
    )
      ? undefined
      : kept;
    // Presentation edits cannot create a second native send after response loss.
    // A retry retains the original receipt payload and its display boundaries.
    const input: MessageInput =
      previous?.text === text && sameMessageImages(previous.images, images)
        && JSON.stringify(previous.clarification) === JSON.stringify(clarification)
        ? previous
        : {
            clientMessageId: crypto.randomUUID(),
            text,
            ...(textBlocks ? { textBlocks } : {}),
            ...(images.length ? { images: [...images] } : {}),
            expectedTurnId: turnId,
            question,
            ...(clarification ? { clarification: structuredClone(clarification) } : {}),
          };
    outbox.current[key] = input;
    persist();
    inFlight.current.add(agentId);
    setSendingFor([...inFlight.current]);
    showReceipt({ input, status: "sending", turnId: null, error: null });
    let received = false;
    try {
      const receipt = await post<MessageReceipt>(
        `/agents/${encodeURIComponent(agentId)}/messages`,
        input,
      );
      received = true;
      showReceipt(receipt);
      refresh();
      // Queued at Claude is sent (not yet read): the preview shows which.
      const sent = receipt.status === "accepted" || receipt.status === "queued";
      // Rejected and unknown are final: the draft stays, and sending it
      // again is a new message.
      if (sent || receipt.status === "rejected" || receipt.status === "unknown") {
        delete outbox.current[key];
        persist();
      }
      if (!sent)
        throw new Error(
          receipt.error ||
            "Delivery is not confirmed. Reconnect to check; this message will not be sent twice.",
        );
      return receipt;
    } catch (error) {
      if (!received && error instanceof HttpError && error.code === "message_not_submitted") {
        received = true;
        delete outbox.current[key];
        persist();
        setOutgoing(messages => messages.filter(m =>
          m.agentId !== agentId || m.receipt.input.clientMessageId !== input.clientMessageId));
        refresh();
      } else if (
        !received &&
        error instanceof HttpError &&
        error.message.startsWith("workspace_updating:")
      ) {
        if (previous?.clientMessageId !== input.clientMessageId) {
          // Core's admission fence rejects this fresh input before native work
          // or a send receipt exists. A lost earlier attempt stays uncertain.
          received = true;
          showReceipt({
            input,
            status: "rejected",
            turnId: null,
            error: error.message,
          });
          delete outbox.current[key];
          persist();
        } else {
          showReceipt({
            input,
            status: "uncertain",
            turnId: null,
            error:
              "This retry paused for an update. The earlier delivery still needs confirmation; your draft is kept.",
          });
          throw new Error(
            "The update paused this retry. Reconnect afterward to confirm the earlier delivery; it has not been sent again.",
          );
        }
      }
      if (!received)
        showReceipt({
          input,
          status: "uncertain",
          turnId: null,
          error: "Reconnect to confirm delivery. Your draft is kept.",
        });
      throw error;
    } finally {
      inFlight.current.delete(agentId);
      setSendingFor([...inFlight.current]);
    }
  }
  return { submit, sending: sendingFor.includes(agentId), outgoing, pendingInputs: outbox.current };
}
