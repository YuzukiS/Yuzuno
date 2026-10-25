import { sameMessageImages } from "./image-input";
import { useEffect, useRef, useState } from "react";
import { HttpError, postWithin } from "./api";
import type {
  AgentDetail,
  MessageInput,
  MessageReceipt,
  QuestionSource,
  SkillRef,
} from "./types";

const storageKey = "yuzuno.outbox";
export type OutgoingMessage = { agentId: string; receipt: MessageReceipt };
type Outbox = Record<string, MessageInput>;

/**
 * Which Workspace's unsent records these are (T-195). Two saved Workspaces
 * can sit at one address, and their Agents can share an id; one flat map
 * keyed by Agent alone let a retry in one Workspace reuse the other's client
 * message id, so Core would have deduplicated the two against each other and
 * one Workspace's message would never have arrived.
 *
 * The file is a Workspace's id to its records, each still keyed
 * `<agent>:<slot>` as before, so what this hook hands out is one Workspace's
 * bucket and nothing else: another Workspace's records are not reachable
 * rather than merely unread. Writing merges into the file, so a Workspace
 * open in another tab keeps its own.
 */
function readFile(): Record<string, unknown> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One message, as a record written before the outbox was kept per Workspace
 * sits at the top of the file. It says which Agent but not which Workspace,
 * so it is left exactly as it is and never read into one: handing it to
 * whichever Workspace is open would be attributing it by guesswork. Sending
 * that text again is then a new message with its own id, and Core still
 * never re-sends an input whose delivery is uncertain. */
const isMessage = (value: unknown): boolean =>
  !!value &&
  typeof value === "object" &&
  typeof (value as MessageInput).clientMessageId === "string";

function load(workspace: string): Outbox {
  if (!workspace) return {};
  const bucket = readFile()[workspace];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket) || isMessage(bucket)) return {};
  return Object.fromEntries(
    Object.entries(bucket as Record<string, unknown>).filter(([, input]) => isMessage(input)),
  ) as Outbox;
}

