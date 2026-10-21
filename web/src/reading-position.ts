/**
 * Where the user was reading each conversation (T-166): following the latest
 * messages, or at a message. Kept by this client only; reopening a
 * conversation returns there. Another device's position is never applied
 * without the user choosing it (T-170: reading-handoff.ts shares the message
 * and `progress`, never the pixel offset).
 */
export type ReadingPosition =
  | { mode: "latest"; savedAt: number }
  | {
      mode: "anchor";
      turnId: string;
      itemId?: string;
      /** The message's top relative to the conversation's top, in px. */
      offset: number;
      /** How far into the message the pane's top was, 0..1 (T-170): what
       * another screen, with other heights, can use. */
      progress?: number;
      /** The Agent's native session when it was saved. */
      threadId?: string;
      savedAt: number;
    };

export interface ReadingPositions {
  get(agentId: string): ReadingPosition | null;
  set(agentId: string, position: ReadingPosition): void;
}

/** Conversations remembered per Workspace; the oldest are forgotten first. */
export const READING_LIMIT = 200;

function valid(value: unknown): value is ReadingPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  if (typeof position.savedAt !== "number") return false;
  if (position.mode === "latest") return true;
  return (
    position.mode === "anchor" &&
    typeof position.turnId === "string" &&
    !!position.turnId &&
    (position.itemId === undefined || typeof position.itemId === "string") &&
    (position.threadId === undefined || typeof position.threadId === "string") &&
    (position.progress === undefined ||
      (typeof position.progress === "number" && Number.isFinite(position.progress) && position.progress >= 0 && position.progress <= 1)) &&
    typeof position.offset === "number" &&
    Number.isFinite(position.offset)
  );
}

/** Positions in this client's storage for one Workspace. */
export function localReadingPositions(
  workspaceId: string,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  limit = READING_LIMIT,
): ReadingPositions {
  const key = `yuzuno.reading.${workspaceId}`;
  const read = (): Record<string, ReadingPosition> => {
    try {
      const stored = JSON.parse(storage.getItem(key) || "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, ReadingPosition] => valid(entry[1])));
    } catch {
      return {};
    }
  };
  return {
    get: (agentId) => read()[agentId] ?? null,
    set(agentId, position) {
      const positions = { ...read(), [agentId]: position };
      const kept = Object.entries(positions)
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, limit);
      try {
        storage.setItem(key, JSON.stringify(Object.fromEntries(kept)));
      } catch {
        // A full or unavailable storage keeps the conversation usable; the
        // position is simply not remembered.
      }
    },
  };
}

/**
 * The message at the top of the conversation pane and how far its top is
 * from the pane's: where to return to. Only mounted rows are read, so this
 * stays bounded however long the conversation is.
 */
export function readingAnchor(pane: HTMLElement, threadId?: string): ReadingPosition | null {
  const top = pane.getBoundingClientRect().top;
  for (const element of pane.querySelectorAll<HTMLElement>("[data-turn-id] [data-item-id]")) {
    // An anchor inside a message (a sub-agent, a plan step) is not an Item
    // Core can open a window at; its message is.
    if (element.parentElement?.closest("[data-item-id]")) continue;
    const box = element.getBoundingClientRect();
    if (box.height <= 0 || box.bottom <= top + 1) continue;
    const turnId = element.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId;
    if (!turnId) return null;
    const progress = box.height > 0 ? Math.min(1, Math.max(0, (top - box.top) / box.height)) : 0;
    return {
      mode: "anchor", turnId, itemId: element.dataset.itemId, offset: Math.round(box.top - top),
      progress: Math.round(progress * 10_000) / 10_000, threadId, savedAt: Date.now(),
    };
  }
  return null;
}
