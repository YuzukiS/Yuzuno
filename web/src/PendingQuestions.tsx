import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from "lucide-react";
import { Modal } from "./components";
import { AsyncQuestion } from "./AsyncQuestion";
import { errorText } from "./api";
import {
  answerDraftKey,
  answerText,
  loadAnswerDraft,
  loadQuestionHandling,
  isPendingQuestion,
  questionDismissalKey,
  QuestionIndex,
  questionKey,
  questionReceipts,
  type AnswerDraft,
  type ConversationQuestion,
} from "./pending-questions";
import type {
  AgentDetail,
  MessageInput,
  MessageReceipt,
  QuestionSource,
} from "./types";
import type { OutgoingMessage } from "./useConversationSend";
import "./pending-questions.css";

export type PendingQuestionsHandle = { open: (source: QuestionSource) => void };
const noTurns: AgentDetail["turns"] = [];
const noReceipts: MessageReceipt[] = [];

export const PendingQuestions = memo(
  forwardRef<
    PendingQuestionsHandle,
    {
      agentId: string;
      workspaceId: string;
      detail: AgentDetail | null;
      shown: AgentDetail | null;
      known: ConversationQuestion[];
      outgoing: OutgoingMessage[];
      pendingInputs: Readonly<Record<string, MessageInput>>;
      disabled: boolean;
      onSend: (text: string, source: QuestionSource) => Promise<unknown>;
      onAdd: (text: string) => void;
      onSource: (source: QuestionSource) => void;
      onCheck: () => Promise<unknown>;
    }
  >((props, ref) => {
    const {
      agentId,
      workspaceId,
      detail,
      shown,
      outgoing,
      pendingInputs,
      known,
    } = props;
    const [shownIndex] = useState(() => new QuestionIndex());
    const visible = useMemo(
      () => shownIndex.read(shown?.turns || noTurns),
      [shownIndex, shown?.turns],
    );
    const sources = useMemo(() => new Set(known.map(questionKey)), [known]);
    const dismissalKey = questionDismissalKey(workspaceId, agentId);
    const [handling, setHandling] = useState(() =>
      loadQuestionHandling(dismissalKey),
    );
    const { dismissed, restored } = handling;
    const [dismissalError, setDismissalError] = useState("");
    function setDismissal(source: QuestionSource, hide: boolean) {
      const next = {
        dismissed: new Set(dismissed),
        restored: new Set(restored),
      };
      const key = questionKey(source);
      if (hide) {
        next.dismissed.add(key);
        next.restored.delete(key);
      } else {
        next.dismissed.delete(key);
        next.restored.add(key);
      }
      try {
        localStorage.setItem(
          dismissalKey,
          JSON.stringify({
            dismissed: [...next.dismissed],
            restored: [...next.restored],
          }),
        );
        setHandling(next);
        setDismissalError("");
      } catch {
        setDismissalError(
          "This change could not be saved. The question stays as it was; your answer draft is kept.",
        );
      }
    }
    const receipts = useMemo(
      () =>
        questionReceipts(
          agentId,
          detail?.messageReceipts || noReceipts,
          outgoing,
          pendingInputs,
        ),
      [agentId, detail?.messageReceipts, outgoing, pendingInputs],
    );
    const pending = useMemo(
      () =>
        known.filter(
          (q) =>
            !dismissed.has(questionKey(q)) &&
            isPendingQuestion(
              q,
              receipts.get(questionKey(q)),
              restored.has(questionKey(q)),
            ),
        ),
      [known, receipts, dismissed, restored],
    );
    const [selected, setSelected] = useState<string | null>(null);
    const [dockKey, setDockKey] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
    const [sending, setSending] = useState<string | null>(null);
    const submitting = useRef(false);
    const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(new Set());
    const returnFocus = useRef<HTMLElement | null>(null);
    const afterClose = useRef<(() => void) | null>(null);
    const dock = useRef<HTMLButtonElement>(null);
    const active =
      visible.find((q) => questionKey(q) === selected) ||
      known.find((q) => questionKey(q) === selected);
    const current =
      pending.find((q) => questionKey(q) === dockKey) || pending[0];
    const index = current ? pending.indexOf(current) : 0;
    const dockDraftKey =
      current && answerDraftKey(workspaceId, agentId, current);
    useEffect(() => {
      if (dockDraftKey)
        setDrafts((all) =>
          all[dockDraftKey]
            ? all
            : { ...all, [dockDraftKey]: loadAnswerDraft(dockDraftKey) },
        );
    }, [dockDraftKey]);
    const source = active && { turnId: active.turnId, itemId: active.itemId };
    const key = source && answerDraftKey(workspaceId, agentId, source);
    const draft = key
      ? drafts[key] || { answers: {}, error: "" }
      : { answers: {}, error: "" };
    const receipt = selected ? receipts.get(selected) : undefined;
    function open(source: QuestionSource) {
      const key = answerDraftKey(workspaceId, agentId, source);
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setDrafts((all) =>
        all[key] ? all : { ...all, [key]: loadAnswerDraft(key) },
      );
      setSelected(questionKey(source));
    }
    useImperativeHandle(ref, () => ({ open }));
    function save(key: string, next: AnswerDraft) {
      setDrafts((all) => ({ ...all, [key]: next }));
      try {
        localStorage.setItem(key, JSON.stringify(next));
        setUnsaved((keys) => {
          const next = new Set(keys);
          next.delete(key);
          return next;
        });
      } catch {
        setUnsaved((keys) => new Set(keys).add(key));
      }
    }
    async function submit() {
      if (
        !active ||
        !source ||
        !key ||
        submitting.current ||
        props.disabled ||
        !sources.has(questionKey(source))
      )
        return;
      submitting.current = true;
      const submitted = selected!;
      setSending(submitted);
      save(key, { ...draft, error: "" });
      try {
        await props.onSend(answerText(active.item, draft.answers), source);
        try {
          localStorage.removeItem(key);
        } catch {
          /* Retained draft is harmless: receipts own completion. */
        }
      } catch (error) {
        save(key, { ...draft, error: errorText(error) });
      } finally {
        submitting.current = false;
        setSending(null);
      }
    }
    function closeThen(action: () => void) {
      afterClose.current = action;
      setSelected(null);
    }
    return (
      <>
        {current && (
          <section
            className="pending-questions"
            aria-label="Questions to answer"
          >
            {current && (
              <div className="question-dock-row">
                <MessageSquare size={16} aria-hidden="true" />
                <button
                  type="button"
                  className="question-dock-open"
                  ref={dock}
                  onClick={() => open(current)}
                >
                  <strong>Questions to answer · {pending.length}</strong>
                  <span>{current.item.questions?.[0]?.title}</span>
                  {["uncertain", "unknown"].includes(
                    receipts.get(questionKey(current))?.status || "",
                  ) && <small>Delivery unconfirmed</small>}
                  {receipts.get(questionKey(current))?.status === "sending" && (
                    <small>Sending…</small>
                  )}
                  {!/^(sending|uncertain|unknown)$/.test(
                    receipts.get(questionKey(current))?.status || "",
                  ) &&
                    (receipts.get(questionKey(current))?.status ===
                      "rejected" ||
                      (dockDraftKey && drafts[dockDraftKey]?.error)) && (
                      <small>Answer needs attention · draft kept</small>
                    )}
                </button>
                <button
                  type="button"
                  className="quiet-button question-dismiss"
                  aria-label="Dismiss question"
                  title="Hide from questions to answer. Your question and draft stay in the conversation."
                  onClick={() => setDismissal(current, true)}
                >
                  Dismiss
                </button>
                {pending.length > 1 && (
                  <div
                    className="question-switcher"
                    aria-label="Choose a question"
                  >
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Previous question"
                      onClick={() =>
                        setDockKey(
                          questionKey(
                            pending[
                              (index + pending.length - 1) % pending.length
                            ],
                          ),
                        )
                      }
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span>
                      {index + 1}/{pending.length}
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Next question"
                      onClick={() =>
                        setDockKey(
                          questionKey(pending[(index + 1) % pending.length]),
                        )
                      }
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </div>
            )}
            {dismissalError && (
              <p role="alert" className="question-state">
                {dismissalError}
              </p>
            )}
          </section>
        )}
        <Modal
          open={!!active}
          onOpenChange={(open) => !open && setSelected(null)}
          title="Answer a question"
          description="Your answer draft stays with this question."
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const action = afterClose.current;
            afterClose.current = null;
            if (action) action();
            else if (returnFocus.current?.isConnected)
              returnFocus.current.focus({ preventScroll: true });
            else dock.current?.focus({ preventScroll: true });
          }}
        >
          {active && key && source && (
            <>
              <div className="question-dialog-actions">
                <button
                  type="button"
                  className="inline-link"
                  onClick={() => closeThen(() => props.onSource(source))}
                >
                  Original question <ArrowUpRight size={13} />
                </button>
                {known.some((q) => questionKey(q) === selected) &&
                  isPendingQuestion(active, receipt, true) && (
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() =>
                        setDismissal(
                          source,
                          !dismissed.has(questionKey(source)) &&
                            isPendingQuestion(
                              active,
                              receipt,
                              restored.has(questionKey(source)),
                            ),
                        )
                      }
                    >
                      {!dismissed.has(questionKey(source)) &&
                      isPendingQuestion(
                        active,
                        receipt,
                        restored.has(questionKey(source)),
                      )
                        ? "Dismiss question"
                        : "Restore to questions"}
                    </button>
                  )}
                {(receipt?.status === "unknown" ||
                  receipt?.status === "uncertain" ||
                  receipt?.status === "sending") && (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={sending === selected}
                    onClick={() =>
                      void props
                        .onCheck()
                        .catch((error) =>
                          save(key, { ...draft, error: errorText(error) }),
                        )
                    }
                  >
                    Check delivery
                  </button>
                )}
              </div>
              {dismissed.has(questionKey(source)) && (
                <p className="question-state">
                  Dismissed in this browser. The question and your draft are
                  kept; dismissal does not send an answer.
                </p>
              )}
              {dismissalError && (
                <p role="alert" className="question-state">
                  {dismissalError}
                </p>
              )}
              {active.historical && (
                <p className="question-state">
                  Historical question · answer status unconfirmed. You can open
                  and answer the original question here, or restore its
                  reminder.
                </p>
              )}
              <AsyncQuestion
                item={active.item}
                draft={draft}
                receipt={receipt}
                sending={sending === selected}
                historical={!sources.has(questionKey(source))}
                disabled={props.disabled}
                storageError={unsaved.has(key)}
                onChange={(answers) => save(key, { answers, error: "" })}
                onSubmit={() => void submit()}
                onAdd={() =>
                  closeThen(() =>
                    props.onAdd(answerText(active.item, draft.answers)),
                  )
                }
              />
            </>
          )}
        </Modal>
      </>
    );
  }),
);
