import { api } from "./api";

/** An executor template as Core keeps it (`/api/executor-templates`, T-34). */
export type ExecutorHarness = "codex" | "claude" | "opencode";
/** A permission said once for every harness, which Core maps to each one's own (YN-56). */
export type PermissionLevel = "ask" | "auto" | "full" | "read-only";
/** read-only (YN-74): reads and proposes, changes nothing itself; Core serves its labels. */
export const PERMISSION_LEVELS: PermissionLevel[] = ["ask", "auto", "full", "read-only"];
/** The kind of model a template's work wants (YN-70): strong for designing and deciding, fast for building what was decided. */
export type ModelTier = "strong" | "fast";
export type ExecutorTemplate = {
  id: string;
  label: string;
  /** Unset is the view's `defaultNamePattern`. */
  namePattern?: string;
  /** A fixed template's only (YN-56): one that follows routing names none. */
  harness?: ExecutorHarness;
  /** A fixed template's: Codex or Claude Code on this Core host, OpenCode as it names it; unset inherits the defaults for new Agents. */
  model?: string;
  /** A fixed Codex template's, with a model. */
  reasoningEffort?: string;
  /** Unset is each harness's default for new Agents (YN-56). */
  permissionLevel?: PermissionLevel;
  /** A fixed Codex template's `config` only: its machine's own Codex configuration. */
  permissionPreset?: string;
  /** The harness a template that follows routing named before core.29 (#824 R1): the way back, kept until it is fixed. */
  formerHarness?: ExecutorHarness;
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
  /** "fixed": its executors start with its own harness, whatever the routing policy (YN-34 S3); unset follows routing,
   * or while routing is off the defaults for new Agents (YN-56). */
  routing?: "fixed";
  /** The kind of model its work wants (YN-70); unset is no preference. Told to its executors in their materials. */
  tier?: ModelTier;
};
/** What a level is on each harness, as Core serves it (`levels`): null where that harness doesn't keep it. */
export type LevelInfo = {
  level: PermissionLevel;
  label: string;
  labelZh: string;
  codex: { permissionPreset: string } | null;
  claude: { permissionMode: string } | null;
  opencode: Record<string, unknown> | null;
};
/** The levels before Core served them: Codex keeps each, Claude Code all but full, OpenCode none. */
export const DEFAULT_LEVELS: LevelInfo[] = [
  { level: "ask", label: "Ask you first", labelZh: "先问你", codex: { permissionPreset: "ask" }, claude: { permissionMode: "default" }, opencode: null },
  { level: "auto", label: "Auto-approve", labelZh: "自动审批", codex: { permissionPreset: "auto" }, claude: { permissionMode: "auto" }, opencode: null },
  { level: "full", label: "Full access", labelZh: "完全放开", codex: { permissionPreset: "full" }, claude: null, opencode: null },
];
/** Whether `harness` keeps `level`; no level is kept everywhere. */
export const keepsLevel = (levels: LevelInfo[], level: string, harness: ExecutorHarness) =>
  !level || levels.some((l) => l.level === level && l[harness] != null);
export type DeliveryMode = "pr" | "direct-commit" | "none";
export type StepKind = "materials" | "work" | "result" | "gate" | "job" | "pr" | "review" | "ci" | "merge";
/** `rounds` only on a review (1 or 2), `approver` only on a gate (unset: the user). */
export type TemplateStep = { kind: StepKind; label?: string; rounds?: number; approver?: "user" | "lead" | "either" };
/** A template the user can adopt in Settings (YN-23): its fields in one
 * language, with no harness (its template follows routing, YN-56), a model
 * hint, since Core has no model tiers, and its permission level if it names
 * one. Never stored until the user saves. */
export type ExecutorPreset = {
  id: string;
  language?: string;
  label: string;
  whenToChoose?: string;
  modelHint?: string;
  instructions?: string;
  deliveryMode?: DeliveryMode;
  steps?: TemplateStep[];
  permissionLevel?: PermissionLevel;
  /** The tier its work wants (YN-70), which a template made from it keeps. */
  tier?: ModelTier;
};
/** The presets in the page's language; one without a language is in every one. */
export const presetsIn = (presets: ExecutorPreset[], language: string) => {
  const these = presets.filter((p) => !p.language || p.language === language);
  return these.length ? these : presets.filter((p) => !p.language || p.language === "en");
};
export const STEP_KINDS: StepKind[] = ["materials", "work", "result", "gate", "job", "pr", "review", "ci", "merge"];
/** The kinds only a template delivered by pull request has. */
export const PR_STEP_KINDS: StepKind[] = ["pr", "review", "ci", "merge"];
export const MAX_STEPS = 12;
/** A template's steps when it sets none, as Core resolves them (executor_templates.rs `default_steps`). */
export const defaultSteps = (mode: DeliveryMode = "pr"): TemplateStep[] =>
  (mode === "direct-commit" ? ["materials", "work", "job", "result"] as StepKind[]
    : mode === "none" ? ["materials", "work", "result"] as StepKind[]
    : ["materials", "work", "job", "pr", "review", "ci", "merge"] as StepKind[]).map((kind) => ({ kind }));
/** `laterTemplates`: templates a newer Core saved that this one can't read or use; a save keeps them. */
export type TemplateList = { version: number; templates: ExecutorTemplate[]; laterTemplates?: number };
export type ExecutorTemplatesView = {
  /** The Workspace's templates: the only list (YN-2 S2). */
  workspace: TemplateList;
  /** What a dispatch can use: the Workspace's templates. `project` only from a Core before YN-2 S2. */
  available: { template: ExecutorTemplate; source: "project" | "workspace" }[];
  /** Presets the user can adopt, each in each language (YN-23). */
  presets: ExecutorPreset[];
  defaultNamePattern: string;
  /** Core also answers `maxConcurrent` for a release (YN-2): a template has no limit of its own any more (T-43). */
  limits: { templates: number; instructionsBytes: number };
  opencodeEnabled: boolean;
  /** What a general executor (`executor: {}`, YN-2) of the read Project would be made with now; absent from an older Core. */
  general?: GeneralExecutor;
  /** Who last changed each template, when and why, by its id (YN-24); absent from a Core without it. */
  lastModified?: Record<string, TemplateChange>;
  /** What each permission level is on each harness (YN-56); DEFAULT_LEVELS from a Core without it. */
  levels: LevelInfo[];
};
/** A template's last change: by you or a lead, the reason a lead gave. */
export type TemplateChange = { version?: number; at: string; reason?: string | null; by: { kind: string; id?: string | null; name: string } };

const changesOf = (value: unknown): Record<string, TemplateChange> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, TemplateChange> = {};
  for (const [id, change] of Object.entries(value as Record<string, Partial<TemplateChange>>)) {
    if (change && typeof change.at === "string" && change.by && typeof change.by.name === "string") out[id] = change as TemplateChange;
  }
  return out;
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
    ...(changesOf(value.lastModified) ? { lastModified: changesOf(value.lastModified) } : {}),
    levels: Array.isArray(value.levels) && value.levels.length
      ? value.levels.filter((l) => l && PERMISSION_LEVELS.includes(l.level)) : DEFAULT_LEVELS,
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
