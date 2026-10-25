import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  CircleAlert,
  Folder,
  GitFork,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { errorText, post } from "./api";
import { Modal } from "./components";
import { permissionLabel, permissionLabelIn } from "./CodexPermissions";
import { langTag, strings, useLanguage } from "./i18n";
import type { Agent, AgentDetail, ForkOutcome, ForkPreview } from "./types";
import "./session-import.css";
import "./codex-fork.css";

// One request ID per source and boundary, kept across reloads, so a retry
// after a lost response settles the same attempt instead of forking again.
const storageKey = "yuzuno.codexForkRequests";
function requests(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
function saveRequests(value: Record<string, string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* The in-memory attempt still applies for this page. */
  }
}

// The notice's own words (T-189); the Fork dialog's are in forkText below.
const writerText = strings({
  continuesIn: "This conversation continues in ",
  continuesFrom: (closed: boolean, turns: number) =>
    `${closed ? " (closed)" : ""}, from a Codex fork of its first ${turns} ${turns === 1 ? "turn" : "turns"}. This session was not changed.`,
  open: "Open",
  conflict: "Another Codex client still owns this session, even if its turn has finished, so it can’t continue here. Release it in that client and try again, or continue from an official Codex fork.",
  tryAgain: "Try again",
  fork: "Continue in a fork…",
}, {
  continuesIn: "此会话在 ",
  continuesFrom: (closed, turns) => `${closed ? "（已关闭）" : " "}中继续，它来自 Codex 对前 ${turns} 个 Turn 的分叉。此会话本身未被更改。`,
  open: "打开",
  conflict: "另一个 Codex 客户端仍占有此会话（即使它的 Turn 已经结束），因此无法在这里继续。请在该客户端中释放它后重试，或从官方 Codex 分叉继续。",
  tryAgain: "重试",
  fork: "在分叉中继续…",
});

// The Fork dialog's own words (T-189). The folder, model, reasoning effort,
// project, the agent name typed, Core's warnings and its outcome message are
// shown as they are.
const forkText = strings({
  title: "Continue in a Codex fork",
  description: "Creates a new native Codex session and a new agent from this conversation’s history through its latest completed turn. Nothing happens until you confirm.",
  reading: "Reading this session’s history…",
  preview: "Fork preview",
  copies: (turns: number) => `Copies ${turns} ${turns === 1 ? "turn" : "turns"}`,
  later: (turns: number) => `${turns} later not included`,
  history: (completed: string | null) =>
    completed ? `History up to and including the latest completed turn, completed ${completed}.` : "History up to and including the latest completed turn.",
  reasoning: (effort: string) => ` · ${effort} reasoning`,
  currentPermissions: "Current permissions",
  name: "Agent name",
  note: (later: boolean): ReactNode => (
    <>
      This creates a <strong>new native session</strong> and a <strong>new agent</strong> with this folder, model, reasoning and
      permissions. The original session, its client and this entry stay open; nothing is closed for you.
      {later && " Later turns (running, interrupted or failed) stay with the original session."} Live sub-agents and the other
      client’s tools don’t carry over. Your unsent draft is copied to the new agent’s message box (unless it already has one);
      nothing is sent.
    </>
  ),
  uncertain: "The fork result isn’t confirmed yet. ",
  failed: "The fork didn’t complete. ",
  cancel: "Cancel",
  forking: "Forking…",
  again: "Fork again anyway",
  tryAgain: "Try again",
  fork: "Fork and continue",
}, {
  title: "在 Codex 分叉中继续",
  description: "用此会话截至最新已完成 Turn 的历史，创建一个新的原生 Codex 会话和一个新 Agent。确认之前不会发生任何事。",
  reading: "正在读取此会话的历史…",
  preview: "分叉预览",
  copies: (turns) => `复制 ${turns} 个 Turn`,
  later: (turns) => `之后的 ${turns} 个不包含在内`,
  history: (completed) => (completed ? `历史截至并包括最新已完成的 Turn（完成于 ${completed}）。` : "历史截至并包括最新已完成的 Turn。"),
  reasoning: (effort) => ` · 推理 ${effort}`,
  currentPermissions: "当前权限",
  name: "Agent 名称",
  note: (later) => (
    <>
      这会用此文件夹、模型、推理和权限创建一个<strong>新的原生会话</strong>和一个<strong>新 Agent</strong>。原会话、它的客户端和这个条目都保持打开；不会替你关闭任何东西。
      {later && "之后的 Turn（运行中、被中断或失败的）留在原会话中。"}运行中的子 Agent 和另一个客户端的工具不会带过去。你未发送的草稿会复制到新 Agent 的输入框（如果它还没有草稿）；不会发送任何内容。
    </>
  ),
  uncertain: "分叉结果尚未确认。",
  failed: "分叉没有完成。",
  cancel: "取消",
  forking: "正在分叉…",
  again: "仍然再次分叉",
  tryAgain: "重试",
  fork: "分叉并继续",
});

