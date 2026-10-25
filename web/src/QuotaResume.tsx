import { useEffect, useRef, useState } from "react";
import { Clock, LoaderCircle, Play, X } from "lucide-react";
import { api, errorText, post } from "./api";
import { langTag, strings, useLanguage, useStrings } from "./i18n";
import type { AgentDetail } from "./types";
import "./recovery.css";
import "./quota-resume.css";

/** Core's automatic continue after a Claude usage limit resets (T-94). */
export interface AutoContinueIntent {
  id: string;
  turnId: string;
  resetsAt: number;
  dueAt: number;
  limitType: string | null;
  attempt: number;
  state: "waiting" | "sending" | "sent" | "cancelled" | "failed" | "uncertain";
  reason: string | null;
  sentTurn: string | null;
}

export interface AutoContinueView {
  workspace: boolean;
  agent: boolean | null;
  enabled: boolean;
  intent: AutoContinueIntent | null;
  stopped: {
    turnId: string;
    resetsAt: number;
    limitType: string | null;
  } | null;
}

// The notice's and the panel setting's own words (T-189); Core's reasons,
// errors and times as they came.
const noticeText = strings({
  limits: { five_hour: "five-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet" } as Record<string, string>,
  /** Claude's usage limit, of that kind when known. */
  limit: (kind: string) => `Claude’s ${kind ? `${kind} ` : ""}usage limit`,
  waiting: (limit: string, resets: string, due: string) =>
    `${limit} stopped this agent. It resets at ${resets}; Yuzuno then sends one message to continue the task in the same session, at about ${due}. Earlier messages and tools are not sent again, and approvals still ask you.`,
  sending: "Continuing after Claude’s usage limit reset…",
  cancelled: "Automatic continue was cancelled",
  uncertain: "The automatic continue message’s delivery isn’t confirmed",
  failed: "Couldn’t continue automatically",
  ended: (what: string, reason: string | null, limit: string, resets: string | null) =>
    `${what}: ${reason || "no reason given"}.${resets ? ` ${limit} resets at ${resets}.` : ""}`,
  stopped: (limit: string, resets: string, enabled: boolean) =>
    `${limit} stopped this agent. It resets at ${resets}. ${enabled ? "Automatic continue couldn’t be arranged for this stop." : "Nothing continues by itself."}`,
  mayRefuse: (resets: string) => `Claude may still refuse until ${resets}.`,
  now: "Continue now",
  dontContinue: "Don’t continue automatically",
  afterReset: "Continue automatically after the reset",
  usageLimit: "Usage limit",
  loading: "Loading this Agent’s usage-limit policy…",
  selectLabel: "After Claude’s usage limit resets",
  selectTitle: "When Claude’s usage limit stops this agent, Yuzuno can wait for Claude’s reset and send one message to continue the task in the same session.",
  default: (workspace: boolean) => `Default · ${workspace ? "continue" : "wait for you"}`,
  resume: "Continue after reset",
  wait: "Wait for you",
  makeDefault: (workspace: boolean) => (workspace ? "Make the default: wait for you" : "Make the default: continue"),
  savedUnread: (error: string) => `The default is saved, but this agent’s view couldn’t be read again: ${error}`,
}, {
  limits: { five_hour: "5 小时", seven_day: "每周", seven_day_opus: "每周 Opus", seven_day_sonnet: "每周 Sonnet" },
  limit: (kind) => `Claude 的${kind ? ` ${kind}` : ""}用量限额`,
  waiting: (limit, resets, due) =>
    `${limit}让此 Agent 停了下来。它会在 ${resets} 重置；届时 Yuzuno 会在同一会话中发送一条消息继续任务，时间约为 ${due}。之前的消息和工具不会重新发送，审批仍会询问你。`,
  sending: "Claude 的用量限额已重置，正在继续…",
  cancelled: "自动继续已取消",
  uncertain: "自动继续消息的送达尚未确认",
  failed: "无法自动继续",
  ended: (what, reason, limit, resets) => `${what}：${reason || "未给出原因"}。${resets ? `${limit}会在 ${resets} 重置。` : ""}`,
  stopped: (limit, resets, enabled) =>
    `${limit}让此 Agent 停了下来。它会在 ${resets} 重置。${enabled ? "无法为这次停止安排自动继续。" : "不会自动继续。"}`,
  mayRefuse: (resets) => `在 ${resets} 之前，Claude 可能仍会拒绝。`,
  now: "立即继续",
  dontContinue: "不要自动继续",
  afterReset: "重置后自动继续",
  usageLimit: "用量限额",
  loading: "正在载入此 Agent 的用量限额策略…",
  selectLabel: "Claude 的用量限额重置后",
  selectTitle: "当 Claude 的用量限额让此 Agent 停下时，Yuzuno 可以等待 Claude 重置，再在同一会话中发送一条消息继续任务。",
  default: (workspace) => `默认 · ${workspace ? "继续" : "等你处理"}`,
  resume: "重置后继续",
  wait: "等你处理",
  makeDefault: (workspace) => (workspace ? "设为默认：等你处理" : "设为默认：继续"),
  savedUnread: (error) => `默认值已保存，但无法重新读取此 Agent 的视图：${error}`,
});
type NoticeWords = ReturnType<typeof noticeText>;
const limitName = (type: string | null | undefined, t: NoticeWords) =>
  t.limit(type ? t.limits[type] || type.replace(/_/g, " ") : "");
