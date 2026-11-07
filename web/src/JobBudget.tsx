import { useEffect, useId, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { LoaderCircle } from "lucide-react";
import { post, errorText } from "./api";
import { readMachineLoad } from "./home/home-api";
import type { MachineLoad } from "./home/types";
import { strings, useStrings } from "./i18n";
type Resources = { cpuMillis: number; memoryMiB: number; swapMiB: number };
/** Memory in GiB once it reaches one, else MiB. */
export const memoryText = (miB: number) =>
  miB >= 1024 ? `${(miB / 1024).toFixed(1)} GiB` : `${Math.round(miB)} MiB`;
const share = (part: number, whole: number) =>
  whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0;
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * What this Core host's jobs use right now, read every three seconds while
 * the Jobs panel shows the machine. Null until the first reading and after a
 * failed one (an older Core has no reading): use then shows as unknown, never 0.
 */
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
/** A reading with the numbers the machine card uses; anything else is unknown. */
const readable = (value: MachineLoad | null | undefined): value is MachineLoad =>
  !!value &&
  finite(value.cpu?.jobsPct) &&
  finite(value.cpu?.cores) &&
  finite(value.memory?.jobsMiB) &&
  (value.gpus == null || Array.isArray(value.gpus));
export function useMachineLoad(): MachineLoad | null {
  const [load, setLoad] = useState<MachineLoad | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    // Not sampled while the page is hidden; the last reading stays and a
    // new one is taken on return.
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      try {
        const value = await readMachineLoad(controller.signal);
        if (!controller.signal.aborted) setLoad(readable(value) ? value : null);
      } catch {
        if (!controller.signal.aborted) setLoad(null);
      }
      if (!controller.signal.aborted) timer = setTimeout(sample, 3_000);
    };
    void sample();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visible]);
  return load;
}

