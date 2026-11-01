import type { HomeReplyOrigin, HomeReplySnapshot, NativeItem } from "../types";
import type { ProjectPanel } from "../home/types";

/**
 * A reply from Home (T-9), as Core's receipt names it: a user message Core
 * marked `home`, with the identity Core attached to it on reading the
 * conversation. Never from its text, which anyone could have typed.
 */
export function homeReplyOf(item: NativeItem): HomeReplyOrigin | null {
  if (item.type !== "userMessage" || item._yuzunoInput !== "home") return null;
  const home = item._yuzunoHome;
  return home && typeof home === "object" && typeof home.projectId === "string" ? home : null;
}

/** An answer a form field left empty. */
export const unanswered = (answer: string | string[]) =>
  Array.isArray(answer) ? answer.length === 0 : !answer.trim();

/**
 * What "Copy answer" copies: the answer as the card shows it (Dev 7, hr5),
 * never the message's protocol. A choice, then the user's words after a blank
 * line; or a form's fields in its order, `label: answer`, several options
 * joined, an empty one as `notAnswered`.
 */
export function answerText(snapshot: HomeReplySnapshot, notAnswered: string): string {
  if (snapshot.form)
    return snapshot.form.fields
      .map((field) => `${field.label}: ${unanswered(field.answer) ? notAnswered : Array.isArray(field.answer) ? field.answer.join(", ") : field.answer}`)
      .join("\n");
  return [snapshot.choice?.label, snapshot.text].filter((part): part is string => !!part).join("\n\n");
}

/**
 * What Home finds, on arrival, of the section a reply answered (T-9): Home
 * decides it then, from what it shows now, and never shows the current card
 * as the version answered.
 */
export type Arrival =
  /** A reply to the whole Project Brief: the project. */
  | { kind: "project" }
  /** Still the version answered. */
  | { kind: "unchanged" }
  /** A later version is live now. */
  | { kind: "changed"; current: number }
  | { kind: "resolved" }
  /** Its author removed it, or Home no longer has it at all. */
  | { kind: "removed" }
  /** A card the user marked seen, now in History. */
  | { kind: "history" }
  /** Its project is not on Home. */
  | { kind: "gone" };

export function arrivalOf(origin: HomeReplyOrigin, panel: ProjectPanel | undefined): Arrival {
  if (!panel) return { kind: "gone" };
  if (origin.key === null) return { kind: "project" };
  const live = [...panel.brief.sections, ...(panel.brief.teamSections ?? [])].find((s) => s.key === origin.key);
  if (live) return live.version === origin.version ? { kind: "unchanged" } : { kind: "changed", current: live.version };
  const past = panel.brief.history.filter((s) => s.key === origin.key).sort((a, b) => b.version - a.version)[0];
  if (past?.historyReason === "resolved") return { kind: "resolved" };
  if (past?.historyReason === "seen") return { kind: "history" };
  return { kind: "removed" };
}
