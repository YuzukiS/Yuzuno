import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, NetworkError } from "./api";
import { BackupRetention } from "./BackupRetention";
import "./workspace-backup.css";

/** T-192: Settings → Backup. Core backs up its own Workspace, checks a
 * backup and restores one into a new or empty folder, each as an operation
 * it runs and reports (core/src/workspace_backup/online.rs). This page never
 * replaces or switches the Workspace this Core uses and never starts a Core
 * on a restored copy; through the phone entry it only reads. */

type Excluded = { path: string; reason: string };
type Summary = {
  path: string;
  workspaceId: string;
  createdAt: string;
  agents: number;
  files: number;
  bytes: number;
  excluded: Excluded[];
  notCovered: string[];
};
type Operation = {
  id: string;
  requestId: string;
  kind: "backup" | "check" | "restore" | "remove";
  state: "running" | "succeeded" | "failed" | "stopped" | "interrupted";
  step: string;
  /** As started; an automatic removal (T-196) says `automatic`. */
  request: Record<string, string | number | boolean | undefined>;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: (Summary & {
    restoredTo?: string;
    nextSteps?: string[];
    notes?: string[];
    /** A removal (T-196): what it removed and the backup it read back whole first;
     * an automatic one (slice 6) lists what it removed. */
    removed?: string | Pass["removed"];
    freedEstimateBytes?: number | null;
    keptChecked?: string;
  }) | null;
};
type View = {
  canChange: boolean;
  workspaceId: string;
  canBackUp: boolean;
  refusals: { code: string; detail: string }[];
  unfinishedJobs: { id: string; name: string }[];
  estimateBytes: number;
  current: Operation | null;
  recent: Operation[];
  notCovered: string[];
  replaceRunningWorkspace: string;
  /** Absent from a Core before T-196. */
  schedule?: Schedule;
};
/** What one automatic removal pass did (core retention::prune). */
type Pass = {
  removed: { name: string; freedEstimateBytes?: number | null }[];
  skipped: { name: string; reason: string }[];
  left: number;
  removedEstimateBytes?: number;
  keptCheckedName?: string;
  sizeBasis: string;
};
/** Automatic removal after each daily backup that succeeds (T-196, slice 6),
 * as confirmed for the schedule's folder. */
type Retention = { keep: number; budgetBytes?: number; folder: string; confirmedAt: string };
/** What automatic removal did after one run, apart from its backup. */
type Cleanup = {
  state: "due" | "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "not_run";
  keep: number;
  budgetBytes?: number;
  folder: string;
  decidedAt: string;
  operationId: string | null;
  reason: string | null;
  error: string | null;
  result: Pass | null;
  finishedAt: string | null;
};
/** The daily backup (T-196): a time of day in UTC, a folder each run writes a
 * new folder in, the next slot and the last run as its operation ended. */
type Schedule = {
  enabled: boolean;
  timeUtc: string;
  folder: string | null;
  nextRunAt: string | null;
  /** Absent from a Core before slice 6. */
  retention?: Retention | null;
  retentionNote?: string | null;
  lastRun: {
    slot: string;
    missed: number;
    startedAt: string;
    to: string;
    operationId: string | null;
    state: "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "not_started";
    error: string | null;
    finishedAt: string | null;
    cleanup?: Cleanup | null;
  } | null;
};
type Precheck = {
  ok: true;
  workspaceId: string;
  createdAt: string;
  agents: number;
  files: number;
  bytes: number;
  target: "new" | "empty";
  sameIdentity: boolean;
  notes: string[];
};
/** A request sent and not yet answered: a retry sends it again as is. */
type Pending = { path: string; body: Record<string, string | number | undefined> & { requestId: string } };

const steps: Record<string, string> = {
  start: "Starting",
  database: "Copying the database",
  files: "Copying files",
  verify: "Reading the backup back",
  check: "Checking the restored Workspace",
  preview: "Checking the folder",
  recheck: "Checking the folder again",
  remove: "Removing the old backup",
};
const kinds = { backup: "Backup", check: "Check", restore: "Restore", remove: "Removal" } as const;
/** An automatic removal (T-196, slice 6) is said as one. */
const kindName = (op: Operation) => (op.request.automatic ? "Automatic removal" : kinds[op.kind]);

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function requestId() {
  return crypto.randomUUID();
}

