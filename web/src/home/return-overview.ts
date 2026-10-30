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
    section.id === undefined
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
      if (
        section.kind !== "ask" &&
        !section.history &&
        (!section.seen || section.seen.version < section.version)
      )
        changes.push(entry(section));
    }
    const current = new Map(
      live.map((s) => [overviewIdentity(panel.project.id, s), s]),
    );
    const history = [...panel.brief.history].sort(
      (a, b) => b.version - a.version,
    );
    for (const section of history) {
      const id = overviewIdentity(panel.project.id, section);
      if (!current.has(id)) current.set(id, section);
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
  const signature = JSON.stringify({
    changes: changes.map(({ identity, section: s }) => [
      identity,
      s.version,
      s.title,
      s.seen?.version,
      s.status?.stale,
    ]),
    replies: replies.map(({ identity, section: s, state }) => [
      identity,
      s.version,
      state,
      s.owner,
      s.ask?.repliedAt,
      s.ask?.replyText,
    ]),
  });
  return { at: data.generatedAt, changes, replies, signature };
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
