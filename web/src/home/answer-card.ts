import type { HomeReplySnapshot } from "../types";
import type { Section } from "./types";

/** Closing quotes and brackets that may follow a question mark inside its sentence. */
const CLOSERS = "」』）)\"”’";

/**
 * A question as R-29's answer card reads it (YN-223, the design the user settled): its first sentence, through the
 * first question mark that ends one, as the heading, and what follows as the note under it, both whole. A full-width
 * ？ always ends a sentence; a ? only before a space or a line break, so a link's query or a version like "v2?x" stays
 * whole. No such mark, or nothing after it: the whole question is the heading.
 */
export function questionParts(question: string): { head: string; note: string } {
  const text = question.trim();
  const closers = `[${CLOSERS.replace(/[\]\\]/g, "\\$&")}]*`;
  const match = new RegExp(`^([\\s\\S]*?(?:？|\\?(?=${closers}\\s))${closers})\\s*([\\s\\S]+)$`).exec(text);
  return match ? { head: match[1], note: match[2].trim() } : { head: text, note: "" };
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