// The budget's own words (T-189); device and machine names, paths, Core's
// rules, scopes, reasons and errors are shown as they came.
const text = strings({
  cpuQuota: "CPU quota",
  ram: "RAM (MiB)",
  swap: "Swap (MiB)",
  saving: "Saving rechecks queued jobs automatically. Running jobs keep their original limits. A lower budget pauses new starts until reservations fit.",
  reference: (cpus: number, memory: number, swap: number | null) =>
    `For reference, this host has ${cpus} CPU · ${memory} MiB RAM${swap != null ? ` · ${swap} MiB swap` : ""}; the budget may use all of it. `,
  conservative: (cpu: number, memory: number, swap: number) => `Conservative default: ${cpu} CPU · ${memory} MiB RAM · ${swap} MiB swap.`,
  startsWhen: (headroom: number | null) =>
    `A job starts only when the host also has the RAM it needs free at that moment${headroom != null ? `, keeping ${headroom} MiB for Core and the desktop` : ""}. CPU is a shared quota, not reserved cores.`,
  collector: (cpu: number, memory: number, cpuNeeded: number, memoryNeeded: number) =>
    `Each job also reserves ${cpu} CPU and ${memory} MiB RAM for collection. Two jobs with 2 CPU and 4096 MiB each need at least ${cpuNeeded} CPU and ${memoryNeeded} MiB RAM in this budget.`,
  saveBudget: "Save budget",
  read: (when: string | null) => `Read ${when}`,
  diskReserve: "Disk reserve",
  keepFreeGib: "Keep free (GiB)",
  default: "Default",
  diskNote: (rule: string, scope: string) =>
    `No new job starts while Core's data folder or its working directory has less free space than this. Empty uses the default: ${rule}. ${scope}`,
  saveReserve: "Save reserve",
  useDefault: "Use default",
  disk: "Disk",
  diskN: (n: number) => `Disk ${n}`,
  notReported: "Not reported",
  diskNotReported: "Disk: not reported",
  free: (value: string) => `${value} free`,
  freeUnknown: "Free space unknown",
  diskTitle: (label: string, free: string, total: string | null) => `${label}: ${free}${total ? ` of ${total}` : ""}`,
  of: (total: string) => `of ${total}`,
  unreadable: (error: string) => `Could not be read (${error}); new jobs wait until it can be checked.`,
  low: (reserve: string) => `Below the ${reserve} reserve: new jobs wait here. Running jobs go on.`,
  ceiling: (max: number, set: boolean) => `${max} at once${set ? "" : " (default)"}`,
  windows: "Windows",
  windowsInUse: (max: number) => ` of ${max} in use`,
  windowsTitle: (active: number, ceiling: string) => `Windows: ${active} in use of ${ceiling}`,
  sharesBudget: "Shares this host's budget",
  windowsCeiling: (ceiling: string) => `Windows: ${ceiling}`,
  windowsJobs: "Windows jobs",
  atMost: "At most at once",
  defaultN: (n: number) => `Default (${n})`,
  windowsNote: (n: number) =>
    `How many Windows jobs may run at the same time, 1–64. Empty uses the default (${n}). It is only a ceiling: Windows jobs still share this host's CPU and RAM budget, and lowering it stops nothing that is running.`,
  save: "Save",
  notChanged: (resume: boolean, jobs: string) => `Not ${resume ? "resumed" : "paused"}: ${jobs}`,
  aJob: "a job",
  sampled: (when: string | null) => `Sampled ${when}. `,
  gpuWait: (problem: string) => `GPU jobs wait: ${problem}. CPU jobs are not held.`,
  unknown: "unknown",
  inUse: " in use",
  gpuTitle: (name: string, inUse: string, total: string, held: string | null) =>
    `${name} memory: ${inUse} in use of ${total}${held ? `, ${held} reserved by jobs` : ""}`,
  reserved: (value: string) => `${value} reserved`,
  busy: (pct: number) => `${pct}% busy`,
  closed: (byAgent: boolean, reason: string | null) =>
    `Closed to new jobs${byAgent ? " by an Agent" : ""}${reason ? ` (${reason})` : ""}. Jobs already on it keep it.`,
  resumeGpuTitle: "Resume the jobs paused on this GPU and reopen it to new jobs if the pause closed it",
  pauseGpuTitle: "Stop new jobs on this GPU and pause the managed jobs using it. Their memory and GPU memory stay reserved; GPU work already sent finishes first.",
  resumeGpu: "Resume GPU work",
  pauseGpu: "Pause GPU work",
  closedState: "Closed",
  shared: "Shared",
  exclusive: "Exclusive",
  open: "Open to new jobs",
  reason: "Reason (optional)",
  close: "Close to new jobs",
  share: "Let managed jobs share it",
  keepFreeMib: "Keep free (MiB)",
  sharingNote:
    "By default one managed GPU job uses a device at a time. Shared, jobs that ask for shared mode start while their declared memory fits in the sampled free memory, less what managed jobs reserve and this amount. Nothing limits what a job really uses.",
  // Settings' Core host editor (T-55): the settings the Jobs card showed.
  budgetGroup: "This host's Job budget",
  jobsAtOnce: "Jobs at once",
  jobsAtOnceNote: (min: number, max: number, preset: number) =>
    `How many of this host's own jobs run at the same time, ${min}–${max}; ${preset} unless you change it. One more waits in the queue, and lowering it stops nothing that is running. The CPU and RAM budget still bounds them.`,
  inEffect: (value: string) => `In effect: ${value}.`,
  useDefaultN: (n: number) => `Use default (${n})`,
  reserveInEffect: (reserve: number | null) =>
    reserve == null ? "In effect: the default." : `In effect: keep ${reserve} GiB free.`,
  saved: "Saved.",
  unsaved: "Unsaved changes",
  gpusGroup: "GPUs",
  takesJobs: (shared: boolean): string =>
    shared ? "Open to new jobs; managed jobs may share it." : "Open to new jobs, one managed GPU job at a time.",
}, {
  cpuQuota: "CPU 配额",
  ram: "内存（MiB）",
  swap: "交换空间（MiB）",
  saving: "保存后会自动重新检查排队的 Job。运行中的 Job 保持原来的限制。降低预算会暂停新的启动，直到预留能够容纳。",
  reference: (cpus, memory, swap) => `供参考，此主机有 ${cpus} CPU · ${memory} MiB 内存${swap != null ? ` · ${swap} MiB 交换空间` : ""}；预算可以使用全部。`,
  conservative: (cpu, memory, swap) => `保守默认值：${cpu} CPU · ${memory} MiB 内存 · ${swap} MiB 交换空间。`,
  startsWhen: (headroom) => `只有当主机在那一刻也有它所需的空闲内存时，Job 才会启动${headroom != null ? `，并为 Core 和桌面保留 ${headroom} MiB` : ""}。CPU 是共享配额，不是预留的核心。`,
  collector: (cpu, memory, cpuNeeded, memoryNeeded) =>
    `每个 Job 还会为结果收集预留 ${cpu} CPU 和 ${memory} MiB 内存。两个各需 2 CPU 和 4096 MiB 的 Job，在此预算中至少需要 ${cpuNeeded} CPU 和 ${memoryNeeded} MiB 内存。`,
  saveBudget: "保存预算",
  read: (when) => `读取于 ${when}`,
  diskReserve: "磁盘保留",
  keepFreeGib: "保留空闲（GiB）",
  default: "默认",
  diskNote: (rule, scope) => `当 Core 的数据文件夹或其工作目录的空闲空间少于此值时，不会启动新的 Job。留空则使用默认值：${rule}。${scope}`,
  saveReserve: "保存保留值",
  useDefault: "使用默认值",
  disk: "磁盘",
  diskN: (n) => `磁盘 ${n}`,
  notReported: "未报告",
  diskNotReported: "磁盘：未报告",
  free: (value) => `空闲 ${value}`,
  freeUnknown: "空闲空间未知",
  diskTitle: (label, free, total) => `${label}：${free}${total ? `，共 ${total}` : ""}`,
  of: (total) => `共 ${total}`,
  unreadable: (error) => `无法读取（${error}）；新的 Job 会等待，直到可以检查它。`,
  low: (reserve) => `低于 ${reserve} 的保留值：新的 Job 会在这里等待。运行中的 Job 继续。`,
  ceiling: (max, set) => `同时最多 ${max} 个${set ? "" : "（默认）"}`,
  windowsInUse: (max) => ` / ${max} 使用中`,
  windowsTitle: (active, ceiling) => `Windows：${active} 个使用中，${ceiling}`,
  sharesBudget: "共享此主机的预算",
  windowsCeiling: (ceiling) => `Windows：${ceiling}`,
  windowsJobs: "Windows Job",
  atMost: "同时最多",
  defaultN: (n) => `默认（${n}）`,
  windowsNote: (n) => `可以同时运行多少个 Windows Job，1–64。留空则使用默认值（${n}）。这只是上限：Windows Job 仍共享此主机的 CPU 和内存预算，降低它不会停止任何正在运行的 Job。`,
  save: "保存",
  notChanged: (resume, jobs) => `未能${resume ? "继续" : "暂停"}：${jobs}`,
  aJob: "某个 Job",
  sampled: (when) => `采样于 ${when}。`,
  gpuWait: (problem) => `GPU Job 正在等待：${problem}。CPU Job 不受影响。`,
  unknown: "未知",
  inUse: " 使用中",
  gpuTitle: (name, inUse, total, held) => `${name} 内存：${inUse} 使用中，共 ${total}${held ? `，Job 预留 ${held}` : ""}`,
  reserved: (value) => `已预留 ${value}`,
  busy: (pct) => `${pct}% 繁忙`,
  closed: (byAgent, reason) => `已${byAgent ? "由某个 Agent " : ""}对新 Job 关闭${reason ? `（${reason}）` : ""}。已在其上的 Job 继续使用它。`,
  resumeGpuTitle: "继续在此 GPU 上暂停的 Job，如果是暂停关闭了它，就重新对新 Job 开放",
  pauseGpuTitle: "停止在此 GPU 上启动新 Job，并暂停正在使用它的托管 Job。它们的内存和 GPU 内存仍保留；已发送的 GPU 工作会先完成。",
  resumeGpu: "继续 GPU 工作",
  pauseGpu: "暂停 GPU 工作",
  closedState: "已关闭",
  shared: "共享",
  exclusive: "独占",
  open: "对新 Job 开放",
  reason: "原因（可选）",
  close: "对新 Job 关闭",
  share: "允许托管 Job 共享它",
  keepFreeMib: "保留空闲（MiB）",
  sharingNote: "默认情况下，一个设备同一时间只由一个托管 GPU Job 使用。设为共享后，请求共享模式的 Job 会在其声明的内存能放入采样的空闲内存（减去托管 Job 的预留和此数值）时启动。实际用量不受任何限制。",
  budgetGroup: "此主机的 Job 预算",
  jobsAtOnce: "同时运行的 Job 数",
  jobsAtOnceNote: (min, max, preset) =>
    `此主机自己的 Job 同时最多运行多少个，${min}–${max}；未更改时为 ${preset}。超出的会在队列中等待，降低它不会停止任何正在运行的 Job。它们仍受 CPU 和内存预算限制。`,
  inEffect: (value) => `当前生效：${value}。`,
  useDefaultN: (n) => `使用默认值（${n}）`,
  reserveInEffect: (reserve) => (reserve == null ? "当前生效：默认值。" : `当前生效：保留 ${reserve} GiB 空闲。`),
  saved: "已保存。",
  unsaved: "有未保存的更改",
  gpusGroup: "GPU",
  takesJobs: (shared) => (shared ? "对新 Job 开放；托管 Job 可以共享它。" : "对新 Job 开放，同一时间一个托管 GPU Job。"),
});
type Text = ReturnType<typeof text>;