export function WorkspaceBackup({ active }: { active: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [to, setTo] = useState("");
  const [checkPath, setCheckPath] = useState("");
  const [from, setFrom] = useState("");
  const [into, setInto] = useState("");
  const [precheck, setPrecheck] = useState<{ from: string; to: string; result: Precheck } | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lost, setLost] = useState(false);
  const [watched, setWatched] = useState<Operation | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<View>("/workspace/backup", { signal });
      setView(next);
      if (next.current) setWatched(next.current);
    } catch (e) {
      if (!signal?.aborted) setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [active, read]);

  // While an operation runs, its step is read once a second.
  useEffect(() => {
    if (!active || watched?.state !== "running") return;
    const id = watched.id;
    timer.current = window.setTimeout(async () => {
      try {
        const op = await api<Operation>(`/workspace/backup/operations/${id}`);
        setWatched(op);
        if (op.state !== "running") void read();
      } catch (e) {
        setError(errorText(e));
        setWatched((old) => (old ? { ...old } : old));
      }
    }, 1000);
    return () => window.clearTimeout(timer.current);
  }, [active, watched, read]);

  async function send(next: Pending) {
    setPending(next);
    setLost(false);
    setError("");
    try {
      const answer = await api<{ operation: Operation }>(next.path, {
        method: "POST",
        body: JSON.stringify(next.body),
      });
      setPending(null);
      setWatched(answer.operation);
      void read();
    } catch (e) {
      if (e instanceof NetworkError) {
        // The request may have arrived: Try again sends the same requestId.
        setLost(true);
      } else {
        setPending(null);
        setError(errorText(e));
      }
    }
  }

  async function runPrecheck() {
    setPrechecking(true);
    setError("");
    setPrecheck(null);
    try {
      const result = await api<Precheck>("/workspace/restore/precheck", {
        method: "POST",
        body: JSON.stringify({ from, to: into }),
      });
      setPrecheck({ from, to: into, result });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPrechecking(false);
    }
  }

  const running = watched?.state === "running";
  const busy = running || !!pending;
  const canChange = !!view?.canChange;
  const prechecked = !!precheck && precheck.from === from && precheck.to === into;
  const jobsRefusal = view?.refusals.find((r) => r.code === "unfinished_jobs");
  const otherRefusals = view?.refusals.filter((r) => r.code !== "unfinished_jobs" && r.code !== "busy") ?? [];

  return (
    <section id="settings-backup" className="settings-section workspace-backup" aria-label="Workspace backup">
      <header className="settings-section-heading">
        <div>
          <h3>Workspace backup</h3>
          <p>
            A backup is a folder on the computer that runs Core. It holds the database, image copies, Brief attachments,
            finished reviews and Job folders, with a manifest of every file and of what was left out.
          </p>
        </div>
      </header>

      {view && !canChange && (
        <p className="workspace-backup-note" role="note">
          Backups and restores start from the computer that runs Core. Here they can only be seen.
        </p>
      )}
      {view && (
        <details className="workspace-backup-coverage">
          <summary>Never in a backup</summary>
          <ul>
            {view.notCovered.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      )}

      {canChange && (
        <div className="settings-group" aria-label="Back up this Workspace">
          <div className="settings-row workspace-backup-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Back up this Workspace</span>
              <span className="settings-row-help">
                A new folder, as an absolute path on the computer that runs Core.
                {view ? ` About ${bytes(view.estimateBytes)}.` : ""}
              </span>
            </span>
            <input
              className="settings-input"
              aria-label="Backup folder"
              placeholder="/path/to/new-backup-folder"
              value={to}
              disabled={busy}
              onChange={(e) => setTo(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !view?.canBackUp || !to.trim()}
              onClick={() => void send({ path: "/workspace/backups", body: { requestId: requestId(), to: to.trim() } })}
            >
              Back up
            </button>
          </div>
          {jobsRefusal && (
            <div className="workspace-backup-refusal" role="status">
              <p>{jobsRefusal.detail}:</p>
              <ul>
                {view?.unfinishedJobs.map((job) => (
                  <li key={job.id}>
                    {job.name || "Job"} <code>{job.id}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {otherRefusals.map((r) => (
            <p key={r.code} className="workspace-backup-refusal" role="status">
              {r.detail}
            </p>
          ))}
        </div>
      )}

      {canChange && (
        <div className="settings-group" aria-label="Check a backup">
          <div className="settings-row workspace-backup-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Check a backup</span>
              <span className="settings-row-help">Reads every file and the database back against its manifest.</span>
            </span>
            <input
              className="settings-input"
              aria-label="Backup to check"
              placeholder="/path/to/backup-folder"
              value={checkPath}
              disabled={busy}
              onChange={(e) => setCheckPath(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !checkPath.trim()}
              onClick={() =>
                void send({ path: "/workspace/backups/check", body: { requestId: requestId(), path: checkPath.trim() } })
              }
            >
              Check
            </button>
          </div>
        </div>
      )}

      {canChange && (
        <div className="settings-group" aria-label="Restore into a new folder">
          <div className="settings-row workspace-backup-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Restore into a new folder</span>
              <span className="settings-row-help">
                A new or empty folder. The Workspace this Core uses is never replaced, and no Core is started on the
                restored copy.
              </span>
            </span>
          </div>
          <div className="settings-row workspace-backup-row">
            <input
              className="settings-input"
              aria-label="Backup to restore"
              placeholder="/path/to/backup-folder"
              value={from}
              disabled={busy}
              onChange={(e) => setFrom(e.target.value)}
            />
            <input
              className="settings-input"
              aria-label="Restore into"
              placeholder="/path/to/new-workspace-folder"
              value={into}
              disabled={busy}
              onChange={(e) => setInto(e.target.value)}
            />
            <button type="button" disabled={busy || prechecking || !from.trim() || !into.trim()} onClick={() => void runPrecheck()}>
              Check restore
            </button>
            <button
              type="button"
              disabled={busy || !prechecked}
              onClick={() =>
                void send({ path: "/workspace/restores", body: { requestId: requestId(), from, to: into } })
              }
            >
              Restore
            </button>
          </div>
          {prechecked && precheck && (
            <div className="workspace-backup-precheck" role="status">
              <p>
                Can be restored into this {precheck.result.target === "new" ? "new" : "empty"} folder:{" "}
                {precheck.result.agents} Agents, {precheck.result.files} files, {bytes(precheck.result.bytes)}, backed up{" "}
                {new Date(precheck.result.createdAt).toLocaleString()}.
              </p>
              {precheck.result.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {view?.schedule && (
        <DailyBackup
          schedule={view.schedule}
          canChange={canChange}
          onSaved={(schedule) => setView((old) => (old ? { ...old, schedule } : old))}
        />
      )}

      {lost && pending && (
        <div className="workspace-backup-refusal" role="alert">
          <p>No answer from Core. The request may have arrived; trying again sends the same request.</p>
          <button type="button" onClick={() => void send(pending)}>
            Try again
          </button>
        </div>
      )}
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}

      {/* Keyed by operation: the next one starts with its own Stop. */}
      {watched && <OperationView key={watched.id} op={watched} canStop={canChange && running} />}

      {canChange && (
        <BackupRetention
          defaultFolder={view?.schedule?.folder ?? null}
          busy={busy}
          onCheck={(path) => void send({ path: "/workspace/backups/check", body: { requestId: requestId(), path } })}
          onRemove={(target) =>
            void send({ path: "/workspace/backup/retention/remove", body: { requestId: requestId(), ...target } })
          }
        />
      )}

      {view && view.recent.filter((op) => op.id !== watched?.id).length > 0 && (
        <div className="workspace-backup-recent">
          <h4>Recent</h4>
          <ul>
            {view.recent
              .filter((op) => op.id !== watched?.id)
              .map((op) => (
                <li key={op.id} data-state={op.state}>
                  {kindName(op)} · {op.state}
                  {op.finishedAt ? ` · ${new Date(op.finishedAt).toLocaleString()}` : ""}
                  {op.request.to || op.request.path ? ` · ${op.request.to || op.request.path}` : ""}
                  {op.kind === "remove" && op.request.name ? ` · ${op.request.name}` : ""}
                </li>
              ))}
          </ul>
        </div>
      )}
      {view && <p className="settings-row-help workspace-backup-limit">{view.replaceRunningWorkspace}.</p>}
    </section>
  );
}

/** "03:00" UTC as this device's clock shows it today. */
function localTime(timeUtc: string) {
  const [hours, minutes] = timeUtc.split(":").map(Number);
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes))
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function lastRunText(run: NonNullable<Schedule["lastRun"]>) {
  const made = run.missed > 0 ? ` It made up for ${run.missed} missed ${run.missed === 1 ? "day" : "days"}.` : "";
  switch (run.state) {
    case "running":
      return `The run for ${utc(run.slot)} is backing up to ${run.to}.${made}`;
    case "succeeded":
      return `Last run, for ${utc(run.slot)}: backed up to ${run.to} and checked.${made}`;
    case "not_started":
      return `Last run, for ${utc(run.slot)}, did not start: ${run.error ?? "no reason was given"}.${made}`;
    default:
      return `Last run, for ${utc(run.slot)}, ${run.state === "failed" ? "failed" : run.state}: ${run.error ?? "no reason was given"}.${made}`;
  }
}

/** What an automatic removal pass removed, by the sizes manifests declared. */
function passText(pass: Pass) {
  const n = pass.removed.length;
  const removed = n
    ? `Removed ${n} old ${n === 1 ? "backup" : "backups"}: ${pass.removed.map((r) => r.name).join(", ")}${
        pass.removedEstimateBytes ? `, about ${bytes(pass.removedEstimateBytes)} as their manifests declared (disk use can differ)` : ""
      }.${pass.keptCheckedName ? ` First, ${pass.keptCheckedName} was read back whole.` : ""}`
    : "Nothing needed removing.";
  const skipped = pass.skipped.length ? ` Not removed: ${pass.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.` : "";
  const left = pass.left > 0 ? ` ${pass.left} more wait for the next run that succeeds.` : "";
  return removed + skipped + left;
}

/** What automatic removal did after the last run: said apart from its backup. */
function cleanupText(cleanup: Cleanup) {
  switch (cleanup.state) {
    case "due":
      return "Removing old backups after this run waits for another backup, check or restore to end.";
    case "running":
      return "Removing old backups after this run…";
    case "succeeded":
      return `After this run: ${cleanup.result ? passText(cleanup.result) : "done."}`;
    case "not_run":
      return `Old backups were not removed after this run: ${cleanup.reason ?? "no reason was given"}.`;
    default:
      return `Removing old backups after this run ${cleanup.state === "interrupted" ? "was interrupted" : cleanup.state}: ${
        cleanup.error ?? "no reason was given"
      }. The backup itself is as said above; this is not tried again on its own.`;
  }
}

/** The daily backup in Settings (T-196): off until turned on here. Its time
 * is UTC, shown with this device's equivalent. A run starting is not shown
 * as a success; its outcome is, once the backup ends. Nothing is deleted. */
function DailyBackup({ schedule, canChange, onSaved }: {
  schedule: Schedule;
  canChange: boolean;
  onSaved: (schedule: Schedule) => void;
}) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [time, setTime] = useState(schedule.timeUtc || "03:00");
  const [folder, setFolder] = useState(schedule.folder ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changed = enabled !== schedule.enabled || time !== (schedule.timeUtc || "03:00") || folder !== (schedule.folder ?? "");
  async function save() {
    setSaving(true);
    setError("");
    try {
      const answer = await api<{ schedule: Schedule }>("/workspace/backup/schedule", {
        method: "POST",
        body: JSON.stringify({ enabled, timeUtc: time, folder: folder.trim() || null }),
      });
      onSaved(answer.schedule);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const run = schedule.lastRun;
  return (
    <div className="settings-group workspace-backup-daily" aria-label="Daily backup">
      <div className="settings-row workspace-backup-row">
        <span className="settings-row-main">
          <span className="settings-row-title">Daily backup</span>
          <span className="settings-row-help">
            {schedule.enabled
              ? `Every day at ${schedule.timeUtc} UTC (${localTime(schedule.timeUtc)} on this device), into a new folder in ${schedule.folder}. ${
                  schedule.retention ? "Old backups there are removed as Automatic removal below says." : "Old backups are never deleted."
                }`
              : "Off. When on, Core backs up once a day while it runs, as Back up does; a day it was stopped or asleep is made up once."}
          </span>
        </span>
      </div>
      {canChange && (
        <div className="settings-row workspace-backup-row">
          <label className="workspace-backup-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Back up every day
          </label>
          <input
            className="settings-input workspace-backup-time"
            type="time"
            aria-label="Time of day (UTC)"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <input
            className="settings-input"
            aria-label="Folder for daily backups"
            placeholder="/path/to/backups-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
          <button type="button" disabled={saving || !changed} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
      {canChange && /^\d\d:\d\d$/.test(time) && (
        <p className="settings-row-help workspace-backup-note">
          {time} UTC is {localTime(time)} on this device today.
        </p>
      )}
      {schedule.enabled && schedule.nextRunAt && (
        <p className="workspace-backup-note" role="status">
          Next run: {utc(schedule.nextRunAt)}.
        </p>
      )}
      {run && (
        <p className={run.state === "succeeded" || run.state === "running" ? "workspace-backup-note" : "workspace-backup-error"}>
          {lastRunText(run)}
        </p>
      )}
      {run?.cleanup && (
        <p
          className={["failed", "stopped", "interrupted"].includes(run.cleanup.state) ? "workspace-backup-error" : "workspace-backup-note"}
          data-cleanup={run.cleanup.state}
        >
          {cleanupText(run.cleanup)}
        </p>
      )}
      {schedule.retention !== undefined && <AutoRemoval schedule={schedule} canChange={canChange} onSaved={onSaved} />}
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The preview Core gives for the schedule's folder (retention.rs), as much of it as this needs. */
type RemovalPreview = {
  folder: string;
  keep: number;
  entries: { name: string; verdict: "keep" | "remove" | "protected" | "unknown" | "ignored"; reason: string }[];
  unreadableNames: number;
  removableEstimateBytes: number;
  removableUnknownSizes: number;
  sizeBasis: string;
  budget?: { bytes: number; state: "met" | "over" | "unknown"; reason: string };
};
const GIB = 1024 ** 3;

/** Automatic removal of old daily backups (T-196, slice 6): off until turned
 * on here, for the schedule's folder, after a preview of what it would
 * remove now. Turning it on removes nothing; after each daily backup that
 * succeeds Core removes what such a preview offers then, as Remove… does. */
function AutoRemoval({ schedule, canChange, onSaved }: {
  schedule: Schedule;
  canChange: boolean;
  onSaved: (schedule: Schedule) => void;
}) {
  const on = schedule.retention ?? null;
  const [keep, setKeep] = useState(String(on?.keep ?? 7));
  const [budget, setBudget] = useState(on?.budgetBytes ? String(Math.round((on.budgetBytes / GIB) * 100) / 100) : "");
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = Number(keep);
  const gib = Number(budget);
  const budgetBytes = budget.trim() === "" ? undefined : Math.max(1, Math.round(gib * GIB));
  const valid =
    Number.isInteger(count) && count >= 1 && count <= 100 && (budget.trim() === "" || (Number.isFinite(gib) && gib > 0 && gib <= 1024 * 1024));
  const folder = schedule.folder;
  // Confirmed only as previewed: these settings, for the schedule's folder as it is now.
  const previewed =
    !!preview && !!folder && preview.folder === folder && preview.keep === count && (preview.budget?.bytes ?? undefined) === budgetBytes;
  const same = !!on && on.keep === count && (on.budgetBytes ?? undefined) === budgetBytes && on.folder === folder;

  async function call<T>(path: string, body: object) {
    setBusy(true);
    setError("");
    try {
      return await api<T>(path, { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function runPreview() {
    setPreview(null);
    const answer = await call<RemovalPreview>("/workspace/backup/retention/preview", {
      folder,
      keep: count,
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    });
    if (answer) setPreview(answer);
  }
  async function turnOn() {
    if (!preview) return;
    const answer = await call<{ schedule: Schedule }>("/workspace/backup/schedule/retention", {
      enabled: true,
      keep: preview.keep,
      ...(preview.budget ? { budgetBytes: preview.budget.bytes } : {}),
      folder: preview.folder,
    });
    if (answer) {
      setPreview(null);
      onSaved(answer.schedule);
    }
  }
  async function turnOff() {
    const answer = await call<{ schedule: Schedule }>("/workspace/backup/schedule/retention", { enabled: false });
    if (answer) {
      setPreview(null);
      onSaved(answer.schedule);
    }
  }

  const removable = preview?.entries.filter((e) => e.verdict === "remove") ?? [];
  const kept = preview?.entries.filter((e) => e.verdict === "keep").length ?? 0;
  const held = preview?.entries.filter((e) => e.verdict === "protected" || e.verdict === "unknown").length ?? 0;
  return (
    <div className="settings-group workspace-backup-auto-removal" aria-label="Automatic removal">
      <div className="settings-row workspace-backup-row">
        <span className="settings-row-main">
          <span className="settings-row-title">Automatic removal</span>
          <span className="settings-row-help" data-auto-removal={on ? "on" : "off"}>
            {on
              ? `On since ${utc(on.confirmedAt)}: after each daily backup that succeeds, Core keeps the latest ${on.keep}${
                  on.budgetBytes ? ` within ${bytes(on.budgetBytes)} (by the sizes their manifests declare)` : ""
                } in ${on.folder} and removes older backups of this Workspace there, at most 20 at a time.`
              : "Off: old daily backups are never removed on their own."}{" "}
            A protected backup or one that can't be judged is never removed, and each removal first reads a kept backup
            back whole, as Remove… does. A failed, stopped or interrupted backup removes nothing; nothing is retried on its
            own.
          </span>
        </span>
      </div>
      {schedule.retentionNote && (
        <p className="workspace-backup-error" role="status">
          {schedule.retentionNote}.
        </p>
      )}
      {canChange && !folder && <p className="settings-row-help">Save a folder for the daily backup first.</p>}
      {canChange && folder && (
        <div className="settings-row workspace-backup-row">
          <input
            className="settings-input backup-retention-keep"
            type="number"
            min={1}
            max={100}
            aria-label="Daily backups to keep"
            value={keep}
            onChange={(e) => {
              setKeep(e.target.value);
              setPreview(null);
            }}
          />
          <input
            className="settings-input backup-retention-keep"
            type="number"
            min={0}
            step="any"
            aria-label="Space budget for daily backups in GiB (optional)"
            placeholder="No budget"
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              setPreview(null);
            }}
          />
          <button type="button" disabled={!valid || busy} onClick={() => void runPreview()}>
            Preview
          </button>
          {on && (
            <button type="button" disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </button>
          )}
        </div>
      )}
      {preview && (
        <div className="backup-retention-result" role="region" aria-label="Automatic removal preview">
          <p role="status">
            In {preview.folder} now, keeping the latest {preview.keep}
            {preview.budget && ` within ${bytes(preview.budget.bytes)}`} would keep {kept} and remove {removable.length}
            {removable.length > 0 && ` (about ${bytes(preview.removableEstimateBytes)} as their manifests declare)`}; {held}{" "}
            protected or can't be judged.
            {preview.unreadableNames > 0 && " Some names can't be read, so nothing in this folder would be removed."}
          </p>
          {preview.budget && (
            <p className={preview.budget.state === "met" ? "workspace-backup-note" : "workspace-backup-error"}>{preview.budget.reason}.</p>
          )}
          {removable.length > 0 && (
            <ul aria-label="Would be removed now">
              {removable.map((e) => (
                <li key={e.name}>
                  <code>{e.name}</code> · {e.reason}
                </li>
              ))}
            </ul>
          )}
          <p className="settings-row-help">
            Turning it on removes nothing now. After each daily backup that succeeds, Core previews this folder again
            and removes what that preview offers then. {preview.sizeBasis}
          </p>
          {previewed && !same && (
            <button type="button" disabled={busy} onClick={() => void turnOn()}>
              {on ? "Save these settings" : "Turn on automatic removal"}
            </button>
          )}
          {previewed && same && <p className="settings-row-help">These are the settings on now.</p>}
        </div>
      )}
      {error && (
        <p className="workspace-backup-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function OperationView({ op, canStop }: { op: Operation; canStop: boolean }) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const [said, setSaid] = useState(0);
  const stopLine = useRef<HTMLParagraphElement>(null);
  // On a phone's screen the line saying why Stop did not happen can be below
  // the button that was pressed: it is brought into view each time.
  useEffect(() => {
    if (said) stopLine.current?.scrollIntoView?.({ block: "nearest" });
  }, [said]);
  const label = `${kindName(op)} ${op.state === "running" ? "running" : op.state}`;
  return (
    <div className="workspace-backup-operation" data-state={op.state} aria-label={label}>
      <p className="workspace-backup-operation-title" role="status">
        {op.state === "running"
          ? `${kindName(op)}: ${steps[op.step] ?? op.step}…`
          : op.state === "succeeded"
            ? `${kindName(op)} finished`
            : op.state === "stopped"
              ? `${kindName(op)} stopped; nothing it was writing was kept`
              : op.state === "interrupted"
                ? `${kindName(op)} interrupted when Core stopped; nothing it was writing was kept`
                : `${kindName(op)} failed at “${steps[op.step] ?? op.step}”`}
      </p>
      {canStop && (
        <button
          type="button"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            setStopError("");
            try {
              await api(`/workspace/backup/operations/${op.id}/stop`, { method: "POST", body: "{}" });
            } catch (e) {
              setStopping(false);
              // Stopping a running operation twice is harmless, so Stop asks again as is.
              setStopError(
                e instanceof NetworkError
                  ? "No answer from Core to Stop. It may have arrived; Stop asks again."
                  : errorText(e),
              );
              setSaid((n) => n + 1);
            }
          }}
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      )}
      {stopError && (
        <p className="workspace-backup-error" role="alert" ref={stopLine}>
          {stopError}
        </p>
      )}
      {op.error && op.state !== "running" && <p className="workspace-backup-error">{op.error}</p>}
      {op.state === "succeeded" && op.result && <Result op={op} />}
    </div>
  );
}

function Result({ op }: { op: Operation }) {
  const result = op.result!;
  if (op.kind === "remove" && Array.isArray(result.removed)) {
    return (
      <div className="workspace-backup-result">
        <p>{passText(result as unknown as Pass)}</p>
      </div>
    );
  }
  if (op.kind === "remove") {
    return (
      <div className="workspace-backup-result">
        <p>
          Removed <code>{result.removed}</code>
          {result.freedEstimateBytes ? `, about ${bytes(result.freedEstimateBytes)} as its manifest declared` : ""}. First,{" "}
          <code>{result.keptChecked}</code> was read back whole. A removed backup can't be brought back.
        </p>
      </div>
    );
  }
  if (op.kind === "restore") {
    return (
      <div className="workspace-backup-result">
        <p>
          Restored into <code>{result.restoredTo}</code>: {result.agents} Agents, {result.files} files.
        </p>
        {result.nextSteps && (
          <ol aria-label="To use the restored Workspace">
            {result.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        {result.notes?.map((note) => (
          <p key={note} className="settings-row-help">
            {note}
          </p>
        ))}
      </div>
    );
  }
  return (
    <div className="workspace-backup-result">
      <p>
        {op.kind === "backup" ? "Backed up to" : "Checked"} <code>{result.path}</code>: {result.agents} Agents,{" "}
        {result.files} files, {bytes(result.bytes)}.
      </p>
      <details>
        <summary>Left out ({result.excluded.length})</summary>
        <ul>
          {result.excluded.map((item) => (
            <li key={item.path}>
              <code>{item.path}</code>: {item.reason}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
