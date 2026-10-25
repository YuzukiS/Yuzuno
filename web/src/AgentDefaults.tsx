import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { langTag, strings, useLanguage } from "./i18n";
import type { Model } from "./types";
import {
  CLAUDE_MODES,
  CODEX_PRESETS,
  type AgentDefaultsChange,
  type AgentDefaultsView,
  type SavedDefaults,
  changeAgentDefaults,
  changeProjectAgentDefaults,
  claudeModeText,
  claudeModelText,
  codexModelText,
  codexPermissionText,
  harnessName,
  readAgentDefaults,
  sourceText,
} from "./agent-defaults";

/** One choice in the editor: "" is no choice here (built in for the
 * Workspace; inherited for a project). */
type Draft = { harness: string; codexPermissionPreset: string; claudePermissionMode: string; codexModel: string; codexReasoningEffort: string; claudeModel: string };
const draftFrom = (saved: SavedDefaults): Draft => ({
  harness: saved.harness ?? "",
  codexPermissionPreset: saved.codexPermissionPreset ?? "",
  claudePermissionMode: saved.claudePermissionMode ?? "",
  codexModel: saved.codexModel ?? "",
  codexReasoningEffort: saved.codexReasoningEffort ?? "",
  claudeModel: saved.claudeModel ?? "",
});
const FIELDS = ["harness", "codexPermissionPreset", "claudePermissionMode", "codexModel", "codexReasoningEffort", "claudeModel"] as const;
const modelName = (m: Model) => m.model || m.id;