/**
 * One resource as a bar: the lighter band is what is reserved, the solid
 * part what is in use, both out of the whole. Use that is not known draws
 * nothing and reads "unknown".
 */
export function UsageMeter({
  label,
  used,
  reserved,
  total,
  value,
  title,
  className = "",
  children,
}: {
  label: ReactNode;
  used: number | null;
  reserved: number | null;
  total: number;
  /** The reading in words, beside the label. */
  value: ReactNode;
  /** Words for assistive technology. */
  title: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`jobs-meter ${className}`.trim()}>
      <span className="jobs-meter-label">
        <span className="jobs-meter-name">{label}</span>
        <span className="jobs-meter-value">{value}</span>
      </span>
      <span
        className="jobs-meter-bar"
        role="meter"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share(used ?? reserved ?? 0, total))}
      >
        {reserved != null && <span className="jobs-meter-reserved" style={{ width: `${share(reserved, total)}%` }} />}
        {used != null && <span className="jobs-meter-used" style={{ width: `${share(used, total)}%` }} />}
      </span>
      {children}
    </div>
  );
}

/** What Core accepts as a saved budget: fixed bounds, not this host's size. */
export type BudgetBounds = { minimum: Resources; maximum: Resources };
/** This host's totals, shown beside the budget for reference only. */
export type BudgetHost = {
  logicalCpus?: number;
  memoryTotalMiB?: number;
  swapTotalMiB?: number | null;
  hostHeadroomMiB?: number;
};
/** How many of this host's own Jobs run at once (T-55): the number in
 * effect, whether the user saved one, the default and what Core takes. */
export type MaxActive = { value: number; set: boolean; preset: number; bounds: { minimum: number; maximum: number } };

