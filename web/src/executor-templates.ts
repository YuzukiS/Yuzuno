import { api } from "./api";

/** An executor template as Core keeps it (`/api/executor-templates`, T-34). */
export type ExecutorHarness = "codex" | "claude" | "opencode";
export type ExecutorTemplate = {
  id: string;
  label: string;
  /** Unset is the view's `defaultNamePattern`. */
  namePattern?: string;
  harness: ExecutorHarness;
  /** Codex or Claude Code on this Core host; unset inherits the defaults for new Agents. */
  model?: string;
  /** Codex only, with a model. */
  reasoningEffort?: string;
  permissionPreset?: string;
  permissionMode?: string;
  /** Where its executors run: unset or "local" for this Core host, a
   * registered machine's id, or "auto" for Core to choose at each dispatch (T-35 S3). */
  machineId?: string;
  instructions?: string;
  /** At most this many of its executors run at once (T-35); unset, no limit of its own. */
  maxConcurrent?: number;
};
/** `laterTemplates`: templates a newer Core saved that this one can't read or use; a save keeps them. */
export type TemplateList = { version: number; templates: ExecutorTemplate[]; laterTemplates?: number };
export type ExecutorTemplatesView = {
  workspace: TemplateList;
  /** Read for a project: its own list. */
  project?: TemplateList & { id: string };
  /** What a dispatch can use: in a project, its own, then the Workspace's it doesn't replace. */
  available: { template: ExecutorTemplate; source: "project" | "workspace" }[];
  defaultNamePattern: string;
  limits: { templates: number; instructionsBytes: number; maxConcurrent: number };
  opencodeEnabled: boolean;
};

/** The view as this client reads it: lists, even from an answer without them. */
export const templatesView = (value: Partial<ExecutorTemplatesView>): ExecutorTemplatesView => {
  const list = (from?: Partial<TemplateList>): TemplateList => ({
    version: typeof from?.version === "number" ? from.version : 0,
    templates: Array.isArray(from?.templates) ? from.templates : [],
    laterTemplates: typeof from?.laterTemplates === "number" ? from.laterTemplates : 0,
  });
  return {
    workspace: list(value.workspace),
    ...(value.project ? { project: { ...list(value.project), id: value.project.id } } : {}),
    available: Array.isArray(value.available) ? value.available : [],
    defaultNamePattern: value.defaultNamePattern || "{task} · {label}",
    limits: value.limits ?? { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 },
    opencodeEnabled: value.opencodeEnabled === true,
  };
};

export const readExecutorTemplates = (signal?: AbortSignal, projectId?: string) =>
  api<ExecutorTemplatesView>(projectId ? `/executor-templates?projectId=${encodeURIComponent(projectId)}` : "/executor-templates", { signal })
    .then(templatesView);
/** Replaces the whole list, checked against the version it was read at. */
export const saveExecutorTemplates = (expectedVersion: number, templates: ExecutorTemplate[], projectId?: string) =>
  api<ExecutorTemplatesView>(projectId ? `/projects/${encodeURIComponent(projectId)}/executor-templates` : "/executor-templates", {
    method: "PUT", body: JSON.stringify({ expectedVersion, templates }),
  }).then(templatesView);
