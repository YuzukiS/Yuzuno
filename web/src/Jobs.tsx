import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  BriefcaseBusiness,
  Github,
  GitPullRequest,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  StepForward,
  X,
} from "lucide-react";
import { api, API_BASE, errorText, HttpError, post } from "./api";
import {
  BudgetSettings,
  DiskSpace,
  GpuDevices,
  UsageMeter,
  useMachineLoad,
  WindowsJobs,
  type BudgetBounds,
  type BudgetHost,
  type DiskView,
  type GpuView,
  type WindowsJobsView,
} from "./JobBudget";
import { ArtifactsCard, ReportedLines, RunCard, PendingAnalysisRuns, type Artifact, type Cost, type Progress } from "./JobRun";
import { openTaskReview, ReviewJobs, type ReviewOpen } from "./ReviewJobs";
import { ProvenanceCard } from "./Provenance";
import type { Agent } from "./types";
import { SendToAgentButton, startHandoffDrag } from "./SendToAgent";
import type { HandoffSource } from "./handoff";
import "./jobs.css";
import {
  CiJobs,
  ConversationCi,
  runActive,
  useConversationCi,
  type CiOpen,
  type Run,
} from "./CiJobs";
import { WorkDock, WorkDockGroup, WorkDockItem, WorkDockMore } from "./WorkDock";
import { useAppearance } from "./appearance";
import {
  JobCard,
  JobDetailHeading,
  JobRow,
  JobsSourceHeading,
  moments,
  StateGroups,
  type Placement,
} from "./JobParts";

type Resources = { cpuMillis: number; memoryMiB: number; swapMiB: number };
type Job = {
  id: string;
  name: string;
  status: string;
  reason: string | null;
  agentId: string;
  agent: { name: string };
  taskRef: string;
  cwd: string;
  argv?: string[];
  env?: Record<string, string>;
  inputs?: string[];
  outputs?: string[];
  usage?: Record<string, string> | null;
  guardGit?: boolean;
  timeoutSeconds?: number;
  snapshot?: { scope: string };
  machine: { id?: string; name: string };
  /** Where it runs when not on this host: an SSH machine or Windows (T-108). */
  executor?: { kind: string; machineId?: string; machineName?: string } | null;
  /** Where it runs as the submission named it (`agent`, `local`, an id or
   * null) and as Core resolved it then (T-162). Older Jobs have none. */
  target?: { requested?: string | null; kind: string; machineId: string; machineName?: string } | null;
  resources: Resources;
  exclusive?: boolean;
  reservation: Resources;
  /** Local GPUs requested and, once admitted, reserved (T-106). */
  gpu?: GpuRequest | null;
  gpuReservation?: { uuid: string; index: number | null; name: string; memoryMiB: number; mode: string }[] | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  reserved: boolean;
  cursor: number;
  requestId: string;
  result?: {
    evidence?: { systemd?: Record<string, string> };
    reason?: string;
    artifacts?: Artifact[] | null;
    /** The machine a remote job's artifacts were checked on, and stay on. */
    artifactsOn?: { name: string } | null;
    /** A remote attempt's start: the scope holding its limits there, if any. */
    started?: { limits?: { held?: { unit?: string } | null } | null } | null;
    cost?: Cost | null;
    progress?: Progress | null;
    /** What the wrapper checked after a stop at a checkpoint (T-109). */
    checkpoint?: { ok: boolean; reason?: string | null; files?: { path: string; bytes: number }[] } | null;
  };
  /** One attempt of a run's stage (T-105). */
  run?: { id: string; stage: string; attempt: number } | null;
  artifacts?: { path: string }[];
  /** What a live attempt has reported so far. */
  reports?: { cost?: Cost | null; progress?: Progress | null } | null;
  /** The user's pause and what the host confirmed (T-107). */
  pause?: JobPause | null;
  /** How its command stops at a checkpoint, if it declared one (T-109). */
  checkpoint?: { signal?: string; graceSeconds: number; stoppedExitCode: number } | null;
  /** The user's stop at a checkpoint and how it ended. */
  checkpointStop?: CheckpointStop | null;
  /** The job this one resumes from its checkpoint. */
  resumeOf?: string | null;
  checkpointFrom?: { jobId: string } | null;
};
type CheckpointStop = {
  state: "requested" | "signalled" | "pending" | "failed" | "expired" | "checkpointed" | "notResumable";
  reason?: string | null;
  deadline?: string | null;
  graceSeconds?: number;
  resumedAs?: string | null;
};
type JobPause = {
  intent?: "pause" | "resume";
  state: "requested" | "paused" | "resuming" | "failed" | "unknown";
  requestedAt?: string | null;
  confirmedAt?: string | null;
  reason?: string | null;
};
type Page = {
  jobs: Job[];
  liveJobs?: Job[];
  hasMore: boolean;
  nextBefore: number | null;
};
const uniqueJobs = (jobs: Job[]) => [
  ...new Map(jobs.map((j) => [j.id, j])).values(),
];
type Budget = {
  machine: BudgetHost & { name: string; memoryAvailableMiB: number | null; scope: string; suggestedBudget?: Resources };
  collectorOverhead?: Resources;
  budget: Resources;
  /** Absent from Cores before T-160. */
  budgetBounds?: BudgetBounds;
  reserved: Resources;
  queuedCount: number;
  activeCount: number;
  /** Absent from Cores before T-95. */
  disk?: DiskView;
  /** Absent from Cores before T-106. */
  gpus?: GpuView;
  /** Absent from Cores before T-108's Windows ceiling. */
  windows?: WindowsJobsView;
};
type GpuRequest = { count?: number; devices?: string[]; memoryMiB: number; mode?: "exclusive" | "shared" };
const validBudget = (value: Budget) =>
  !!value?.machine &&
  !!value?.budget &&
  !!value?.reserved &&
  Number.isFinite(value.activeCount) &&
  Number.isFinite(value.queuedCount);
type Log = {
  text: string;
  offset: number;
  nextOffset: number;
  oldestOffset: number;
  totalBytes: number;
  truncated: boolean;
};
/** Still to finish: holding capacity, queued, or a stage waiting for its upstream. */
const active = (job: Job) =>
  job.reserved || job.status === "queued" || job.status === "waiting";
const memory = (miB: number) =>
  miB >= 1024
    ? `${(miB / 1024).toFixed(1)} GiB`
    : `${Number(miB.toFixed(1))} MiB`;
