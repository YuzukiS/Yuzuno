import type {
  MessageInput,
  MessageReceipt,
  NativeItem,
  NativeTurn,
  QuestionSource,
} from "./types";

export type ConversationQuestion = QuestionSource & {
  item: NativeItem;
  historical?: boolean;
};
export const questionKey = (source: QuestionSource) =>
  JSON.stringify([source.turnId, source.itemId]);
export const isQuestion = (item: NativeItem) =>
  item.type === "agentMessage" &&
  item.delivery === "async" &&
  !!item.questions?.length;

/** Import provenance alone says nothing about a later Yuzuno send attempt. */
export const isPendingQuestion = (
  question: ConversationQuestion,
  receipt?: MessageReceipt,
  restored = false,
) =>
  (!question.historical || !!receipt || restored) &&
  receipt?.status !== "accepted" &&
  !/^(cancelled|canceled|expired)$/.test(question.item.status || "");

/** Immutable Turns let streaming updates reuse the question projection of all
 * untouched history. Never inspect message bodies or reparse stored drafts. */
export class QuestionIndex {
  private turns = new WeakMap<NativeTurn, ConversationQuestion[]>();
  private previous: ConversationQuestion[] = [];
  read(turns: readonly NativeTurn[]) {
    const next = turns.flatMap((turn) => {
      let found = this.turns.get(turn);
      if (!found) {
        found = turn.items.filter(isQuestion).map((item) => ({
          turnId: turn.id,
          itemId: item.id,
          item,
          historical: turn._yuzunoImportedQuestions === true,
        }));
        this.turns.set(turn, found);
      }
      return found;
    });
    if (
      next.length === this.previous.length &&
      next.every(
        (q, i) =>
          q.item === this.previous[i].item &&
          q.turnId === this.previous[i].turnId &&
          q.historical === this.previous[i].historical,
      )
    )
      return this.previous;
    return (this.previous = next);
  }
}

/** A native accepted receipt wins over stale local previews. For the same
 * attempt, a durable terminal receipt also resolves a lost HTTP response. */
export function questionReceipts(
  agentId: string,
  durable: readonly MessageReceipt[],
  outgoing: readonly { agentId: string; receipt: MessageReceipt }[],
  pendingInputs: Readonly<Record<string, MessageInput>>,
) {
  const attempts = new Map<string, MessageReceipt>();
  for (const [key, input] of Object.entries(pendingInputs)) {
    if (key.startsWith(agentId + ":") && input.question)
      attempts.set(input.clientMessageId, {
        input,
        status: "uncertain",
        turnId: null,
        error: "Reconnect to check delivery; no automatic resend.",
      });
  }
  for (const { agentId: owner, receipt } of outgoing)
    if (owner === agentId) attempts.set(receipt.input.clientMessageId, receipt);
  for (const receipt of durable) {
    const local = attempts.get(receipt.input.clientMessageId);
    if (
      !local ||
      receipt.status === "accepted" ||
      receipt.status === "rejected" ||
      receipt.status === "unknown"
    )
      attempts.set(receipt.input.clientMessageId, receipt);
  }
  const sources = new Map<string, MessageReceipt>();
  for (const receipt of attempts.values()) {
    if (!receipt.input.question) continue;
    const key = questionKey(receipt.input.question);
    const old = sources.get(key);
    if (old?.status === "accepted") continue;
    if (
      receipt.status === "accepted" ||
      !old ||
      old.status === "rejected" ||
      receipt.status !== "rejected"
    )
      sources.set(key, receipt);
  }
  return sources;
}

export type AnswerDraft = { answers: Record<number, string>; error: string };
export const answerDraftKey = (
  workspaceId: string,
  agentId: string,
  source: QuestionSource,
) =>
  "yuzuno.question-draft.v1:" +
  JSON.stringify([workspaceId, agentId, source.turnId, source.itemId]);
export function loadAnswerDraft(key: string): AnswerDraft {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return {
      answers: Object.fromEntries(
        Object.entries(value?.answers || {}).filter(
          (entry): entry is [string, string] =>
            /^\d+$/.test(entry[0]) && typeof entry[1] === "string",
        ),
      ),
      error: typeof value?.error === "string" ? value.error : "",
    };
  } catch {
    return { answers: {}, error: "" };
  }
}

export const answerText = (item: NativeItem, answers: Record<number, string>) =>
  (item.questions || [])
    .map(
      (question, index) =>
        `Regarding your question “${question.title}”:\n${answers[index]?.trim() || ""}`,
    )
    .join("\n\n");

/** Local handling, separate from both answer drafts and native receipts. */
export const questionDismissalKey = (workspaceId: string, agentId: string) =>
  "yuzuno.question-dismissed.v1:" + JSON.stringify([workspaceId, agentId]);
export function loadQuestionHandling(key: string): {
  dismissed: ReadonlySet<string>;
  restored: ReadonlySet<string>;
} {
  function keys(value: unknown): ReadonlySet<string> {
    return new Set(
      Array.isArray(value)
        ? value.filter((entry): entry is string => {
            if (typeof entry !== "string") return false;
            try {
              const source = JSON.parse(entry);
              return (
                Array.isArray(source) &&
                source.length === 2 &&
                source.every((id) => typeof id === "string")
              );
            } catch {
              return false;
            }
          })
        : [],
    );
  }
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return {
      dismissed: keys(Array.isArray(value) ? value : value?.dismissed),
      restored: keys(value?.restored),
    };
  } catch {
    return { dismissed: new Set(), restored: new Set() };
  }
}
