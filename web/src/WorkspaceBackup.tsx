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
  request: Record<string, string>;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: (Summary & {
    restoredTo?: string;
    nextSteps?: string[];
    notes?: string[];
    /** A removal (T-196): what it removed and the backup it read back whole first. */
    removed?: string;
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
/** The daily backup (T-196): a time of day in UTC, a folder each run writes a
 * new folder in, the next slot and the last run as its operation ended. */
type Schedule = {
  enabled: boolean;
  timeUtc: string;
  folder: string | null;
  nextRunAt: string | null;
  lastRun: {
    slot: string;
    missed: number;
    startedAt: string;
    to: string;
    operationId: string | null;
    state: "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "not_started";
    error: string | null;
    finishedAt: string | null;
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
                  {kinds[op.kind]} · {op.state}
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
              ? `Every day at ${schedule.timeUtc} UTC (${localTime(schedule.timeUtc)} on this device), into a new folder in ${schedule.folder}. Old backups are never deleted.`
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
  const label = `${kinds[op.kind]} ${op.state === "running" ? "running" : op.state}`;
  return (
    <div className="workspace-backup-operation" data-state={op.state} aria-label={label}>
      <p className="workspace-backup-operation-title" role="status">
        {op.state === "running"
          ? `${kinds[op.kind]}: ${steps[op.step] ?? op.step}…`
          : op.state === "succeeded"
            ? `${kinds[op.kind]} finished`
            : op.state === "stopped"
              ? `${kinds[op.kind]} stopped; nothing it was writing was kept`
              : op.state === "interrupted"
                ? `${kinds[op.kind]} interrupted when Core stopped; nothing it was writing was kept`
                : `${kinds[op.kind]} failed at “${steps[op.step] ?? op.step}”`}
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
