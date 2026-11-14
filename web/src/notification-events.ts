import type { NeedsYouItem } from "./home/types";
import type { NotificationCategory } from "./notification-prefs";
import type { Agent } from "./types";
import type { RefreshItem } from "./brief-refreshes";

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
  /** Opened on a click: the Agent's conversation, Home for an Ask, or
   * Settings → Backup & restore of this Workspace for a backup. */
  agentId?: string;
  home?: boolean;
  backup?: { workspaceId: string };
};

export type AgentState = Pick<Agent, "id" | "name" | "status" | "pendingCount" | "closedAt" | "workSummary" | "error">;

/** A failure or a request before a finished Turn (T-188: failures and approvals first). */
const priority: Record<NotificationCategory, number> = { needsYou: 0, failed: 1, backupFailed: 1, finished: 2 };
const PREVIEW_CHARS = 140;
/** More at once than this become one notification. */
export const BURST = 3;

const clip = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
};
const tag = (kind: NotificationCategory, id: string) => `yuzuno:${kind}:${id}`;

function agentNotice(before: AgentState, after: AgentState, preview: boolean, refreshTurns: ReadonlySet<string>): Notice | null {
  if (after.closedAt) return null;
  const summary = after.workSummary;
  const said = (fallback: string) => (preview && summary?.text ? clip(summary.text) : fallback);
  if (after.pendingCount > before.pendingCount || (after.status === "waiting" && before.status !== "waiting"))
    return { kind: "needsYou", tag: tag("needsYou", after.id), title: `${after.name} needs you`, body: said("Waiting for your response."), agentId: after.id };
  // A Turn's end: from working to anything but working or waiting.
  if (before.status !== "working" || after.status === "working" || after.status === "waiting") return null;
  // A refresh Turn's own notice says how it went (YN-113 R4): its generic end
  // would be a second notice of one event.
  if (summary?.turnId && refreshTurns.has(summary.turnId)) return null;
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
export function agentNotices(before: AgentState[] | null, after: AgentState[], preview: boolean, refreshTurns: ReadonlySet<string> = new Set()): Notice[] {
  if (!before) return [];
  const earlier = new Map(before.map((agent) => [agent.id, agent]));
  return after.flatMap((agent) => {
    const was = earlier.get(agent.id);
    const notice = was && agentNotice(was, agent, preview, refreshTurns);
    return notice ? [notice] : [];
  });
}

/** The Turns Home cards' refreshes ran in, as the last read of them names
 * them (YN-113 R4): their Agent's generic Turn end is not notified. */
export function refreshTurns(refreshes: readonly RefreshItem[]): Set<string> {
  return new Set(refreshes.flatMap((refresh) => (refresh.run?.turnId ? [refresh.run.turnId] : [])));
}

/** A refresh's notices (YN-113 design §4): one when its run ends as
 * refreshed, failed or skipped, and one when Core pauses it for a reason of
 * its own. A pause by the user or the owner tells of nothing, and the failed
 * run that reached the failure limit and the pause it caused are one notice.
 * The first read tells of nothing, and a run read again tells of nothing. */
export function refreshNotices(before: RefreshItem[] | null, after: RefreshItem[], preview: boolean): Notice[] {
  if (!before) return [];
  const earlier = new Map(before.map((refresh) => [`${refresh.projectId}/${refresh.identity}`, refresh]));
  return after.flatMap((refresh) => {
    const was = earlier.get(`${refresh.projectId}/${refresh.identity}`);
    const named = refresh.title?.trim() || refresh.key;
    const project = refresh.projectName?.trim() || "Home";
    const found: Notice[] = [];
    const run = refresh.run;
    let reported = false;
    if (run && ["refreshed", "failed", "skipped"].includes(run.state)) {
      const same = was?.run?.state === run.state && was?.run?.slot === run.slot;
      if (!same) {
        const refreshed = run.state === "refreshed";
        const why = run.reason ? (preview ? clip(run.reason.message) : "") : "";
        found.push({
          kind: refreshed ? "finished" : "failed",
          tag: tag(refreshed ? "finished" : "failed", `refresh:${refresh.projectId}:${refresh.identity}`),
          title: refreshed ? `“${named}” refreshed` : `“${named}” didn’t refresh`,
          body: refreshed
            ? `${project}${run.missed > 0 ? ` · caught up, ${run.missed} missed` : ""}`
            : `${project} · ${why || "Open Settings → Home → Refreshes to see why."}`,
          home: true,
        });
        reported = true;
      }
    }
    const paused = refresh.pausedReason?.code;
    const chosen = paused === "paused" || paused === "paused_by_owner" || paused === "restored";
    if (paused && !chosen && was?.pausedReason?.code !== paused && !(paused === "failures" && reported)) {
      found.push({
        kind: "failed",
        tag: tag("failed", `refresh-paused:${refresh.projectId}:${refresh.identity}`),
        title: `“${named}” paused`,
        body: `${project} · ${preview ? clip(refresh.pausedReason!.message) : "It stopped refreshing itself."}`,
        home: true,
      });
    }
    return found;
  });
}

/**
 * Notices for Asks that are new in Home's Needs you, and for executors you
 * dispatched that are new there (T-43 S4a: a result waiting for your
 * release, a start that failed, a task blocked). Approvals there are the
 * Agents' requests, which the Agent list already gives. Each opens Home.
 */
export function askNotices(before: NeedsYouItem[] | null, after: NeedsYouItem[], preview: boolean): Notice[] {
  if (!before) return [];
  const key = (item: NeedsYouItem) => `${item.projectId}/${item.sectionKey ?? ""}`;
  const seen = new Set(before.filter((item) => item.kind === "ask").map(key));
  const asks = after
    .filter((item) => item.kind === "ask" && item.sectionKey && !seen.has(key(item)))
    .map((item) => ({
      kind: "needsYou" as const,
      tag: tag("needsYou", `ask:${key(item)}`),
      title: `${item.agentName} asks you`,
      body: preview && item.title ? clip(item.title) : "An Ask is waiting for your answer on Home.",
      home: true,
    }));
  // An executor's need is its Agent and state: in that state again, it is the same need.
  const need = (item: NeedsYouItem) => `${item.agentId}:${item.state ?? ""}`;
  const waiting = new Set(before.filter((item) => item.kind === "executor").map(need));
  const executors = after
    .filter((item) => item.kind === "executor" && !waiting.has(need(item)))
    .map((item) => {
      const failed = item.state === "failed";
      const said = item.state === "blocked" ? "Its task is blocked." : failed ? "Open Home to see why." : "Its result is in, waiting for your release.";
      return {
        kind: failed ? "failed" as const : "needsYou" as const,
        tag: tag(failed ? "failed" : "needsYou", `executor:${item.agentId}`),
        title: failed ? `${item.agentName}: its start failed` : `${item.agentName} needs you`,
        // With previews on, what it waits for (its reason, or its task's blocker); otherwise words of our own.
        body: preview && item.reason ? clip(item.reason) : said,
        home: true,
      };
    });
  return [...asks, ...executors];
}

/** The daily backup's last run, as Core's Backup status reads it
 * (core/src/workspace_backup/schedule.rs). */
export type BackupRun = {
  slot: string;
  operationId?: string | null;
  /** running, succeeded, failed, stopped, interrupted, or not_started. */
  state: string;
};

/** Ended without a backup, and not because someone stopped it: a backup that
 * failed, was cut off by Core stopping, or could not begin. */
const backupFailures = {
  failed: { title: "The daily backup failed", ended: "did not finish" },
  interrupted: { title: "The daily backup was interrupted", ended: "did not finish" },
  not_started: { title: "The daily backup didn’t start", ended: "could not begin" },
};
const backupFailure = (state: string) =>
  state === "failed" || state === "interrupted" || state === "not_started" ? backupFailures[state] : null;

/**
 * A notice when the daily backup's last run is newly known to have failed
 * (T-196): compared with the read before, as for Agents, so the first read
 * gives none, and a run already failed then gives none again. It names no
 * folder and no error: Settings → Backup & restore shows them.
 */
export function backupNotice(workspaceId: string, before: BackupRun | null | undefined, after: BackupRun | null): Notice | null {
  const failure = after && backupFailure(after.state);
  if (before === undefined || !after || !failure) return null;
  if (before && before.slot === after.slot && backupFailure(before.state)) return null;
  const at = `${after.slot.slice(0, 10)} ${after.slot.slice(11, 16)} UTC`;
  const { title, ended } = failure;
  return {
    kind: "backupFailed",
    tag: tag("backupFailed", `${workspaceId}:${after.operationId || after.slot}`),
    title,
    body: `The backup due at ${at} ${ended}. Open Settings → Backup & restore to see why.`,
    backup: { workspaceId },
  };
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
