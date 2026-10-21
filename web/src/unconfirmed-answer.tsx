import { useState, type MutableRefObject } from "react";
import { NoReplyError } from "./api";

/** An answer to a native request that got no reply in time (T-170). Whether it
 * reached Core is not known, so the card stays closed and Core's record is
 * read again: a record that shows the answer sent locks the card as sent, as
 * any answer Core confirmed does. Answering again is the person's choice;
 * Core keeps only the first answer it records for a request. */
export function useUnconfirmedAnswer(refresh: () => void, answering: MutableRefObject<boolean>) {
  const [unconfirmed, setUnconfirmed] = useState(false);
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

export function AnswerAgain({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="secondary-button" onClick={onClick}>
      Answer again
    </button>
  );
}