// The editor's own words (T-189). Harness and model names, efforts, what Core
// says about where a model applies, and its errors are shown as they come.
const text = strings({
  saved: (project: boolean): string =>
    project
      ? "Saved for this project. Agents created in it from now on use these; existing Agents keep their settings."
      : "Saved. Agents created from now on use these; existing Agents keep their settings.",
  inherit: (value: string, source: string) => `Inherit · ${value} (${source})`,
  builtIn: (value: string) => `Built in · ${value}`,
  sectionProject: "New Agent defaults for this project",
  section: "New Agent defaults",
  title: "New Agent defaults",
  introProject:
    "For Agents created in this project. A setting left to inherit uses the Workspace’s choice, or the built-in. Existing Agents keep their own settings.",
  intro: "Used when an Agent is created, here or by another client. Existing Agents keep their own settings; change those from each Agent.",
  current: "What a new Agent gets now",
  harness: "Harness",
  harnessHelp: (source: string, harness: string) =>
    `${source}: ${harness}. The create dialog starts on it; you can pick another for each Agent.`,
  harnessLabel: "Harness for new Agents",
  sourceLine: (source: string, value: string) => `${source}: ${value}.`,
  codexPermissions: "Codex permissions",
  codexPermissionsHelp:
    "Follow Codex config uses each machine’s own Codex configuration; the others are Yuzuno’s choice. Whether a machine allows it is checked when the Agent starts there.",
  codexPermissionsLabel: "Codex permissions for new Agents",
  claudePermissions: "Claude Code permissions",
  claudePermissionsHelp: "Auto mode needs a model that supports it. Each Agent shows the mode its session reports.",
  claudePermissionsLabel: "Claude Code permissions for new Agents",
  codexModel: "Codex model on the Core host",
  codexModelLine: (source: string, model: string, effort: string | null | undefined) =>
    `${source}: ${model}${effort ? `, reasoning effort ${effort}` : ""}.`,
  codexModelApplies: "Codex Agents created on the Core host. SSH machines, Claude Code and OpenCode keep their own model and effort.",
  catalogError: (harness: string, error: string) => `Couldn’t read this Core host’s ${harness} models: ${error}. A model can’t be chosen now.`,
  stale: (model: string, harness: string, project: boolean) =>
    `${model} is no longer offered by this Core host’s ${harness}, so new Agents can’t use it. Choose another, or ${project ? "inherit" : "Built in"}.`,
  codexModelLabel: "Codex model for new Agents",
  noLongerOffered: (model: string) => `${model} (no longer offered)`,
  effort: "Codex reasoning effort",
  effortHelp: "One the chosen model offers; with none chosen, the model’s own. Choose a model first.",
  effortLabel: "Codex reasoning effort for new Agents",
  modelsOwn: (effort: string | undefined) => `Model’s own${effort ? ` · ${effort}` : ""}`,
  modelAndReasoning: "Model and reasoning",
  modelAndReasoningHelp:
    "Chosen for each Agent when it is created. Model lists differ per machine, so there is no Workspace default for them yet.",
  claudeModel: "Claude Code model on the Core host",
  claudeModelApplies: "Claude Code Agents created on the Core host; their reasoning effort stays each Agent’s own.",
  readingClaude: "Reading this Core host’s Claude Code models…",
  noAutoMode: (model: string) =>
    `${model} can’t run in Auto mode: an Agent that would get Auto mode chooses its own model or permission mode.`,
  claudeModelLabel: "Claude Code model for new Agents",
  inheritAll: "Inherit all",
  builtInAll: "Use built-in for all",
  saving: "Saving…",
  save: "Save",
}, {
  saved: (project) =>
    project ? "已为此项目保存。此后在其中创建的 Agent 会使用这些设置；现有 Agent 保留各自的设置。" : "已保存。此后创建的 Agent 会使用这些设置；现有 Agent 保留各自的设置。",
  inherit: (value, source) => `继承 · ${value}（${source}）`,
  builtIn: (value) => `内置 · ${value}`,
  sectionProject: "此项目的新 Agent 默认值",
  section: "新 Agent 默认值",
  title: "新 Agent 默认值",
  introProject: "用于在此项目中创建的 Agent。设为继承的项使用 Workspace 的选择或内置值。现有 Agent 保留各自的设置。",
  intro: "在这里或其他客户端创建 Agent 时使用。现有 Agent 保留各自的设置；请在各个 Agent 中更改。",
  current: "新 Agent 现在会得到的设置",
  harness: "Harness",
  harnessHelp: (source, harness) => `${source}：${harness}。创建对话框会以它开始；你可以为每个 Agent 另选。`,
  harnessLabel: "新 Agent 的 Harness",
  sourceLine: (source, value) => `${source}：${value}。`,
  codexPermissions: "Codex 权限",
  codexPermissionsHelp: "“跟随 Codex 配置”使用每台机器自己的 Codex 配置；其他选项是 Yuzuno 的选择。机器是否允许会在 Agent 在那里启动时检查。",
  codexPermissionsLabel: "新 Agent 的 Codex 权限",
  claudePermissions: "Claude Code 权限",
  claudePermissionsHelp: "自动模式需要支持它的模型。每个 Agent 会显示其会话报告的模式。",
  claudePermissionsLabel: "新 Agent 的 Claude Code 权限",
  codexModel: "Core 主机上的 Codex 模型",
  codexModelLine: (source, model, effort) => `${source}：${model}${effort ? `，推理强度 ${effort}` : ""}。`,
  codexModelApplies: "在 Core 主机上创建的 Codex Agent。SSH 机器、Claude Code 和 OpenCode 保留各自的模型和强度。",
  catalogError: (harness, error) => `无法读取此 Core 主机的 ${harness} 模型：${error}。现在无法选择模型。`,
  stale: (model, harness, project) =>
    `此 Core 主机的 ${harness} 已不再提供 ${model}，因此新 Agent 无法使用它。请另选一个，或${project ? "改为继承" : "选择“内置”"}。`,
  codexModelLabel: "新 Agent 的 Codex 模型",
  noLongerOffered: (model) => `${model}（已不再提供）`,
  effort: "Codex 推理强度",
  effortHelp: "所选模型提供的一种；未选择时使用模型自己的。请先选择模型。",
  effortLabel: "新 Agent 的 Codex 推理强度",
  modelsOwn: (effort) => `模型自己的${effort ? ` · ${effort}` : ""}`,
  modelAndReasoning: "模型与推理",
  modelAndReasoningHelp: "在创建每个 Agent 时选择。各机器的模型列表不同，因此目前还没有 Workspace 默认值。",
  claudeModel: "Core 主机上的 Claude Code 模型",
  claudeModelApplies: "在 Core 主机上创建的 Claude Code Agent；推理强度仍由每个 Agent 自己决定。",
  readingClaude: "正在读取此 Core 主机的 Claude Code 模型…",
  noAutoMode: (model) => `${model} 无法在自动模式下运行：本应获得自动模式的 Agent 会自行选择模型或权限模式。`,
  claudeModelLabel: "新 Agent 的 Claude Code 模型",
  inheritAll: "全部继承",
  builtInAll: "全部使用内置",
  saving: "正在保存…",
  save: "保存",
});

