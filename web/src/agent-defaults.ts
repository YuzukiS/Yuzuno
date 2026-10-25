import { api } from "./api";
import { permissionLabel } from "./CodexPermissions";

/** Where a new Agent's value comes from (T-190). */
export type DefaultSource = "builtin" | "workspace" | "project" | "request";
export type NewAgentHarness = "codex" | "claude";
export type SavedDefaults = { harness?: NewAgentHarness; codexPermissionPreset?: string; claudePermissionMode?: string };
export type EffectiveDefaults = {
  harness: { value: NewAgentHarness; source: DefaultSource };
  /** null: Yuzuno's built-in "Ask for approval" (on-request, workspace-write). */
  codexPermissionPreset: { value: string | null; source: DefaultSource };
  claudePermissionMode: { value: string; source: DefaultSource };
};
export type AgentDefaultsView = {
  /** The Workspace's own choices. */
  saved: SavedDefaults;
  builtIn: { harness: NewAgentHarness; codexPermissionPreset: null; claudePermissionMode: string };
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
}>;

/** The Workspace's defaults; with a project, as an Agent created in it gets them. */
export const readAgentDefaults = (signal?: AbortSignal, projectId?: string) =>
  api<AgentDefaultsView>(projectId ? `/agent-defaults?projectId=${encodeURIComponent(projectId)}` : "/agent-defaults", { signal });
export const changeAgentDefaults = (change: AgentDefaultsChange) =>
  api<AgentDefaultsView>("/agent-defaults", { method: "POST", body: JSON.stringify(change) });
/** A project's own overrides: null deletes only that project's choice. */
export const changeProjectAgentDefaults = (projectId: string, change: AgentDefaultsChange) =>
  api<AgentDefaultsView>(`/projects/${encodeURIComponent(projectId)}/agent-defaults`, { method: "POST", body: JSON.stringify(change) });

export const harnessName = (harness: string) => (harness === "claude" ? "Claude Code" : harness === "opencode" ? "OpenCode" : "Codex");
export const CODEX_PRESETS = ["config", "ask", "auto", "full"] as const;
/** Yuzuno's built-in Codex permissions are its "Ask for approval". */
export const codexPermissionText = (preset: string | null | undefined) =>
  preset ? permissionLabel(preset) || preset : "Ask for approval";
export const CLAUDE_MODES = ["default", "auto"] as const;
export const claudeModeText = (mode: string | null | undefined) => (mode === "auto" ? "Auto mode" : "Ask before actions");
/** "Follow Codex config" follows the machine; every other value is Yuzuno's own choice. */
export const followsNative = (preset: string | null | undefined) => preset === "config";
export const sourceText = (source: DefaultSource | undefined) =>
  source === "workspace"
    ? "Set for this Workspace"
    : source === "project"
      ? "Set for this project"
      : source === "request"
        ? "Chosen for this Agent"
        : source === "builtin"
          ? "Built in"
          : "Not reported by this Core";
