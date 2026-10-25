import { api } from "./api";
import { permissionLabel } from "./CodexPermissions";
import { strings, type Language } from "./i18n";

/** Where a new Agent's value comes from (T-190). */
export type DefaultSource = "builtin" | "workspace" | "project" | "request";
export type NewAgentHarness = "codex" | "claude";
export type SavedDefaults = {
  harness?: NewAgentHarness;
  codexPermissionPreset?: string;
  claudePermissionMode?: string;
  /** Codex on the Core host only: a model of its catalog, and one of its efforts. */
  codexModel?: string;
  codexReasoningEffort?: string;
  /** Claude Code on the Core host only: a model of its catalog. */
  claudeModel?: string;
};
type Valued = { value: string | null; source: DefaultSource };
export type EffectiveDefaults = {
  harness: { value: NewAgentHarness; source: DefaultSource };
  /** null: Yuzuno's built-in "Ask for approval" (on-request, workspace-write). */
  codexPermissionPreset: { value: string | null; source: DefaultSource };
  claudePermissionMode: { value: string; source: DefaultSource };
  /** null: Codex's own default on the Core host. Left out by a Core without model defaults. */
  codexModel?: Valued;
  /** null: the model's own effort. */
  codexReasoningEffort?: Valued;
  /** null: Claude Code's own default on the Core host. Left out by a Core without it. */
  claudeModel?: Valued;
};
export type AgentDefaultsView = {
  /** The Workspace's own choices. */
  saved: SavedDefaults;
  builtIn: { harness: NewAgentHarness; codexPermissionPreset: null; claudePermissionMode: string; codexModel?: null; codexReasoningEffort?: null; claudeModel?: null };
  /** Where a default model and effort apply (Codex and Claude Code on the Core host). */
  modelAppliesTo?: string;
  /** What a new Agent gets now: in a project, with its overrides. */
  effective: EffectiveDefaults;
  /** Read for a project: its own overrides, and what it inherits without them. */
  project?: { id: string; saved: SavedDefaults; inherited: EffectiveDefaults };
};
/** A change: a field left out stays as it is, null returns it to built in. */
export type AgentDefaultsChange = Partial<{
  harness: NewAgentHarness | null;
  codexPermissionPreset: string | null;
  claudePermissionMode: string | null;
  codexModel: string | null;
  codexReasoningEffort: string | null;
  claudeModel: string | null;
}>;

/** The Workspace's defaults; with a project, as an Agent created in it gets them. */
export const readAgentDefaults = (signal?: AbortSignal, projectId?: string) =>
  api<AgentDefaultsView>(projectId ? `/agent-defaults?projectId=${encodeURIComponent(projectId)}` : "/agent-defaults", { signal });
export const changeAgentDefaults = (change: AgentDefaultsChange) =>
  api<AgentDefaultsView>("/agent-defaults", { method: "POST", body: JSON.stringify(change) });
/** A project's own overrides: null deletes only that project's choice. */
export const changeProjectAgentDefaults = (projectId: string, change: AgentDefaultsChange) =>
  api<AgentDefaultsView>(`/projects/${encodeURIComponent(projectId)}/agent-defaults`, { method: "POST", body: JSON.stringify(change) });

// How these values are said, in English unless a page passes its language
// (T-189: Settings → New Agent defaults). Model names are said as they come.
const words = strings({
  presets: {} as Record<string, string>,
  ask: "Ask for approval",
  auto: "Auto mode",
  askFirst: "Ask before actions",
  sources: {
    workspace: "Set for this Workspace",
    project: "Set for this project",
    request: "Chosen for this Agent",
    builtin: "Built in",
  } as Record<DefaultSource, string>,
  unreported: "Not reported by this Core",
  codexDefault: "Codex’s own default",
  claudeDefault: "Claude Code’s own default",
}, {
  presets: { config: "跟随 Codex 配置", ask: "请求批准", auto: "替我批准", full: "完全访问" },
  ask: "请求批准",
  auto: "自动模式",
  askFirst: "操作前询问",
  sources: { workspace: "已为此 Workspace 设置", project: "已为此项目设置", request: "为此 Agent 选择", builtin: "内置" },
  unreported: "此 Core 未报告",
  codexDefault: "Codex 自己的默认值",
  claudeDefault: "Claude Code 自己的默认值",
});

export const harnessName = (harness: string) => (harness === "claude" ? "Claude Code" : harness === "opencode" ? "OpenCode" : "Codex");
export const CODEX_PRESETS = ["config", "ask", "auto", "full"] as const;
/** Yuzuno's built-in Codex permissions are its "Ask for approval". */
export const codexPermissionText = (preset: string | null | undefined, language: Language = "en") => {
  const w = words(language);
  return preset ? w.presets[preset] || permissionLabel(preset) || preset : w.ask;
};
export const CLAUDE_MODES = ["default", "auto"] as const;
export const claudeModeText = (mode: string | null | undefined, language: Language = "en") =>
  mode === "auto" ? words(language).auto : words(language).askFirst;
/** "Follow Codex config" follows the machine; every other value is Yuzuno's own choice. */
export const followsNative = (preset: string | null | undefined) => preset === "config";
export const sourceText = (source: DefaultSource | undefined, language: Language = "en") =>
  (source && words(language).sources[source]) || words(language).unreported;
/** A Codex model on the Core host, said: null is Codex's own default there. */
export const codexModelText = (model: string | null | undefined, language: Language = "en") => model || words(language).codexDefault;
/** A Claude Code model on the Core host, said: null is Claude Code's own default there. */
export const claudeModelText = (model: string | null | undefined, language: Language = "en") => model || words(language).claudeDefault;
