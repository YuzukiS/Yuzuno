// Settings → Jobs & resources (T-55): this Core host's Job settings, which
// the Jobs card showed in place before, and each SSH machine's, which its
// editor on the Machines page also has. Each reads what it shows itself and
// saves through Core's existing routes; Core's refusals are shown as they came.
import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { api, errorText } from "./api";
import { langTag, strings, useLanguage } from "./i18n";
import {
  BudgetSettings,
  DiskReserveSettings,
  GpuDeviceSettings,
  maxActiveOf,
  validBudget,
  WindowsJobsSettings,
  type JobsBudgetView,
} from "./JobBudget";
import { MachineEditor } from "./MachineEditor";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import "./jobs-settings.css";

const text = strings({
  hostTitle: "Core host budget",
  hostSection: "Core host Job budget",
  hostIntro: (name: string | null) =>
    `Managed jobs on this Core's host${name ? `, ${name}` : ""}: what they may reserve together, how many run at once, the disk space they leave free, Windows' ceiling and each GPU. The Jobs panel shows what they use now.`,
  readingHost: "Reading this host's budget…",
  updatedCore: "Local jobs require an updated Core.",
  readAgain: "Read again",
  remoteTitle: "Remote machines",
  remoteSection: "Remote machine Job budgets",
  remoteIntro:
    "Jobs on each SSH machine: how many run at once, what they may reserve together, and what happens to a limit the machine can't enforce. This host's budget is not used there. Saving changes only jobs that have not started.",
  readingMachines: "Reading machines…",
  machine: "Machine",
  chooseMachine: "Choose a machine…",
  noMachines: "No SSH machine is registered yet. Add one on the Machines page.",
  openMachines: "Open Machines",
  savedMachine: (name: string) => `Saved ${name}.`,
}, {
  hostTitle: "Core 主机预算",
  hostSection: "Core 主机 Job 预算",
  hostIntro: (name) =>
    `此 Core 主机${name ? ` ${name} ` : ""}上的托管 Job：它们合计可预留多少、同时运行多少个、保留多少磁盘空闲，以及 Windows 的上限和每个 GPU 的设置。Job 面板显示它们现在的用量。`,
  readingHost: "正在读取此主机的预算…",
  updatedCore: "本地 Job 需要更新的 Core。",
  readAgain: "重新读取",
  remoteTitle: "远程机器",
  remoteSection: "远程机器 Job 预算",
  remoteIntro: "每台 SSH 机器上的 Job：同时运行多少个、合计可预留多少，以及该机器无法强制执行的限制如何处理。那里不使用此主机的预算。保存只影响尚未开始的 Job。",
  readingMachines: "正在读取机器…",
  machine: "机器",
  chooseMachine: "选择一台机器…",
  noMachines: "还没有登记 SSH 机器。请在“机器”页面添加。",
  openMachines: "打开“机器”",
  savedMachine: (name) => `已保存 ${name}。`,
});

/** This Core host's Job settings: its budget with how many Jobs run at once,
 * the disk reserve, Windows' ceiling and each GPU's admission and sharing.
 * Read when shown, and again after each save; a read again keeps what is
 * being typed unless Core's value changed. */