export const at = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Reads the view again whenever the Agent's record changes. */
function useAutoContinue(agentId: string, version: string) {
  const [view, setView] = useState<AutoContinueView | null>(null);
  const [error, setError] = useState("");
  const current = useRef(agentId);
  current.current = agentId;
  async function load(target = agentId) {
    try {
      const next = await api<AutoContinueView>(
        `/agents/${encodeURIComponent(target)}/claude/auto-continue`,
      );
      if (current.current === target) {
        setView(next);
        setError("");
      }
    } catch (e) {
      if (current.current === target) setError(errorText(e));
    }
  }
  useEffect(() => {
    setView(null);
    setError("");
  }, [agentId]);
  useEffect(() => {
    void load(agentId);
  }, [agentId, version]);
  return { view, setView, error, setError, reload: () => load(agentId) };
}

/** When to read the view again: on every record change only while the
 * agent is stopped (an intent is armed, cancelled or sent then), otherwise
 * when its status changes. A running turn changes the record constantly. */
export const autoContinueVersion = (detail: AgentDetail) =>
  detail.agent.status === "error"
    ? [
        detail.agent.status,
        detail.agent.updatedAt,
        detail.agent.lastSeq,
        detail.turns.length,
      ].join("|")
    : detail.agent.status;

/**
 * In the conversation: why a Claude agent stopped at its usage limit, and
 * what happens next. Nothing is shown unless the limit stopped its latest
 * turn or an automatic continue concerns it.
 */
