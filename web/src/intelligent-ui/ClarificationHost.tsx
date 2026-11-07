import { createContext, useContext } from "react";
import { strings, useStrings } from "../i18n";
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

// Why a published form can't be answered here, in the interface language (T-189).
const hostText = strings({
  publish: "This form can't be answered here: ask the Agent to put it in a Home Ask.",
  readOnly: "This form is read-only. Open its original conversation to answer.",
  closed: "This Agent is closed. Reopen it to submit your saved answers.",
}, {
  publish: "这个表单不能在这里回答：请让 Agent 在 Home 里发一个提问。",
  readOnly: "这个表单是只读的。请打开它的原始会话来回答。",
  closed: "此 Agent 已关闭。重新打开它即可提交已保存的答案。",
});

export function PublishedClarification({ form }: { form: ClarificationProps }) {
  const t = useStrings(hostText);
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
    ? t.publish
    : !agent || host?.readOnly
      ? t.readOnly
      : agent.closedAt
        ? t.closed
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