/** GET /api/jobs/budget, as the Jobs card and Settings read it. */
export type JobsBudgetView = {
  machine: BudgetHost & { name: string; memoryAvailableMiB: number | null; scope: string; suggestedBudget?: Resources };
  collectorOverhead?: Resources;
  budget: Resources;
  /** Absent from Cores before T-160. */
  budgetBounds?: BudgetBounds;
  reserved: Resources;
  queuedCount: number;
  activeCount: number;
  /** Jobs that wait for an earlier stage of their run or for its analysis,
   * in neither count above. Absent from Cores before T-69. */
  waitingCount?: number;
  /** Absent from Cores before T-55. */
  maxActive?: number;
  maxActiveSet?: boolean;
  maxActiveDefault?: number;
  maxActiveBounds?: { minimum: number; maximum: number };
  /** Absent from Cores before T-95. */
  disk?: DiskView;
  /** Absent from Cores before T-106. */
  gpus?: GpuView;
  /** Absent from Cores before T-108's Windows ceiling. */
  windows?: WindowsJobsView;
};
export const validBudget = (value: JobsBudgetView) =>
  !!value?.machine &&
  !!value?.budget &&
  !!value?.reserved &&
  Number.isFinite(value.activeCount) &&
  Number.isFinite(value.queuedCount);
/** The Jobs at once Core reports, or null for a Core before T-55. */
export const maxActiveOf = (view: JobsBudgetView): MaxActive | null =>
  finite(view.maxActive)
    ? {
        value: view.maxActive!,
        set: view.maxActiveSet === true,
        preset: finite(view.maxActiveDefault) ? view.maxActiveDefault! : 4,
        bounds: view.maxActiveBounds ?? { minimum: 1, maximum: 16 },
      }
    : null;

/** A field's draft: what Core has, until it is edited, and again whenever
 * Core's value changes (a save, or a read again), set while rendering. An
 * effect would reset it after the first commit, and a first keystroke that
 * came before that effect ran was undone by it (the CPU quota typed at once
 * came back as Core's). */
function useDraft<T>(saved: T, key: string): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(saved);
  const [from, setFrom] = useState(key);
  if (from !== key) {
    setFrom(key);
    setDraft(saved);
  }
  return [draft, setDraft];
}

/** A field of Settings' Core host editor: its words beside it, its input
 * named so the label reads it. */
function SettingField({
  label,
  help,
  now,
  children,
  extra,
}: {
  label: string;
  help?: ReactNode;
  /** What Core has in effect, as its answer said. */
  now?: ReactNode;
  children: (id: string) => ReactNode;
  /** A button beside the input, outside its label. */
  extra?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="settings-row jobs-settings-row">
      <span className="settings-row-main">
        <label className="settings-row-title" htmlFor={id}>
          {label}
        </label>
        {help && <span className="settings-row-help">{help}</span>}
        {now && <span className="settings-row-help jobs-settings-now">{now}</span>}
      </span>
      <span className="jobs-settings-control">
        {children(id)}
        {extra}
      </span>
    </div>
  );
}

/** A save's outcome under its group's buttons: Core's refusal as it came,
 * or Saved once Core took it (until the next edit), or that the fields
 * differ from what Core has. */
function SaveState({ error, done, changed }: { error: string; done: boolean; changed: boolean }) {
  const t = useStrings(text);
  if (error)
    return (
      <p className="inline-error" role="alert">
        {error}
      </p>
    );
  if (done)
    return (
      <span className="settings-row-help" role="status">
        {t.saved}
      </span>
    );
  return changed ? <span className="settings-row-help">{t.unsaved}</span> : null;
}

/** Settings' editor of this host's budget and, from a Core that has it, how
 * many of its Jobs run at once: saved together, one POST. Its fields follow
 * what Core has whenever that changes; a refused save keeps what was typed. */