const ramReading = (raw?: string) => {
  const bytes = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  // systemd uses UINT64_MAX for an unavailable measurement.
  return Number.isSafeInteger(bytes) && bytes >= 0
    ? memory(bytes / 1048576)
    : "Not available";
};
const statusName: Record<string, string> = {
  waiting: "Waiting for upstream",
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  cancelling: "Cancelling",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  rejected: "Inputs rejected",
  interrupted: "Interrupted",
  unknown: "Outcome unknown",
};
/** What the Machine row adds to the machine's name: that it is the Core host,
 * and that Core chose it as the machine the submitting Agent runs on. */
export const targetNote = (job: Pick<Job, "target" | "executor">) => {
  const here = job.target ? job.target.kind === "local" : !job.executor || job.executor.kind === "local";
  if (job.target?.requested === "agent") {
    return here ? "Core host, where the submitting Agent runs" : "the machine the submitting Agent runs on";
  }
  return here ? "Core host" : "";
};
/** Why this job cannot be paused, or null; Core's rule (remote.rs
 * pause_refusal): on another machine only an attempt that runs in a scope of
 * its own there, and never on Windows. */
const pauseRefusal = (job: Job) =>
  !job.executor || job.executor.kind === "local"
    ? null
    : job.executor.kind === "ssh"
      ? job.result?.started?.limits?.held?.unit
        ? null
        : `Not available: this job runs without a scope of its own on ${job.machine.name} (no limits are held for it there), and pause freezes only an attempt's own scope`
      : `Not available for jobs on ${job.machine.name}`;
/** A running job's pause: it keeps status running and every reservation. */
const pauseOf = (job: Job) =>
  (job.status === "running" || job.status === "cancelling") && job.pause?.state
    ? job.pause
    : null;
const pauseName: Record<JobPause["state"], string> = {
  requested: "Pausing",
  paused: "Paused",
  resuming: "Resuming",
  failed: "Pause failed",
  unknown: "Pause unknown",
};
/** Core's reason as a sentence, so more can follow it. */
const sentence = (text?: string | null) => (text && !/[.!?]$/.test(text) ? `${text}.` : text || "");
/** A running job the user asked to stop at a checkpoint. */
const stoppingAtCheckpoint = (job: Job) =>
  job.status === "running" && ["requested", "signalled", "pending", "failed"].includes(job.checkpointStop?.state ?? "");
/** A finished job its wrapper verified a checkpoint for. */
const checkpointed = (job: Job) =>
  !job.reserved && job.checkpointStop?.state === "checkpointed" && job.result?.checkpoint?.ok === true;
/** Its status in words, and the mark drawn for it. */
function stateOf(job: Job) {
  if (stoppingAtCheckpoint(job)) return { name: "Stopping at checkpoint", mark: job.status };
  if (checkpointed(job)) return { name: "Stopped at checkpoint", mark: job.status };
  const pause = job.status === "running" ? pauseOf(job) : null;
  if (!pause) return { name: statusName[job.status] || job.status, mark: job.status };
  const name =
    pause.state === "failed" && pause.intent === "resume" ? "Resume failed" : pauseName[pause.state];
  return { name, mark: pause.state === "paused" ? "paused" : job.status };
}
/** When the timeout stops it: wall-clock time from its start, pauses included. */
const deadline = (job: Job) =>
  job.startedAt && job.timeoutSeconds
    ? new Date(Date.parse(job.startedAt) + job.timeoutSeconds * 1000)
    : null;
function elapsed(job: Job, now = Date.now()) {
  if (!job.startedAt) return "Not started";
  const seconds = Math.max(
    0,
    Math.floor(
      ((job.finishedAt ? Date.parse(job.finishedAt) : now) -
        Date.parse(job.startedAt)) /
        1000,
    ),
  );
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
/** Still running, so its time so far grows. An unknown outcome does not. */
const live = (job: Job) =>
  !!job.startedAt &&
  !job.finishedAt &&
  (job.status === "starting" ||
    job.status === "running" ||
    job.status === "cancelling");
/** How long it ran, or has run so far; nothing before it starts. */
const ranFor = (job: Job, now: number) =>
  job.finishedAt || live(job) ? elapsed(job, now) : null;
/** The time now, again every second while something runs. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
/** Still going (holding capacity, queued or waiting for upstream), or ended
 * however it ended. */
const placeJob = (job: Job): Placement => (active(job) ? "active" : "done");
/** When it was queued and, once it has, when it finished. */
const queuedAndFinished = (job: Job) =>
  moments([
    ["Queued", job.createdAt],
    ["Finished", job.finishedAt],
  ]);
/** Its latest moment, for the dock: finished, else started, else queued. */
const latestMoment = (job: Job) =>
  job.finishedAt
    ? moments([["Finished", job.finishedAt]])
    : job.startedAt
      ? moments([["Started", job.startedAt]])
      : moments([["Queued", job.createdAt]]);
const when = (job: Job) =>
  [
    job.startedAt && `Started ${new Date(job.startedAt).toLocaleString()}`,
    job.finishedAt && `Finished ${new Date(job.finishedAt).toLocaleString()}`,
  ]
    .filter(Boolean)
    .join(" · ") || undefined;
type JobScope = { agentId?: string; taskId?: string };
type JobSource = "local" | "github_actions" | "reviews";
type JobOpen = JobScope &
  Omit<CiOpen, "source"> &
  ReviewOpen & { source?: JobSource; jobId?: string };
export const openJobs = (detail: JobOpen = {}) =>
  window.dispatchEvent(new CustomEvent("yuzuno:open-job", { detail }));

// The last jobs read for each Agent, shown again when its conversation comes
// back, so the dock keeps its room until the next answer (see lastCi).
const lastJobs = new Map<string, Job[]>();
export function ConversationJobs({
  agentId,
  revision,
  disabled,
  children,
}: {
  agentId: string;
  revision: string;
  disabled: boolean;
  /** More groups for the dock, after jobs and runs (the sub-agents). */
  children?: ReactNode;
}) {
  const [jobs, setJobs] = useState<Job[]>(() => lastJobs.get(agentId) ?? []);
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    void api<Page>(`/jobs?agentId=${encodeURIComponent(agentId)}`, {
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted || !Array.isArray(page.jobs)) return;
        const next = uniqueJobs([...(page.liveJobs || []), ...page.jobs]);
        lastJobs.set(agentId, next);
        setJobs(next);
      })
      .catch(() => {
        /* Old/offline Core has no job cards; the panel shows errors on demand. */
      });
    return () => controller.abort();
  }, [agentId, revision, disabled]);
  const ci = useConversationCi(agentId, revision, disabled);
  // As many marks of each kind as Settings allows (Appearance, Conversation
  // dock): what is running or waiting first, then whatever finished last.
  const { dock } = useAppearance();
  const time = (value?: string | null) => Date.parse(value || "") || 0;
  const first = <T,>(items: T[], waiting: (item: T) => boolean, at: (item: T) => number, limit: number) =>
    items
      .map((item) => ({ item, waiting: waiting(item), at: at(item) }))
      .sort((a, b) => +b.waiting - +a.waiting || (a.waiting ? 0 : b.at - a.at))
      .slice(0, limit)
      .map(({ item }) => item);
  const shown = first(jobs, active, (job) => time(job.finishedAt), dock.jobs);
  // A running job's time so far, as a finished one shows how long it took.
  const now = useNow(shown.some(live));
  const runs = first(ci.runs, runActive, (run) => time(run.updatedAt), dock.actions);
  // Jobs, then CI, as marks on the conversation's left edge (WorkDock.tsx).
  // A kind set to 0 has no group here at all.
  return (
    <WorkDock label="Jobs and CI in this conversation">
      {jobs.length > 0 && dock.jobs > 0 && (
        <WorkDockGroup
          label="Local jobs"
          icon={<BriefcaseBusiness size={14} />}
          onOpen={() => openJobs({ agentId })}
        >
          {shown.map((job) => (
            <WorkDockItem
              key={job.id}
              className="conversation-job"
              status={stateOf(job).mark}
              state={stateOf(job).name}
              name={job.name}
              sub={[stateOf(job).name, ranFor(job, now)]
                .filter(Boolean)
                .join(" · ")}
              detail={`${job.taskRef} · ${job.exclusive ? "Exclusive" : "Normal"} · ${job.resources.cpuMillis / 1000} CPU · ${memory(job.resources.memoryMiB)}`}
              when={latestMoment(job)}
              onOpen={() => openJobs({ jobId: job.id, agentId })}
            />
          ))}
          {jobs.length > shown.length && (
            <WorkDockMore
              label="Local jobs"
              count={jobs.length - shown.length}
              onOpen={() => openJobs({ agentId })}
            />
          )}
        </WorkDockGroup>
      )}
      {dock.actions > 0 && (
        <ConversationCi
          agentId={agentId}
          page={ci}
          runs={runs}
          more={ci.runs.length - runs.length}
        />
      )}
      {children}
    </WorkDock>
  );
}