/**
 * New Agent defaults (T-190): the Workspace's own choice of harness and of
 * each harness's permissions, used only when an Agent is created. "Built in"
 * is no choice at all; choosing it deletes the Workspace's value rather than
 * copying Yuzuno's. Existing Agents keep their own settings, and a machine
 * still decides at start whether it allows a permission.
 *
 * With `projectId`, the same fields for Agents created in that project: no
 * choice there inherits the Workspace's (or the built-in), and clearing one
 * deletes only that project's override. Its words follow the interface
 * language there too, with its own `lang`: the page around it is English.
 */
export function AgentDefaults({ active, projectId, disabled = false }: { active: boolean; projectId?: string; disabled?: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<AgentDefaultsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Whether the last save went through, worded when shown.
  const [status, setStatus] = useState(false);
  // The Core host's Codex catalog, for a default model and effort (T-190).
  const [models, setModels] = useState<Model[] | null>(null);
  const [catalogError, setCatalogError] = useState("");
  // Claude Code's catalog starts a catalog-only Claude Code on the Core host,
  // so it is read when its choice is opened, or at once when this level has a
  // Claude model to check.
  const [claudeModels, setClaudeModels] = useState<Model[] | null>(null);
  const [claudeCatalogError, setClaudeCatalogError] = useState("");
  const [claudeWanted, setClaudeWanted] = useState(false);
  const own = (from: AgentDefaultsView) => (projectId ? from.project?.saved ?? {} : from.saved);
  const draftOf = (from: AgentDefaultsView) => draftFrom(own(from));
  const adopt = (next: AgentDefaultsView) => {
    setView(next);
    setDraft(draftOf(next));
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    void readAgentDefaults(controller.signal, projectId)
      .then((value) => {
        if (!controller.signal.aborted) adopt(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId]);
  // Only from a Core that has model defaults: an older one doesn't report them.
  const modelDefaults = !!view?.effective?.codexModel;
  useEffect(() => {
    if (!active || !modelDefaults) return;
    const controller = new AbortController();
    setCatalogError("");
    void api<{ models: Model[] }>("/models", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setModels(result.models || []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setCatalogError(errorText(e));
      });
    return () => controller.abort();
  }, [active, modelDefaults]);
  const claudeModelDefaults = !!view?.effective?.claudeModel;
  const claudeSaved = !!(view && own(view).claudeModel);
  const claudeRead = active && claudeModelDefaults && (claudeWanted || claudeSaved);
  useEffect(() => {
    if (!claudeRead) return;
    const controller = new AbortController();
    setClaudeCatalogError("");
    void api<{ models: Model[] }>("/models?harness=claude", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setClaudeModels(result.models || []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setClaudeCatalogError(errorText(e));
      });
    return () => controller.abort();
  }, [claudeRead]);
  const savedDraft = view ? draftOf(view) : null;
  const changes: AgentDefaultsChange = {};
  if (draft && savedDraft) {
    for (const field of FIELDS) {
      if (draft[field] !== savedDraft[field]) (changes as Record<string, string | null>)[field] = draft[field] || null;
    }
  }
  const changed = Object.keys(changes).length > 0;
  const chosenModel = draft?.codexModel ? models?.find((m) => modelName(m) === draft.codexModel) : undefined;
  // A saved model the Core host no longer offers: shown, and said.
  const stale = !!draft?.codexModel && models !== null && !chosenModel;
  const chosenClaude = draft?.claudeModel ? claudeModels?.find((m) => modelName(m) === draft.claudeModel) : undefined;
  const claudeStale = !!draft?.claudeModel && claudeModels !== null && !chosenClaude;
  const anySaved = !!savedDraft && FIELDS.some((field) => savedDraft[field]);
  async function save(change: AgentDefaultsChange) {
    if (saving) return;
    setSaving(true);
    setError("");
    setStatus(false);
    try {
      adopt(await (projectId ? changeProjectAgentDefaults(projectId, change) : changeAgentDefaults(change)));
      setStatus(true);
    } catch (e) {
      // The choice stays as made, to save again or change.
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const effective = view?.effective;
  // What "no choice here" means: the built-in for the Workspace, what the project inherits for a project.
  const inherited = projectId ? view?.project?.inherited : undefined;
  const none = (value: string, source?: Parameters<typeof sourceText>[0]) =>
    projectId ? t.inherit(value, sourceText(source, language)) : t.builtIn(value);
  const locked = saving || disabled;
  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLSelectElement>) => {
    setStatus(false);
    const value = event.target.value;
    setDraft((old) => {
      if (!old) return old;
      const next = { ...old, [field]: value };
      // An effort belongs to its model: one the new model doesn't offer goes.
      if (field === "codexModel") {
        const offered = models?.find((m) => modelName(m) === value)?.supportedReasoningEfforts?.some((e) => e.reasoningEffort === old.codexReasoningEffort);
        if (!offered) next.codexReasoningEffort = "";
      }
      return next;
    });
  };
  return (
    <section
      id={projectId ? undefined : "settings-agent-defaults"}
      className="settings-section agent-defaults-settings"
      aria-label={projectId ? t.sectionProject : t.section}
      lang={langTag(language)}
    >
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{projectId ? t.introProject : t.intro}</p>
        </div>
        {effective && (
          <span className="settings-current" title={t.current}>
            {harnessName(effective.harness.value)} ·{" "}
            {effective.harness.value === "claude"
              ? claudeModeText(effective.claudePermissionMode.value, language)
              : codexPermissionText(effective.codexPermissionPreset.value, language)}
          </span>
        )}
      </header>
      {draft && view && effective && (
        <div className="settings-group">
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.harness}</span>
              <span className="settings-row-help agent-default-source" data-source={effective.harness.source}>
                {t.harnessHelp(sourceText(effective.harness.source, language), harnessName(effective.harness.value))}
              </span>
            </span>
            <select
              className="settings-select"
              aria-label={t.harnessLabel}
              value={draft.harness}
              disabled={locked}
              onChange={set("harness")}
            >
              <option value="">
                {none(harnessName(inherited?.harness.value ?? view.builtIn.harness), inherited?.harness.source)}
              </option>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.codexPermissions}</span>
              <span className="settings-row-help agent-default-source" data-source={effective.codexPermissionPreset.source}>
                {t.sourceLine(sourceText(effective.codexPermissionPreset.source, language), codexPermissionText(effective.codexPermissionPreset.value, language))}
              </span>
              <span className="settings-row-help">{t.codexPermissionsHelp}</span>
            </span>
            <select
              className="settings-select"
              aria-label={t.codexPermissionsLabel}
              value={draft.codexPermissionPreset}
              disabled={locked}
              onChange={set("codexPermissionPreset")}
            >
              <option value="">
                {none(codexPermissionText(inherited ? inherited.codexPermissionPreset.value : null, language), inherited?.codexPermissionPreset.source)}
              </option>
              {CODEX_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {codexPermissionText(preset, language)}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.claudePermissions}</span>
              <span className="settings-row-help agent-default-source" data-source={effective.claudePermissionMode.source}>
                {t.sourceLine(sourceText(effective.claudePermissionMode.source, language), claudeModeText(effective.claudePermissionMode.value, language))}
              </span>
              <span className="settings-row-help">{t.claudePermissionsHelp}</span>
            </span>
            <select
              className="settings-select"
              aria-label={t.claudePermissionsLabel}
              value={draft.claudePermissionMode}
              disabled={locked}
              onChange={set("claudePermissionMode")}
            >
              <option value="">
                {none(claudeModeText(inherited?.claudePermissionMode.value ?? view.builtIn.claudePermissionMode, language), inherited?.claudePermissionMode.source)}
              </option>
              {CLAUDE_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {claudeModeText(mode, language)}
                </option>
              ))}
            </select>
          </label>
          {effective.codexModel ? (
            <>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.codexModel}</span>
                  <span className="settings-row-help agent-default-source" data-source={effective.codexModel.source}>
                    {t.codexModelLine(
                      sourceText(effective.codexModel.source, language),
                      codexModelText(effective.codexModel.value, language),
                      effective.codexReasoningEffort?.value,
                    )}
                  </span>
                  <span className="settings-row-help">{view.modelAppliesTo ?? t.codexModelApplies}</span>
                  {catalogError && (
                    <span className="settings-row-help updates-error" role="alert">
                      {t.catalogError("Codex", catalogError)}
                    </span>
                  )}
                  {stale && (
                    <span className="settings-row-help updates-error" role="alert">
                      {t.stale(draft.codexModel, "Codex", !!projectId)}
                    </span>
                  )}
                </span>
                <select
                  className="settings-select"
                  aria-label={t.codexModelLabel}
                  value={draft.codexModel}
                  disabled={locked}
                  onChange={set("codexModel")}
                >
                  <option value="">
                    {none(codexModelText(inherited ? inherited.codexModel?.value : null, language), inherited?.codexModel?.source)}
                  </option>
                  {stale && <option value={draft.codexModel}>{t.noLongerOffered(draft.codexModel)}</option>}
                  {catalogError && draft.codexModel && !models && <option value={draft.codexModel}>{draft.codexModel}</option>}
                  {(models ?? []).map((m) => (
                    <option key={modelName(m)} value={modelName(m)}>
                      {m.displayName || modelName(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.effort}</span>
                  <span className="settings-row-help">{t.effortHelp}</span>
                </span>
                <select
                  className="settings-select"
                  aria-label={t.effortLabel}
                  value={draft.codexReasoningEffort}
                  disabled={locked || !chosenModel}
                  onChange={set("codexReasoningEffort")}
                >
                  <option value="">
                    {t.modelsOwn(chosenModel?.defaultReasoningEffort)}
                  </option>
                  {(chosenModel?.supportedReasoningEfforts ?? []).map((e) => (
                    <option key={e.reasoningEffort} value={e.reasoningEffort}>
                      {e.reasoningEffort}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <div className="settings-row">
              <span className="settings-row-main">
                <span className="settings-row-title">{t.modelAndReasoning}</span>
                <span className="settings-row-help">{t.modelAndReasoningHelp}</span>
              </span>
            </div>
          )}
          {effective.claudeModel && (
            <label className="settings-row">
              <span className="settings-row-main">
                <span className="settings-row-title">{t.claudeModel}</span>
                <span className="settings-row-help agent-default-source" data-source={effective.claudeModel.source}>
                  {t.sourceLine(sourceText(effective.claudeModel.source, language), claudeModelText(effective.claudeModel.value, language))}
                </span>
                <span className="settings-row-help">{t.claudeModelApplies}</span>
                {claudeRead && !claudeModels && !claudeCatalogError && <span className="settings-row-help">{t.readingClaude}</span>}
                {claudeCatalogError && (
                  <span className="settings-row-help updates-error" role="alert">
                    {t.catalogError("Claude Code", claudeCatalogError)}
                  </span>
                )}
                {claudeStale && (
                  <span className="settings-row-help updates-error" role="alert">
                    {t.stale(draft.claudeModel, "Claude Code", !!projectId)}
                  </span>
                )}
                {chosenClaude?.supportsAutoMode === false && <span className="settings-row-help">{t.noAutoMode(draft.claudeModel)}</span>}
              </span>
              <select
                className="settings-select"
                aria-label={t.claudeModelLabel}
                value={draft.claudeModel}
                disabled={locked}
                onFocus={() => setClaudeWanted(true)}
                onPointerDown={() => setClaudeWanted(true)}
                onChange={set("claudeModel")}
              >
                <option value="">
                  {none(claudeModelText(inherited ? inherited.claudeModel?.value : null, language), inherited?.claudeModel?.source)}
                </option>
                {claudeStale && <option value={draft.claudeModel}>{t.noLongerOffered(draft.claudeModel)}</option>}
                {draft.claudeModel && !claudeModels && <option value={draft.claudeModel}>{draft.claudeModel}</option>}
                {(claudeModels ?? []).map((m) => (
                  <option key={modelName(m)} value={modelName(m)}>
                    {m.displayName || modelName(m)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(changed || saving || anySaved) && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                {anySaved && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() =>
                      void save({
                        harness: null,
                        codexPermissionPreset: null,
                        claudePermissionMode: null,
                        // Only to a Core that has them: an older one refuses fields it doesn't know.
                        ...(modelDefaults ? { codexModel: null, codexReasoningEffort: null } : {}),
                        ...(claudeModelDefaults ? { claudeModel: null } : {}),
                      })
                    }
                  >
                    {projectId ? t.inheritAll : t.builtInAll}
                  </button>
                )}
                {changed && (
                  <button type="button" className="primary-button" disabled={locked} onClick={() => void save(changes)}>
                    {saving ? t.saving : t.save}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {status && (
        <p className="settings-row-help" role="status">
          {t.saved(!!projectId)}
        </p>
      )}
      {error && (
        <p className="updates-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