export function BudgetSettings({
  budget,
  bounds,
  host,
  suggested,
  collector,
  maxActive,
  onSaved,
}: {
  budget: Resources;
  bounds?: BudgetBounds;
  host?: BudgetHost;
  suggested?: Resources;
  collector?: Resources;
  /** Null from a Core before T-55: no field, never sent. */
  maxActive?: MaxActive | null;
  onSaved: () => void;
}) {
  const t = useStrings(text);
  const [value, setValue] = useDraft(budget, `${budget.cpuMillis}:${budget.memoryMiB}:${budget.swapMiB}`);
  const slotsKey = maxActive ? `${maxActive.value}:${maxActive.set}` : "";
  const [slots, setSlots] = useDraft(maxActive ? String(maxActive.value) : "", slotsKey);
  // Use default chosen: the default shows, and null is sent.
  const [toDefault, setToDefault] = useDraft(false, slotsKey);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // maxActive only when it differs from what was read: left out, Core keeps it.
  const slotsChange: { maxActive?: number | null } = !maxActive
    ? {}
    : toDefault
      ? maxActive.set
        ? { maxActive: null }
        : {}
      : slots.trim() !== "" && Number(slots) !== maxActive.value
        ? { maxActive: Number(slots) }
        : {};
  const changed =
    value.cpuMillis !== budget.cpuMillis ||
    value.memoryMiB !== budget.memoryMiB ||
    value.swapMiB !== budget.swapMiB ||
    "maxActive" in slotsChange;
  // Each field changes only its own part, whatever the others are by then.
  const edit = (change: Partial<Resources>) => {
    setDone(false);
    setValue((old) => ({ ...old, ...change }));
  };
  return (
    <form
      className="settings-group jobs-settings-group jobs-settings-budget"
      aria-label={t.budgetGroup}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        setDone(false);
        try {
          await post("/jobs/budget", { ...value, ...slotsChange });
          setDone(true);
          onSaved();
        } catch (error) {
          setError(errorText(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      {maxActive && (
        <SettingField
          label={t.jobsAtOnce}
          help={t.jobsAtOnceNote(maxActive.bounds.minimum, maxActive.bounds.maximum, maxActive.preset)}
          now={t.inEffect(t.ceiling(maxActive.value, maxActive.set))}
          extra={
            maxActive.set &&
            !toDefault && (
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => {
                  setDone(false);
                  setToDefault(true);
                  setSlots(String(maxActive.preset));
                }}
              >
                {t.useDefaultN(maxActive.preset)}
              </button>
            )
          }
        >
          {(id) => (
            <input
              id={id}
              name="maxActive"
              className="settings-input"
              type="number"
              inputMode="numeric"
              min={maxActive.bounds.minimum}
              max={maxActive.bounds.maximum}
              step="1"
              required
              value={slots}
              onChange={(e) => {
                setDone(false);
                setToDefault(false);
                setSlots(e.target.value);
              }}
            />
          )}
        </SettingField>
      )}
      <SettingField label={t.cpuQuota}>
        {(id) => (
          <input
            id={id}
            name="cpu"
            className="settings-input"
            type="number"
            min={(bounds?.minimum.cpuMillis ?? 200) / 1000}
            max={bounds && bounds.maximum.cpuMillis / 1000}
            step="0.1"
            required
            value={value.cpuMillis / 1000}
            onChange={(e) => edit({ cpuMillis: Math.round(Number(e.target.value) * 1000) })}
          />
        )}
      </SettingField>
      <SettingField label={t.ram}>
        {(id) => (
          <input
            id={id}
            name="memory"
            className="settings-input"
            type="number"
            min={bounds?.minimum.memoryMiB ?? 128}
            max={bounds?.maximum.memoryMiB}
            required
            value={value.memoryMiB}
            onChange={(e) => edit({ memoryMiB: Number(e.target.value) })}
          />
        )}
      </SettingField>
      <SettingField label={t.swap}>
        {(id) => (
          <input
            id={id}
            name="swap"
            className="settings-input"
            type="number"
            min={bounds?.minimum.swapMiB ?? 0}
            max={bounds?.maximum.swapMiB}
            required
            value={value.swapMiB}
            onChange={(e) => edit({ swapMiB: Number(e.target.value) })}
          />
        )}
      </SettingField>
      <div className="jobs-settings-notes">
        <p className="settings-row-help">{t.saving}</p>
        {(host?.logicalCpus != null || suggested) && (
          <p className="settings-row-help">
            {host?.logicalCpus != null && host.memoryTotalMiB != null &&
              t.reference(host.logicalCpus, host.memoryTotalMiB, host.swapTotalMiB ?? null)}
            {suggested && t.conservative(suggested.cpuMillis / 1000, suggested.memoryMiB, suggested.swapMiB)}
          </p>
        )}
        <p className="settings-row-help">{t.startsWhen(host?.hostHeadroomMiB ?? null)}</p>
        {collector && (
          <p className="settings-row-help">
            {t.collector(collector.cpuMillis / 1000, collector.memoryMiB, 4 + (2 * collector.cpuMillis) / 1000, 8192 + 2 * collector.memoryMiB)}
          </p>
        )}
      </div>
      <div className="jobs-settings-actions">
        <button className="secondary-button" disabled={busy}>
          {busy && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
          {t.saveBudget}
        </button>
        <SaveState error={error} done={done} changed={changed} />
      </div>
    </form>
  );
}

export type DiskVolume = {
  device: number | null;
  paths: { path: string; role: string }[];
  totalBytes: number | null;
  availableBytes: number | null;
  reserveBytes: number | null;
  low: boolean | null;
  error: string | null;
};
export type DiskView = {
  reserveGiB: number | null;
  defaultRule: string;
  bounds: { minGiB: number; maxGiB: number };
  observedAt: string;
  volumes: DiskVolume[];
  scope: string;
};
const gib = (bytes: number) => `${(bytes / 1073741824).toFixed(1)} GiB`;

/** Free space where jobs write, each disk as a bar of what is used. Its
 * folders and the time it was read are in its tip; the reserve below which
 * no new job starts is set in Settings (DiskReserveSettings). */
export function DiskSpace({ disk }: { disk: DiskView }) {
  const t = useStrings(text);
  const read = t.read(clock(disk.observedAt));
  // Core reported no disk: one cell says so.
  if (!disk.volumes.length)
    return (
      <UsageMeter
        className="jobs-disk-volume is-unknown"
        label={<span className="jobs-disk-paths" title={read}>{t.disk}</span>}
        used={null}
        reserved={null}
        total={1}
        value={<span className="jobs-disk-free">{t.notReported}</span>}
        title={t.diskNotReported}
      />
    );
  return (
    <>
      {disk.volumes.map((v, index) => {
        const known = !v.error && v.totalBytes != null && v.availableBytes != null;
        const free = known ? t.free(gib(v.availableBytes!)) : t.freeUnknown;
        const label = disk.volumes.length > 1 ? t.diskN(index + 1) : t.disk;
        return (
          <UsageMeter
            key={index}
            className={`jobs-disk-volume${v.low ? " is-low" : ""}${v.error ? " is-unknown" : ""}`}
            label={
              <span
                className="jobs-disk-paths"
                title={[...v.paths.map((p) => `${p.role}: ${p.path}`), read].join("\n")}
              >
                {label}
              </span>
            }
            used={known ? v.totalBytes! - v.availableBytes! : null}
            reserved={null}
            total={known ? v.totalBytes! : 1}
            value={<span className="jobs-disk-free">{free}</span>}
            title={t.diskTitle(label, free, known ? gib(v.totalBytes!) : null)}
          >
            {known && (
              <span className="jobs-cell-foot">
                <span className="jobs-disk-total">{t.of(gib(v.totalBytes!))}</span>
              </span>
            )}
            {v.error ? (
              <small role="status">{t.unreadable(v.error)}</small>
            ) : v.low ? (
              <small role="status">{t.low(gib(v.reserveBytes!))}</small>
            ) : null}
          </UsageMeter>
        );
      })}
    </>
  );
}

/** Settings' disk reserve, one for every disk: a number of GiB, or empty for
 * Core's default rule. Saved alone; a refusal keeps what was typed. */
export function DiskReserveSettings({ disk, onSaved }: { disk: DiskView; onSaved: () => void }) {
  const t = useStrings(text);
  const saved = disk.reserveGiB == null ? "" : String(disk.reserveGiB);
  const [value, setValue] = useDraft(saved, saved);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const save = async (reserveGiB: number | null) => {
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await post("/jobs/disk", { reserveGiB });
      setDone(true);
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="settings-group jobs-settings-group jobs-settings-disk"
      aria-label={t.diskReserve}
      onSubmit={(e) => {
        e.preventDefault();
        void save(value === "" ? null : Number(value));
      }}
    >
      <SettingField
        label={t.keepFreeGib}
        help={t.diskNote(disk.defaultRule, disk.scope)}
        now={t.reserveInEffect(disk.reserveGiB)}
      >
        {(id) => (
          <input
            id={id}
            name="reserveGiB"
            className="settings-input"
            type="number"
            min={disk.bounds.minGiB}
            max={disk.bounds.maxGiB}
            step="1"
            placeholder={t.default}
            value={value}
            onChange={(e) => {
              setDone(false);
              setValue(e.target.value);
            }}
          />
        )}
      </SettingField>
      <div className="jobs-settings-actions">
        <button className="secondary-button" disabled={busy}>
          {t.saveReserve}
        </button>
        {disk.reserveGiB != null && (
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void save(null)}>
            {t.useDefault}
          </button>
        )}
        <SaveState error={error} done={done} changed={value !== saved} />
      </div>
    </form>
  );
}

export type WindowsJobsView = {
  /** Whether Windows Jobs exist here (Core in WSL with interop on). */
  available?: boolean;
  maxJobs: number;
  set: boolean;
  defaultMaxJobs: number;
  activeCount: number;
  sharesThisBudget: boolean;
};

/** Windows on this PC: the slots its attempts hold (starting and unknown ones
 * too, so "in use", not running; the job list says which run) against its own
 * ceiling, which the user sets in Settings (WindowsJobsSettings). Only a
 * ceiling: Windows jobs keep sharing this host's CPU/RAM budget. */
export function WindowsJobs({ windows }: { windows: WindowsJobsView }) {
  const t = useStrings(text);
  const ceiling = t.ceiling(windows.maxJobs, windows.set);
  return (
    <UsageMeter
      className="jobs-windows"
      label={t.windows}
      used={windows.activeCount}
      reserved={null}
      total={Math.max(windows.maxJobs, windows.activeCount, 1)}
      value={
        <>
          <strong>{windows.activeCount}</strong>{t.windowsInUse(windows.maxJobs)}
        </>
      }
      title={t.windowsTitle(windows.activeCount, ceiling)}
    >
      <span className="jobs-cell-foot">
        <span className="jobs-reserved-text" title={t.windowsCeiling(ceiling)}>
          {t.sharesBudget}
        </span>
      </span>
    </UsageMeter>
  );
}

/** Settings' ceiling on Windows jobs at once, 1–64, or empty for the
 * default. Saved alone; a refusal keeps what was typed. */
export function WindowsJobsSettings({ windows, onSaved }: { windows: WindowsJobsView; onSaved: () => void }) {
  const t = useStrings(text);
  const saved = windows.set ? String(windows.maxJobs) : "";
  const [value, setValue] = useDraft(saved, saved);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const save = async (maxJobs: number | null) => {
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await post("/jobs/windows", { maxJobs });
      setDone(true);
      onSaved();
    } catch (error) {
      // The typed value stays, so it can be corrected and saved again.
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="settings-group jobs-settings-group jobs-settings-windows"
      aria-label={t.windowsJobs}
      onSubmit={(e) => {
        e.preventDefault();
        void save(value === "" ? null : Number(value));
      }}
    >
      <SettingField
        label={t.atMost}
        help={t.windowsNote(windows.defaultMaxJobs)}
        now={t.inEffect(t.ceiling(windows.maxJobs, windows.set))}
      >
        {(id) => (
          <input
            id={id}
            name="windowsMaxJobs"
            className="settings-input"
            type="number"
            min={1}
            max={64}
            step="1"
            placeholder={t.defaultN(windows.defaultMaxJobs)}
            value={value}
            onChange={(e) => {
              setDone(false);
              setValue(e.target.value);
            }}
          />
        )}
      </SettingField>
      <div className="jobs-settings-actions">
        <button className="secondary-button" disabled={busy}>
          {t.save}
        </button>
        {windows.set && (
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void save(null)}>
            {t.useDefault}
          </button>
        )}
        <SaveState error={error} done={done} changed={value !== saved} />
      </div>
    </form>
  );
}

export type GpuDevice = {
  uuid: string;
  index: number | null;
  name: string;
  memoryTotalMiB: number;
  /** Null when the device is missing from a current sample. */
  memoryFreeMiB: number | null;
  admission: "open" | "closed";
  closedReason: string | null;
  /** Who closed it; only the user reopens a close the user made. */
  closedBy?: "user" | "agent" | null;
  sharing: boolean;
  headroomMiB: number;
  reservations: { jobId: string; name: string; memoryMiB: number; mode: "exclusive" | "shared" }[];
};
export type GpuView = {
  devices: GpuDevice[];
  observedAt: string | null;
  problem: string | null;
  scope: string;
};

/** A device's name as the card and Settings show it. */
const gpuName = (d: GpuDevice) => `${d.index == null ? "" : `GPU ${d.index} · `}${d.name}`;

/** Local GPUs by UUID: the latest sample, what managed jobs hold on each,
 * whether each takes new jobs and how, and the pause of the user's GPU work
 * (T-107). Admission and sharing are set in Settings (GpuDeviceSettings). */
export function GpuDevices({
  gpus,
  paused,
  busyNow,
  onSaved,
}: {
  gpus: GpuView;
  /** GPUs on which the user paused a running job (T-107). */
  paused?: Set<string>;
  /** The host's latest GPU reading, in device order, for how busy each is. */
  busyNow?: MachineLoad["gpus"];
  /** After a pause or resume, to read the budget again. */
  onSaved: () => void;
}) {
  const t = useStrings(text);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  // A host without NVIDIA devices shows nothing.
  if (!gpus.devices.length) return null;
  // A device pause or resume reports every job; say which ones it could not change.
  const pauseGpu = async (uuid: string, resume: boolean) => {
    setActing(uuid);
    setError("");
    try {
      const answer = await post<{ jobs?: { name?: string; error?: string }[] }>(
        `/jobs/gpus/${encodeURIComponent(uuid)}/${resume ? "resume" : "pause"}`,
      );
      const failed = (answer?.jobs ?? []).filter((j) => j.error);
      if (failed.length)
        setError(t.notChanged(resume, failed.map((j) => `${j.name || t.aJob} (${j.error})`).join("; ")));
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setActing("");
    }
  };
  const sampled = gpus.observedAt ? t.sampled(clock(gpus.observedAt)) : "";
  return (
    <>
      {gpus.problem && (
        <p className="jobs-gpus-problem" role="status">
          {t.gpuWait(gpus.problem)}
        </p>
      )}
      {gpus.devices.map((d, position) => {
        const name = gpuName(d);
        // The card's own name without the maker's prefix fits a cell; the tip has it whole.
        const short = `${d.index == null ? "" : `GPU ${d.index} · `}${d.name.replace(/^NVIDIA (GeForce )?/, "")}`;
        const used = d.memoryFreeMiB == null ? null : d.memoryTotalMiB - d.memoryFreeMiB;
        const held = d.reservations.reduce((sum, r) => sum + r.memoryMiB, 0);
        // The host reading lists GPUs in the same order; a name that differs is not matched.
        const reading = busyNow?.[position];
        const busyPct = reading && reading.name === d.name ? reading.utilPct : null;
        const inUse = used == null ? t.unknown : memoryText(used);
        return (
          <UsageMeter
            key={d.uuid}
            className={`jobs-gpu${d.admission === "closed" ? " is-closed" : ""}`}
            label={
              <span className="jobs-gpu-name" title={`${name}\n${d.uuid}\n${sampled}${gpus.scope}`}>
                {short}
              </span>
            }
            used={used}
            reserved={held || null}
            total={d.memoryTotalMiB}
            value={
              <span className="jobs-gpu-free">
                <strong>{inUse}</strong>{t.inUse}
              </span>
            }
            title={t.gpuTitle(name, inUse, memoryText(d.memoryTotalMiB), held ? memoryText(held) : null)}
          >
            <span className="jobs-cell-foot">
              <span className="jobs-gpu-total">{t.of(memoryText(d.memoryTotalMiB))}</span>
              {held > 0 && (
                <span
                  className="jobs-gpu-held"
                  title={d.reservations.map((r) => `${r.name}: ${memoryText(r.memoryMiB)} ${r.mode}`).join("\n")}
                >
                  {t.reserved(memoryText(held))}
                </span>
              )}
              {busyPct != null && <span className="jobs-gpu-busy">{t.busy(Math.round(busyPct))}</span>}
              <span className="jobs-gpu-mode">
                {d.admission === "closed" ? t.closedState : d.sharing ? t.shared : t.exclusive}
              </span>
              <GpuPause
                resume={!!paused?.has(d.uuid) || (d.admission === "closed" && d.closedBy === "user" && d.closedReason === PAUSE_REASON)}
                busy={acting === d.uuid}
                act={(resume) => pauseGpu(d.uuid, resume)}
              />
            </span>
            {d.admission === "closed" && (
              <small role="status">{t.closed(d.closedBy === "agent", d.closedReason)}</small>
            )}
          </UsageMeter>
        );
      })}
      {error && (
        <p className="inline-error jobs-gpus-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** The close a GPU pause makes (pause.rs); its resume reopens only that one. */
const PAUSE_REASON = "Paused by the user";

/** Pause or resume the user's GPU work on one device (T-107): stop new jobs
 * there and pause the managed jobs using it, or the reverse. */
function GpuPause({
  resume,
  busy,
  act,
}: {
  resume: boolean;
  busy: boolean;
  act: (resume: boolean) => Promise<void>;
}) {
  const t = useStrings(text);
  return (
    <button
      type="button"
      className="quiet-button jobs-gpu-pause"
      disabled={busy}
      onClick={() => void act(resume)}
      title={resume ? t.resumeGpuTitle : t.pauseGpuTitle}
    >
      {resume ? t.resumeGpu : t.pauseGpu}
    </button>
  );
}

/** Settings' choices for each local GPU, by UUID: new jobs or not, and
 * sharing with the memory kept free. Each is posted alone; Core's refusal is
 * shown under that GPU as it came. */
export function GpuDeviceSettings({ gpus, onSaved }: { gpus: GpuView; onSaved: () => void }) {
  const t = useStrings(text);
  if (!gpus.devices.length) return null;
  return (
    <div className="jobs-settings-gpus" role="group" aria-label={t.gpusGroup}>
      {gpus.devices.map((d) => (
        <GpuSettings key={d.uuid} device={d} onSaved={onSaved} />
      ))}
    </div>
  );
}

function GpuSettings({ device, onSaved }: { device: GpuDevice; onSaved: () => void }) {
  const t = useStrings(text);
  const [reason, setReason] = useState("");
  // What Core has, again whenever it changes: after a save, or another window's.
  const [sharing, setSharing] = useDraft(device.sharing, String(device.sharing));
  const [headroom, setHeadroom] = useDraft(String(device.headroomMiB), String(device.headroomMiB));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const save = async (path: "admission" | "settings", body: object) => {
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await post(`/jobs/gpus/${encodeURIComponent(device.uuid)}/${path}`, body);
      if (path === "admission") setReason("");
      setDone(true);
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const name = gpuName(device);
  const changed = sharing !== device.sharing || headroom !== String(device.headroomMiB);
  return (
    <section className="settings-group jobs-settings-group jobs-settings-gpu" aria-label={name}>
      <div className="settings-row">
        <span className="settings-row-main">
          <span className="settings-row-title jobs-settings-gpu-name" lang="">
            {name}
          </span>
          <span className="settings-row-help jobs-settings-now" role="status">
            {device.admission === "closed" ? t.closed(device.closedBy === "agent", device.closedReason) : t.takesJobs(device.sharing)}
          </span>
        </span>
        {device.admission === "closed" && (
          <span className="jobs-settings-control">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void save("admission", { open: true })}>
              {t.open}
            </button>
          </span>
        )}
      </div>
      {device.admission !== "closed" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("admission", { open: false, ...(reason.trim() ? { reason: reason.trim() } : {}) });
          }}
        >
          <SettingField
            label={t.reason}
            extra={
              <button className="secondary-button" disabled={busy}>
                {t.close}
              </button>
            }
          >
            {(id) => (
              <input
                id={id}
                name="reason"
                className="settings-input jobs-settings-reason"
                maxLength={200}
                value={reason}
                onChange={(e) => {
                  setDone(false);
                  setReason(e.target.value);
                }}
              />
            )}
          </SettingField>
        </form>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save("settings", { sharing, headroomMiB: Number(headroom) });
        }}
      >
        <label className="settings-row jobs-settings-check">
          <input
            type="checkbox"
            name="sharing"
            checked={sharing}
            onChange={(e) => {
              setDone(false);
              setSharing(e.target.checked);
            }}
          />
          <span className="settings-row-title">{t.share}</span>
        </label>
        <SettingField label={t.keepFreeMib} help={t.sharingNote}>
          {(id) => (
            <input
              id={id}
              name="headroomMiB"
              className="settings-input"
              type="number"
              min="0"
              max="65536"
              step="1"
              required
              value={headroom}
              onChange={(e) => {
                setDone(false);
                setHeadroom(e.target.value);
              }}
            />
          )}
        </SettingField>
        <div className="jobs-settings-actions">
          <button className="secondary-button" disabled={busy}>
            {t.save}
          </button>
          <SaveState error={error} done={done} changed={changed} />
        </div>
      </form>
    </section>
  );
}