export function Jobs({
  workspaceId,
  agent,
  agents,
  revision,
  disabled,
}: {
  workspaceId: string;
  agent?: Agent | null;
  agents?: Agent[];
  revision: string;
  disabled: boolean;
}) {
  const owners = (agents || (agent ? [agent] : [])).filter(
    (a) => !a.closedAt && !a.remote,
  );
  const pendingKey = `yuzuno.job-submission.v1:${JSON.stringify([workspaceId])}`;
  const [saved] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(pendingKey) || "null");
      return value &&
        typeof value.key === "string" &&
        typeof value.requestId === "string" &&
        value.draft
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<JobScope>({});
  const [source, setSource] = useState<JobSource>("local");
  const [ciInitial, setCiInitial] = useState<CiOpen>({});
  const [reviewInitial, setReviewInitial] = useState<ReviewOpen>({});
  const [page, setPage] = useState<Page>({
    jobs: [],
    hasMore: false,
    nextBefore: null,
  });
  const [budget, setBudget] = useState<Budget | null>(null);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Job | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(!!saved);
  const [draft, setDraft] = useState<Draft>(
    saved?.draft || {
      agentId: agent?.id || owners[0]?.id || "",
      name: "",
      taskId: "",
      command: "",
      cwd: agent?.cwd || owners[0]?.cwd || "",
      cpu: "1",
      memory: "512",
      swap: "0",
      timeout: "86400",
      env: "{}",
      inputs: "",
      outputs: "",
      guardGit: true,
      exclusive: false,
    },
  );
  const pending = useRef<{ key: string; requestId: string } | null>(saved);
  const generation = useRef(0);
  const load = useCallback(
    async (before?: number) => {
      const stamp = generation.current;
      try {
        const query = new URLSearchParams(scope);
        if (before) query.set("before", String(before));
        const [next, capacity] = await Promise.all([
          api<Page>(`/jobs?${query}`),
          api<Budget>("/jobs/budget"),
        ]);
        if (stamp !== generation.current) return;
        if (!Array.isArray(next.jobs))
          throw new Error("Local jobs require an updated Core.");
        setPage((old) => {
          const retained = old.jobs.filter((j) => !active(j));
          const jobs = uniqueJobs([
            ...retained,
            ...next.jobs,
            ...(next.liveJobs || []),
          ]);
          jobs.sort(
            (a, b) =>
              Number(active(b)) - Number(active(a)) || b.cursor - a.cursor,
          );
          return {
            ...next,
            jobs,
            hasMore: before || !old.jobs.length ? next.hasMore : old.hasMore,
            nextBefore:
              before || !old.jobs.length ? next.nextBefore : old.nextBefore,
          };
        });
        if (!validBudget(capacity))
          throw new Error("Local jobs require an updated Core.");
        setBudget(capacity);
        if (selected) {
          const [job, output] = await Promise.all([
            api<Job>(`/jobs/${selected}`),
            api<Log>(`/jobs/${selected}/logs`),
          ]);
          if (stamp === generation.current) {
            setDetail(job);
            setLog(output);
          }
        }
      } catch (e) {
        if (stamp === generation.current) setError(errorText(e));
      }
    },
    [scope, selected],
  );
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<JobOpen>).detail;
      setScope(
        detail.taskId
          ? { taskId: detail.taskId }
          : detail.agentId
            ? { agentId: detail.agentId }
            : {},
      );
      setSource(detail.source || "local");
      setCiInitial(
        detail.source === "github_actions"
          ? { ...detail, source: "github_actions" }
          : {},
      );
      setReviewInitial(
        detail.source === "reviews"
          ? { reviewId: detail.reviewId, taskId: detail.taskId }
          : {},
      );
      setSelected(detail.jobId || "");
      setCreating(false);
      setOpen(true);
    };
    window.addEventListener("yuzuno:open-job", listener);
    // Send to Agent added a Job to a draft and opened that Agent (T-152).
    const sent = () => setOpen(false);
    window.addEventListener("yuzuno:handoff-sent", sent);
    return () => {
      window.removeEventListener("yuzuno:open-job", listener);
      window.removeEventListener("yuzuno:handoff-sent", sent);
    };
  }, []);
  useEffect(() => {
    generation.current++;
    if (!open || disabled || source !== "local") return;
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [open, disabled, load, revision, source]);
  useEffect(() => {
    setPage({ jobs: [], hasMore: false, nextBefore: null });
  }, [scope]);
  useEffect(() => {
    setDetail(null);
    setLog(null);
  }, [selected]);
  useEffect(() => {
    if (disabled || open) return;
    const controller = new AbortController();
    void api<Budget>("/jobs/budget", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && validBudget(value)) setBudget(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [revision, disabled, open]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const env: unknown = JSON.parse(draft.env);
      if (
        !env ||
        Array.isArray(env) ||
        typeof env !== "object" ||
        Object.values(env).some((v) => typeof v !== "string")
      )
        throw new Error("Environment must be a JSON object of string values.");
      const body = {
        agentId: draft.agentId,
        taskId: draft.taskId.trim(),
        name: draft.name.trim(),
        cwd: draft.cwd,
        argv: ["/bin/sh", "-c", draft.command],
        env,
        inputs: draft.inputs
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        outputs: draft.outputs
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        guardGit: draft.guardGit,
        // Keep an old unconfirmed ordinary draft's request key unchanged.
        ...(draft.exclusive ? { exclusive: true } : {}),
        ...(draft.gpuMemory?.trim()
          ? {
              gpu: {
                ...(draft.gpuCount && draft.gpuCount > 1 ? { count: draft.gpuCount } : {}),
                ...(draft.gpuDevices?.length ? { devices: draft.gpuDevices } : {}),
                memoryMiB: Number(draft.gpuMemory),
                ...(draft.gpuShared ? { mode: "shared" } : {}),
              },
            }
          : {}),
        resources: {
          cpuMillis: Math.round(Number(draft.cpu) * 1000),
          memoryMiB: Number(draft.memory),
          swapMiB: Number(draft.swap),
        },
        timeoutSeconds: Number(draft.timeout),
      };
      const key = JSON.stringify(body);
      if (pending.current && pending.current.key !== key)
        throw new Error(
          "A previous submission reply is unconfirmed. Keep its command unchanged and retry to retrieve the same Job ID.",
        );
      pending.current ||= { key, requestId: crypto.randomUUID() };
      localStorage.setItem(
        pendingKey,
        JSON.stringify({ ...pending.current, draft }),
      );
      const job = await post<Job>("/jobs", {
        ...body,
        requestId: pending.current.requestId,
      });
      localStorage.removeItem(pendingKey);
      pending.current = null;
      setCreating(false);
      setSelected(job.id);
      await load();
      window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh"));
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
        pending.current = null;
        try {
          localStorage.removeItem(pendingKey);
        } catch {
          /* Keep visible error. */
        }
      }
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(job: Job) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await post(`/jobs/${job.id}/cancel`);
      await load();
      window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  /** Stop at a checkpoint, or resume from one as a new job (T-109). */
  async function checkpoint(job: Job, resume: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await post<Job>(`/jobs/${job.id}/${resume ? "resume-checkpoint" : "checkpoint"}`);
      await load();
      window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh"));
      if (resume && value?.id) setSelected(value.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function pause(job: Job, resume: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await post(`/jobs/${job.id}/${resume ? "resume" : "pause"}`);
      await load();
      window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function rerun(job: Job) {
    if (job.reserved || !job.argv) return;
    setDraft({
      agentId: job.agentId,
      name: job.name,
      taskId: job.taskRef,
      command:
        job.argv.length === 3 &&
        job.argv[0] === "/bin/sh" &&
        job.argv[1] === "-c"
          ? job.argv[2]
          : job.argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" "),
      cwd: job.cwd,
      cpu: String(job.resources.cpuMillis / 1000),
      memory: String(job.resources.memoryMiB),
      swap: String(job.resources.swapMiB),
      timeout: String(job.timeoutSeconds || 86400),
      env: JSON.stringify(job.env || {}, null, 2),
      inputs: (job.inputs || []).join("\n"),
      outputs: (job.outputs || []).join("\n"),
      guardGit: job.guardGit !== false,
      exclusive: job.exclusive === true,
      gpuMemory: job.gpu ? String(job.gpu.memoryMiB) : "",
      gpuShared: job.gpu?.mode === "shared",
      gpuDevices: job.gpu?.devices,
      gpuCount: job.gpu?.count,
    });
    setCreating(true);
  }
  const now = useNow(open && source === "local" && page.jobs.some(live));
  const rail = useRef<HTMLDivElement>(null);
  const waiting = budget ? budget.activeCount + budget.queuedCount : 0;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) generation.current++;
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={`catchup-nav jobs-nav${open ? " selected" : ""}`}
          onClick={() => {
            setScope({});
            setReviewInitial({});
            setSelected("");
            if (!pending.current) setCreating(false);
          }}
          disabled={disabled}
          aria-label="Jobs"
          title="Local jobs, GitHub Actions and PR reviews"
        >
          <BriefcaseBusiness size={15} />
          <span className="toolbar-nav-label">Jobs</span>
          {budget && (
            <span
              className="nav-count"
              aria-label={`${budget.activeCount} active jobs, ${budget.queuedCount} queued jobs`}
              title={`${budget.activeCount} active · ${budget.queuedCount} queued`}
            >
              {budget.activeCount} / {budget.queuedCount}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal jobs-dialog"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>Jobs</Dialog.Title>
              <Dialog.Description>
                Local commands, watched GitHub Actions and PR reviews. Results return to the requesting Agent.
              </Dialog.Description>
            </div>
            <div className="jobs-scope" role="group" aria-label="Job scope">
              <button
                type="button"
                aria-pressed={!scope.agentId && !scope.taskId}
                onClick={() => {
                  setScope({});
                  setReviewInitial({});
                }}
              >
                Workspace
              </button>
              {agent && (
                <button
                  type="button"
                  aria-pressed={scope.agentId === agent.id}
                  title={`Jobs ${agent.name} asked for`}
                  onClick={() => {
                    setScope({ agentId: agent.id });
                    setReviewInitial({});
                  }}
                >
                  {agent.name}
                </button>
              )}
              {scope.taskId && (
                <span className="job-task-scope">Task {scope.taskId}</span>
              )}
            </div>
            <Dialog.Close className="icon-button" aria-label="Close jobs">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="jobs-layout">
            <div
              ref={rail}
              className="settings-nav jobs-rail"
              role="tablist"
              aria-label="Job source"
              aria-orientation="vertical"
              onKeyDown={(event) => {
                const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
                if (!step) return;
                event.preventDefault();
                const index = jobSources.findIndex((s) => s.id === source);
                const next = jobSources[(index + step + jobSources.length) % jobSources.length];
                setSource(next.id);
                rail.current?.querySelector<HTMLElement>(`#jobs-tab-${next.id}`)?.focus();
              }}
            >
              {jobSources.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`jobs-tab-${id}`}
                  aria-selected={source === id}
                  aria-controls="jobs-source-panel"
                  tabIndex={source === id ? 0 : -1}
                  onClick={() => setSource(id)}
                >
                  <Icon size={15} aria-hidden="true" />
                  {label}
                  {id === "local" && waiting > 0 && (
                    <span
                      className="jobs-rail-count"
                      title={`${budget!.activeCount} active · ${budget!.queuedCount} queued on this machine`}
                    >
                      {waiting}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div
              className="jobs-pane"
              role="tabpanel"
              id="jobs-source-panel"
              aria-labelledby={`jobs-tab-${source}`}
            >
              {source === "reviews" ? (
                <ReviewJobs
                  key={JSON.stringify([scope, reviewInitial])}
                  scope={scope}
                  agentName={agent?.name}
                  revision={revision}
                  initial={reviewInitial}
                  onOpenReport={(review) => {
                    // One dialog at a time: Jobs closes, the task opens.
                    setOpen(false);
                    openTaskReview({ taskId: review.taskRef, reviewId: review.id });
                  }}
                />
              ) : source === "github_actions" ? (
                <CiJobs
                  key={JSON.stringify([scope, ciInitial])}
                  scope={scope}
                  owners={owners}
                  defaultAgent={agent?.id}
                  revision={revision}
                  initial={ciInitial}
                />
              ) : (
                <section className="jobs-source local-jobs" aria-labelledby="jobs-local-title">
                  <JobsSourceHeading
                    id="jobs-local-title"
                    title="Local jobs"
                    actions={
                      <>
                        {!creating && (
                          <button
                            type="button"
                            className="icon-button"
                            onClick={() => {
                              setError("");
                              void load();
                            }}
                            aria-label="Refresh jobs"
                            title="Refresh jobs"
                          >
                            <RefreshCw size={15} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!owners.length || busy}
                          onClick={() => {
                            if (!creating && scope.taskId && !pending.current)
                              setDraft((d) => ({ ...d, taskId: scope.taskId! }));
                            setCreating((v) => !v);
                          }}
                        >
                          {creating ? <ArrowLeft size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                          {creating ? "Back to jobs" : "New job"}
                        </button>
                      </>
                    }
                  >
                    Commands run on this machine within its job budget, with the Core user's permissions. Closing this window stops nothing.
                  </JobsSourceHeading>
                  {budget && (
                    <JobsBudget
                      budget={budget}
                      // GPUs on which the user paused a running job (T-107).
                      pausedGpus={
                        new Set(
                          page.jobs
                            .filter((j) => j.status === "running" && j.pause?.intent === "pause")
                            .flatMap((j) => j.gpuReservation?.map((d) => d.uuid) ?? []),
                        )
                      }
                      onSaved={() => void load()}
                    />
                  )}
                  {error && (
                    <p className="inline-error" role="alert">
                      {error}
                    </p>
                  )}
                  {creating ? (
                    <JobForm
                      draft={draft}
                      setDraft={setDraft}
                      owners={owners}
                      locked={!!pending.current}
                      busy={busy}
                      onSubmit={submit}
                    />
                  ) : (
                    <>
                    <PendingAnalysisRuns key={`${scope.agentId || ""}:${scope.taskId || ""}`} scope={scope} revision={revision} onOpen={setSelected} />
                    <div className="jobs-browser">
                      <StateGroups
                        label="Job queue"
                        items={page.jobs}
                        place={placeJob}
                        selected={selected}
                        empty={<p className="jobs-empty">No jobs yet.</p>}
                        row={(job) => (
                          <JobRow
                            status={stateOf(job).mark}
                            state={stateOf(job).name}
                            name={job.name}
                            meta={[
                              job.taskRef,
                              job.agent.name,
                              job.run && `${job.run.stage} · attempt ${job.run.attempt}`,
                              job.exclusive && "Exclusive",
                            ]}
                            note={pauseOf(job)?.reason || (active(job) ? job.reason : null)}
                            time={ranFor(job, now)}
                            timeTitle={when(job)}
                            moments={queuedAndFinished(job)}
                            selected={selected === job.id}
                            onSelect={() => setSelected(job.id)}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "copy";
                              startHandoffDrag(event, jobHandoff(job));
                            }}
                          />
                        )}
                      >
                        {page.hasMore && (
                          <button
                            type="button"
                            className="quiet-button"
                            onClick={() => void load(page.nextBefore!)}
                          >
                            Earlier jobs
                          </button>
                        )}
                      </StateGroups>
                      <div className="job-detail">
                        {/* Only the selected job: a reply for the job selected
                            before can land after the selection changed, until
                            the selection's effects have run. */}
                        {detail && detail.id === selected ? (
                          <JobDetail
                            job={detail}
                            log={log}
                            now={now}
                            busy={busy}
                            revision={revision}
                            onCancel={() => void cancel(detail)}
                            onPause={(resume) => void pause(detail, resume)}
                            onCheckpoint={(resume) => void checkpoint(detail, resume)}
                            onRerun={() => rerun(detail)}
                            onOpen={setSelected}
                          />
                        ) : (
                          <p className="jobs-empty">
                            Select a job to inspect its outcome and output.
                          </p>
                        )}
                      </div>
                    </div>
                    </>
                  )}
                </section>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const jobSources: { id: JobSource; label: string; Icon: typeof BriefcaseBusiness }[] = [
  { id: "local", label: "Local", Icon: BriefcaseBusiness },
  { id: "github_actions", label: "GitHub Actions", Icon: Github },
  { id: "reviews", label: "Reviews", Icon: GitPullRequest },
];

/**
 * The machine at a glance: one bar per resource, the lighter band what jobs
 * have reserved and the solid part what they use now, each with its one
 * setting beneath. The fine print sits in tips.
 */
function JobsBudget({
  budget,
  pausedGpus,
  onSaved,
}: {
  budget: Budget;
  pausedGpus: Set<string>;
  onSaved: () => void;
}) {
  const load = useMachineLoad();
  const cpu = (millis: number) => Number((millis / 1000).toFixed(1));
  // Jobs' share of the whole host, in CPUs, as the budget counts them.
  const cpuUsed = load ? Number(((load.cpu.jobsPct / 100) * load.cpu.cores).toFixed(1)) : null;
  const memoryUsed = load ? load.memory.jobsMiB : null;
  const unknown = "unknown";
  const hostAvailable =
    budget.machine.memoryAvailableMiB == null ? "unknown" : memory(budget.machine.memoryAvailableMiB);
  return (
    <div className="jobs-budget">
      <div className="jobs-budget-head">
        <div className="jobs-budget-machine">
          <strong>{budget.machine.name}</strong>
          <span>
            {budget.activeCount} active · {budget.queuedCount} queued
          </span>
        </div>
        <span
          className="jobs-budget-key"
          title="Reservations include the bounded result collector. CPU is a quota; other apps and Windows also use this host."
        >
          <span className="jobs-key is-used" aria-hidden="true" /> In use
          <span className="jobs-key is-reserved" aria-hidden="true" /> Reserved
        </span>
      </div>
      <div className="jobs-budget-meters">
        <UsageMeter
          label="CPU"
          used={cpuUsed}
          reserved={budget.reserved.cpuMillis / 1000}
          total={budget.budget.cpuMillis / 1000}
          value={
            <>
              <strong>{cpuUsed ?? unknown}</strong> in use
            </>
          }
          title={`CPU: ${cpuUsed ?? unknown} in use, ${cpu(budget.reserved.cpuMillis)} of ${cpu(budget.budget.cpuMillis)} reserved`}
        >
          <span className="jobs-cell-foot">
            <span className="jobs-reserved-text">
              {cpu(budget.reserved.cpuMillis)} / {cpu(budget.budget.cpuMillis)} reserved
            </span>
            <BudgetSettings
              budget={budget.budget}
              bounds={budget.budgetBounds}
              host={budget.machine}
              suggested={budget.machine.suggestedBudget}
              collector={budget.collectorOverhead}
              onSaved={onSaved}
            />
          </span>
        </UsageMeter>
        <UsageMeter
          label="RAM"
          used={memoryUsed}
          reserved={budget.reserved.memoryMiB}
          total={budget.budget.memoryMiB}
          value={
            <>
              <strong>{memoryUsed == null ? unknown : memory(memoryUsed)}</strong> in use
            </>
          }
          title={`RAM: ${memoryUsed == null ? unknown : memory(memoryUsed)} in use, ${memory(budget.reserved.memoryMiB)} of ${memory(budget.budget.memoryMiB)} reserved`}
        >
          <span className="jobs-cell-foot">
            <span className="jobs-reserved-text">
              {memory(budget.reserved.memoryMiB)} / {memory(budget.budget.memoryMiB)} reserved
            </span>
            <span className="jobs-budget-host">{hostAvailable} free on the host</span>
          </span>
        </UsageMeter>
        {budget.disk && <DiskSpace disk={budget.disk} onSaved={onSaved} />}
        {budget.windows?.available && <WindowsJobs windows={budget.windows} onSaved={onSaved} />}
        {budget.gpus && (
          <GpuDevices gpus={budget.gpus} paused={pausedGpus} busyNow={load?.gpus} onSaved={onSaved} />
        )}
      </div>
    </div>
  );
}

/** A Job for Send to Agent (T-152): where its files stay decides what another Agent can open. */
function jobHandoff(job: Job): HandoffSource {
  const executor = job.executor;
  return {
    kind: "job",
    jobId: job.id,
    name: job.name,
    status: job.status,
    reason: job.result?.reason || job.reason || null,
    finishedAt: job.finishedAt,
    machine:
      // An SSH machine without a recorded id still is not this host.
      executor?.kind === "ssh"
        ? { kind: "ssh", id: executor.machineId || "", name: executor.machineName || job.machine.name }
        : executor?.kind === "windows"
          ? { kind: "windows", name: executor.machineName || job.machine.name }
          : { kind: "core" },
    artifacts: job.result?.artifacts?.map(a => a.absolutePath || a.path) ?? (job.artifacts || []).map(a => a.path),
  };
}

function JobDetail({
  job,
  log,
  now,
  busy,
  revision,
  onCancel,
  onPause,
  onCheckpoint,
  onRerun,
  onOpen,
}: {
  job: Job;
  log: Log | null;
  now: number;
  busy: boolean;
  revision: string;
  onCancel: () => void;
  /** Pause, or with true resume, the running job. */
  onPause: (resume: boolean) => void;
  /** Stop the running job at a checkpoint, or with true resume from it. */
  onCheckpoint: (resume: boolean) => void;
  onRerun: () => void;
  onOpen: (jobId: string) => void;
}) {
  const pause = pauseOf(job);
  const ends = deadline(job);
  // Resume whenever a pause was asked for or found, also to abandon one that
  // has not taken hold; pause again after a pause that failed.
  const resume = !!pause && !(pause.state === "failed" && pause.intent === "pause");
  const refused = resume ? null : pauseRefusal(job);
  const stop = job.checkpointStop;
  const stopping = stoppingAtCheckpoint(job);
  return (
    <>
      <JobDetailHeading
        status={stateOf(job).mark}
        state={[stateOf(job).name, ranFor(job, now) || (!job.startedAt && "Not started")]
          .filter(Boolean)
          .join(" · ")}
        title={job.name}
        role={active(job) ? "status" : undefined}
      >
        {job.status === "running" && !stopping && (
          <button
            type="button"
            className="secondary-button"
            // Only while a request is in flight: a resume that has not taken
            // hold (still frozen, or Core restarted mid-way) is asked again.
            // A job that cannot be paused says why.
            disabled={busy || !!refused}
            onClick={() => onPause(resume)}
            title={
              refused ??
              (resume
                ? "Continue the same processes"
                : "Freeze every process of this job. Its memory, GPU memory and reservation stay; GPU work already sent finishes first.")
            }
          >
            {resume ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
            {resume ? "Resume" : "Pause"}
          </button>
        )}
        {job.status === "running" && job.checkpoint && (stop?.state === "failed" || !stopping) && (
          <button
            type="button"
            className="secondary-button"
            // A paused command cannot save; Core refuses it until resumed.
            disabled={busy || !!pause}
            onClick={() => onCheckpoint(false)}
            title={
              pause
                ? "Resume it first: a paused command cannot save a checkpoint"
                : `Ask the command to save a checkpoint and exit. Unlike Pause, this ends the attempt and frees its memory; you can resume it later as a new attempt. It has ${job.checkpoint.graceSeconds} s: if it is still running then, it is cancelled and cannot be resumed.`
            }
          >
            <Save size={12} aria-hidden="true" />
            Stop at checkpoint
          </button>
        )}
        {checkpointed(job) && !stop?.resumedAs && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => onCheckpoint(true)}
            title="Queue a new attempt of the same command that continues from this checkpoint, checked again before it starts"
          >
            <StepForward size={12} aria-hidden="true" />
            Resume from checkpoint
          </button>
        )}
        {active(job) ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || job.status === "cancelling"}
            onClick={onCancel}
          >
            <Square size={12} aria-hidden="true" />
            Cancel
          </button>
        ) : (
          // A stage is retried in its run, with its frozen inputs, not rerun as a free job.
          !job.run && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={onRerun}
            >
              <RotateCcw size={13} aria-hidden="true" />
              Run again…
            </button>
          )
        )}
        <SendToAgentButton source={() => jobHandoff(job)} />
      </JobDetailHeading>
      {stop && (job.status === "running" || job.status === "cancelling" || !job.reserved) ? (
        <p className="job-checkpoint-note">
          {sentence(stop.reason)}
          {stopping && stop.deadline && ` If it has not stopped by ${new Date(stop.deadline).toLocaleString()}, it is cancelled and cannot be resumed.`}
          {stop.state === "checkpointed" && !!job.result?.checkpoint?.files?.length &&
            ` ${job.result.checkpoint.files.length} checkpoint file${job.result.checkpoint.files.length === 1 ? "" : "s"} checked by SHA-256.`}
          {stop.resumedAs && (
            <>
              {" "}
              <button type="button" className="quiet-button" onClick={() => onOpen(stop.resumedAs!)}>
                Resumed as a new job
              </button>
            </>
          )}
        </p>
      ) : pause ? (
        <p className="job-pause-note">
          {pause.state === "paused"
            ? job.executor && job.executor.kind !== "local"
              ? `Paused on ${job.machine.name}. Its memory and the machine's reservation stay; only you can resume it.`
              : "Paused. Memory and GPU memory stay reserved; only you can resume it."
            : pause.reason}
          {ends && ` The timeout still counts: it stops at ${ends.toLocaleString()}.`}
          {job.status === "cancelling" && " Cancelling resumes it briefly while it stops."}
        </p>
      ) : (
        job.reason && <p>{job.reason}</p>
      )}
      <JobCard title="Summary">
        <dl>
          <dt>Source</dt>
          <dd>
            {job.taskRef} · {job.agent.name}
          </dd>
          <dt>Machine</dt>
          <dd>
            {job.machine.name}
            {targetNote(job) && ` · ${targetNote(job)}`}
          </dd>
          <dt>Execution</dt>
          <dd>{job.exclusive ? "Exclusive — this Core's managed local jobs" : "Normal"}</dd>
          <dt>Resources</dt>
          <dd>
            {job.resources.cpuMillis / 1000} CPU ·{" "}
            {memory(job.resources.memoryMiB)} RAM ·{" "}
            {memory(job.resources.swapMiB)} swap
          </dd>
          {job.gpu && (
            <>
              <dt>GPU</dt>
              <dd className="job-gpu">
                {job.gpuReservation?.length
                  ? job.gpuReservation
                      .map((d) => `${d.index == null ? "" : `GPU ${d.index} · `}${d.name} (${d.uuid}) · ${d.memoryMiB} MiB ${d.mode}`)
                      .join("; ")
                  : `${job.gpu.count && job.gpu.count > 1 ? `${job.gpu.count} × ` : ""}${job.gpu.memoryMiB} MiB ${job.gpu.mode || "exclusive"}${
                      job.gpu.devices?.length ? ` on ${job.gpu.devices.join(", ")}` : ""
                    }; not reserved`}
              </dd>
            </>
          )}
          <dt>Current RAM</dt>
          <dd>{ramReading(job.usage?.MemoryCurrent)}</dd>
          <dt>Process/thread limit</dt>
          <dd>
            {job.usage?.TasksMax ||
              job.result?.evidence?.systemd?.TasksMax ||
              "Not reported"}
          </dd>
          <dt>Peak RAM</dt>
          <dd>
            {ramReading(
              job.usage?.MemoryPeak || job.result?.evidence?.systemd?.MemoryPeak,
            )}
          </dd>
          <dt>Directory</dt>
          <dd>{job.cwd}</dd>
          {job.checkpoint && (
            <>
              <dt>Checkpoint</dt>
              <dd>
                On stop: {job.checkpoint.signal || "SIGTERM"}, {job.checkpoint.graceSeconds} s to save, exits{" "}
                {job.checkpoint.stoppedExitCode}
              </dd>
            </>
          )}
          {(job.resumeOf || job.checkpointFrom?.jobId) && (
            <>
              <dt>Resumes</dt>
              <dd>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => onOpen((job.resumeOf || job.checkpointFrom?.jobId)!)}
                >
                  The job it continues from
                </button>
              </dd>
            </>
          )}
          <ReportedLines
            cost={job.result?.cost ?? job.reports?.cost}
            progress={job.result?.progress ?? job.reports?.progress}
          />
        </dl>
      </JobCard>
      {job.run && (
        <RunCard
          runId={job.run.id}
          jobId={job.id}
          revision={`${revision}|${job.status}`}
          onOpen={onOpen}
        />
      )}
      {!!job.artifacts?.length && (
        <ArtifactsCard
          jobId={job.id}
          declared={job.artifacts}
          checked={job.result?.artifacts}
          on={job.result?.artifactsOn ?? (job.executor && job.executor.kind !== "local" ? job.machine : null)}
        />
      )}
      <JobCard title="Command">
        <pre className="job-command">
          {job.argv?.map((a) => JSON.stringify(a)).join(" ")}
        </pre>
        {job.snapshot && <p className="job-footnote">{job.snapshot.scope}</p>}
      </JobCard>
      <JobCard
        title="Output"
        className="job-output"
        aside={
          <small>
            {log ? `${log.totalBytes.toLocaleString()} bytes written` : "Loading…"}
          </small>
        }
      >
        {log && (log.oldestOffset > 0 || log.truncated) && (
          <p className="job-footnote">
            Older output was rotated out; at most 2 MiB is retained.
          </p>
        )}
        <pre className="job-log" tabIndex={0}>
          {log?.text || "No output yet."}
        </pre>
      </JobCard>
      {!!job.outputs?.length && (
        <JobCard title="Declared output files" className="job-outputs">
          {job.outputs.map((path, index) => (
            <a
              key={path}
              href={`${API_BASE}/api/jobs/${job.id}/outputs/${index}`}
              download
            >
              {path}
            </a>
          ))}
        </JobCard>
      )}
      <ProvenanceCard key={job.id} jobId={job.id} runId={job.run?.id} />
      <details className="job-evidence-details">
        <summary>Execution evidence</summary>
        <pre className="job-evidence">
          {JSON.stringify(
            job.result || { status: "No terminal evidence yet" },
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}

type Draft = {
  agentId: string;
  name: string;
  taskId: string;
  command: string;
  cwd: string;
  cpu: string;
  memory: string;
  swap: string;
  timeout: string;
  env: string;
  inputs: string;
  outputs: string;
  guardGit: boolean;
  exclusive?: boolean;
  /** Empty: no GPU. Devices and count come only from a rerun's original. */
  gpuMemory?: string;
  gpuShared?: boolean;
  gpuDevices?: string[];
  gpuCount?: number;
};

/** A new job: what runs, its limits, then its checks and files. */
function JobForm({
  draft,
  setDraft,
  owners,
  locked,
  busy,
  onSubmit,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  owners: Agent[];
  /** An unconfirmed submission keeps its Agent and mode. */
  locked: boolean;
  busy: boolean;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form className="job-form" onSubmit={onSubmit}>
      <fieldset className="job-form-group">
        <legend>What runs</legend>
        <label className="job-wide">
          Requesting Agent
          <select
            required
            value={draft.agentId}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
          >
            <option value="">Choose an Agent</option>
            {owners.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            required
            value={draft.name}
            maxLength={160}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Existing task
          <input
            required
            placeholder="T-47"
            value={draft.taskId}
            onChange={(e) => setDraft({ ...draft, taskId: e.target.value })}
          />
        </label>
        <label className="job-wide">
          Working directory
          <input
            required
            value={draft.cwd}
            onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
          />
        </label>
        <label className="job-wide">
          Command
          <textarea
            className="job-code"
            required
            rows={3}
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            placeholder="python train.py"
          />
        </label>
      </fieldset>
      <fieldset className="job-form-group">
        <legend>Limits</legend>
        <label>
          CPU quota
          <input
            type="number"
            min="0.1"
            step="0.1"
            required
            value={draft.cpu}
            onChange={(e) => setDraft({ ...draft, cpu: e.target.value })}
          />
        </label>
        <label>
          RAM limit (MiB)
          <input
            type="number"
            min="64"
            required
            value={draft.memory}
            onChange={(e) => setDraft({ ...draft, memory: e.target.value })}
          />
        </label>
        <label>
          Swap limit (MiB)
          <input
            type="number"
            min="0"
            required
            value={draft.swap}
            onChange={(e) => setDraft({ ...draft, swap: e.target.value })}
          />
        </label>
        <label>
          Time limit (seconds)
          <input
            type="number"
            min="1"
            max="604800"
            required
            value={draft.timeout}
            onChange={(e) => setDraft({ ...draft, timeout: e.target.value })}
          />
        </label>
        <div className="job-wide">
          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={draft.exclusive === true}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, exclusive: e.target.checked })}
            />
            Exclusive execution
          </label>
          <p className="job-footnote">
            Waits for earlier jobs to finish, then runs alone among this
            Core's managed local jobs. Later jobs stay queued until
            cleanup finishes. Other applications keep running; resource
            limits still apply. Unchecked jobs use normal shared capacity.
          </p>
        </div>
        <label>
          GPU memory (MiB)
          <input
            type="number"
            min="64"
            placeholder="No GPU"
            value={draft.gpuMemory || ""}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, gpuMemory: e.target.value })}
          />
        </label>
        {draft.gpuMemory?.trim() && (
          <div className="job-wide">
            <label className="job-checkbox">
              <input
                type="checkbox"
                checked={draft.gpuShared === true}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, gpuShared: e.target.checked })}
              />
              Shared GPU
            </label>
            <p className="job-footnote">
              Starts when a GPU{draft.gpuDevices?.length ? ` (${draft.gpuDevices.join(", ")})` : ""} has this much free
              memory and no other managed GPU job, and only that GPU is visible to the command
              (CUDA_VISIBLE_DEVICES). Shared runs beside other shared jobs on a GPU you opened for sharing.
            </p>
          </div>
        )}
      </fieldset>
      <fieldset className="job-form-group">
        <legend>Checks and files</legend>
        <details className="job-wide">
          <summary>Environment and input checks</summary>
          <label>
            Explicit environment (JSON)
            <textarea
              className="job-code"
              rows={3}
              value={draft.env}
              onChange={(e) => setDraft({ ...draft, env: e.target.value })}
            />
          </label>
          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={draft.guardGit}
              onChange={(e) => setDraft({ ...draft, guardGit: e.target.checked })}
            />
            Check Git HEAD and changed tracked files before launch
          </label>
          <label>
            Additional small input files, one per line
            <textarea
              className="job-code"
              rows={2}
              value={draft.inputs}
              onChange={(e) => setDraft({ ...draft, inputs: e.target.value })}
            />
          </label>
          <p>
            Commands and environment are captured. Untracked data and
            changes after launch are not frozen. No dataset copying.
          </p>
        </details>
        <label className="job-wide">
          Output files, relative to the working directory
          <textarea
            className="job-code"
            rows={2}
            value={draft.outputs}
            onChange={(e) => setDraft({ ...draft, outputs: e.target.value })}
            placeholder="reports/result.json"
          />
        </label>
      </fieldset>
      <div className="job-form-footer">
        <small>
          Runs on the Core host with the Core user's permissions.
          Agent sandbox rules do not apply.
          <br />
          Job completion does not complete its task. Closing this
          window does not stop a job.
        </small>
        <button className="primary-button" disabled={busy} type="submit">
          {busy
            ? "Submitting…"
            : locked
              ? "Retry same submission"
              : "Submit job"}
        </button>
      </div>
    </form>
  );
}
