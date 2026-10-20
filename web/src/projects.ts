import type { Agent, Project } from "./types";

/** What this window shows. Switching it never changes Core, data or read state. */
export type ProjectScope = "all" | "none" | `project:${string}`;
export const ALL_PROJECTS: ProjectScope = "all";
export const NO_PROJECT: ProjectScope = "none";

export const projectScope = (id: string): ProjectScope => `project:${id}`;
export const scopeProjectId = (scope: ProjectScope) =>
  scope.startsWith("project:") ? scope.slice("project:".length) : null;
export const scopeStorageKey = (workspaceId: string) =>
  `yuzuno.projectScope.${workspaceId}`;

export const activeProjects = (projects: Project[]) =>
  projects.filter((project) => !project.archivedAt);

/** A remembered project that is gone or archived falls back to All projects. */
export function validScope(value: unknown, projects: Project[]): ProjectScope {
  if (value === ALL_PROJECTS || value === NO_PROJECT)
    return value as ProjectScope;
  if (typeof value !== "string") return ALL_PROJECTS;
  const id = scopeProjectId(value as ProjectScope);
  return id && activeProjects(projects).some((project) => project.id === id)
    ? (value as ProjectScope)
    : ALL_PROJECTS;
}

export function inScope(agent: Pick<Agent, "projectId">, scope: ProjectScope) {
  if (scope === ALL_PROJECTS) return true;
  if (scope === NO_PROJECT) return !agent.projectId;
  return agent.projectId === scopeProjectId(scope);
}

/** Where to look to find this agent: its own project, or everything. */
export function scopeForAgent(
  agent: Pick<Agent, "projectId">,
  projects: Project[],
): ProjectScope {
  if (!agent.projectId) return NO_PROJECT;
  return validScope(projectScope(agent.projectId), projects);
}

export function scopeLabel(scope: ProjectScope, projects: Project[]) {
  if (scope === ALL_PROJECTS) return "All projects";
  if (scope === NO_PROJECT) return "No project";
  return (
    projects.find((project) => project.id === scopeProjectId(scope))?.name ||
    "Project"
  );
}

export function projectName(
  id: string | null | undefined,
  projects: Project[],
) {
  if (!id) return "";
  return (
    projects.find((project) => project.id === id)?.name || "Unknown project"
  );
}

export const machineIdOf = (agent: Pick<Agent, "remote">) =>
  agent.remote?.machine.id || "local";

/**
 * Requests waiting outside the current scope. Every open agent counts,
 * including those in archived projects, so a scope never hides them.
 */
export function pendingElsewhere(agents: Agent[], scope: ProjectScope) {
  return agents
    .filter((agent) => !agent.closedAt && !inScope(agent, scope))
    .reduce((n, agent) => n + agent.pendingCount, 0);
}

export interface FolderGroup {
  key: string;
  machineId: string;
  machineName: string;
  cwd: string;
  agents: Agent[];
}

/** Suggestions only: agents sharing a folder are offered together, never linked automatically. */
export function unassignedFolders(agents: Agent[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const agent of agents) {
    if (agent.projectId) continue;
    const machineId = machineIdOf(agent);
    const key = `${machineId}\u0000${agent.cwd}`;
    const group = groups.get(key) || {
      key,
      machineId,
      machineName: agent.remote?.machine.name || "Core host",
      cwd: agent.cwd,
      agents: [],
    };
    group.agents.push(agent);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function folderName(path: string) {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}
