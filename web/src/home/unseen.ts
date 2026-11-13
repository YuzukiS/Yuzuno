import { readVersion, unreadChange } from "./brief-layout.ts";
import type { NeedsYouItem, ProjectPanel } from "./types.ts";

/**
 * How many cards in a project the user has not read (YN-86): Core's count of
 * what changed since they last read it (marked seen, or a report opened whole),
 * less the Asks they answered that their owner has not changed since: those
 * are not new to the user (YN-3). A project's page and its place on the
 * overview count the same cards.
 */
export function projectUnseen(panel: ProjectPanel): number {
  const answered = panel.brief.sections.filter(
    (section) =>
      section.ask?.state === "replied" &&
      (readVersion(section) ?? 0) < section.version &&
      !unreadChange(section),
  ).length;
  return Math.max(0, panel.unseen - answered);
}

/**
 * What waits for the user in a project as its page lists it (YN-86 §2.2):
 * open Asks, the project's approvals and its executors' matters. An approval
 * Core lists among Needs you and as the project's pending request is one
 * matter, not two.
 */
export function projectNeeds(
  needsYou: readonly NeedsYouItem[],
  pending: readonly { id: string }[],
  asks: number,
): number {
  const pendingIds = new Set(pending.map((request) => request.id));
  const executors = needsYou.filter(
    (item) => item.kind === "executor" || (item.kind === "approval" && !(item.requestId && pendingIds.has(item.requestId))),
  ).length;
  return asks + pending.length + executors;
}
