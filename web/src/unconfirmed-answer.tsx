import { useState, type MutableRefObject } from "react";
import { NoReplyError } from "./api";

/** An answer to a native request that got no reply in time (T-170). Whether it
 * reached Core is not known, so the card stays closed and Core's record is
 * read again: a record that shows the answer sent locks the card as sent, as
 * any answer Core confirmed does. Answering again is the person's choice;
 * Core keeps only the first answer it records for a request. */
export function useUnconfirmedAnswer(refresh: () => void, answering: MutableRefObject<boolean>, initial = false) {
  // `initial`: such an answer from before a refresh (request-draft.ts).
  const [unconfirmed, setUnconfirmed] = useState(initial);
  return {
    unconfirmed,
    /** Whether it took the error; then the card stays closed. */
    noReply(error: unknown) {
      if (!(error instanceof NoReplyError)) return false;
      setUnconfirmed(true);
      refresh();
      return true;
    },
    answerAgain() {
      answering.current = false;
      setUnconfirmed(false);
    },
  };
}

/** A question card's draft that this browser could not save. */
export function DraftNotSaved() {
  return <p className="field-hint">This answer is kept in this window only; it could not be saved in this browser. Copy it before reloading.</p>;
}

export function AnswerAgain({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="secondary-button" onClick={onClick}>
      Answer again
    </button>
  );
}
