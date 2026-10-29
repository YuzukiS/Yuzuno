import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, Settings2 } from "lucide-react";
import { api, errorText, post } from "./api";
import { Modal } from "./components";
import { ChoiceChips } from "./ChoiceChips";
import type { Agent, AgentSettings as Settings, ContextUsage, Model, PermissionCatalog } from "./types";
import { CodexContextSettings, TOKEN_INVALID, tokenSetting } from "./CodexContextSettings";
import type { CodexContextSettings as ContextSettings } from "./types";
import { CodexPermissions } from "./CodexPermissions";
import { langTag, strings, useLanguage } from "./i18n";
import "./agent-settings.css";

const defaults: Settings = {
  reasoningEffort: null,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
};
// Thrown in English and said in the language shown (T-189).
const COMPACT_EXCEEDS = "The compaction threshold cannot exceed the configured window.";
// The dialog's own words (T-189). Names, models, effort levels and their
// descriptions, and Core's errors are shown as they came.
const text = strings({
  button: "Agent settings",
  buttonTitle: (harness: string): string => (harness === "claude" ? "Claude Code model, reasoning effort and approvals" : harness === "opencode" ? "OpenCode model and variant" : "Model, reasoning and permissions"),
  model: "Model",
  andWhat: (harness: string) => ` & ${harness === "claude" ? "approvals" : harness === "opencode" ? "variant" : "reasoning"}`,
  title: (name: string) => `${name} · Agent settings`,
  claudeDescription: "The model and reasoning effort apply from the next turn; a running turn keeps its own, and this conversation stays together. Approvals apply to Claude’s next permission check, including in a running turn.",
  codexDescription: "Model, effort and permissions apply to new turns. The current turn and pending requests keep their existing permissions. Context settings need a separate safe reload while the conversation is idle.",
  opencodeDescription: "The model and its variant go with each new message from the next one; a running turn keeps what it was sent with. Both are what OpenCode’s configured providers list. Permissions stay OpenCode’s own configuration.",
  variant: "Variant",
  variantNote: "OpenCode runs the model with this variant from the next message. Default leaves it to OpenCode.",
  variantBack: (name: string, variant: string) => `${name || "This model"} does not list variant ${variant}; it is back to the default.`,
  machine: (name: string | null) => `Execution machine: ${name || "Core host"}`,
  loading: "Loading this agent’s model catalog…",
  harnessDefault: "Harness default",
  current: "current",
  default: "default",
  effort: "Reasoning effort",
  claudeDefault: "Claude Code default",
  notForModel: "not available for this model",
  effortRefused: "This model does not take the saved effort. Choose another, or Claude Code default.",
  noEffort: "This model does not take a reasoning effort.",
  effortNext: "Claude runs at this effort from the next turn.",
  effortDecides: "Claude Code decides: the model’s default, or the effort in your Claude settings when a session starts.",
  effortReported: (level: string, latest: boolean) =>
    `Claude Code reported ${level} for ${latest ? "the latest turn" : "an earlier turn"}.`,
  approvals: "Approvals",
  askBefore: "Ask before actions",
  autoMode: "Auto mode",
  autoNote: "Claude Code’s classifier approves or blocks each action. It still asks when it cannot decide, and for questions.",
  askNote: "Claude asks before any action its permission rules do not already allow.",
  sessionMode: (mode: string) => `This session is currently in ${mode} mode. Saving applies the mode chosen here to it now.`,
  chooseModel: "Choose a model to see its reasoning efforts.",
  retry: "Retry models",
  saving: "Saving…",
  save: "Save",
  closeDialog: "Close dialog",
  unknownModel: (wanted: string, claude: boolean) =>
    `“${wanted}” is not a model this Agent's ${claude ? "Claude Code" : "Codex"} offers; choose one below.`,
  effortBack: (name: string, effort: string) =>
    `${name || "This model"} does not take reasoning effort ${effort}; it is back to Claude Code default.`,
  contextReset: "Context overrides reset to automatic for the new model. Save, then apply when idle.",
  savedApply: "Saved. Apply them when this conversation is idle.",
  savedUnread: (error: string) => `Saved, but the context status couldn’t be read again (${error}). Refresh it before applying.`,
  reloadRequested: "Reload requested for this same conversation. The available window above updates when Codex reports it.",
  overridesCleared: "Saved context overrides cleared. Reconnect to use your Codex configuration, or apply when available and idle.",
  compactExceeds: COMPACT_EXCEEDS,
  tokenInvalid: TOKEN_INVALID,
}, {
  button: "Agent 设置",
  buttonTitle: (harness) => (harness === "claude" ? "Claude Code 的模型、推理强度与审批" : harness === "opencode" ? "OpenCode 的模型与变体" : "模型、推理与权限"),
  model: "模型",
  andWhat: (harness) => ` 与${harness === "claude" ? "审批" : harness === "opencode" ? "变体" : "推理"}`,
  title: (name) => `${name} · Agent 设置`,
  claudeDescription: "模型和推理强度从下一个 Turn 起生效；正在运行的 Turn 保持自己的设置，此会话也不会被拆开。审批设置对 Claude 的下一次权限检查生效，包括正在运行的 Turn。",
  codexDescription: "模型、推理强度和权限对新的 Turn 生效。当前 Turn 和待处理的请求保留原有权限。上下文设置需要在会话空闲时另行安全地重新载入。",
  opencodeDescription: "模型及其变体从下一条消息起随每条新消息发送；正在运行的 Turn 保持发送时的设置。两者都来自 OpenCode 已配置的提供方。权限仍由 OpenCode 自己的配置决定。",
  variant: "变体",
  variantNote: "从下一条消息起，OpenCode 用这个变体运行模型。选默认则由 OpenCode 决定。",
  variantBack: (name, variant) => `${name || "此模型"}没有列出变体 ${variant}，已恢复为默认。`,
  machine: (name) => `执行机器：${name || "Core 主机"}`,
  loading: "正在载入此 Agent 的模型目录…",
  harnessDefault: "Harness 默认",
  current: "当前",
  default: "默认",
  effort: "推理强度",
  claudeDefault: "Claude Code 默认",
  notForModel: "此模型不可用",
  effortRefused: "此模型不接受已保存的推理强度。请另选一个，或使用 Claude Code 默认。",
  noEffort: "此模型不接受推理强度。",
  effortNext: "Claude 从下一个 Turn 起按此强度运行。",
  effortDecides: "由 Claude Code 决定：模型的默认值，或会话开始时你在 Claude 设置中的推理强度。",
  effortReported: (level, latest) => `Claude Code 报告${latest ? "最近一个 Turn" : "较早的一个 Turn"}的推理强度为 ${level}。`,
  approvals: "审批",
  askBefore: "操作前询问",
  autoMode: "自动模式",
  autoNote: "Claude Code 的分类器会批准或阻止每个操作。无法判断时以及遇到问题时，它仍会询问。",
  askNote: "对于权限规则尚未允许的任何操作，Claude 都会先询问。",
  sessionMode: (mode) => `此会话当前处于 ${mode} 模式。保存后会立即把这里选择的模式应用到它。`,
  chooseModel: "选择一个模型以查看其推理强度。",
  retry: "重新读取模型",
  saving: "正在保存…",
  save: "保存",
  closeDialog: "关闭对话框",
  unknownModel: (wanted, claude) => `“${wanted}”不是此 Agent 的 ${claude ? "Claude Code" : "Codex"} 提供的模型；请在下方选择一个。`,
  effortBack: (name, effort) => `${name || "此模型"}不接受推理强度 ${effort}，已恢复为 Claude Code 默认。`,
  contextReset: "已为新模型把上下文覆盖设置恢复为自动。请先保存，再在空闲时应用。",
  savedApply: "已保存。请在此会话空闲时应用。",
  savedUnread: (error) => `已保存，但无法重新读取上下文状态（${error}）。请先刷新再应用。`,
  reloadRequested: "已请求重新载入此会话。上方的可用窗口会在 Codex 报告后更新。",
  overridesCleared: "已清除保存的上下文覆盖设置。重新连接即可使用你的 Codex 配置，或在可用且空闲时应用。",
  compactExceeds: "压缩阈值不能超过所设置的窗口。",
  tokenInvalid: "请输入正整数，或留空以使用自动值。",
});
type Words = ReturnType<typeof text>;
/** A note or error: as Core gave it, or worded on show from this dialog's words. */
type Said = string | ((t: Words) => string);

