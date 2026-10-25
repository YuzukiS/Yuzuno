import { useEffect, useState } from "react";
import { ListChecks, LoaderCircle, RefreshCw } from "lucide-react";
import { HttpError, api, errorText, post } from "./api";
import { Modal } from "./components";
import { langTag, strings, useLanguage } from "./i18n";
import type { Agent, CodexPlanState } from "./types";
import "./remote.css";
import "./session-import.css";

type Mode = "plan" | "default";
type PlanView = {
  state: "ready" | "unavailable" | "unsupported" | "failed";
  reason: string;
  generation: number | null;
  /** The modes this connection's Codex lists, of the two its CLI switches. */
  modes: Mode[];
  reported: CodexPlanState["reported"];
  switch: CodexPlanState["switch"];
};

// The dialog's and the chip's own words (T-189). A mode Codex names
// otherwise, the Agent's name and Core's reasons are shown as they came.
const text = strings({
  notes: {
    not_connected: "Connect this Agent to see its Codex mode.",
    closed: "This Agent is closed.",
    no_thread: "This Agent has no Codex session yet.",
    old_protocol: "This Agent's Codex has no collaboration modes, so no Plan mode.",
    harness: "Plan mode here is Codex's own.",
  } as Record<string, string>,
  names: { plan: "Plan mode", default: "Default mode" } as Record<string, string>,
  otherMode: (mode: string) => `the mode “${mode}”`,
  reported: (name: string, resumed: boolean) =>
    `Codex reports ${name}, ${resumed ? "when it resumed this conversation" : "after its settings last changed"}.`,
  switching: (to: string) => `Switching to ${to}…`,
  accepted: (to: string) => `Codex accepted the switch to ${to} and has not reported its mode since.`,
  noAnswer: (to: string) => `No answer came back for the switch to ${to}. Codex may have switched: Refresh, or reconnect, to see what it reports. It is not sent again.`,
  toPlanDone: (confirmed: boolean) =>
    `Codex ${confirmed ? "switched to" : "accepted"} Plan mode. Your next message starts the planning; Codex's questions show as they always do.`,
  toDefaultDone: (confirmed: boolean) =>
    `Codex ${confirmed ? "switched back to" : "accepted"} Default mode. The plan stays in this conversation; nothing was sent to carry it out.`,
  unanswered: (error: string) => `No answer came back (${error}). Codex may have switched: shown below as Codex now reports it.`,
  title: "Codex mode",
  description: (name: string) => `${name}'s own Codex mode for this conversation. Opening this changes nothing.`,
  reading: "Reading the mode…",
  couldNotList: (reason: string) => `Codex could not list its modes: ${reason}`,
  current: "Current mode",
  notReported: "Not reported yet",
  refresh: "Refresh",
  noReport: "Codex has not reported this conversation's mode on this connection yet.",
  noPlanMode: "This Agent's Codex lists no Plan mode.",
  about: "Plan mode is Codex's own, an experimental part of this Codex: Codex plans, and asks you what it needs, before it changes files. Switching sends nothing to the model; your next message starts the planning. The model, effort, permissions, folder and your draft stay as they are. Leaving Plan mode only switches back: it does not ask Codex to carry out the plan.",
  afterTurn: " Switch once this turn has ended, as Codex's CLI does.",
  close: "Close",
  closeDialog: "Close dialog",
  leavePlan: "Leave Plan mode",
  toDefault: "Switch to Default mode",
  toPlan: "Switch to Plan mode",
  chipReported: "Codex reports Plan mode: it plans, and asks what it needs, before it changes files · open /plan",
  chipPending: "A switch to Plan mode that Codex has not reported yet · open /plan",
  chip: (reported: boolean): string => (reported ? "Plan mode" : "Plan mode?"),
}, {
  notes: {
    not_connected: "连接此 Agent 后即可查看其 Codex 模式。",
    closed: "此 Agent 已关闭。",
    no_thread: "此 Agent 还没有 Codex 会话。",
    old_protocol: "此 Agent 的 Codex 没有协作模式，因此没有 Plan 模式。",
    harness: "这里的 Plan 模式是 Codex 自己的。",
  },
  names: { plan: "Plan 模式", default: "默认模式" },
  otherMode: (mode) => `“${mode}”模式`,
  reported: (name, resumed) => `Codex 报告为${name}（${resumed ? "恢复此会话时" : "上次更改设置后"}）。`,
  switching: (to) => `正在切换到${to}…`,
  accepted: (to) => `Codex 已接受切换到${to}，此后尚未报告其模式。`,
  noAnswer: (to) => `切换到${to}的请求没有收到回复。Codex 可能已经切换：请刷新或重新连接以查看它的报告。不会重新发送。`,
  toPlanDone: (confirmed) => `Codex ${confirmed ? "已切换到" : "已接受"} Plan 模式。你的下一条消息会开始规划；Codex 的问题照常显示。`,
  toDefaultDone: (confirmed) => `Codex ${confirmed ? "已切换回" : "已接受"}默认模式。计划仍保留在此会话中；没有发送任何内容去执行它。`,
  unanswered: (error) => `没有收到回复（${error}）。Codex 可能已经切换：下方按 Codex 现在的报告显示。`,
  title: "Codex 模式",
  description: (name) => `${name} 在此会话中的 Codex 模式。打开这里不会改变任何东西。`,
  reading: "正在读取模式…",
  couldNotList: (reason) => `Codex 无法列出其模式：${reason}`,
  current: "当前模式",
  notReported: "尚未报告",
  refresh: "刷新",
  noReport: "在此连接上，Codex 尚未报告此会话的模式。",
  noPlanMode: "此 Agent 的 Codex 没有列出 Plan 模式。",
  about: "Plan 模式是 Codex 自己的功能，属于此 Codex 的实验性部分：Codex 会先规划，并在更改文件前询问它需要的信息。切换不会向模型发送任何内容；你的下一条消息会开始规划。模型、推理强度、权限、文件夹和你的草稿都保持不变。离开 Plan 模式只是切换回去：不会让 Codex 执行计划。",
  afterTurn: "请在这个 Turn 结束后再切换，与 Codex 的 CLI 一致。",
  close: "关闭",
  closeDialog: "关闭对话框",
  leavePlan: "离开 Plan 模式",
  toDefault: "切换到默认模式",
  toPlan: "切换到 Plan 模式",
  chipReported: "Codex 报告为 Plan 模式：它会先规划，并在更改文件前询问所需信息 · 打开 /plan",
  chipPending: "正在切换到 Plan 模式，Codex 尚未报告 · 打开 /plan",
  chip: (reported) => (reported ? "Plan 模式" : "Plan 模式？"),
});
type PlanWords = ReturnType<typeof text>;
const modeName = (mode: string, t: PlanWords) => t.names[mode] ?? t.otherMode(mode);

