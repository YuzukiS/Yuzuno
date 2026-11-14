import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import { readExecutorSlots, saveStartLimit, type ExecutorSlotsView } from "./executor-slots";
import { strings, useLanguage } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";

const text = strings({
  group: "How many executors run at once",
  title: "Executors at once",
  perMachine: (list: string, total: number) => `Executors at once is set for each machine: ${list}; ${total} in all. Those dispatched beyond a machine's number wait in a queue and start in turn, as executors there close. Change a machine's number in Settings → Machines.`,
  // YN-137: the number is Core's (limits.urgentExtra).
  urgentMore: (n: number) => ` An urgent dispatch (a release, say) may start ${n === 1 ? "one more" : `${n} more`} when a machine is full.`,
  machine: (name: string, n: number, own: boolean) => own ? `${name} ${n}` : `${name} ${n} (default)`,
  inUse: (running: number, starting: number, waiting: number) => `In this Workspace now: ${running} running, ${starting} starting, ${waiting} waiting.`,
  startLimit: "Start time limit (seconds)",
  startLimitHelp: (preset: number) => `How long an executor’s start may take before Core cuts it off. A start that fails is rebuilt once; a second failure blocks its task. ${preset} unless you change it.`,
  startLimitRange: (min: number, max: number) => `A whole number of seconds from ${min} to ${max}.`,
  save: "Save start time limit",
  saved: "Saved.",
  unsaved: "Unsaved change",
  reload: "Reload executors at once",
}, {
  group: "同时运行的执行者数量",
  title: "同时运行的执行者",
  perMachine: (list, total) => `同时运行的执行者按机器设置：${list}；合计 ${total} 个。超出某台机器数量的派发会排队，在该机器上的执行者关闭后按顺序启动。在“设置 → 机器”中更改各机器的数量。`,
  urgentMore: (n) => `加急派发（发布等）在满额时可多开 ${n} 个。`,
  machine: (name, n, own) => own ? `${name} ${n} 个` : `${name} ${n} 个（默认）`,
  inUse: (running, starting, waiting) => `此 Workspace 现在：${running} 个运行中，${starting} 个启动中，${waiting} 个排队中。`,
  startLimit: "启动时限（秒）",
  startLimitHelp: (preset) => `执行者启动最多可用的时间，超时后 Core 会中止它。启动失败的执行者会重建一次；再次失败则该任务标记为受阻。未更改时为 ${preset}。`,
  startLimitRange: (min, max) => `${min} 到 ${max} 之间的整数秒。`,
  save: "保存启动时限",
  saved: "已保存。",
  unsaved: "有未保存的更改",
  reload: "重新读取同时运行的执行者",
});

/** The Workspace's start time limit for this draft, or none when Core wouldn't take it. */
const parseLimit = (draft: string, view: ExecutorSlotsView): number | null => {
  const value = draft.trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  const { min, max } = view.limits.startLimitSeconds;
  return n >= min && n <= max ? n : null;
};

/** Settings' executors at once (T-35, YN-2 S5): each machine's number, set
 * on its machine page, and the Workspace's start time limit, the one thing
 * saved here. `projectId` is taken for older callers and ignored: a project
 * has no limit of its own any more. Only the user changes it. */
export function ExecutorSlots({ active, disabled = false }: { active: boolean; projectId?: string; disabled?: boolean }) {
  const t = text(useLanguage());
  const [view, setView] = useState<ExecutorSlotsView | null>(null);
  const [limitDraft, setLimitDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [reload, setReload] = useState(0);
  const adopt = (next: ExecutorSlotsView) => {
    setView(next);
    setLimitDraft(String(next.workspace.startLimitSeconds));
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setView(null);
    setError("");
    readExecutorSlots(controller.signal).then(next => {
      if (!controller.signal.aborted) adopt(next);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [active, reload]);
  const limit = view ? parseLimit(limitDraft, view) : null;
  const badLimit = !!view && limit === null;
  const changed = !!view && limit !== null && limit !== view.workspace.startLimitSeconds;
  async function save(): Promise<boolean> {
    if (!view || limit === null) return false;
    setBusy(true);
    setError("");
    try {
      adopt(await saveStartLimit(view.workspace.version, limit));
      setDone(true);
      return true;
    } catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(false); }
  }
  // On Settings › Executors the change joins the page's save bar (YN-8),
  // held while out of range; alone it keeps its own Save.
  const edited = !!view && limitDraft !== String(view.workspace.startLimitSeconds);
  const inBar = useSaveBarPart("executor-start-limit", edited && view && !disabled ? {
    ready: !badLimit,
    save,
    discard: () => { setError(""); adopt(view); },
  } : null);
  return (
    <div className="settings-group executor-slots" role="group" aria-label={t.group}>
      {view && <>
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.title}</span>
            <span className="settings-row-help executor-slots-machines">
              {t.perMachine(view.machines.map(m => t.machine(m.name, m.limit, m.slots !== null)).join(", "), view.total)}
              {view.limits.urgentExtra > 0 && t.urgentMore(view.limits.urgentExtra)}
            </span>
          </span>
        </div>
        <label className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.startLimit}</span>
            <span className="settings-row-help">{t.startLimitHelp(view.limits.startLimitSeconds.default)}</span>
          </span>
          <input className="settings-input" aria-label={t.startLimit} type="number" inputMode="numeric" step={1}
            min={view.limits.startLimitSeconds.min} max={view.limits.startLimitSeconds.max} value={limitDraft}
            disabled={disabled || busy} aria-invalid={badLimit || undefined}
            onChange={e => { setDone(false); setLimitDraft(e.target.value); }} />
        </label>
        <p className="settings-row-help executor-slots-in-use">
          {t.inUse(view.inUse.running, view.inUse.starting, view.inUse.waiting)}
        </p>
        <div className="executor-templates-actions executor-slots-actions">
          {!inBar && (
            <button type="button" className="secondary-button" disabled={disabled || busy || !changed} onClick={() => void save()}>
              {busy && <LoaderCircle size={13} className="spin" />} {t.save}
            </button>
          )}
          {badLimit ? <span className="settings-row-help">{t.startLimitRange(view.limits.startLimitSeconds.min, view.limits.startLimitSeconds.max)}</span>
            : changed && !inBar ? <span className="settings-row-help">{t.unsaved}</span>
            : done && <span className="settings-row-help" role="status">{t.saved}</span>}
        </div>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reload}</button>}
    </div>
  );
}