// Retain the same client id after an HTTP failure, including across a reload.
// Core owns durable delivery receipts and never re-sends an uncertain input.
export function useConversationSend(
  workspaceId: string,
  agentId: string,
  turnId: string | null,
  refresh: () => void,
  harness?: "codex" | "claude" | "opencode",
  detail?: AgentDetail | null,
) {
  // A failed send may contain a large paste. Load its retry record once,
  // rather than parsing the full body again on every composer keystroke.
  const [outbox] = useState<{ current: Outbox }>(() => ({ current: {} }));
  // `App.tsx` has no Workspace id until /api/workspace answers, so the
  // records are read when it is known -- once per Workspace, not per
  // keystroke -- and nothing is read while it is not. In-window memory is
  // this window's alone, so it is kept across a Workspace that goes unknown;
  // only what reaches or comes from disk is bound to a Workspace.
  const loadedFor = useRef("");
  useEffect(() => {
    if (!workspaceId || loadedFor.current === workspaceId) return;
    loadedFor.current = workspaceId;
    outbox.current = load(workspaceId);
  }, [workspaceId, outbox]);
  // Which Workspace this window is in now, for a send that is still running
  // from the one before it.
  const current = useRef(workspaceId);
  current.current = workspaceId;
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
  // `startedIn` is the Workspace the send belongs to. A send that outlives a
  // move to another Workspace does not draw its delivery there: the preview
  // would be of a message no one in this Workspace sent, under an Agent id
  // that can be the same in both (T-195). The request is not cancelled -- it
  // may already have been delivered -- and it is not sent again.
  const showReceipt = (receipt: MessageReceipt, startedIn: string) =>
    current.current === startedIn &&
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
  // Takes the records and the Workspace rather than reading them, so a send
  // still running after a move writes the records it started with, under the
  // Workspace it started in, and never this Workspace's records under the
  // other one's name. Nothing is written against a Workspace this window
  // does not know yet.
  const persist = (records: Outbox, workspace: string) => {
    if (!workspace) return;
    try {
      const file = readFile();
      if (Object.keys(records).length) file[workspace] = records;
      else delete file[workspace];
      localStorage.setItem(storageKey, JSON.stringify(file));
    } catch {
      /* In-memory retry protection still applies. */
    }
  };
  async function submit(text: string, question: QuestionSource | null = null, images: readonly string[] = [], clarification?: MessageInput["clarification"], textBlocks?: MessageInput["textBlocks"], skills: readonly SkillRef[] = []) {
    if (images.length && (harness !== "codex" && harness !== "claude")) throw new Error("Images are supported by Codex and Claude Agents.");
    if (skills.length && (harness !== "codex" || question || clarification)) throw new Error("Skills are sent only to a Codex Agent, in a new or follow-up message.");
    // Covers both the composer and answers to nonblocking model questions.
    // Native pending approvals use their own respond endpoint and stay usable.
    if (detail?.collaboration?.ready === false)
      throw new Error(detail.collaboration.error || "Reconnect to confirm the workspace collaboration connection. Your text is kept.");
    if (inFlight.current.has(agentId))
      throw new Error("A message is already being sent.");
    if (harness === "claude" && question)
      throw new Error("Claude answers in the conversation; reply with a new message.");
    const key = `${agentId}:${clarification ? `form:${clarification.resultId}:${clarification.formId}` : question ? `${question.turnId}:${question.itemId}` : "composer"}`;
    // This send belongs to the Workspace it starts in, and to that
    // Workspace's records, whatever this window moves to while it runs.
    const startedIn = workspaceId;
    const records = outbox.current;
    // A message whose delivery became unknown is never sent again; sending
    // the same text after that is a new message with its own id.
    const kept = records[key];
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
        && JSON.stringify(previous.skills ?? []) === JSON.stringify(skills)
        ? previous
        : {
            clientMessageId: crypto.randomUUID(),
            text,
            ...(textBlocks ? { textBlocks } : {}),
            ...(images.length ? { images: [...images] } : {}),
            ...(skills.length ? { skills: skills.map(({ name, path }) => ({ name, path })) } : {}),
            expectedTurnId: turnId,
            question,
            ...(clarification ? { clarification: structuredClone(clarification) } : {}),
          };
    records[key] = input;
    persist(records, startedIn);
    inFlight.current.add(agentId);
    setSendingFor([...inFlight.current]);
    showReceipt({ input, status: "sending", turnId: null, error: null }, startedIn);
    let received = false;
    try {
      const receipt = await postWithin<MessageReceipt>(
        `/agents/${encodeURIComponent(agentId)}/messages`,
        input,
      );
      received = true;
      showReceipt(receipt, startedIn);
      // Only this Workspace's page is read again for it.
      if (current.current === startedIn) refresh();
      // Queued at Claude is sent (not yet read): the preview shows which.
      const sent = receipt.status === "accepted" || receipt.status === "queued";
      // Rejected and unknown are final: the draft stays, and sending it
      // again is a new message.
      if (sent || receipt.status === "rejected" || receipt.status === "unknown") {
        delete records[key];
        persist(records, startedIn);
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
        delete records[key];
        persist(records, startedIn);
        if (current.current === startedIn) {
          setOutgoing(messages => messages.filter(m =>
            m.agentId !== agentId || m.receipt.input.clientMessageId !== input.clientMessageId));
          refresh();
        }
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
          }, startedIn);
          delete records[key];
          persist(records, startedIn);
        } else {
          showReceipt({
            input,
            status: "uncertain",
            turnId: null,
            error:
              "This retry paused for an update. The earlier delivery still needs confirmation; your draft is kept.",
          }, startedIn);
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
        }, startedIn);
      throw error;
    } finally {
      inFlight.current.delete(agentId);
      setSendingFor([...inFlight.current]);
    }
  }
  return { submit, sending: sendingFor.includes(agentId), outgoing, pendingInputs: outbox.current };
}