/** What Codex last reported, in words; null when it has not. */
function reportedText(reported: PlanView["reported"], t: PlanWords) {
  if (!reported) return null;
  return t.reported(modeName(reported.mode, t), reported.source === "resume");
}

function switchText(change: NonNullable<PlanView["switch"]>, t: PlanWords) {
  const to = modeName(change.to, t);
  if (change.state === "sending") return t.switching(to);
  if (change.state === "accepted") return t.accepted(to);
  return t.noAnswer(to);
}

/**
 * `/plan` (T-29): this Codex Agent's own collaboration mode, as Codex's CLI
 * switches it (Plan or Default). It is read when this opens and on Refresh
 * only, on the connection the Agent already has. Opening it starts nothing,
 * and changes nothing. A switch is the user's click, between turns. It
 * changes the mode only: no message, no turn, and the model, effort,
 * permissions, folder and draft stay as they are. The mode shown is what
 * Codex reported; an experimental part of Codex 0.162.1, asked per
 * connection.
 */
export function CodexPlanDialog({ agent, open, turnRunning, onOpenChange, onChanged }: {
  agent: Agent;
  open: boolean;
  /** A turn is running or waiting: Codex's CLI switches only between turns. */
  turnRunning: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (notice: string) => void;
}) {
  const [view, setView] = useState<PlanView | null>(null);
  const [reading, setReading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const language = useLanguage();
  const t = text(language);
  // Read on opening, on Refresh, and after a switch with no answer.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setView(null);
    api<PlanView>(`/agents/${encodeURIComponent(agent.id)}/codex/plan`, { signal: controller.signal })
      .then(setView, (e) => {
        if (!controller.signal.aborted) setView({ state: "failed", reason: errorText(e), generation: null, modes: [], reported: null, switch: null });
      });
    return () => controller.abort();
  }, [open, agent.id, reading]);

  async function change(mode: Mode) {
    if (busy || !view?.generation) return;
    setBusy(true);
    setError("");
    try {
      const answer = await post<PlanView>(`/agents/${encodeURIComponent(agent.id)}/codex/plan`, { mode, generation: view.generation });
      setView(answer);
      const confirmed = answer.reported?.mode === mode && !answer.switch;
      // Worded when it happens, as App's other notices are.
      onChanged(mode === "plan" ? t.toPlanDone(confirmed) : t.toDefaultDone(confirmed));
    } catch (e) {
      // Core's answer says what happened; no answer leaves it unknown. The
      // mode is read again either way, and nothing is sent again.
      setError(e instanceof HttpError ? errorText(e) : t.unanswered(errorText(e)));
      setReading((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  const reported = view?.reported?.mode;
  const offered = (mode: Mode) => !!view && view.state === "ready" && view.modes.includes(mode) && reported !== mode;
  return (
    <Modal open={open} onOpenChange={(next) => !busy && onOpenChange(next)} title={t.title}
      description={t.description(agent.name)} lang={langTag(language)} closeLabel={t.closeDialog}>
      <div className="create-form remote-create">
        {!view ? (
          <p role="status"><LoaderCircle size={14} className="spin" /> {t.reading}</p>
        ) : view.state !== "ready" ? (
          <p role="status" className="remote-field-note">{t.notes[view.reason] ?? t.couldNotList(view.reason)}</p>
        ) : (
          <section className="session-preview" aria-label={t.current}>
            <div className="session-preview-heading">
              <span><ListChecks size={14} /> {reported ? modeName(reported, t) : t.notReported}</span>
              <button type="button" className="quiet-button" disabled={busy} onClick={() => setReading((n) => n + 1)}>
                <RefreshCw size={13} /> {t.refresh}
              </button>
            </div>
            <p className="session-preview-excerpt">
              {reportedText(view.reported, t) ?? t.noReport}
            </p>
            {view.switch && <p className="session-preview-model" role="status">{switchText(view.switch, t)}</p>}
            {!view.modes.includes("plan") && <p className="session-preview-model">{t.noPlanMode}</p>}
          </section>
        )}
        {view?.state === "ready" && (
          <p className="remote-field-note">
            {t.about}
            {turnRunning && t.afterTurn}
          </p>
        )}
        {error && <p role="alert" className="remote-field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>{t.close}</button>
          {offered("default") && (
            <button type="button" className="secondary-button" disabled={busy || turnRunning} onClick={() => void change("default")}>
              {reported === "plan" ? t.leavePlan : t.toDefault}
            </button>
          )}
          {offered("plan") && (
            <button type="button" className="primary-button" disabled={busy || turnRunning} onClick={() => void change("plan")}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <ListChecks size={15} />} {t.toPlan}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The composer's sign that Codex reports Plan mode for this conversation,
 * or has accepted a switch to it; it opens `/plan`. Nothing when Codex
 * reports another mode, or nothing at all.
 */
export function CodexPlanChip({ state, onOpen }: { state: CodexPlanState | undefined; onOpen: () => void }) {
  const reported = state?.reported?.mode === "plan";
  const switching = state?.switch?.to === "plan";
  const language = useLanguage();
  const t = text(language);
  if (!reported && !switching) return null;
  const title = reported ? t.chipReported : t.chipPending;
  return (
    <button type="button" className="composer-tool composer-mode" data-unconfirmed={reported ? undefined : ""} title={title} onClick={onOpen} lang={langTag(language)}>
      <ListChecks size={14} /> {t.chip(reported)}
    </button>
  );
}
