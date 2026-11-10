import { readVersion } from "./brief-layout.ts";
import type { HomeData, Section } from "./types";

/** A small, read-only projection. This is not a task state or a receipt of
 * an Agent reading a message: Home has neither fact. */
export type OverviewSection = {
  projectId: string;
  projectName: string;
  section: Section;
  identity: string;
};
export type ReplyReceipt = OverviewSection & { state: "waiting" | "resolved" };
export type ReturnOverview = {
  at: string;
  changes: OverviewSection[];
  replies: ReplyReceipt[];
  signature: string;
};

/** New Cores preserve a section's id through edits and change it when a
 * removed key is reused. With an old Core, never join different revisions:
 * matching a key alone could associate a new question with an old answer. */
export function overviewIdentity(projectId: string, section: Section): string {
  return JSON.stringify(
    !Number.isSafeInteger(section.id)
      ? [
          projectId,
          "legacy",
          section.key,
          section.owner.agentId,
          section.version,
          section.updatedAt,
        ]
      : [projectId, "section", section.id],
  );
}

export function returnOverview(data: HomeData): ReturnOverview {
  const changes: OverviewSection[] = [];
  const replies: ReplyReceipt[] = [];
  for (const panel of data.projects) {
    const entry = (section: Section): OverviewSection => ({
      projectId: panel.project.id,
      projectName: panel.project.name,
      section,
      identity: overviewIdentity(panel.project.id, section),
    });
    // Team details remain in their existing, explicitly opened area.
    const live = panel.brief.sections;
    for (const section of live) {
      // Changed since the user last read it: marked seen, or a report
      // opened whole (YN-86), as Home's New marks and Core's count say.
      if (
        section.kind !== "ask" &&
        !section.history &&
        (readVersion(section) ?? 0) < section.version
      )
        changes.push(entry(section));
    }
    const current = new Map(
      live.map((s) => [overviewIdentity(panel.project.id, s), s]),
    );
    const liveIds = new Set(current.keys());
    // Choose the newest revision within a lineage without sorting unrelated
    // questions by their version numbers. Their order remains Core's order.
    for (const section of panel.brief.history) {
      const id = overviewIdentity(panel.project.id, section);
      if (liveIds.has(id)) continue;
      const previous = current.get(id);
      if (!previous || previous.version < section.version)
        current.set(id, section);
    }
    for (const section of current.values()) {
      const ask = section.ask;
      // An Agent may resolve a question without any user reply. That is
      // not "your reply". Missing metadata from older Cores stays absent.
      if (
        section.kind !== "ask" ||
        !ask ||
        (!ask.repliedAt && !ask.replyText?.trim())
      )
        continue;
      if (section.historyReason === "removed") continue;
      const state =
        ask.state === "resolved" || section.historyReason === "resolved"
          ? "resolved"
          : ask.state === "replied"
            ? "waiting"
            : null;
      if (state) replies.push({ ...entry(section), state });
    }
  }
  // Preserve Core's project/card order; do not make a new urgency ranking.
  return { at: data.generatedAt, changes, replies, signature: overviewSignature(changes, replies) };
}

/** Project and owner metadata can change without a card revision. Compare
 * the fields a reading shows, not generatedAt (a read is not a change). */
function overviewSignature(changes: OverviewSection[], replies: ReplyReceipt[]) {
  return JSON.stringify({
    changes: changes.map(({ identity, projectName, section: s }) => [
      identity,
      projectName,
      s.version,
      s.title,
      [s.owner.agentId, s.owner.name, s.owner.state],
      readVersion(s),
      s.status?.stale,
    ]),
    replies: replies.map(({ identity, projectName, section: s, state }) => [
      identity,
      projectName,
      s.version,
      s.title,
      state,
      [s.owner.agentId, s.owner.name, s.owner.state],
      s.ask?.question,
      s.ask?.repliedAt,
      s.ask?.replyText,
    ]),
  });
}

/** A report version the user opened whole here (YN-86), by Core's identity of its section. */
export type OpenedMark = { projectId: string; sectionId: number; version: number };

/**
 * A held reading without the changes the user has since opened here, each
 * up to the version opened: the reading is otherwise kept as it was (its
 * time, every other change and reply), never refreshed by it. A newer
 * version than the one opened stays.
 */
export function withoutOpened(reading: ReturnOverview, opened: readonly OpenedMark[]): ReturnOverview {
  if (!opened.length) return reading;
  const read = (entry: OverviewSection) =>
    opened.some((mark) => mark.projectId === entry.projectId && mark.sectionId === entry.section.id && mark.version >= entry.section.version);
  const changes = reading.changes.filter((entry) => !read(entry));
  return changes.length === reading.changes.length
    ? reading
    : { ...reading, changes, signature: overviewSignature(changes, reading.replies) };
}

/** A link to a card is offered only while this precise section lineage is
 * still live. A reused key is not the same destination. */
export function currentOverviewSection(
  entry: OverviewSection,
  data: HomeData,
): Section | null {
  const sections =
    data.projects.find((p) => p.project.id === entry.projectId)?.brief
      .sections ?? [];
  return (
    sections.find(
      (section) =>
        !section.history &&
        overviewIdentity(entry.projectId, section) === entry.identity,
    ) ?? null
  );
}
