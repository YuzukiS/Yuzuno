import type { ReadingPosition } from "./reading-position";

/**
 * Where a conversation was last read, shared through Core with the user's
 * other browsers (T-170). This browser publishes its place when it leaves a
 * conversation, as it saves it locally; another browser may then offer to
 * continue there. Nothing here navigates, sends or marks anything read: only
 * the user's Continue opens the place, through the usual restore.
 *
 * The shared place names the message (Turn, Item, native session) and how far
 * into it the reader was (0..1), never pixels, which mean something else on
 * another screen.
 */
export type Handoff = {
  mode: "anchor" | "latest";
  turnId?: string;
  itemId?: string;
  threadId?: string;
  progress?: number;
  source: string;
  label: "desktop" | "browser";
  /** Core's count of accepted writes, and how long ago it accepted the last (its own clock). */
  version: number;
  ageSeconds: number;
};
export type Answer = { handoff: Handoff | null; sourceSeq: number; accepted?: boolean };

/** Versions taken or dismissed here, remembered per Workspace. */
export const OFFER_LIMIT = 200;
const scoped = (name: string, workspaceId: string) => `yuzuno.${name}.v1:${JSON.stringify([workspaceId])}`;

function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Unavailable storage: this window still works, without sharing. */
  }
}

/** This browser's random name for one Workspace. Tabs share it, so they
 * never offer each other their place; it says nothing about the device. */
export function readingSource(workspaceId: string) {
  const key = scoped("reading-source", workspaceId);
  const known = stored(key);
  if (known && /^[0-9a-f]{32}$/.test(known)) return known;
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const made = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  store(key, made);
  return stored(key) || made;
}

/** The highest write number this browser has used or seen Core accept. */
function highest(workspaceId: string) {
  const value = Number(stored(scoped("reading-seq", workspaceId)));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Raises the high-water mark to what Core says this source reached; never lowers it. */
export function observeSeq(workspaceId: string, seq: unknown) {
  if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > highest(workspaceId))
    store(scoped("reading-seq", workspaceId), String(seq));
}

/** The next write number, kept before it is used: past anything used or
 * seen, and past the clock, so a reload or a clock set back cannot leave
 * this browser's writes ignored for good. Tabs are not atomic with each
 * other; two that collide keep one write. */
export function nextSeq(workspaceId: string, now = Date.now()) {
  const next = Math.max(highest(workspaceId), Math.floor(now)) + 1;
  if (!Number.isSafeInteger(next)) return null;
  store(scoped("reading-seq", workspaceId), String(next));
  return next;
}

/** What other screens can use of a place: the message and how far into it. */
export function sharedPosition(position: ReadingPosition) {
  if (position.mode === "latest") return { mode: "latest" as const };
  return {
    mode: "anchor" as const,
    turnId: position.turnId,
    ...(position.itemId ? { itemId: position.itemId } : {}),
    ...(position.threadId ? { threadId: position.threadId } : {}),
    ...(position.progress !== undefined ? { progress: position.progress } : {}),
  };
}

const offerKey = (agentId: string, version: number) => JSON.stringify([agentId, version]);
function handled(workspaceId: string): string[] {
  try {
    const value = JSON.parse(stored(scoped("reading-offers", workspaceId)) || "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Continue or Not now: that version is not offered here again. */
export function markOfferHandled(workspaceId: string, agentId: string, version: number) {
  const key = offerKey(agentId, version);
  const next = [...handled(workspaceId).filter((v) => v !== key), key].slice(-OFFER_LIMIT);
  store(scoped("reading-offers", workspaceId), JSON.stringify(next));
}

/** Whether to offer another browser's place in this conversation: a message
 * from another source, not already handled here, and not where this browser
 * itself left it. */
export function offerable(workspaceId: string, agentId: string, handoff: Handoff | null, local: ReadingPosition | null): handoff is Handoff {
  if (!handoff || handoff.mode !== "anchor" || !handoff.turnId) return false;
  if (handoff.source === readingSource(workspaceId)) return false;
  if (handled(workspaceId).includes(offerKey(agentId, handoff.version))) return false;
  if (local?.mode === "anchor" && local.turnId === handoff.turnId && (local.itemId ?? "") === (handoff.itemId ?? "")) return false;
  return true;
}

/** Where a shared place puts the message's top on this screen, in px from
 * the pane's top: as far into it as the other screen was, keeping at least
 * a little of it in view however short the message or the pane. */
export function restoredOffset(progress: number, height: number, pane: number) {
  const visible = Math.max(0, Math.min(48, height, pane));
  const offset = -Math.min(1, Math.max(0, progress)) * height;
  return Math.min(Math.max(offset, visible - height), Math.max(0, pane - visible));
}

/** "5 min ago", by Core's own clock; in Chinese when `zh` (T-189). */
export function ageText(seconds: number, zh = false) {
  if (!(seconds >= 60)) return zh ? "刚刚" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return zh ? `${hours} 小时前` : `${hours} h ago`;
  return zh ? `${Math.floor(hours / 24)} 天前` : `${Math.floor(hours / 24)} days ago`;
}