export function JobsBudgetEditor({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<JobsBudgetView | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  const read = (signal?: AbortSignal) => {
    const stamp = ++generation.current;
    setReading(true);
    return api<JobsBudgetView>("/jobs/budget", { signal })
      .then((next) => {
        if (stamp !== generation.current) return;
        if (!validBudget(next)) throw new Error(t.updatedCore);
        setView(next);
        setError("");
      })
      .catch((e: unknown) => {
        if (stamp === generation.current && !signal?.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (stamp === generation.current) setReading(false);
      });
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => {
      controller.abort();
      generation.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const refresh = () => void read();
  return (
    <section id="settings-jobs-budget" className="settings-section jobs-settings" aria-label={t.hostSection} lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.hostTitle}</h3>
          <p>{t.hostIntro(view?.machine.name ?? null)}</p>
        </div>
      </header>
      {!view && !error && <p className="settings-row-help" role="status">{t.readingHost}</p>}
      {view && (
        <>
          <BudgetSettings
            budget={view.budget}
            bounds={view.budgetBounds}
            host={view.machine}
            suggested={view.machine.suggestedBudget}
            collector={view.collectorOverhead}
            maxActive={maxActiveOf(view)}
            onSaved={refresh}
          />
          {view.disk && <DiskReserveSettings disk={view.disk} onSaved={refresh} />}
          {view.windows?.available && <WindowsJobsSettings windows={view.windows} onSaved={refresh} />}
          {view.gpus && <GpuDeviceSettings gpus={view.gpus} onSaved={refresh} />}
        </>
      )}
      {error && (
        <div className="jobs-settings-read-error">
          <p className="inline-error" role="alert">
            {error}
          </p>
          <button type="button" className="quiet-button" disabled={reading} onClick={refresh}>
            <RefreshCw size={13} aria-hidden="true" />
            {t.readAgain}
          </button>
        </div>
      )}
    </section>
  );
}

/** Each SSH machine's Jobs settings, one machine at a time: chosen first,
 * never the first by default, then edited in its own editor, which saves
 * the machine through Core as the Machines page does. This Core host is not
 * listed: its budget is the other tab's. */
export function RemoteJobsEditor({ active, onOpenMachines }: { active: boolean; onOpenMachines?: () => void }) {
  const language = useLanguage();
  const t = text(language);
  const [machines, setMachines] = useState<WorkspaceMachine[] | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState("");
  // The machine last saved, said until another is chosen; its editor starts
  // again from what Core saved, so the next save sends only what changes then.
  const [saved, setSaved] = useState<{ id: string; name: string; round: number } | null>(null);
  const [reload, setReload] = useState(0);
  const picker = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError("");
    api<{ machines: WorkspaceMachine[] }>("/machines", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setMachines(result.machines || []);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [active, reload]);
  const remote = (machines ?? []).filter((m) => m.kind !== "local");
  const machine = remote.find((m) => m.id === chosen);
  return (
    <section id="settings-jobs-remote" className="settings-section jobs-settings jobs-remote-settings" aria-label={t.remoteSection} lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.remoteTitle}</h3>
          <p>{t.remoteIntro}</p>
        </div>
      </header>
      {!machines && !error && <p className="settings-row-help" role="status">{t.readingMachines}</p>}
      {machines && !remote.length && (
        <div className="jobs-settings-empty">
          <p className="settings-row-help">{t.noMachines}</p>
          {onOpenMachines && (
            <button type="button" className="secondary-button" onClick={onOpenMachines}>
              {t.openMachines}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {remote.length > 0 && (
        <div className="settings-group jobs-settings-group">
          <label className="settings-row jobs-settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.machine}</span>
            </span>
            <span className="jobs-settings-control">
              <select
                ref={picker}
                className="settings-select"
                name="machine"
                value={machine?.id ?? ""}
                onChange={(e) => {
                  setChosen(e.target.value);
                  setSaved(null);
                }}
              >
                <option value="">{t.chooseMachine}</option>
                {/* Names and destinations as their owner wrote them. */}
                {remote.map((m) => (
                  <option key={m.id} value={m.id} lang="">
                    {m.target ? `${m.name} · ${m.target}` : m.name}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>
      )}
      {machine && (
        <MachineEditor
          key={`${machine.id}:${saved?.id === machine.id ? saved.round : 0}`}
          machine={machine}
          language={language}
          autoFocus={false}
          onCancel={() => {
            setChosen("");
            setSaved(null);
            picker.current?.focus();
          }}
          onSaved={(next) => {
            // What Core saved shows at once, and the editor starts from it.
            setMachines((list) => (list ?? []).map((m) => (m.id === next.id ? next : m)));
            setSaved((old) => ({ id: next.id, name: next.name, round: (old?.id === next.id ? old.round : 0) + 1 }));
          }}
        />
      )}
      {machine && saved?.id === machine.id && (
        <p className="settings-row-help jobs-settings-saved" role="status">
          {t.savedMachine(saved.name)}
        </p>
      )}
      {error && (
        <div className="jobs-settings-read-error">
          <p className="inline-error" role="alert">
            {error}
          </p>
          <button type="button" className="quiet-button" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={13} aria-hidden="true" />
            {t.readAgain}
          </button>
        </div>
      )}
    </section>
  );
}
