import { useState, type MutableRefObject } from "react";
import { NoReplyError } from "./api";
import { useStrings } from "./i18n";
import { requestWords } from "./request-text";

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
  const t = useStrings(requestWords);
  return <p className="field-hint">{t.notSaved}</p>;
}

export function AnswerAgain({ onClick }: { onClick: () => void }) {
  const t = useStrings(requestWords);
  return (
    <button type="button" className="secondary-button" onClick={onClick}>
      {t.answerAgain}
    </button>
  );
}
