import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import { readExecutorSlots, saveExecutorSlots, type ExecutorSlotsView } from "./executor-slots";
import { strings, useLanguage } from "./i18n";

const text = strings({
  group: "Executors at once",
  title: "Executors at once",
  help: (preset: number) => `How many executors run at once in this Workspace. Those dispatched beyond it wait in a queue and start in turn, as executors close. ${preset} unless you change it.`,
  helpProject: (workspace: number) => `At most this many of this project’s executors at once, within the Workspace’s ${workspace}. Empty: only the Workspace’s limit applies.`,
  inUse: (running: number, starting: number, waiting: number) => `In this Workspace now: ${running} running, ${starting} starting, ${waiting} waiting.`,
  range: (min: number, max: number) => `A whole number from ${min} to ${max}.`,
  rangeProject: (min: number, max: number) => `A whole number from ${min} to ${max}, or empty.`,
  save: "Save executors at once",
  saved: "Saved.",
  unsaved: "Unsaved change",
  reload: "Reload executors at once",
}, {
  group: "同时运行的执行者",
  title: "同时运行的执行者",
  help: (preset) => `此 Workspace 中同时运行的执行者数量。超出的派发会排队，在执行者关闭后按顺序启动。未更改时为 ${preset}。`,
  helpProject: (workspace) => `此项目的执行者同时最多运行这么多个，且不超过 Workspace 的 ${workspace} 个。留空：只按 Workspace 的上限。`,
  inUse: (running, starting, waiting) => `此 Workspace 现在：${running} 个运行中，${starting} 个启动中，${waiting} 个排队中。`,
  range: (min, max) => `${min} 到 ${max} 之间的整数。`,
  rangeProject: (min, max) => `${min} 到 ${max} 之间的整数，或留空。`,
  save: "保存同时运行的执行者",
  saved: "已保存。",
  unsaved: "有未保存的更改",
  reload: "重新读取同时运行的执行者",
});

/** The number Core takes for this draft, or why there is none: an empty
 * Project limit is null (unset); the Workspace's needs a number. */
const parse = (draft: string, view: ExecutorSlotsView, project: boolean): { slots: number | null } | null => {
  const value = draft.trim();
  if (!value) return project ? { slots: null } : null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= view.limits.min && n <= view.limits.max ? { slots: n } : null;
};

/** Settings' limit on executors running at once (T-35): the Workspace's, or
 * with `projectId` that project's own. Saved apart from the templates, each
 * against its own version. Only the user changes it. */
export function ExecutorSlots({ active, projectId, disabled = false }: { active: boolean; projectId?: string; disabled?: boolean }) {
  const t = text(useLanguage());
  const [view, setView] = useState<ExecutorSlotsView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [reload, setReload] = useState(0);
  const saved = (from: ExecutorSlotsView) => (projectId ? from.project?.slots ?? null : from.workspace.slots);
  const adopt = (next: ExecutorSlotsView) => {
    setView(next);
    const own = saved(next);
    setDraft(own === null ? "" : String(own));
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setView(null);
    setError("");
    readExecutorSlots(controller.signal, projectId).then(next => {
      if (!controller.signal.aborted) adopt(next);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId, reload]);
  const parsed = view ? parse(draft, view, !!projectId) : null;
  const changed = !!view && !!parsed && parsed.slots !== saved(view);
  const invalid = !!view && !parsed;
  async function save() {
    if (!view || !parsed) return;
    setBusy(true);
    setError("");
    try {
      const version = projectId ? view.project?.version ?? 0 : view.workspace.version;
      adopt(await saveExecutorSlots(version, parsed.slots, projectId));
      setDone(true);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="settings-group executor-slots" role="group" aria-label={t.group}>
      {view && <>
        <label className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.title}</span>
            <span className="settings-row-help">
              {projectId ? t.helpProject(view.workspace.slots) : t.help(view.workspace.default)}
            </span>
          </span>
          <input className="settings-input" aria-label={t.title} type="number" inputMode="numeric" step={1}
            min={view.limits.min} max={view.limits.max} value={draft} disabled={disabled || busy}
            aria-invalid={invalid || undefined}
            onChange={e => { setDone(false); setDraft(e.target.value); }} />
        </label>
        <p className="settings-row-help executor-slots-in-use">
          {t.inUse(view.inUse.running, view.inUse.starting, view.inUse.waiting)}
        </p>
        <div className="executor-templates-actions executor-slots-actions">
          <button type="button" className="secondary-button" disabled={disabled || busy || !changed} onClick={() => void save()}>
            {busy && <LoaderCircle size={13} className="spin" />} {t.save}
          </button>
          {invalid ? <span className="settings-row-help">{projectId ? t.rangeProject(view.limits.min, view.limits.max) : t.range(view.limits.min, view.limits.max)}</span>
            : changed ? <span className="settings-row-help">{t.unsaved}</span>
            : done && <span className="settings-row-help" role="status">{t.saved}</span>}
        </div>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reload}</button>}
    </div>
  );
}
