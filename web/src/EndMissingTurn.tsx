import { useEffect, useRef, useState } from "react";
import { CircleStop, LoaderCircle } from "lucide-react";
import { Modal } from "./components";
import { endMissingTurns, errorText } from "./api";
import { langTag, strings, useLanguage } from "./i18n";
import type { AgentDetail } from "./types";
import "./recovery.css";

// The confirmation's own words (T-189); Core's refusal as it came.
const text = strings({
  title: (count: number) => (count === 1 ? "End the unconfirmed turn?" : `End ${count} unconfirmed turns?`),
  description: "Only you can decide this. Nothing changes until you confirm.",
  missing: (count: number, checked: string) =>
    `Codex’s own history doesn’t have ${count === 1 ? "the turn" : `${count} turns`} Yuzuno recorded as still running. Codex probably never saved ${count === 1 ? "it" : "them"}, for example after a power cut, so reconnecting can’t tell what ${count === 1 ? "it" : "they"} did. Checked ${checked}.`,
  ifEnded: (count: number) => `If you end ${count === 1 ? "it" : "them"} here:`,
  marked: (count: number) => `${count === 1 ? "it’s" : "they’re"} marked interrupted, with the result unknown;`,
  goesOn: "this agent goes on in the same Codex session, with its history, permissions and tasks;",
  notUndone: "nothing is sent again, and anything already done, such as commands or file changes, isn’t undone. Check your work if it matters.",
  running: "When it was checked, Codex said this session was running a turn. Let it finish or stop it in Codex, then reconnect and check again.",
  failed: (error: string) => `Couldn’t end it: ${error}`,
  cancel: "Cancel",
  close: "Close dialog",
  ending: "Ending…",
  end: "End as interrupted",
}, {
  title: (count) => (count === 1 ? "结束未确认的 Turn？" : `结束 ${count} 个未确认的 Turn？`),
  description: "只有你能决定。在你确认之前，不会有任何改变。",
  missing: (count, checked) =>
    `Codex 自己的历史中没有 Yuzuno 记录为仍在运行的${count === 1 ? "那个 Turn" : ` ${count} 个 Turn`}。Codex 很可能从未保存过${count === 1 ? "它" : "它们"}（例如断电之后），因此重新连接也无法知道${count === 1 ? "它" : "它们"}做了什么。检查于 ${checked}。`,
  ifEnded: (count) => `如果在这里结束${count === 1 ? "它" : "它们"}：`,
  marked: (count) => `${count === 1 ? "它" : "它们"}会被标记为已中断，结果未知；`,
  goesOn: "此 Agent 会在同一个 Codex 会话中继续，保留其历史、权限和任务；",
  notUndone: "不会重新发送任何内容，已经完成的操作（例如命令或文件更改）也不会撤销。如果重要，请检查你的工作。",
  running: "检查时，Codex 表示此会话正在运行一个 Turn。请让它完成，或在 Codex 中停止它，然后重新连接并再次核对。",
  failed: (error) => `无法结束：${error}`,
  cancel: "取消",
  close: "关闭对话框",
  ending: "正在结束…",
  end: "作为中断结束",
});

/**
 * Ending the Turns a check found missing from Codex's own history (T-198).
 * Codex never saved them, after a power cut for one, so no reconnect can
 * say what they did. Ending them is the user's decision: each becomes
 * interrupted with its result unknown, in the same session. Nothing is sent
 * again, and nothing the Turn may have done is undone or called not done.
 * Nothing changes until the user confirms here.
 */
export function EndMissingTurnDialog({
  detail,
  open,
  onOpenChange,
  onEnded,
}: {
  detail: AgentDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnded: () => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agentId = detail.agent.id;
  // A result for another Agent must not land on this one.
  const current = useRef(agentId);
  useEffect(() => {
    current.current = agentId;
    setBusy(false);
    setError("");
  }, [agentId, open]);
  const missing = detail.codexHandoff?.missingTurns;
  if (!missing) return null;
  const count = missing.turnIds.length;
  const running = missing.nativeStatus === "active";
  const checked = new Date(missing.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  async function end() {
    if (busy || !missing) return;
    const target = agentId;
    setBusy(true);
    setError("");
    try {
      await endMissingTurns(target, missing);
      if (current.current !== target) return;
      onEnded();
      onOpenChange(false);
    } catch (e) {
      if (current.current === target) setError(errorText(e));
    } finally {
      if (current.current === target) setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={t.title(count)}
      description={t.description}
      lang={langTag(language)}
      closeLabel={t.close}
    >
      <div className="end-missing-dialog">
        <p>{t.missing(count, checked)}</p>
        <p>{t.ifEnded(count)}</p>
        <ul>
          <li>{t.marked(count)}</li>
          <li>{t.goesOn}</li>
          <li>{t.notUndone}</li>
        </ul>
        {running && (
          <p role="alert" className="recovery-error">
            {t.running}
          </p>
        )}
        {error && (
          <p role="alert" className="recovery-error">
            {t.failed(error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </button>
          <button type="button" className="primary-button" disabled={busy || running} onClick={() => void end()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <CircleStop size={15} />}
            {busy ? t.ending : t.end}
          </button>
        </div>
      </div>
    </Modal>
  );
}