const chosenMode = (agent: Agent) =>
  agent.settings?.permissionMode === "auto" ? "auto" : "default";
export function AgentSettings({
  agent,
  disabled,
  onSaved,
  onOpenChange,
  observedPermissionMode,
  observedEffort,
  observedContextUsage,
  request,
  onRequestOpened,
}: {
  agent: Agent;
  disabled?: boolean;
  onSaved: () => void;
  onOpenChange?: (open: boolean) => void;
  /** Mode the live Claude session reports, which may differ from the choice. */
  observedPermissionMode?: string | null;
  /** Effort Claude Code reported for a turn, and whether that is the latest. */
  observedEffort?: { level: string; latest: boolean } | null;
  observedContextUsage?: ContextUsage | null;
  /** The composer's `/model [name]`: open, preselecting that model. */
  request?: { model: string; nonce: number; agentId?: string; section?: "model" | "context" } | null;
  /** Called once the dialog has actually opened for `request`. */
  onRequestOpened?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const language = useLanguage();
  const t = text(language);
  const say = (said: Said) =>
    typeof said === "function" ? said(t)
      : said === COMPACT_EXCEEDS ? t.compactExceeds
        : said === TOKEN_INVALID ? t.tokenInvalid
          : said;
  const requested = useRef("");
  // A request made before this mount (for another Agent) is not this one's.
  const seen = useRef(request?.agentId === agent.id ? undefined : request?.nonce);
  const form = useRef<HTMLFormElement>(null);
  const focusContext = useRef(false);
  const claude = agent.harness === "claude";
  // OpenCode (T-10): only the model, from what its own OpenCode lists.
  const opencode = agent.harness === "opencode";
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<Model[]>([]);
  const [permissions, setPermissions] = useState<PermissionCatalog>();
  const [context, setContext] = useState<ContextSettings>();
  const [contextWindow, setContextWindow] = useState("");
  const [compactLimit, setCompactLimit] = useState("");
  const [contextNote, setContextNote] = useState<Said>("");
  const [model, setModel] = useState(agent.model);
  const [settings, setSettings] = useState<Settings>(
    agent.settings || defaults,
  );
  // Sessions start only in a mode the user chose; older records may hold a
  // mode Claude reported (e.g. accept edits), which is not a choice.
  const currentMode = chosenMode(agent);
  const [permissionMode, setPermissionMode] = useState(currentMode);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Said>("");
  const [effortNote, setEffortNote] = useState<Said>("");
  useEffect(() => {
    if (!open) return;
    let valid = true;
    setLoading(true);
    setError("");
    setEffortNote("");
    setModels([]);
    setPermissions(undefined);
    setModel(agent.model);
    setSettings(agent.settings || defaults);
    setContextWindow(String(agent.settings?.contextWindow ?? ""));
    setCompactLimit(String(agent.settings?.autoCompactTokenLimit ?? ""));
    setContext(undefined);
    setContextNote("");
    setPermissionMode(chosenMode(agent));
    api<{ models: Model[]; permissions?: PermissionCatalog; context?: ContextSettings }>(`/agents/${encodeURIComponent(agent.id)}/models`)
      .then(({ models, permissions, context }) => {
        if (!valid) return;
        setModels(models);
        setPermissions(permissions);
        setContext(context);
        const wanted = requested.current;
        requested.current = "";
        if (wanted) {
          const row = models.find((m) => m.model === wanted || m.id === wanted);
          // Chosen exactly as its chip would choose it; only Save keeps it.
          if (row && (row.model || row.id) !== agent.model) {
            selectModel(row.model || row.id, models, agent.settings?.reasoningEffort || "");
            return;
          }
          if (!row) setError(() => (t: Words) => t.unknownModel(wanted, agent.harness === "claude"));
        }
        // A Claude effort is only ever the user's choice; no default fills it.
        // OpenCode takes none here.
        if (agent.harness === "claude" || agent.harness === "opencode") return;
        const selected = models.find((m) => (m.model || m.id) === agent.model);
        setSettings((s) => ({
          ...s,
          reasoningEffort:
            s.reasoningEffort || selected?.defaultReasoningEffort || null,
        }));
      })
      .catch((e) => valid && setError(errorText(e)))
      .finally(() => valid && setLoading(false));
    return () => {
      valid = false;
    };
  }, [open, agent.id, agent.harness, reload]);
  useEffect(() => {
    if (!open || observedContextUsage === undefined) return;
    setContext((current) => current && ({ ...current,
      observedWindowTokens: observedContextUsage?.windowTokens ?? null,
      observedStale: observedContextUsage?.stale ?? false,
    }));
  }, [open, observedContextUsage]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  function changeOpen(next: boolean) {
    if (saving) return;
    setOpen(next);
    onOpenChange?.(next);
  }
  useEffect(() => {
    if (!request || (request.agentId && request.agentId !== agent.id) || request.nonce === seen.current || disabled) return;
    seen.current = request.nonce;
    requested.current = request.model;
    focusContext.current = request.section === "context";
    // Already open: read the catalog again so the requested model is chosen.
    if (open) setReload((n) => n + 1);
    else if (saving) return;
    else changeOpen(true);
    onRequestOpened?.();
    // Only a new request opens it; nothing else here reopens the dialog.
  }, [request?.nonce]);
  useEffect(() => {
    if (!open || loading || !focusContext.current) return;
    const fieldset = form.current?.querySelector<HTMLElement>(".codex-context-settings");
    if (fieldset) {
      focusContext.current = false;
      fieldset.tabIndex = -1;
      fieldset.focus();
      fieldset.scrollIntoView?.({ block: "start" });
    }
  }, [open, loading, request?.nonce]);
  const selected = models.find((m) => (m.model || m.id) === model);
  const efforts = selected?.supportedReasoningEfforts || [];
  // Claude's levels come from the chosen model's catalog row; no model is
  // Claude Code's default model, the catalog's "default" row.
  const effortRow = (m: string) =>
    models.find((row) => (row.model || row.id) === (m || "default"));
  const levelsFor = (row?: Model) =>
    row?.supportsEffort ? row.supportedEffortLevels || [] : [];
  const claudeEffortRow = claude ? effortRow(model) : undefined;
  const effortLevels = levelsFor(claudeEffortRow);
  const claudeEffort = claude ? settings.reasoningEffort || "" : "";
  // Without the model's row (catalog loading or failed) the saved effort
  // can be neither offered nor refused; Core checks it again on save.
  const effortUnlisted = !!claudeEffort && !effortLevels.includes(claudeEffort);
  // Choosing a model, from its chip or from the composer's /model: the same
  // switch either way, against `catalog` and the effort chosen so far.
  // Nothing is saved until Save.
  function selectModel(value: string, catalog: Model[], effort: string) {
    setModel(value);
    if (opencode) {
      // A chosen variant survives a model switch only if the new model lists it.
      const row = catalog.find((r) => (r.model || r.id) === value);
      if (effort && !(row?.variants || []).includes(effort)) {
        setSettings((s) => ({ ...s, reasoningEffort: null }));
        setEffortNote(() => (t: Words) => t.variantBack(row?.displayName || value, effort));
      } else setEffortNote("");
      return;
    }
    if (claude) {
      // A chosen effort survives a model switch only if the new model takes
      // it; otherwise say so and fall back to default.
      const row = catalog.find((r) => (r.model || r.id) === (value || "default"));
      if (effort && !levelsFor(row).includes(effort)) {
        setSettings((s) => ({ ...s, reasoningEffort: null }));
        const name = row?.displayName || value;
        setEffortNote(() => (t: Words) => t.effortBack(name, effort));
      } else setEffortNote("");
      return;
    }
    setContextWindow(""); setCompactLimit("");
    setContextNote(() => (t: Words) => t.contextReset);
    setSettings((s) => ({
      ...s,
      reasoningEffort: catalog.find((m) => (m.model || m.id) === value)?.defaultReasoningEffort || null,
    }));
  }
  const effortRefused = effortUnlisted && !!claudeEffortRow;
  // OpenCode's variant (T-10), kept where Claude keeps its effort.
  const opencodeVariant = opencode ? settings.reasoningEffort || "" : "";
  const variants = opencode ? selected?.variants || [] : [];
  const variantUnlisted = !!opencodeVariant && !variants.includes(opencodeVariant);
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const window = claude || opencode ? null : tokenSetting(contextWindow);
      const compact = claude || opencode ? null : tokenSetting(compactLimit);
      if (window !== null && compact !== null && compact > window) throw new Error(COMPACT_EXCEEDS);
      const contextChanged = !claude && !opencode && (window !== (agent.settings?.contextWindow ?? null) || compact !== (agent.settings?.autoCompactTokenLimit ?? null));
      await post(`/agents/${encodeURIComponent(agent.id)}/settings`, {
        model,
        // Claude always receives the chosen mode: saving also returns a live
        // session from a mode Claude switched to, and replaces older records.
        // OpenCode receives the model alone.
        ...(opencode
          ? { effort: opencodeVariant || null }
          : claude
            ? { permissionMode, effort: claudeEffort || null }
            : { settings: { ...settings, contextWindow: window, autoCompactTokenLimit: compact } }),
      });
      onSaved();
      if (contextChanged) {
        // Saved. What follows only reads the context status again, which
        // needs Codex; its failure must not read as a failed save (T-187).
        setContextNote(() => (t: Words) => t.savedApply);
        try {
          const updated = await api<{ context: ContextSettings }>(`/agents/${encodeURIComponent(agent.id)}/models`);
          setContext(updated.context);
        } catch (e) {
          const failed = errorText(e);
          setContextNote(() => (t: Words) => t.savedUnread(failed));
        }
        return;
      }
      setOpen(false);
      onOpenChange?.(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function applyContext() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const applied = await post<ContextSettings>(`/agents/${encodeURIComponent(agent.id)}/context/apply`, {});
      setContext(applied); setContextNote(() => (t: Words) => t.reloadRequested);
      onSaved();
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  async function resetContext() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      await post(`/agents/${encodeURIComponent(agent.id)}/settings`, {
        model: agent.model,
        settings: { ...(agent.settings || defaults), contextWindow: null, autoCompactTokenLimit: null },
      });
      setContextWindow(""); setCompactLimit("");
      setContext((current) => current && ({ ...current, requestedWindowTokens: null, settingsSubmitted: false, observedStale: true }));
      setContextNote(() => (t: Words) => t.overridesCleared);
      onSaved();
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  async function refreshContext() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const updated = await api<{ context: ContextSettings }>(`/agents/${encodeURIComponent(agent.id)}/models`);
      setContext(updated.context);
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  return (
    <>
      <button
        type="button"
        className="conversation-action agent-settings-button"
        aria-label={t.button}
        title={t.buttonTitle(agent.harness ?? "codex")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => changeOpen(true)}
      >
        <Settings2 size={16} />
        <span>
          {t.model}
          <span className="reasoning-label">{t.andWhat(agent.harness ?? "codex")}</span>
        </span>
        <ChevronDown size={12} className="settings-chevron" />
      </button>
      <Modal
        open={open}
        onOpenChange={changeOpen}
        title={t.title(agent.name)}
        description={claude ? t.claudeDescription : opencode ? t.opencodeDescription : t.codexDescription}
        lang={langTag(language)}
        closeLabel={t.closeDialog}
      >
        <form
          ref={form}
          className="agent-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="agent-settings-location">{t.machine(agent.remote?.machine.name || null)}</p>
          {loading && (
            <p role="status">
              <LoaderCircle size={14} className="spin" /> {t.loading}
            </p>
          )}
          <div className="agent-setting">
            <ChoiceChips
              label={t.model}
              name="agent-model"
              value={model}
              disabled={loading || saving}
              onChange={(value) => selectModel(value, models, opencode ? opencodeVariant : claudeEffort)}
              choices={[
                ...(claude || opencode ? [{ value: "", label: t.harnessDefault }] : []),
                // The model in use stays shown while the catalog loads, or
                // when the catalog no longer lists it.
                ...(!selected && model
                  ? [{ value: model, label: model, note: t.current }]
                  : []),
                ...models.map((m) => ({
                  value: m.model || m.id,
                  label: m.displayName,
                  note: m.isDefault ? t.default : undefined,
                  title: m.description || undefined,
                })),
              ]}
            />
            {selected?.description && (
              <small className="model-catalog-note">{selected.description}</small>
            )}
          </div>
          {claude && (
            <div className="agent-setting">
              <ChoiceChips
                label={t.effort}
                name="agent-effort"
                value={claudeEffort}
                disabled={loading || saving}
                onChange={(value) => {
                  setEffortNote("");
                  setSettings((s) => ({
                    ...s,
                    reasoningEffort: value || null,
                  }));
                }}
                choices={[
                  { value: "", label: t.claudeDefault },
                  ...(effortUnlisted
                    ? [
                        {
                          value: claudeEffort,
                          label: claudeEffort,
                          note: effortRefused ? t.notForModel : undefined,
                        },
                      ]
                    : []),
                  ...effortLevels.map((level) => ({ value: level, label: level })),
                ]}
              />
              <small>
                {effortRefused
                  ? t.effortRefused
                  : claudeEffortRow && !claudeEffortRow.supportsEffort
                    ? t.noEffort
                    : claudeEffort
                      ? t.effortNext
                      : t.effortDecides}
              </small>
              {effortNote && (
                <small className="model-catalog-note" role="status">
                  {say(effortNote)}
                </small>
              )}
              {observedEffort && (
                <small className="model-catalog-note">{t.effortReported(observedEffort.level, observedEffort.latest)}</small>
              )}
            </div>
          )}
          {claude && (
            <div className="agent-setting">
              <ChoiceChips
                label={t.approvals}
                name="agent-approvals"
                value={permissionMode}
                disabled={saving}
                onChange={setPermissionMode}
                choices={[
                  { value: "default", label: t.askBefore },
                  {
                    value: "auto",
                    label: t.autoMode,
                    disabled: selected?.supportsAutoMode === false,
                    note: selected?.supportsAutoMode === false ? t.notForModel : undefined,
                  },
                ]}
              />
              <small>
                {permissionMode === "auto" ? t.autoNote : t.askNote}
              </small>
              {observedPermissionMode &&
                observedPermissionMode !== currentMode && (
                  <small className="model-catalog-note">{t.sessionMode(observedPermissionMode)}</small>
                )}
            </div>
          )}
          {opencode && (variants.length > 0 || variantUnlisted) && (
            <div className="agent-setting">
              <ChoiceChips
                label={t.variant}
                name="agent-variant"
                value={opencodeVariant}
                disabled={loading || saving}
                onChange={(value) => {
                  setEffortNote("");
                  setSettings((s) => ({ ...s, reasoningEffort: value || null }));
                }}
                choices={[
                  { value: "", label: t.harnessDefault },
                  ...(variantUnlisted ? [{ value: opencodeVariant, label: opencodeVariant, note: t.notForModel }] : []),
                  ...variants.map((variant) => ({ value: variant, label: variant })),
                ]}
              />
              <small>{t.variantNote}</small>
            </div>
          )}
          {opencode && effortNote && (
            <small className="model-catalog-note" role="status">{say(effortNote)}</small>
          )}
          {!claude && !opencode && (
            <>
              <div className="agent-setting">
                <ChoiceChips
                  label={t.effort}
                  name="agent-effort"
                  value={settings.reasoningEffort || ""}
                  disabled={loading || saving || !efforts.length}
                  onChange={(value) =>
                    setSettings((s) => ({
                      ...s,
                      reasoningEffort: value,
                    }))
                  }
                  choices={[
                    // A saved effort the model no longer lists stays shown.
                    ...(settings.reasoningEffort &&
                    !efforts.some(
                      (e) => e.reasoningEffort === settings.reasoningEffort,
                    )
                      ? [
                          {
                            value: settings.reasoningEffort,
                            label: settings.reasoningEffort,
                            note: t.current,
                          },
                        ]
                      : []),
                    ...efforts.map((e) => ({
                      value: e.reasoningEffort,
                      label: e.reasoningEffort,
                    })),
                  ]}
                />
                <small>
                  {efforts.find(
                    (e) => e.reasoningEffort === settings.reasoningEffort,
                  )?.description ||
                    (!efforts.length && !loading ? t.chooseModel : "")}
                </small>
              </div>
              <CodexContextSettings context={context} window={contextWindow} compact={compactLimit}
                disabled={loading || saving} note={say(contextNote)} onWindow={setContextWindow} onCompact={setCompactLimit}
                onApply={() => void applyContext()} onRefresh={() => void refreshContext()}
                onReset={agent.settings?.contextWindow != null || agent.settings?.autoCompactTokenLimit != null
                  ? () => void resetContext() : undefined} />
              <CodexPermissions
                settings={settings}
                catalog={permissions}
                disabled={loading || saving}
                onChange={setSettings}
                language={language}
              />
            </>
          )}
          {error && (
            <div role="alert" className="inline-error model-catalog-error">
              <span>{say(error)}</span>
              <button
                className="quiet-button"
                type="button"
                disabled={loading || saving}
                onClick={() => setReload((n) => n + 1)}
              >
                {t.retry}
              </button>
            </div>
          )}
          <div className="button-row">
            <button
              type="submit"
              className="primary-button"
              disabled={
                saving ||
                loading ||
                (opencode
                  ? (!!model && !selected) || variantUnlisted
                  : claude
                    ? (!!model && !selected) || effortUnlisted
                    : !selected ||
                      !efforts.some(
                        (e) => e.reasoningEffort === settings.reasoningEffort,
                      ))
              }
            >
              {saving ? t.saving : t.save}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