/** Explains another client's ownership, or where the session continues. */
export function CodexWriterNotice({
  detail,
  agents,
  disabled,
  onReconnect,
  onFork,
  onOpen,
}: {
  detail: AgentDetail;
  agents: Agent[];
  disabled: boolean;
  onReconnect: () => Promise<void>;
  onFork: () => void;
  onOpen: (agentId: string) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const language = useLanguage();
  const t = writerText(language);
  const handoff = detail.codexHandoff;
  const forkedTo = handoff?.forkedTo;
  // A closed continuation still exists; a deleted one no longer continues
  // anything, so the conflict and its explicit fork are offered again.
  const target =
    forkedTo && agents.find((agent) => agent.id === forkedTo.agentId);
  if (forkedTo && target) {
    return (
      <div className="codex-writer-notice is-continued" role="status" lang={langTag(language)}>
        <GitFork size={14} />
        <span>
          {t.continuesIn}<strong>{target.name}</strong>
          {t.continuesFrom(!!target.closedAt, forkedTo.turnCount)}
        </span>
        <button
          type="button"
          className="inline-link"
          onClick={() => onOpen(target.id)}
        >
          {t.open}
          <ArrowUpRight size={12} />
        </button>
      </div>
    );
  }
  if (!handoff?.writerConflictAt || detail.agent.connectionState === "connected")
    return null;
  return (
    <div className="codex-writer-notice" role="status" lang={langTag(language)}>
      <CircleAlert size={14} />
      <span>
        {t.conflict}
      </span>
      <span className="codex-writer-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || retrying}
          onClick={() => {
            setRetrying(true);
            void onReconnect().finally(() => setRetrying(false));
          }}
        >
          {retrying ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {t.tryAgain}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={disabled}
          onClick={onFork}
        >
          <GitFork size={14} />
          {t.fork}
        </button>
      </span>
    </div>
  );
}

/** One explicit fork. Cancel changes nothing; only Fork and continue writes. */
export function ForkCodexDialog({
  agent,
  open,
  projectLabel,
  onOpenChange,
  onForked,
}: {
  agent: Agent;
  open: boolean;
  projectLabel: (projectId: string | null) => string;
  onOpenChange: (open: boolean) => void;
  onForked: (outcome: ForkOutcome) => void;
}) {
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(agent.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<ForkOutcome | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (!open) return;
    let valid = true;
    setPreview(null);
    setOutcome(null);
    setError("");
    setName(agent.name);
    setLoading(true);
    post<ForkPreview>(
      `/agents/${encodeURIComponent(agent.id)}/codex/fork/preview`,
    )
      .then((result) => valid && setPreview(result))
      .catch((e) => valid && setError(errorText(e)))
      .finally(() => valid && setLoading(false));
    return () => {
      valid = false;
    };
  }, [open, agent.id]);

  const through = preview?.throughTurnId;
  const uncertain = outcome?.state === "uncertain";
  async function fork() {
    if (running.current || !through || !name.trim()) return;
    running.current = true;
    setBusy(true);
    setError("");
    const key = `${agent.id}:${through}`;
    const saved = requests();
    // Forking again after an unconfirmed result is the user's explicit
    // choice: a new attempt that gives the old one up. Nothing else is new.
    const abandonUnconfirmed = uncertain;
    const requestId =
      (!abandonUnconfirmed && saved[key]) || crypto.randomUUID();
    saveRequests({ ...saved, [key]: requestId });
    try {
      const result = await post<ForkOutcome>(
        `/agents/${encodeURIComponent(agent.id)}/codex/fork`,
        {
          requestId,
          throughTurnId: through,
          name: name.trim(),
          ...(abandonUnconfirmed ? { abandonUnconfirmed } : {}),
        },
      );
      const current = requests();
      if (result.state === "uncertain") {
        // A retry reports this same attempt; it is never repeated by itself.
        saveRequests({ ...current, [key]: result.requestId });
        setOutcome(result);
      } else {
        delete current[key];
        saveRequests(current);
        if (result.state === "completed" && result.agent) {
          onForked(result);
          onOpenChange(false);
        } else setOutcome(result);
      }
    } catch (e) {
      // The request may have reached Core; keep its ID for the next try.
      setError(errorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const language = useLanguage();
  const t = forkText(language);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={t.title}
      description={t.description}
    >
      <form
        className="session-import create-form codex-fork-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void fork();
        }}
      >
        {loading && (
          <p role="status" className="remote-field-note">
            <LoaderCircle size={14} className="spin" /> {t.reading}
          </p>
        )}
        {preview && (
          <>
            <section className="session-preview" aria-label={t.preview}>
              <div className="session-preview-heading">
                <span>
                  <GitFork size={14} /> {t.copies(preview.includedTurns)}
                </span>
                {preview.excludedTurns > 0 && (
                  <span>{t.later(preview.excludedTurns)}</span>
                )}
              </div>
              <p className="session-preview-excerpt">
                {t.history(preview.throughCompletedAt ? new Date(preview.throughCompletedAt * 1000).toLocaleString() : null)}
              </p>
              <div className="session-preview-folder">
                <Folder size={14} />
                <span>{preview.cwd}</span>
              </div>
              <p className="session-preview-model">
                {preview.model}
                {preview.reasoningEffort
                  ? t.reasoning(preview.reasoningEffort)
                  : ""}
                {" · "}
                {permissionLabelIn(preview.permissionPreset, language) ||
                  permissionLabel(preview.permissionPreset) ||
                  t.currentPermissions}
                {preview.projectId
                  ? ` · ${projectLabel(preview.projectId)}`
                  : ""}
              </p>
            </section>
            {preview.warnings.length > 0 && (
              <div className="session-import-warnings" role="status">
                {preview.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
              </div>
            )}
            <fieldset
              className="remote-form-fields"
              disabled={busy || !through}
            >
              <label>
                {t.name}
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={60}
                />
              </label>
            </fieldset>
            <p className="session-handoff-note">{t.note(preview.excludedTurns > 0)}</p>
          </>
        )}
        {outcome && (
          <p role="alert" className="remote-field-error">
            {uncertain ? t.uncertain : t.failed}
            {outcome.message}
          </p>
        )}
        {error && (
          <p role="alert" className="remote-field-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t.cancel}
          </button>
          <button
            className="primary-button"
            disabled={busy || loading || !through || !name.trim()}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <GitFork size={15} />
            )}
            {busy ? t.forking : uncertain ? t.again : outcome ? t.tryAgain : t.fork}
          </button>
        </div>
      </form>
    </Modal>
  );
}
