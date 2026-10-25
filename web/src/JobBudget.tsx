import { useEffect, useRef, useState, type ReactNode } from "react";
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
  machineBudget: "Machine budget",
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
  keepFreeTitle: (read: string) => `Keep free · ${read}`,
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
}, {
  machineBudget: "机器预算",
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
  keepFreeTitle: (read) => `保留空闲 · ${read}`,
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

export function BudgetSettings({
  openRequest,
  onOpenRequestHandled,
  budget,
  bounds,
  host,
  suggested,
  collector,
  onSaved,
}: {
  openRequest?: number;
  onOpenRequestHandled?: () => void;
  budget: Resources;
  bounds?: BudgetBounds;
  host?: BudgetHost;
  suggested?: Resources;
  collector?: Resources;
  onSaved: () => void;
}) {
  const t = useStrings(text);
  const [editing, setEditing] = useState(false);
  const container = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!openRequest) return;
    setEditing(true);
    container.current?.querySelector("summary")?.focus();
    container.current?.scrollIntoView?.({ block: "start" });
    onOpenRequestHandled?.();
  }, [openRequest, onOpenRequestHandled]);
  const [value, setValue] = useState(budget);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details
      ref={container}
      className="job-budget-settings"
      open={editing}
      onToggle={(e) => setEditing(e.currentTarget.open)}
    >
      <summary
        onClick={() => {
          if (!editing) setValue(budget);
        }}
      >
        {t.machineBudget}
      </summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await post("/jobs/budget", value);
            setEditing(false);
            onSaved();
          } catch (error) {
            setError(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {t.cpuQuota}
          <input
            type="number"
            min={(bounds?.minimum.cpuMillis ?? 200) / 1000}
            max={bounds && bounds.maximum.cpuMillis / 1000}
            step="0.1"
            required
            value={value.cpuMillis / 1000}
            onChange={(e) =>
              setValue({
                ...value,
                cpuMillis: Math.round(Number(e.target.value) * 1000),
              })
            }
          />
        </label>
        <label>
          {t.ram}
          <input
            type="number"
            min={bounds?.minimum.memoryMiB ?? 128}
            max={bounds?.maximum.memoryMiB}
            required
            value={value.memoryMiB}
            onChange={(e) =>
              setValue({ ...value, memoryMiB: Number(e.target.value) })
            }
          />
        </label>
        <label>
          {t.swap}
          <input
            type="number"
            min={bounds?.minimum.swapMiB ?? 0}
            max={bounds?.maximum.swapMiB}
            required
            value={value.swapMiB}
            onChange={(e) =>
              setValue({ ...value, swapMiB: Number(e.target.value) })
            }
          />
        </label>
        <p className="job-footnote">{t.saving}</p>
        {(host?.logicalCpus != null || suggested) && (
          <p className="job-footnote">
            {host?.logicalCpus != null && host.memoryTotalMiB != null &&
              t.reference(host.logicalCpus, host.memoryTotalMiB, host.swapTotalMiB ?? null)}
            {suggested && t.conservative(suggested.cpuMillis / 1000, suggested.memoryMiB, suggested.swapMiB)}
          </p>
        )}
        <p className="job-footnote">{t.startsWhen(host?.hostHeadroomMiB ?? null)}</p>
        {collector && (
          <p className="job-footnote">
            {t.collector(collector.cpuMillis / 1000, collector.memoryMiB, 4 + (2 * collector.cpuMillis) / 1000, 8192 + 2 * collector.memoryMiB)}
          </p>
        )}
        <button className="secondary-button" disabled={busy}>
          {t.saveBudget}
        </button>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </details>
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

/** Free space where jobs write, each disk as a bar of what is used, with the
 * reserve below which no new job starts. Its folders and the time it was read
 * are in its tip. */
export function DiskSpace({ disk, onSaved }: { disk: DiskView; onSaved: () => void }) {
  const t = useStrings(text);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(disk.reserveGiB == null ? "" : String(disk.reserveGiB));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (reserveGiB: number | null) => {
    setBusy(true);
    setError("");
    try {
      await post("/jobs/disk", { reserveGiB });
      setEditing(false);
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const read = t.read(clock(disk.observedAt));
  // One reserve for every disk, under the first.
  const reserve = (
    <details
                className="job-budget-settings jobs-disk"
                open={editing}
                onToggle={(e) => setEditing(e.currentTarget.open)}
              >
                <summary
                  title={t.keepFreeTitle(read)}
                  onClick={() => {
                    if (!editing) setValue(disk.reserveGiB == null ? "" : String(disk.reserveGiB));
                  }}
                >
                  {t.diskReserve}
                </summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(value === "" ? null : Number(value));
                  }}
                >
                  <label>
                    {t.keepFreeGib}
                    <input
                      type="number"
                      min={disk.bounds.minGiB}
                      max={disk.bounds.maxGiB}
                      step="1"
                      placeholder={t.default}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </label>
                  <p className="job-footnote">{t.diskNote(disk.defaultRule, disk.scope)}</p>
                  <button className="secondary-button" disabled={busy}>
                    {t.saveReserve}
                  </button>
                  {disk.reserveGiB != null && (
                    <button type="button" className="quiet-button" disabled={busy} onClick={() => void save(null)}>
                      {t.useDefault}
                    </button>
                  )}
                  {error && (
                    <p className="inline-error" role="alert">
                      {error}
                    </p>
                  )}
                </form>
              </details>
  );
  // Core reported no disk: the reserve still has its place.
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
      >
        <span className="jobs-cell-foot">{reserve}</span>
      </UsageMeter>
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
            <span className="jobs-cell-foot">
              {known && <span className="jobs-disk-total">{t.of(gib(v.totalBytes!))}</span>}
              {index === 0 && reserve}
            </span>
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
 * ceiling, which the user may set (1–64) or leave at the default. Only a
 * ceiling: Windows jobs keep sharing this host's CPU/RAM budget. */
export function WindowsJobs({ windows, onSaved }: { windows: WindowsJobsView; onSaved: () => void }) {
  const t = useStrings(text);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(windows.set ? String(windows.maxJobs) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (maxJobs: number | null) => {
    setBusy(true);
    setError("");
    try {
      await post("/jobs/windows", { maxJobs });
      setEditing(false);
      onSaved();
    } catch (error) {
      // The typed value stays, so it can be corrected and saved again.
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
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
        <span className="jobs-reserved-text">{t.sharesBudget}</span>
        <details
          className="job-budget-settings jobs-windows-settings"
          open={editing}
          onToggle={(e) => setEditing(e.currentTarget.open)}
        >
          <summary
            title={t.windowsCeiling(ceiling)}
            onClick={() => {
              if (!editing) setValue(windows.set ? String(windows.maxJobs) : "");
            }}
          >
            {t.windowsJobs}
          </summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(value === "" ? null : Number(value));
            }}
          >
            <label>
              {t.atMost}
              <input
                type="number"
                min={1}
                max={64}
                step="1"
                placeholder={t.defaultN(windows.defaultMaxJobs)}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <p className="job-footnote">{t.windowsNote(windows.defaultMaxJobs)}</p>
            <button className="secondary-button" disabled={busy}>
              {t.save}
            </button>
            {windows.set && (
              <button type="button" className="quiet-button" disabled={busy} onClick={() => void save(null)}>
                {t.useDefault}
              </button>
            )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </details>
      </span>
    </UsageMeter>
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

/** Local GPUs by UUID: the latest sample, what managed jobs hold on each,
 * and the user's choices — new jobs or not, sharing, memory kept free. */
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
  onSaved: () => void;
}) {
  const t = useStrings(text);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  // A host without NVIDIA devices shows nothing.
  if (!gpus.devices.length) return null;
  const save = async (uuid: string, path: string, body: object) => {
    setActing(uuid);
    setError("");
    try {
      await post(`/jobs/gpus/${encodeURIComponent(uuid)}/${path}`, body);
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setActing("");
    }
  };
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
        const name = `${d.index == null ? "" : `GPU ${d.index} · `}${d.name}`;
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
              <GpuSettings device={d} busy={acting === d.uuid} save={(path, body) => save(d.uuid, path, body)} />
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

function GpuSettings({
  device,
  busy,
  save,
}: {
  device: GpuDevice;
  busy: boolean;
  save: (path: string, body: object) => Promise<void>;
}) {
  const t = useStrings(text);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [sharing, setSharing] = useState(device.sharing);
  const [headroom, setHeadroom] = useState(String(device.headroomMiB));
  return (
    <details
      className="job-budget-settings"
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (e.currentTarget.open) {
          setSharing(device.sharing);
          setHeadroom(String(device.headroomMiB));
        }
      }}
    >
      <summary>{device.admission === "closed" ? t.closedState : device.sharing ? t.shared : t.exclusive}</summary>
      {device.admission === "closed" ? (
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void save("admission", { open: true })}>
          {t.open}
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("admission", { open: false, ...(reason.trim() ? { reason: reason.trim() } : {}) });
          }}
        >
          <label>
            {t.reason}
            <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="secondary-button" disabled={busy}>
            {t.close}
          </button>
        </form>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save("settings", { sharing, headroomMiB: Number(headroom) });
        }}
      >
        <label className="job-checkbox">
          <input type="checkbox" checked={sharing} onChange={(e) => setSharing(e.target.checked)} />
          {t.share}
        </label>
        <label>
          {t.keepFreeMib}
          <input type="number" min="0" max="65536" step="1" required value={headroom} onChange={(e) => setHeadroom(e.target.value)} />
        </label>
        <p className="job-footnote">{t.sharingNote}</p>
        <button className="secondary-button" disabled={busy}>
          {t.save}
        </button>
      </form>
    </details>
  );
}
