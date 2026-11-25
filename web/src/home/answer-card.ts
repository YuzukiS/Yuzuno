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

/** A form field left empty (home-reply-model.ts `unanswered`: this module is read alone by its tests, so it has its own). */
const unanswered = (answer: string | string[]) => (Array.isArray(answer) ? answer.length === 0 : !answer.trim());

/** A form field's answer as words: an option's label, several joined by `list`. */
export const fieldAnswer = (answer: string | string[], list: string) => (Array.isArray(answer) ? answer.join(list) : answer);

/**
 * The answer card's one line (YN-230, R-41's design the user approved): what the user decided, as they filled it in.
 * A choice; a form's answered fields that pick options, in its order; a form with none of those, its first written
 * answer. Every other written answer, and the user's words beside a choice or a form's answers, is counted as a note
 * the record holds. Empty optional fields and the form's own wording (its title and labels) are never on it.
 * `words`: the line is the user's own words, Markdown, folded to its first lines.
 */
export type AnswerLine = { text: string; words: boolean; notes: number };

export function answerLine(snapshot: HomeReplySnapshot, join: { list: string; fields: string }): AnswerLine {
  const note = snapshot.text?.trim() ? 1 : 0;
  if (snapshot.form) {
    const answered = snapshot.form.fields.filter((field) => !unanswered(field.answer));
    const picks = answered.filter((field) => field.type !== "text" || Array.isArray(field.answer));
    const written = answered.filter((field) => !picks.includes(field));
    if (picks.length)
      return { text: picks.map((field) => fieldAnswer(field.answer, join.list)).join(join.fields), words: false, notes: written.length + note };
    if (written.length) return { text: String(written[0].answer), words: true, notes: written.length - 1 + note };
    return { text: snapshot.text ?? "", words: true, notes: 0 };
  }
  if (snapshot.choice) return { text: snapshot.choice.label, words: false, notes: note };
  return { text: snapshot.text ?? "", words: true, notes: 0 };
}

/** A form as an Ask's reply offers it, as far as its options go. */
type FormNow = { id: string; fields: { id: string; type: string; label: string; options: { label: string }[] }[] };
function formNow(form: unknown): FormNow | null {
  if (!form || typeof form !== "object") return null;
  const { id, fields } = form as { id?: unknown; fields?: unknown };
  if (typeof id !== "string" || !Array.isArray(fields)) return null;
  return {
    id,
    fields: fields.flatMap((field) => {
      const { id, type, label, options } = (field ?? {}) as { id?: unknown; type?: unknown; label?: unknown; options?: unknown };
      if (typeof id !== "string" || typeof type !== "string" || typeof label !== "string") return [];
      const labels = Array.isArray(options)
        ? options.flatMap((option) => (typeof option?.label === "string" ? [{ label: option.label as string }] : []))
        : [];
      return [{ id, type, label, options: labels }];
    }),
  };
}

/**
 * The options the user saw and did not choose (YN-230), for the record: the Ask's own options from the snapshot; and
 * a form's choice fields' other options, which the snapshot does not keep, read from the Ask's form only while it
 * is provably the one answered (`sameVersion`: its owner has not changed the Ask since the reply; the same form and
 * field), so nothing its owner wrote later is shown as what the user saw. `field`: the field they belong to.
 */
export function otherOptions(snapshot: HomeReplySnapshot, form: unknown, sameVersion: boolean): { field: string | null; labels: string[] }[] {
  const groups: { field: string | null; labels: string[] }[] = [];
  const own = (snapshot.options ?? []).filter((option) => option.id !== snapshot.choice?.id).map((option) => option.label);
  if (own.length) groups.push({ field: null, labels: own });
  const now = sameVersion && snapshot.form ? formNow(form) : null;
  if (!snapshot.form || !now || now.id !== snapshot.form.id) return groups;
  for (const field of snapshot.form.fields) {
    if (field.type === "text") continue;
    const offered = now.fields.find((f) => f.id === field.id && f.type === field.type && f.label === field.label);
    if (!offered) continue;
    const chosen = [field.answer].flat();
    const labels = offered.options.map((option) => option.label).filter((label) => !chosen.includes(label));
    if (labels.length) groups.push({ field: field.label, labels });
  }
  return groups;
}
