import { useEffect, useState, type ReactNode } from "react";
import { post, errorText } from "./api";
import { readMachineLoad } from "./home/home-api";
import type { MachineLoad } from "./home/types";
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
  budget,
  bounds,
  host,
  suggested,
  collector,
  onSaved,
}: {
  budget: Resources;
  bounds?: BudgetBounds;
  host?: BudgetHost;
  suggested?: Resources;
  collector?: Resources;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(budget);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details
      className="job-budget-settings"
      open={editing}
      onToggle={(e) => setEditing(e.currentTarget.open)}
    >
      <summary
        onClick={() => {
          if (!editing) setValue(budget);
        }}
      >
        Machine budget
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
          CPU quota
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
          RAM (MiB)
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
          Swap (MiB)
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
        <p className="job-footnote">
          Saving rechecks queued jobs automatically. Running jobs keep their
          original limits. A lower budget pauses new starts until reservations
          fit.
        </p>
        {(host?.logicalCpus != null || suggested) && (
          <p className="job-footnote">
            {host?.logicalCpus != null && host.memoryTotalMiB != null && (
              <>
                For reference, this host has {host.logicalCpus} CPU ·{" "}
                {host.memoryTotalMiB} MiB RAM
                {host.swapTotalMiB != null && <> · {host.swapTotalMiB} MiB swap</>}
                ; the budget may use all of it.{" "}
              </>
            )}
            {suggested && (
              <>
                Conservative default: {suggested.cpuMillis / 1000} CPU ·{" "}
                {suggested.memoryMiB} MiB RAM · {suggested.swapMiB} MiB swap.
              </>
            )}
          </p>
        )}
        <p className="job-footnote">
          A job starts only when the host also has its RAM free at that moment
          {host?.hostHeadroomMiB != null && (
            <>, keeping {host.hostHeadroomMiB} MiB for Core and the desktop</>
          )}
          . CPU is a shared quota, not reserved cores.
        </p>
        {collector && (
          <p className="job-footnote">
            Each job also reserves {collector.cpuMillis / 1000} CPU and{" "}
            {collector.memoryMiB} MiB RAM for collection. Two jobs with 2 CPU
            and 4096 MiB each need at least{" "}
            {4 + (2 * collector.cpuMillis) / 1000} CPU and{" "}
            {8192 + 2 * collector.memoryMiB} MiB RAM in this budget.
          </p>
        )}
        <button className="secondary-button" disabled={busy}>
          Save budget
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
  const read = `Read ${clock(disk.observedAt)}`;
  // One reserve for every disk, under the first.
  const reserve = (
    <details
                className="job-budget-settings jobs-disk"
                open={editing}
                onToggle={(e) => setEditing(e.currentTarget.open)}
              >
                <summary
                  title={`Keep free · ${read}`}
                  onClick={() => {
                    if (!editing) setValue(disk.reserveGiB == null ? "" : String(disk.reserveGiB));
                  }}
                >
                  Disk reserve
                </summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(value === "" ? null : Number(value));
                  }}
                >
                  <label>
                    Keep free (GiB)
                    <input
                      type="number"
                      min={disk.bounds.minGiB}
                      max={disk.bounds.maxGiB}
                      step="1"
                      placeholder="Default"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </label>
                  <p className="job-footnote">
                    No new job starts while Core's data folder or its working directory has less free space than
                    this. Empty uses the default: {disk.defaultRule}. {disk.scope}
                  </p>
                  <button className="secondary-button" disabled={busy}>
                    Save reserve
                  </button>
                  {disk.reserveGiB != null && (
                    <button type="button" className="quiet-button" disabled={busy} onClick={() => void save(null)}>
                      Use default
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
        label={<span className="jobs-disk-paths" title={read}>Disk</span>}
        used={null}
        reserved={null}
        total={1}
        value={<span className="jobs-disk-free">Not reported</span>}
        title="Disk: not reported"
      >
        <span className="jobs-cell-foot">{reserve}</span>
      </UsageMeter>
    );
  return (
    <>
      {disk.volumes.map((v, index) => {
        const known = !v.error && v.totalBytes != null && v.availableBytes != null;
        const free = known ? `${gib(v.availableBytes!)} free` : "Free space unknown";
        return (
          <UsageMeter
            key={index}
            className={`jobs-disk-volume${v.low ? " is-low" : ""}${v.error ? " is-unknown" : ""}`}
            label={
              <span
                className="jobs-disk-paths"
                title={[...v.paths.map((p) => `${p.role}: ${p.path}`), read].join("\n")}
              >
                {disk.volumes.length > 1 ? `Disk ${index + 1}` : "Disk"}
              </span>
            }
            used={known ? v.totalBytes! - v.availableBytes! : null}
            reserved={null}
            total={known ? v.totalBytes! : 1}
            value={<span className="jobs-disk-free">{free}</span>}
            title={`Disk${disk.volumes.length > 1 ? ` ${index + 1}` : ""}: ${free}${known ? ` of ${gib(v.totalBytes!)}` : ""}`}
          >
            <span className="jobs-cell-foot">
              {known && <span className="jobs-disk-total">of {gib(v.totalBytes!)}</span>}
              {index === 0 && reserve}
            </span>
            {v.error ? (
              <small role="status">Could not be read ({v.error}); new jobs wait until it can be checked.</small>
            ) : v.low ? (
              <small role="status">Below the {gib(v.reserveBytes!)} reserve: new jobs wait here. Running jobs go on.</small>
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
  const ceiling = `${windows.maxJobs} at once${windows.set ? "" : " (default)"}`;
  return (
    <UsageMeter
      className="jobs-windows"
      label="Windows"
      used={windows.activeCount}
      reserved={null}
      total={Math.max(windows.maxJobs, windows.activeCount, 1)}
      value={
        <>
          <strong>{windows.activeCount}</strong> of {windows.maxJobs} in use
        </>
      }
      title={`Windows: ${windows.activeCount} in use of ${ceiling}`}
    >
      <span className="jobs-cell-foot">
        <span className="jobs-reserved-text">Shares this host&apos;s budget</span>
        <details
          className="job-budget-settings jobs-windows-settings"
          open={editing}
          onToggle={(e) => setEditing(e.currentTarget.open)}
        >
          <summary
            title={`Windows: ${ceiling}`}
            onClick={() => {
              if (!editing) setValue(windows.set ? String(windows.maxJobs) : "");
            }}
          >
            Windows jobs
          </summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(value === "" ? null : Number(value));
            }}
          >
            <label>
              At most at once
              <input
                type="number"
                min={1}
                max={64}
                step="1"
                placeholder={`Default (${windows.defaultMaxJobs})`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <p className="job-footnote">
              How many Windows jobs may run at the same time, 1–64. Empty uses the default ({windows.defaultMaxJobs}). It
              is only a ceiling: Windows jobs still share this host&apos;s CPU and RAM budget, and lowering it stops
              nothing that is running.
            </p>
            <button className="secondary-button" disabled={busy}>
              Save
            </button>
            {windows.set && (
              <button type="button" className="quiet-button" disabled={busy} onClick={() => void save(null)}>
                Use default
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
        setError(`Not ${resume ? "resumed" : "paused"}: ${failed.map((j) => `${j.name || "a job"} (${j.error})`).join("; ")}`);
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setActing("");
    }
  };
  const sampled = gpus.observedAt ? `Sampled ${clock(gpus.observedAt)}. ` : "";
  return (
    <>
      {gpus.problem && (
        <p className="jobs-gpus-problem" role="status">
          GPU jobs wait: {gpus.problem}. CPU jobs are not held.
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
        const inUse = used == null ? "unknown" : memoryText(used);
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
                <strong>{inUse}</strong> in use
              </span>
            }
            title={`${name} memory: ${inUse} in use of ${memoryText(d.memoryTotalMiB)}${held ? `, ${memoryText(held)} reserved by jobs` : ""}`}
          >
            <span className="jobs-cell-foot">
              <span className="jobs-gpu-total">of {memoryText(d.memoryTotalMiB)}</span>
              {held > 0 && (
                <span
                  className="jobs-gpu-held"
                  title={d.reservations.map((r) => `${r.name}: ${memoryText(r.memoryMiB)} ${r.mode}`).join("\n")}
                >
                  {memoryText(held)} reserved
                </span>
              )}
              {busyPct != null && <span className="jobs-gpu-busy">{Math.round(busyPct)}% busy</span>}
              <GpuSettings device={d} busy={acting === d.uuid} save={(path, body) => save(d.uuid, path, body)} />
              <GpuPause
                resume={!!paused?.has(d.uuid) || (d.admission === "closed" && d.closedBy === "user" && d.closedReason === PAUSE_REASON)}
                busy={acting === d.uuid}
                act={(resume) => pauseGpu(d.uuid, resume)}
              />
            </span>
            {d.admission === "closed" && (
              <small role="status">
                Closed to new jobs{d.closedBy === "agent" ? " by an Agent" : ""}
                {d.closedReason ? ` (${d.closedReason})` : ""}. Jobs already on it keep it.
              </small>
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
  return (
    <button
      type="button"
      className="quiet-button jobs-gpu-pause"
      disabled={busy}
      onClick={() => void act(resume)}
      title={
        resume
          ? "Resume the jobs paused on this GPU and reopen it to new jobs if the pause closed it"
          : "Stop new jobs on this GPU and pause the managed jobs using it. Their memory and GPU memory stay reserved; GPU work already sent finishes first."
      }
    >
      {resume ? "Resume GPU work" : "Pause GPU work"}
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
      <summary>{device.admission === "closed" ? "Closed" : device.sharing ? "Shared" : "Exclusive"}</summary>
      {device.admission === "closed" ? (
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void save("admission", { open: true })}>
          Open to new jobs
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("admission", { open: false, ...(reason.trim() ? { reason: reason.trim() } : {}) });
          }}
        >
          <label>
            Reason (optional)
            <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="secondary-button" disabled={busy}>
            Close to new jobs
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
          Let managed jobs share it
        </label>
        <label>
          Keep free (MiB)
          <input type="number" min="0" max="65536" step="1" required value={headroom} onChange={(e) => setHeadroom(e.target.value)} />
        </label>
        <p className="job-footnote">
          By default one managed GPU job uses a device at a time. Shared, jobs that ask for shared mode start while
          their declared memory fits in the sampled free memory, less what managed jobs reserve and this amount.
          Nothing limits what a job really uses.
        </p>
        <button className="secondary-button" disabled={busy}>
          Save
        </button>
      </form>
    </details>
  );
}
