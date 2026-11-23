import type { HomeReplySnapshot } from "../types";
import type { Section } from "./types";

/** Closing quotes and brackets that may follow a question mark inside its sentence. */
const CLOSERS = "」』）)\"”’";
const closers = `[${CLOSERS}]*`;
/** A mark that ends a question: a full-width ？, or a ? before a space or a line break (so a link's query stays whole). */
const ENDS = new RegExp(`(?:？|\\?(?=${closers}\\s))${closers}`, "g");

/**
 * A question as R-29's answer card reads it (YN-223, the design the user settled): the question whole, word for word.
 * Only where it is plainly one question and a note after it, its one question mark, a note following it and no link
 * in it, is the question set as the heading and the note under it, both exactly as written; otherwise (several
 * questions, no question mark, nothing after it, a link) the whole is the heading.
 */
export function questionParts(question: string): { head: string; note: string } {
  const text = question.trim();
  const whole = { head: text, note: "" };
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(text)) return whole;
  const ends = [...text.matchAll(ENDS)];
  // A ? anywhere else is a question mark too: one more is a second question.
  const marks = (text.match(/[？?]/g) ?? []).length;
  if (ends.length !== 1 || marks !== 1) return whole;
  const at = ends[0].index! + ends[0][0].length;
  const note = text.slice(at).trim();
  return note ? { head: text.slice(0, at), note } : whole;
}

/**
 * What an answered Ask's card shows (YN-223): the reply as the user gave it to this version, from the snapshot Core
 * kept with it, with the question they answered; or, for a reply from before Core kept one, its text as sent and the
 * question the Ask has now, said as such. Nothing is read back from the reply's text: a choice is shown as chosen
 * only from the snapshot.
 */
export type AnswerShown = {
  /** The question shown, and whether it is the one the user answered (`questionKept`) or the Ask's now. */
  question: string;
  questionKept: boolean;
} & ({ snapshot: HomeReplySnapshot } | { snapshot: null; text: string });

export function answerShown(ask: NonNullable<Section["ask"]>, text: string): AnswerShown {
  const snapshot = ask.replySnapshot;
  if (snapshot && snapshot.format === 1 && (snapshot.choice || snapshot.text || snapshot.form))
    return typeof snapshot.question === "string"
      ? { question: snapshot.question, questionKept: true, snapshot }
      : { question: ask.question, questionKept: false, snapshot };
  return { question: ask.question, questionKept: false, snapshot: null, text };
}

/** The options the user saw, each marked when it was the one chosen: from the snapshot only. */
export function optionsThen(snapshot: HomeReplySnapshot): { id: string; label: string; chosen: boolean }[] {
  return (snapshot.options ?? []).map((option) => ({ ...option, chosen: snapshot.choice?.id === option.id }));
}
