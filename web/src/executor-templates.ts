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
  /** Copied from a project's own list when templates became the Workspace's (YN-2 S2): which project, and its id there. */
  origin?: { projectId: string; projectName: string; id: string };
  /** How its work is delivered (YN-23); unset is "pr". */
  deliveryMode?: DeliveryMode;
  /** 1 to 12 steps its executors follow, descriptive; unset is its delivery's default. */
  steps?: TemplateStep[];
  /** One line: what work to choose it for. */
  whenToChoose?: string;
};
export type DeliveryMode = "pr" | "direct-commit" | "none";
export type StepKind = "materials" | "work" | "result" | "gate" | "job" | "pr" | "review" | "ci" | "merge";
/** `rounds` only on a review (1 or 2), `approver` only on a gate (unset: the user). */
export type TemplateStep = { kind: StepKind; label?: string; rounds?: number; approver?: "user" | "lead" | "either" };
/** A template the user can adopt in Settings: a template's fields, never stored until the user saves. */
export type ExecutorPreset = ExecutorTemplate & { description?: string };
/** `laterTemplates`: templates a newer Core saved that this one can't read or use; a save keeps them. */
export type TemplateList = { version: number; templates: ExecutorTemplate[]; laterTemplates?: number };
export type ExecutorTemplatesView = {
  /** The Workspace's templates: the only list (YN-2 S2). */
  workspace: TemplateList;
  /** What a dispatch can use: the Workspace's templates. `project` only from a Core before YN-2 S2. */
  available: { template: ExecutorTemplate; source: "project" | "workspace" }[];
  /** Presets the user can adopt; empty until a Core ships some. */
  presets: ExecutorPreset[];
  defaultNamePattern: string;
  /** Core also answers `maxConcurrent` for a release (YN-2): a template has no limit of its own any more (T-43). */
  limits: { templates: number; instructionsBytes: number };
  opencodeEnabled: boolean;
  /** What a general executor (`executor: {}`, YN-2) of the read Project would be made with now; absent from an older Core. */
  general?: GeneralExecutor;
};

/** A general executor: no template, the harness of a new Agent there, and where that came from. */
export type GeneralExecutor = { label: string; harness: string; harnessSource: "project" | "workspace" | "builtin" };

const generalOf = (value: unknown): GeneralExecutor | undefined => {
  const g = value as Partial<GeneralExecutor> | null | undefined;
  return g && typeof g.harness === "string" && typeof g.label === "string"
    ? { label: g.label, harness: g.harness, harnessSource: g.harnessSource === "project" || g.harnessSource === "workspace" ? g.harnessSource : "builtin" }
    : undefined;
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
    available: Array.isArray(value.available) ? value.available : [],
    presets: Array.isArray(value.presets) ? value.presets.filter((p) => p && typeof p.id === "string" && typeof p.label === "string") : [],
    defaultNamePattern: value.defaultNamePattern || "{task} · {label}",
    limits: value.limits ?? { templates: 50, instructionsBytes: 8192 },
    opencodeEnabled: value.opencodeEnabled === true,
    ...(generalOf(value.general) ? { general: generalOf(value.general) } : {}),
  };
};

export const readExecutorTemplates = (signal?: AbortSignal, projectId?: string) =>
  api<ExecutorTemplatesView>(projectId ? `/executor-templates?projectId=${encodeURIComponent(projectId)}` : "/executor-templates", { signal })
    .then(templatesView);
/** Replaces the Workspace's whole list, checked against the version it was read at. */
export const saveExecutorTemplates = (expectedVersion: number, templates: ExecutorTemplate[]) =>
  api<ExecutorTemplatesView>("/executor-templates", {
    method: "PUT", body: JSON.stringify({ expectedVersion, templates }),
  }).then(templatesView);
