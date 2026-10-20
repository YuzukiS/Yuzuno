import type { NativeTurn } from "./types";

export interface ConversationMatch {
  turnId: string;
  itemId: string;
  turnNumber: number;
  role: "user" | "progress" | "assistant";
  before: string;
  match: string;
  after: string;
}

/** One result per loaded message, in conversation order. Tool items are excluded. */
export function searchConversation(
  turns: readonly NativeTurn[],
  query: string,
): ConversationMatch[] {
  const needle = query.trim();
  if (!needle) return [];
  const pattern = new RegExp(
    needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "iu",
  );
  const matches: ConversationMatch[] = [];
  turns.forEach((turn, index) => {
    for (const item of turn.items) {
      if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
      const text =
        item.type === "userMessage"
          ? (item.content || []).map((part) => part.text || "").join("\n")
          : item.text || "";
      const hit = pattern.exec(text);
      if (!hit) continue;
      const start = Math.max(0, hit.index - 60);
      const end = Math.min(text.length, hit.index + hit[0].length + 120);
      matches.push({
        turnId: turn.id,
        itemId: item.id,
        turnNumber: index + 1,
        role:
          item.type === "userMessage"
            ? "user"
            : item.phase === "commentary"
              ? "progress"
              : "assistant",
        before: (start > 0 ? "…" : "") + text.slice(start, hit.index),
        match: hit[0],
        after:
          text.slice(hit.index + hit[0].length, end) +
          (end < text.length ? "…" : ""),
      });
    }
  });
  return matches;
}