export function QuotaResumeNotice({
  detail,
  disabled,
}: {
  detail: AgentDetail;
  disabled: boolean;
}) {
  const agentId = detail.agent.id;
  const { view, setView, error, setError } = useAutoContinue(
    agentId,
    autoContinueVersion(detail),
  );
  const [busy, setBusy] = useState<"" | "now" | "cancel" | "on">("");
  const language = useLanguage();
  const t = noticeText(language);
  if (!view) return null;
  const intent = view.intent;
  const stopped = view.stopped;
  if (!intent && !stopped) return null;
  if (intent?.state === "sent" && !stopped) return null;

  async function act(kind: "now" | "cancel" | "on") {
    if (busy || disabled) return;
    setBusy(kind);
    setError("");
    try {
      const path = `/agents/${encodeURIComponent(agentId)}/claude/auto-continue`;
      setView(
        kind === "on"
          ? await post<AutoContinueView>(path, { enabled: true })
          : await post<AutoContinueView>(`${path}/${kind}`, {
              intentId: intent!.id,
            }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  const resets = intent?.resetsAt ?? stopped?.resetsAt;
  const limit = limitName(intent?.limitType ?? stopped?.limitType, t);
  const beforeReset = resets !== undefined && resets * 1000 > Date.now();
  let text: string;
  if (intent?.state === "waiting") {
    text = t.waiting(limit, at(intent.resetsAt), at(intent.dueAt));
  } else if (intent?.state === "sending") {
    text = t.sending;
  } else if (intent && intent.state !== "sent") {
    const what =
      intent.state === "cancelled" ? t.cancelled : intent.state === "uncertain" ? t.uncertain : t.failed;
    text = t.ended(what, intent.reason, limit, resets ? at(resets) : null);
  } else {
    text = t.stopped(limit, at(resets!), view.enabled);
  }
  return (
    <div className="recovery-notice quota-resume-notice" role="status" lang={langTag(language)}>
      <Clock size={14} />
      <span>{text}</span>
      <div className="quota-resume-actions">
        {intent?.state === "waiting" && (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={disabled || !!busy}
              title={
                beforeReset ? t.mayRefuse(at(intent.resetsAt)) : undefined
              }
              onClick={() => void act("now")}
            >
              {busy === "now" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Play size={14} />
              )}
              {t.now}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={disabled || !!busy}
              onClick={() => void act("cancel")}
            >
              {busy === "cancel" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <X size={14} />
              )}
              {t.dontContinue}
            </button>
          </>
        )}
        {!intent && stopped && !view.enabled && beforeReset && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || !!busy}
            onClick={() => void act("on")}
          >
            {busy === "on" ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Clock size={14} />
            )}
            {t.afterReset}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="recovery-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Open Agent panels and Settings hear a Workspace default saved in any of
 * them (T-190): Core sends no Agent event for it when nothing waits or is
 * armed. The one that saved it is not told again. */
type HearDefault = (value: WorkspaceDefault) => void;
const workspaceDefaultSaved = new Set<HearDefault>();
const tellWorkspaceDefault = (value: WorkspaceDefault, from: HearDefault | null) =>
  workspaceDefaultSaved.forEach((hear) => hear !== from && hear(value));

/** "At a glance": this agent's choice, or the workspace default. */
export function AutoContinueSetting({
  detail,
  disabled,
}: {
  detail: AgentDetail;
  disabled: boolean;
}) {
  const agentId = detail.agent.id;
  const { view, setView, error, setError, reload } = useAutoContinue(
    agentId,
    detail.agent.status,
  );
  const [busy, setBusy] = useState(false);
  const t = useStrings(noticeText);
  // Core confirmed it, so it is shown at once; the rest of this Agent's
  // view (an armed or cancelled continue) is read again.
  const heard = useRef<HearDefault | null>(null);
  useEffect(() => {
    const hear = ({ enabled }: WorkspaceDefault) => {
      setView((current) => current && { ...current, workspace: enabled, enabled: current.agent ?? enabled });
      void reload();
    };
    heard.current = hear;
    workspaceDefaultSaved.add(hear);
    return () => {
      workspaceDefaultSaved.delete(hear);
    };
  }, [agentId]);
  if (!view) return <div id="agent-auto-continue" tabIndex={-1} className="auto-continue-setting">
    <dt>{t.usageLimit}</dt>
    <dd role={error ? "alert" : "status"}>{error || t.loading}</dd>
  </div>;
  const value = view.agent === null ? "default" : view.agent ? "on" : "off";
  async function choose(next: string) {
    setBusy(true);
    setError("");
    try {
      setView(
        await post<AutoContinueView>(
          `/agents/${encodeURIComponent(agentId)}/claude/auto-continue`,
          { enabled: next === "default" ? null : next === "on" },
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function setDefault(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const saved = await post<WorkspaceDefault>("/claude/auto-continue", { enabled });
      // Core confirmed the default; the rest of the view is read again, and
      // a failed read must not read as a failed save (T-187).
      setView((current) => current && { ...current, workspace: saved.enabled });
      tellWorkspaceDefault(saved, heard.current);
      try {
        setView(
          await api<AutoContinueView>(
            `/agents/${encodeURIComponent(agentId)}/claude/auto-continue`,
          ),
        );
      } catch (e) {
        setError(t.savedUnread(errorText(e)));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auto-continue-setting" id="agent-auto-continue" tabIndex={-1}>
      <dt>{t.usageLimit}</dt>
      <dd>
        <select
          aria-label={t.selectLabel}
          value={value}
          disabled={disabled || busy}
          onChange={(e) => void choose(e.target.value)}
          title={t.selectTitle}
        >
          <option value="default">{t.default(view.workspace)}</option>
          <option value="on">{t.resume}</option>
          <option value="off">{t.wait}</option>
        </select>
        <button
          type="button"
          className="inline-link"
          disabled={disabled || busy}
          onClick={() => void setDefault(!view.workspace)}
        >
          {t.makeDefault(view.workspace)}
        </button>
        {error && (
          <span role="alert" className="recovery-error">
            {error}
          </span>
        )}
      </dd>
    </div>
  );
}

/** What Core says of the Workspace default (T-190): what applies, and what
 * is saved (`null`: nothing, so the built-in off). An older Core says only
 * what applies. */
interface WorkspaceDefault {
  enabled: boolean;
  saved?: boolean | null;
}

// The editor's own words (T-189); Core's errors are shown as they come.
const defaultText = strings({
  section: "Continue after a usage limit: Workspace default",
  title: "Continue after a usage limit",
  intro: "When Claude’s usage limit stops a Claude Code Agent on the Core host, Yuzuno can wait for the reset and then send one message to continue the task in the same session. This is the Workspace’s default for that.",
  applies: "It applies at once to every such Agent without its own choice, existing ones included. Turned on, an Agent the limit has stopped, with its reset still ahead, continues after it; turned off, a continue that is waiting is cancelled. An Agent’s own choice, under Usage limit in its panel, stays as it is. Agents on SSH machines are not continued.",
  source: (saved: boolean | null | undefined) =>
    saved === undefined
      ? "This Core doesn’t say whether a default is saved."
      : saved === null
        ? "Built in: wait for you."
        : `Set for this Workspace: ${saved ? "continue after the reset" : "wait for you"}.`,
  inUse: "In effect now",
  label: "After a usage limit resets",
  help: "For Agents that haven’t chosen for themselves.",
  wait: "Wait for you",
  resume: "Continue after the reset",
  save: "Save default",
  saving: "Saving…",
  useBuiltIn: "Use built-in",
}, {
  section: "用量限额后继续：Workspace 默认值",
  title: "用量限额后继续",
  intro: "当 Claude 的用量限额让 Core 主机上的 Claude Code Agent 停下时，Yuzuno 可以等到额度重置，再发送一条消息，在同一会话中继续任务。这里是它的 Workspace 默认值。",
  applies: "它立即作用于所有未自行选择的此类 Agent，包括现有 Agent。开启后，已被限额停下且重置时间尚未到的 Agent 会在重置后继续；关闭后，正在等待的继续会被取消。Agent 在其面板“用量限额”中的自身选择保持不变。SSH 机器上的 Agent 不会自动继续。",
  source: (saved) =>
    saved === undefined
      ? "此 Core 未说明是否保存了默认值。"
      : saved === null
        ? "内置：等你处理。"
        : `已为此 Workspace 设置：${saved ? "重置后继续" : "等你处理"}。`,
  inUse: "当前生效",
  label: "用量限额重置后",
  help: "用于未自行选择的 Agent。",
  wait: "等你处理",
  resume: "重置后继续",
  save: "保存默认值",
  saving: "正在保存…",
  useBuiltIn: "使用内置",
});

/**
 * The Workspace default for continuing after a usage limit (T-94), in
 * Settings (T-190): no Agent need be chosen, or exist. It is a chain
 * (an Agent's own choice, else this, else off), so a change applies to the
 * Agents that follow it now, existing ones included. What is shown after a
 * save is Core's own answer to it, never read again, so a saved change is
 * not reported as failed; only a refused or failed save says so. Open
 * Agent panels are told, and read their own view again; a default saved
 * from a panel is shown here too.
 */
export function AutoContinueDefault({ active }: { active: boolean }) {
  const t = useStrings(defaultText);
  const [view, setView] = useState<WorkspaceDefault | null>(null);
  const [draft, setDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const heard = useRef<HearDefault | null>(null);
  useEffect(() => {
    const hear = (value: WorkspaceDefault) => {
      setView(value);
      setDraft(value.enabled);
    };
    heard.current = hear;
    workspaceDefaultSaved.add(hear);
    return () => {
      workspaceDefaultSaved.delete(hear);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    void api<WorkspaceDefault>("/claude/auto-continue", { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setView(value);
        setDraft(value.enabled);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [active]);
  async function save(enabled: boolean | null) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const value = await post<WorkspaceDefault>("/claude/auto-continue", { enabled });
      setView(value);
      setDraft(value.enabled);
      tellWorkspaceDefault(value, heard.current);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const changed = !!view && draft !== view.enabled;
  // Only a saved default can be deleted; an older Core can't say.
  const own = view?.saved === true || view?.saved === false;
  return (
    <section className="settings-section auto-continue-default" aria-label={t.section}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
          <p>{t.applies}</p>
          {view && (
            <p className="settings-row-help auto-continue-source" data-saved={String(view.saved)}>
              {t.source(view.saved)}
            </p>
          )}
        </div>
        {view && (
          <span className="settings-current" title={t.inUse}>
            {view.enabled ? t.resume : t.wait}
          </span>
        )}
      </header>
      {view && (
        <div className="settings-group">
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.label}</span>
              <span className="settings-row-help">{t.help}</span>
            </span>
            <select
              className="settings-select"
              aria-label={t.label}
              value={draft ? "on" : "off"}
              disabled={saving}
              onChange={(e) => {
                setError("");
                setDraft(e.target.value === "on");
              }}
            >
              <option value="off">{t.wait}</option>
              <option value="on">{t.resume}</option>
            </select>
          </label>
          {(changed || saving || own) && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                {own && (
                  <button type="button" className="secondary-button" disabled={saving} onClick={() => void save(null)}>
                    {t.useBuiltIn}
                  </button>
                )}
                {(changed || saving) && (
                  <button type="button" className="primary-button" disabled={saving} onClick={() => void save(draft)}>
                    {saving ? t.saving : t.save}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="updates-error github-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
