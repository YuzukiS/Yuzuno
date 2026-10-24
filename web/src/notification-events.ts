import type { NeedsYouItem } from "./home/types";
import type { NotificationCategory } from "./notification-prefs";
import type { Agent } from "./types";

/**
 * What a system notification would say about a change the Workspace read
 * (T-188). Core sends no event that means "needs you", "failed" or
 * "finished": only that an Agent or the Workspace changed, after which the
 * app reads again. So a notice comes from comparing one read with the next,
 * never from the stream of a running Turn (its text arrives a few characters
 * at a time).
 */
export type Notice = {
  kind: NotificationCategory;
  /** The system shows one notification per tag: a later one replaces it,
   * quietly, instead of adding another. */
  tag: string;
  title: string;
  body: string;
  /** Opened on a click: the Agent's conversation, or Home for an Ask. */
  agentId?: string;
  home?: boolean;
};

export type AgentState = Pick<Agent, "id" | "name" | "status" | "pendingCount" | "closedAt" | "workSummary" | "error">;

/** A failure or a request before a finished Turn (T-188: failures and approvals first). */
const priority: Record<NotificationCategory, number> = { needsYou: 0, failed: 1, finished: 2 };
const PREVIEW_CHARS = 140;
/** More at once than this become one notification. */
export const BURST = 3;

const clip = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
};
const tag = (kind: NotificationCategory, id: string) => `yuzuno:${kind}:${id}`;

function agentNotice(before: AgentState, after: AgentState, preview: boolean): Notice | null {
  if (after.closedAt) return null;
  const summary = after.workSummary;
  const said = (fallback: string) => (preview && summary?.text ? clip(summary.text) : fallback);
  if (after.pendingCount > before.pendingCount || (after.status === "waiting" && before.status !== "waiting"))
    return { kind: "needsYou", tag: tag("needsYou", after.id), title: `${after.name} needs you`, body: said("Waiting for your response."), agentId: after.id };
  // A Turn's end: from working to anything but working or waiting.
  if (before.status !== "working" || after.status === "working" || after.status === "waiting") return null;
  if (after.status === "error" || summary?.kind === "error") {
    const why = preview ? clip(after.error || summary?.text || "") : "";
    return { kind: "failed", tag: tag("failed", after.id), title: `${after.name}: the Turn failed`, body: why || "Open the conversation to see why.", agentId: after.id };
  }
  // Stopped by someone, or the Agent went offline: not a result to report.
  if (after.status !== "idle" || summary?.kind === "interrupted") return null;
  return { kind: "finished", tag: tag("finished", after.id), title: `${after.name} finished`, body: said("The Turn finished."), agentId: after.id };
}

/**
 * Notices for what changed between two reads of the Agent list, at most one
 * per Agent. The first read has nothing to compare with, so it gives none;
 * nor does an Agent new to the list.
 */
export function agentNotices(before: AgentState[] | null, after: AgentState[], preview: boolean): Notice[] {
  if (!before) return [];
  const earlier = new Map(before.map((agent) => [agent.id, agent]));
  return after.flatMap((agent) => {
    const was = earlier.get(agent.id);
    const notice = was && agentNotice(was, agent, preview);
    return notice ? [notice] : [];
  });
}

/**
 * Notices for Asks that are new in Home's Needs you. Approvals there are the
 * Agents' requests, which the Agent list already gives.
 */
export function askNotices(before: NeedsYouItem[] | null, after: NeedsYouItem[], preview: boolean): Notice[] {
  if (!before) return [];
  const key = (item: NeedsYouItem) => `${item.projectId}/${item.sectionKey ?? ""}`;
  const seen = new Set(before.filter((item) => item.kind === "ask").map(key));
  return after
    .filter((item) => item.kind === "ask" && item.sectionKey && !seen.has(key(item)))
    .map((item) => ({
      kind: "needsYou" as const,
      tag: tag("needsYou", `ask:${key(item)}`),
      title: `${item.agentName} asks you`,
      body: preview && item.title ? clip(item.title) : "An Ask is waiting for your answer on Home.",
      home: true,
    }));
}

/**
 * What to show of one read's notices: the most urgent first, and a burst as
 * one notification, so a reconnect that brings many changes at once does not
 * bring as many notifications.
 */
export function merged(notices: Notice[]): Notice[] {
  const ordered = [...notices].sort((a, b) => priority[a.kind] - priority[b.kind]);
  if (ordered.length <= BURST) return ordered;
  const first = ordered[0];
  const names = [...new Set(ordered.map((notice) => notice.title))];
  return [
    {
      kind: first.kind,
      tag: "yuzuno:summary",
      title: `${ordered.length} updates in your Workspace`,
      body: clip(names.join(" · ")),
    },
  ];
}
