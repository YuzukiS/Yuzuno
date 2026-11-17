import type { HomeReplyOrigin, HomeReplySnapshot, NativeItem } from "../types";
import type { ProjectPanel, Section } from "../home/types";

/**
 * A reply from Home (T-9), as Core's receipt names it: a user message Core
 * marked `home`, with the identity Core attached to it on reading the
 * conversation, or Core's preview of one too large for the window, which
 * keeps both (YN-201). Never from its text, which anyone could have typed.
 */
export function homeReplyOf(item: NativeItem): HomeReplyOrigin | null {
  if (item.type === "userMessage" ? item._yuzunoInput !== "home" : !homeReplyPreview(item)) return null;
  return homeOrigin(item);
}

const homeOrigin = (item: NativeItem): HomeReplyOrigin | null => {
  const home = item._yuzunoHome;
  return home && typeof home === "object" && typeof home.projectId === "string" ? home : null;
};

/** Core's preview of a user message too large for the conversation's window
 * (conversation_window.rs `bounded_item`): its text is only a start, and the
 * whole message is read from its original. */
export const messagePreview = (item: NativeItem) =>
  item.type === "historyPreview" && item._yuzunoWindowPreview?.type === "userMessage";

/** Core's preview of a reply from Home, which keeps the reply's `_yuzunoHome`
 * (YN-201): as Core marked it, never from its text. */
export const homeReplyPreview = (item: NativeItem) =>
  messagePreview(item) && item._yuzunoInput === "home" && !!homeOrigin(item);

/**
 * How much of the user's words is drawn while they are folded (YN-201):
 * about five times what the six lines shown of the widest card hold (44rem
 * at a line height of 1.75, home-reply.css: some 240 CJK or 540 Latin
 * characters), and enough source lines for a table's header and rule to
 * still fill six. Shown all, the whole text is drawn.
 */
export const FOLD_LINES = 24;
export const FOLD_CHARS = 3000;

/** The start of `text` drawn while folded: whole lines, at most FOLD_LINES
 * of them and FOLD_CHARS in all; a first line longer than that is cut at
 * FOLD_CHARS, never inside a character. */
export function foldSource(text: string): string {
  let end = 0;
  for (let line = 0; line < FOLD_LINES && end < text.length; line++) {
    const next = text.indexOf("\n", end);
    const stop = next < 0 ? text.length : next + 1;
    if (stop > FOLD_CHARS) break;
    end = stop;
  }
  if (end > 0 || text.length <= FOLD_CHARS) return text.slice(0, end || text.length);
  const high = text.charCodeAt(FOLD_CHARS - 1);
  return text.slice(0, high >= 0xd800 && high < 0xdc00 ? FOLD_CHARS - 1 : FOLD_CHARS);
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
 * decides it then, from what it shows now. It says what became of that
 * section only from a record that is provably that section's, and never
 * shows the current card as the version answered.
 */
export type Arrival =
  /** A reply to the whole Project Brief: the project. */
  | { kind: "project" }
  /** Still the version answered. */
  | { kind: "unchanged" }
  /** The same section, at a later version now. */
  | { kind: "changed"; current: number }
  | { kind: "resolved" }
  | { kind: "removed" }
  /** A card archived when its task ended (YN-86 S2a), now in History. */
  | { kind: "archived" }
  /** A card whose author the user no longer lists as a lead (YN-195), now in History. */
  | { kind: "leadLeft" }
  /** A card the user marked seen, now in History. */
  | { kind: "history" }
  /** Home has no record that is provably that section's (its History may
   * have expired, or the reply predates Core naming its section). `current`:
   * the version under its key now, which may be another section. */
  | { kind: "unknown"; current: number | null }
  /** Its project is not on Home. */
  | { kind: "gone" };

export function arrivalOf(origin: HomeReplyOrigin, panel: ProjectPanel | undefined): Arrival {
  if (!panel) return { kind: "gone" };
  if (origin.key === null) return { kind: "project" };
  const live = [...panel.brief.sections, ...(panel.brief.teamSections ?? [])].find((s) => s.key === origin.key);
  const past = panel.brief.history.filter((s) => s.key === origin.key);
  const ended = (section: Section): Arrival =>
    section.historyReason === "resolved" ? { kind: "resolved" } : section.historyReason === "seen" ? { kind: "history" }
      : section.historyReason === "archived" ? { kind: "archived" }
        : section.historyReason === "lead-left" ? { kind: "leadLeft" } : { kind: "removed" };
  const unknown: Arrival = { kind: "unknown", current: live?.version ?? null };
  if (typeof origin.sectionId === "number") {
    // The section answered, by its identity: the same through every edit,
    // a resolve and a seen card written again; another for a key written anew.
    if (live?.id === origin.sectionId) return live.version === origin.version ? { kind: "unchanged" } : { kind: "changed", current: live.version };
    const own = past.filter((s) => s.id === origin.sectionId).sort((a, b) => b.version - a.version)[0];
    return own ? ended(own) : unknown;
  }
  // No identity recorded: only the very version is provably the one answered
  // (versions never repeat under a key; removing or marking seen keeps it).
  if (live?.version === origin.version) return { kind: "unchanged" };
  const same = past.find((s) => s.version === origin.version);
  return same ? ended(same) : unknown;
}

/** Whether Home shows the very section answered, live: only then is its card the one to open. */
export const sameSectionLive = (arrival: Arrival) => arrival.kind === "unchanged" || arrival.kind === "changed";
