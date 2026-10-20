import type { MessageReceipt, NativeItem } from "./types";

/** Original question remains readable; its only editor lives in the dock dialog. */
export function QuestionAnchor({
  item,
  registered,
  historical,
  receipt,
  onOpen,
}: {
  item: NativeItem;
  registered: boolean;
  historical?: boolean;
  receipt?: MessageReceipt;
  onOpen?: () => void;
}) {
  return (
    <div className="question-anchor">
      <strong>A question for you</strong>
      {(!registered || historical) && (
        <p className="question-state">
          Historical question · answer status unconfirmed
        </p>
      )}
      {item.questions?.map((question, i) => (
        <div key={i}>
          <p>{question.title}</p>
          {!!question.options?.length && (
            <ul>
              {question.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {receipt?.status === "accepted" && (
        <p className="question-state">Answer sent</p>
      )}
      {receipt && ["sending", "uncertain", "unknown"].includes(receipt.status) && (
        <p className="question-state">{receipt.status === "sending" ? "Sending answer…" : "Delivery unconfirmed"}</p>
      )}
      <button
        type="button"
        className="quiet-button"
        disabled={!onOpen}
        onClick={onOpen}
      >
        {registered ? "View question and answer" : "View historical question"}
      </button>
    </div>
  );
}
