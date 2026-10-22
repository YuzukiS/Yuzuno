import type { HomeData, Section } from "./types";

/** A topic key read as words ("memory-read-progress" → "Memory read progress"),
 * for a topic that has no section of its own to give it a title (T-173). */
export function topicName(topic: string) {
  const words = topic.replace(/-+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : topic;
}

/** A topic with its own section (if any) and the sub-topics other Agents added. */
export type TopicGroup = { topic: string; parent: Section | null; subs: Section[] };

/**
 * Groups `topic/sub` keys under their topic, in Core's section order: a group
 * sits where its first section does, so a later section never reorders
 * what is already shown.
 */
export function groupSections(sections: Section[]): TopicGroup[] {
  const groups = new Map<string, TopicGroup>();
  for (const section of sections) {
    const slash = section.key.indexOf("/");
    const topic = slash < 0 ? section.key : section.key.slice(0, slash);
    let group = groups.get(topic);
    if (!group) groups.set(topic, (group = { topic, parent: null, subs: [] }));
    if (slash < 0) group.parent = section;
    else group.subs.push(section);
  }
  return [...groups.values()];
}

/** Changed since the user last marked it seen (never inferred from reading). */
export const changedSinceSeen = (section: Section) =>
  !section.seen || section.seen.version < section.version;

/**
 * The next read with every section that did not change kept as the same
 * object, so its card and body (charts included) are not drawn again when
 * Home reads after an unrelated Agent or Job event.
 */
export function keepUnchanged(previous: HomeData | null, next: HomeData): HomeData {
  if (!previous) return next;
  const before = new Map<string, { json: string; section: Section }>();
  const slot = (projectId: string, section: Section) =>
    JSON.stringify([projectId, section.history, section.key, section.version]);
  for (const panel of previous.projects)
    for (const section of [...panel.brief.sections, ...(panel.brief.teamSections ?? []), ...panel.brief.history])
      before.set(slot(panel.project.id, section), { json: JSON.stringify(section), section });
  const keep = (projectId: string) => (section: Section) => {
    const old = before.get(slot(projectId, section));
    return old && old.json === JSON.stringify(section) ? old.section : section;
  };
  return {
    ...next,
    projects: next.projects.map((panel) => ({
      ...panel,
      brief: {
        ...panel.brief,
        sections: panel.brief.sections.map(keep(panel.project.id)),
        teamSections: panel.brief.teamSections?.map(keep(panel.project.id)),
        history: panel.brief.history.map(keep(panel.project.id)),
      },
    })),
  };
}

export const sectionDomId = (projectId: string, key: string) =>
  `home-section-${projectId}-${key}`;
export const requestDomId = (requestId: string) => `home-request-${requestId}`;
export const projectDomId = (projectId: string) => `home-project-${projectId}`;
