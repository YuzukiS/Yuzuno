import { activeProjects } from "./projects.ts";
import type { Agent, Project } from "./types";

/** One project's Agents in the Agent list while it shows All projects. */
export type ProjectGroup = {
  /** The project's id, or NO_PROJECT_KEY. Also what folding remembers. */
  key: string;
  projectId: string | null;
  name: string;
  agents: Agent[];
  /** The project's band colour; none without a project. */
  colour: string | null;
  /** A new Agent can start here: a listed project, or no project. */
  creatable: boolean;
};

export const NO_PROJECT_KEY = "none";

// Muted enough to sit beside the status dots in both themes.
const COLOURS = ["#8fa172", "#c0896f", "#7f9fb0", "#a58bb5", "#c4a95c", "#6f9a8d"];

/** A project's band colour, the same every time for the same project. */
export function projectColour(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

/**
 * The Agents by project: in the project menu's order, then projects the menu
 * no longer lists (archived or unknown) by name, then those without a
 * project. Each group keeps the list's own order. Null when the Agents all
 * share one group, which needs no heading.
 */
export function groupAgents(
  agents: Agent[],
  projects: Project[],
  // The two groups this window names itself, in the interface language.
  names: { unknown: string; none: string } = { unknown: "Unknown project", none: "No project" },
): ProjectGroup[] | null {
  const byProject = new Map<string, Agent[]>();
  const unassigned: Agent[] = [];
  for (const agent of agents) {
    if (!agent.projectId) unassigned.push(agent);
    else byProject.set(agent.projectId, [...(byProject.get(agent.projectId) ?? []), agent]);
  }
  const groups: ProjectGroup[] = [];
  for (const project of activeProjects(projects)) {
    const list = byProject.get(project.id);
    if (!list) continue;
    byProject.delete(project.id);
    groups.push({ key: project.id, projectId: project.id, name: project.name, agents: list, colour: projectColour(project.id), creatable: true });
  }
  const unlisted = [...byProject].map(([id, list]) => ({
    key: id,
    projectId: id,
    name: projects.find((project) => project.id === id)?.name || names.unknown,
    agents: list,
    colour: projectColour(id),
    creatable: false,
  }));
  groups.push(...unlisted.sort((a, b) => a.name.localeCompare(b.name)));
  if (unassigned.length)
    groups.push({ key: NO_PROJECT_KEY, projectId: null, name: names.none, agents: unassigned, colour: null, creatable: true });
  return groups.length > 1 ? groups : null;
}

/** What a folded group still tells: requests waiting, work running, unread. */
export function groupSummary(agents: Agent[]) {
  return {
    needs: agents.reduce((n, agent) => n + (agent.closedAt ? 0 : agent.pendingCount), 0),
    working: agents.filter((agent) => agent.status === "working").length,
    unread: agents.filter((agent) => agent.unreadCount > 0).length,
  };
}
