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
  // A failed send may contain a large paste. Each Workspace's records are
  // read once per window, rather than parsing the full body again on every
  // composer keystroke, and they keep one object while this window lives:
  // leaving a Workspace and coming back hands a send that is still running
  // the same records the window is using, so settling it cannot write an old
  // snapshot over records added since. `App.tsx` has no Workspace id until
  // /api/workspace answers, and nothing is read while it has none.
  const buckets = useRef(new Map<string, Outbox>());
  function records(workspace: string): Outbox {
    let kept = buckets.current.get(workspace);
    if (!kept) {
      kept = workspace ? load(workspace) : {};
      buckets.current.set(workspace, kept);
    }
    return kept;
  }
  // Takes the records and the Workspace rather than reading them, so a send
  // still running after a move writes the records it started with, under the
  // Workspace it started in, and never this Workspace's records under the
  // other one's name. Nothing is written against a Workspace this window
  // does not know yet.
  const persist = (bucket: Outbox, workspace: string) => {
    if (!workspace) return;
    try {
      const file = readFile();
      if (Object.keys(bucket).length) file[workspace] = bucket;
      else delete file[workspace];
      localStorage.setItem(storageKey, JSON.stringify(file));
    } catch {
      /* In-memory retry protection still applies. */
    }
  };
  const loadedFor = useRef("");
  /**
   * Which Workspace each running send belongs to (T-195).
   *
   * A send can start before /api/workspace has answered. That is not another
   * Workspace: it is this connection, not yet named. When the name arrives
   * it is this send's, so its owner is filled in rather than replaced -- its
   * receipt is drawn, its page is read again, and the record that stops it
   * being sent twice becomes that Workspace's.
   *
   * The owner is a Workspace, not a count of changes: going to another
   * Workspace and back must find this send again, so that this Agent is
   * still shown as sending and a second one is still refused. A send is
   * drawn only while the Workspace it belongs to is the one on screen.
   */
  const owners = useRef(new Set<{ workspace: string }>());
  const current = useRef(workspaceId);
  current.current = workspaceId;
  /** `<workspace>\n<agent>`: one send at a time for one Agent of one
   * Workspace. The same Agent id in another Workspace is another Agent. */
  const inFlight = useRef(new Set<string>());
  const [sendingFor, setSendingFor] = useState<string[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>([]);
  // Once a native message is observed, discard its delivery preview. Keeping
  // it hidden only while its Turn is loaded would resurrect it after paging.
  const synchronized = useRef(new Set<string>());
  useEffect(() => {
    if (!workspaceId || loadedFor.current === workspaceId) return;
    const first = !loadedFor.current;
    loadedFor.current = workspaceId;
    if (first) {
      // This connection is named for the first time. Records this window
      // made while it was unnamed are this Workspace's: this window made
      // them, moments ago, and nothing was read from disk for them. They are
      // merged into its records -- a record of this window's is newer than
      // the same key on disk -- saved, and the sends still running for them
      // settle here. Nothing written by an earlier version or another window
      // is claimed this way; `load("")` reads nothing.
      // Every send still running under the unnamed connection is this
      // Workspace's, and so is the lock that keeps its Agent to one send.
      for (const owner of owners.current) if (!owner.workspace) owner.workspace = workspaceId;
      for (const lock of [...inFlight.current])
        if (lock.startsWith("\n")) {
          inFlight.current.delete(lock);
          inFlight.current.add(workspaceId + lock);
        }
      setSendingFor([...inFlight.current]);
      const unnamed = buckets.current.get("");
      buckets.current.delete("");
      if (unnamed && Object.keys(unnamed).length) {
        const mine = records(workspaceId);
        Object.assign(mine, unnamed);
        persist(mine, workspaceId);
      }
      return;
    }
    // The Core at this address now answers as another Workspace. A delivery
    // of a send made in the one before it is not this Workspace's to show,
    // and an Agent id can be the same in both. The sends themselves are not
    // cancelled and not sent again; their durable receipts stay with the
    // Workspace that has them, and are read from it (T-195).
    setOutgoing((messages) => (messages.length ? [] : messages));
    synchronized.current.clear();
  }, [workspaceId]);
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
  // A send that outlives a move to another Workspace does not draw its
  // delivery there: the preview would be of a message no one in this
  // Workspace sent, under an Agent id that can be the same in both (T-195).
  // Coming back to the Workspace it belongs to shows it again. The request
  // is not cancelled -- it may already have been delivered -- and it is not
  // sent again.
  const showReceipt = (receipt: MessageReceipt, owner: { workspace: string }) =>
    owner.workspace === current.current &&
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
  async function submit(text: string, question: QuestionSource | null = null, images: readonly string[] = [], clarification?: MessageInput["clarification"], textBlocks?: MessageInput["textBlocks"], skills: readonly SkillRef[] = []) {
    if (images.length && (harness !== "codex" && harness !== "claude" && harness !== "opencode")) throw new Error("Images are supported by Codex, Claude and OpenCode Agents.");
    if (skills.length && (harness !== "codex" || question || clarification)) throw new Error("Skills are sent only to a Codex Agent, in a new or follow-up message.");
    // Covers both the composer and answers to nonblocking model questions.
    // Native pending approvals use their own respond endpoint and stay usable.
    if (detail?.collaboration?.ready === false)
      throw new Error(detail.collaboration.error || "Reconnect to confirm the workspace collaboration connection. Your text is kept.");
    // This send belongs to the Workspace it starts in -- filled in if that
    // Workspace is named after it starts -- and to that Workspace's records,
    // whatever this window moves to while it runs. Sending, and the refusal
    // of a second send, are per Workspace and Agent together: the same Agent
    // id in another Workspace is another Agent, and neither its composer nor
    // its spinner is this send's business.
    const owner = { workspace: workspaceId };
    const lock = () => `${owner.workspace}\n${agentId}`;
    if (inFlight.current.has(lock()))
      throw new Error("A message is already being sent.");
    if (harness === "claude" && question)
      throw new Error("Claude answers in the conversation; reply with a new message.");
    const key = `${agentId}:${clarification ? `form:${clarification.resultId}:${clarification.formId}` : question ? `${question.turnId}:${question.itemId}` : "composer"}`;
    // Resolved when it is used, not captured: a send that starts before this
    // connection is named settles the records of the Workspace it turns out
    // to be in.
    const kept = () => records(owner.workspace);
    // Removed only if it is still this send's record. Another send for the
    // same Agent and slot may have replaced it, and that one is not this
    // send's to settle.
    const settle = () => {
      const bucket = kept();
      if (bucket[key]?.clientMessageId === input.clientMessageId) delete bucket[key];
      persist(bucket, owner.workspace);
    };
    // A message whose delivery became unknown is never sent again; sending
    // the same text after that is a new message with its own id.
    const previousInput = kept()[key];
    const previous = detail?.messageReceipts?.some(
      (r) => r.input.clientMessageId === previousInput?.clientMessageId && r.status === "unknown",
    )
      ? undefined
      : previousInput;
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
    kept()[key] = input;
    persist(kept(), owner.workspace);
    owners.current.add(owner);
    inFlight.current.add(lock());
    setSendingFor([...inFlight.current]);
    showReceipt({ input, status: "sending", turnId: null, error: null }, owner);
    let received = false;
    try {
      const receipt = await postWithin<MessageReceipt>(
        `/agents/${encodeURIComponent(agentId)}/messages`,
        input,
      );
      received = true;
      showReceipt(receipt, owner);
      // Only this Workspace's page is read again for it.
      if (owner.workspace === current.current) refresh();
      // Queued at Claude is sent (not yet read): the preview shows which.
      const sent = receipt.status === "accepted" || receipt.status === "queued";
      // Rejected and unknown are final: the draft stays, and sending it
      // again is a new message.
      if (sent || receipt.status === "rejected" || receipt.status === "unknown") {
        settle();
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
        settle();
        if (owner.workspace === current.current) {
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
          }, owner);
          settle();
        } else {
          showReceipt({
            input,
            status: "uncertain",
            turnId: null,
            error:
              "This retry paused for an update. The earlier delivery still needs confirmation; your draft is kept.",
          }, owner);
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
        }, owner);
      throw error;
    } finally {
      owners.current.delete(owner);
      inFlight.current.delete(lock());
      setSendingFor([...inFlight.current]);
    }
  }
  return {
    submit,
    sending: sendingFor.includes(`${workspaceId}\n${agentId}`),
    outgoing,
    pendingInputs: records(workspaceId),
  };
}
