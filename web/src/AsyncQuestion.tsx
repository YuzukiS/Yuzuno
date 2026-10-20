import { MessageSquare } from "lucide-react";
import type { MessageReceipt, NativeItem } from "./types";
import type { AnswerDraft } from "./pending-questions";

/** The single answer form, opened from either the dock or the original item. */
export function AsyncQuestion({
  item,
  draft,
  onChange,
  onSubmit,
  onAdd,
  receipt,
  sending,
  historical,
  disabled,
  storageError,
}: {
  item: NativeItem;
  draft: AnswerDraft;
  onChange: (answers: Record<number, string>) => void;
  onSubmit: () => void;
  onAdd?: () => void;
  receipt?: MessageReceipt;
  sending: boolean;
  historical: boolean;
  disabled: boolean;
  storageError: boolean;
}) {
  const answered = receipt?.status === "accepted";
  const inactive = /^(cancelled|canceled|expired)$/.test(item.status || "");
  const uncertain =
    receipt?.status === "uncertain" || receipt?.status === "unknown" || receipt?.status === "sending";
  const blocked = sending || answered || uncertain || disabled || inactive;
  const questions = item.questions || [];
  const incomplete = questions.some(
    (_, index) => !draft.answers[index]?.trim(),
  );
  return (
    <form
      className="async-question"
      onSubmit={(event) => {
        event.preventDefault();
        if (!historical && !blocked && !incomplete) onSubmit();
      }}
    >
      <div className="async-question-heading">
        <MessageSquare size={15} />
        <strong>A question for you</strong>
      </div>
      {historical && (
        <p className="question-state">
          Historical question · answer status unconfirmed. You can quote an
          answer in your draft; this does not mark the question answered.
        </p>
      )}
      {inactive && (
        <p className="question-state">This question is no longer active.</p>
      )}
      {questions.map((question, index) => (
        <fieldset key={index} disabled={blocked}>
          <legend>{question.title}</legend>
          {question.options?.map((option) => (
            <label className="answer-option" key={option}>
              <input
                type="radio"
                name={`async-${item.id}-${index}`}
                checked={draft.answers[index] === option}
                onChange={() => onChange({ ...draft.answers, [index]: option })}
              />
              <span>{option}</span>
            </label>
          ))}
          <input
            type="text"
            aria-label={`Your answer: ${question.title}`}
            placeholder={
              question.options?.length
                ? "Or write your own answer…"
                : "Your answer…"
            }
            value={
              question.options?.includes(draft.answers[index])
                ? ""
                : draft.answers[index] || ""
            }
            onChange={(event) =>
              onChange({ ...draft.answers, [index]: event.target.value })
            }
          />
        </fieldset>
      ))}
      <div className="async-question-footer">
        {!historical && (
          <button className="primary-button" disabled={blocked || incomplete}>
            {answered
              ? "Answer sent"
              : sending || receipt?.status === "sending"
                ? "Sending…"
                : uncertain
                  ? "Delivery unconfirmed"
                  : "Send answer"}
          </button>
        )}
        {!answered && !uncertain && (
          <button
            type="button"
            className="quiet-button"
            disabled={!onAdd || blocked || incomplete}
            onClick={onAdd}
          >
            Add answer to draft
          </button>
        )}
        <span className="answer-delivery">
          {answered
            ? "Submitted to the conversation."
            : uncertain
              ? "Reconnect to check delivery; no automatic resend."
              : historical
                ? "Only a reference in your ordinary draft."
                : disabled
                  ? "Reopen this conversation to answer."
                  : "Send directly, including while the agent is working."}
        </span>
      </div>
      {(draft.error || receipt?.error) && !answered && (
        <p role="alert" className="inline-error">
          {draft.error || receipt?.error}
        </p>
      )}
      {storageError && (
        <p role="alert" className="inline-error">
          This answer draft is kept in this window but could not be saved. Copy
          it before reloading.
        </p>
      )}
    </form>
  );
}
