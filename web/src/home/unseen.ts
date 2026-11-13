import { readVersion, unreadChange } from "./brief-layout.ts";
import type { ProjectPanel } from "./types.ts";

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
