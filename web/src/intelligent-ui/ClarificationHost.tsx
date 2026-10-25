import { createContext, useContext } from "react";
import type { AgentDetail, MessageInput, MessageReceipt } from "../types";
import type { OutgoingMessage } from "../useConversationSend";
import { Clarification } from "./ClarificationForm";
import { clarificationMessage, type ClarificationProps } from "./clarification";
import { useResult } from "./ResultContext";

type Host = {
  /** The Workspace this window is in, "" until /api/workspace answers. Unsent
   * answers are attributed to it, and saved nowhere while it is unknown. */
  workspaceId: string;
  detail: AgentDetail | null;
  outgoing: OutgoingMessage[];
  pendingInputs: Record<string, MessageInput>;
  readOnly: boolean;
  submit: (
    text: string,
    question: null,
    images: readonly string[],
    answer: MessageInput["clarification"],
  ) => Promise<MessageReceipt | undefined>;
  refresh: () => void;
};
export const ClarificationHost = createContext<Host | null>(null);

export function PublishedClarification({ form }: { form: ClarificationProps }) {
  const host = useContext(ClarificationHost);
  const { identity, resultId } = useResult();
  const agent = host?.detail?.agent;
  const matches = (receipt: MessageReceipt) =>
    receipt.input.clarification?.resultId === resultId &&
    receipt.input.clarification?.formId === form.id;
  const stored = host?.detail?.messageReceipts?.filter(matches).at(-1);
  const local = host?.outgoing
    .filter(
      (message) => message.agentId === agent?.id && matches(message.receipt),
    )
    .at(-1)?.receipt;
  const pending = Object.values(host?.pendingInputs || {}).find(
    (input) =>
      input.clarification?.resultId === resultId &&
      input.clarification?.formId === form.id,
  );
  const receipt =
    stored && ["accepted", "unknown"].includes(stored.status)
      ? stored
      : local || stored;
  const delivery =
    receipt || (pending ? { input: pending, status: "uncertain" } : undefined);
  const blockedReason = !resultId
    ? "Ask the Agent to publish this form so your answers can be linked to the original conversation."
    : !agent || host?.readOnly
      ? "This form is read-only. Open its original conversation to answer."
      : agent.closedAt
        ? "This Agent is closed. Reopen it to submit your saved answers."
        : undefined;
  return (
    <Clarification
      identity={`${agent?.id || "read-only"}:${identity}`}
      draftIdentity={
        host?.workspaceId && agent
          ? JSON.stringify([host.workspaceId, agent.id, identity])
          : null
      }
      form={form}
      agentName={agent?.name || "the Agent"}
      blockedReason={blockedReason}
      delivery={
        delivery && {
          ...delivery,
          values: delivery.input.clarification?.answers,
        }
      }
      onCheck={host?.refresh}
      onSubmit={
        host && resultId && agent
          ? async (answers) => {
              await host.submit(
                clarificationMessage(resultId, form, answers),
                null,
                [],
                { resultId, formId: form.id, answers },
              );
            }
          : undefined
      }
    />
  );
}
