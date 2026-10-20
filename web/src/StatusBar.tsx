import { useEffect, useRef, useState } from "react";
import { Bot, Check, GitPullRequest, Server, Sparkles, Workflow, X } from "lucide-react";
import { api } from "./api";
import { CoreBacklog } from "./CoreBacklog";
import { limitWindows } from "./ClaudeControls";
import { duration, usageWindows, useCodexUsage } from "./CodexPlanUsage";
import { openJobs } from "./Jobs";
import { runActive, type Run } from "./CiJobs";
import type { ReviewRow } from "./ReviewJobs";
import { reviewPassed } from "./review-outcome";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import type { Agent, ClaudeRuntime } from "./types";
import "./statusbar.css";

/**
 * The bottom bar: what runs in the background, and what the machine, the
 * Claude and Codex plans and the remote machines have left. Core's health shows here
 * only when something is wrong. Nothing in it repeats the toolbar (Core
 * connected, pending), the rail (active agents) or the conversation (model,
 * context).
 */
export function StatusBar({
  previewMode,
  eventConnection,
  live,
  agents,
  revision,
  machinesRevision,
  claudeRuntime,
  codexAgent,
  onMachines,
}: {
  previewMode: boolean;
  eventConnection: string;
  /** Core reachable and live updates open. */
  live: boolean;
  agents: Agent[];
  /** Changes with every job, review or CI event and reconnect. */
  revision: string;
  machinesRevision: string;
  /** The selected Agent's Claude runtime, which carries plan usage. */
  claudeRuntime?: ClaudeRuntime | null;
  /** The selected Agent when it is a Codex one: its plan usage shows. */
  codexAgent?: Agent | null;
  onMachines: () => void;
}) {
  const background = useBackground(revision, !previewMode);
  const plan = usePlan(claudeRuntime);
  const codex = useCodex(previewMode ? null : codexAgent ?? null, eventConnection === "open");
  const machines = useMachines(machinesRevision, !previewMode, agents);
  return (
    <footer className="statusbar">
      <div className="statusbar-start">
        {previewMode && <span className="statusbar-item">Visual specimen</span>}
        {!previewMode && eventConnection !== "open" && (
          <span className="statusbar-item event-connection-status" role="status">
            {eventConnection === "reconnecting"
              ? "Live updates reconnecting"
              : "Live updates connecting"}
          </span>
        )}
        {!previewMode && <CoreBacklog agents={agents} live={live} />}
        {background.reviews > 0 && (
          <button
            type="button"
            className="statusbar-item"
            title="Reviews in progress · open Jobs"
            onClick={() => openJobs({ source: "reviews" })}
          >
            <GitPullRequest size={12} aria-hidden="true" />
            {background.reviews} {background.reviews === 1 ? "review" : "reviews"} running
          </button>
        )}
        {(background.ci > 0 || background.ciPartial) && (
          <button
            type="button"
            className="statusbar-item"
            title={`GitHub Actions runs in progress${background.ciPartial ? "; Core lists more runs than the status bar read, so there may be more" : ""} · open Jobs`}
            onClick={() => openJobs({ source: "github_actions" })}
          >
            <Workflow size={12} aria-hidden="true" />
            {background.ci === 0
              ? "CI runs not all read"
              : `${background.ci}${background.ciPartial ? "+" : ""} CI ${background.ci === 1 && !background.ciPartial ? "run" : "runs"}`}
          </button>
        )}
        <span className="statusbar-notice" role="status" aria-live="polite">
          {background.notice && (
            <button
              type="button"
              className={`statusbar-item ${background.notice.ok ? "is-ok" : "is-failed"}`}
              title={`${background.notice.text}${background.more ? ` · ${background.more} more after it` : ""} · open Jobs`}
              onClick={background.notice.open}
            >
              {background.notice.ok ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <X size={12} aria-hidden="true" />
              )}
              {background.notice.text}
              {background.more > 0 && <span className="statusbar-more"> +{background.more}</span>}
            </button>
          )}
        </span>
      </div>
      <div className="statusbar-end">
        {codex && (
          <span
            className={`statusbar-item statusbar-codex${codex.limited ? " is-failed" : ""}${codex.stale ? " is-stale" : ""}`}
            title={codex.title}
          >
            <Sparkles size={12} aria-hidden="true" />
            Codex {codex.text}
          </span>
        )}
        {plan && (
          <span
            className={`statusbar-item${plan.limited ? " is-failed" : ""}`}
            title={plan.title}
          >
            <Bot size={12} aria-hidden="true" />
            Claude {plan.text}
          </span>
        )}
        {machines && (
          <button
            type="button"
            className={`statusbar-item${machines.unreachable ? " is-failed" : ""}`}
            title={machines.title}
            onClick={onMachines}
          >
            <Server size={12} aria-hidden="true" />
            {machines.text}
          </button>
        )}
        {background.budget && <Memory budget={background.budget} />}
      </div>
    </footer>
  );
}

type Resources = { cpuMillis: number; memoryMiB: number };
type Budget = {
  machine: { name: string; memoryAvailableMiB: number | null };
  budget: Resources;
  reserved: Resources;
};
type Job = {
  id: string;
  name: string;
  status: string;
  finishedAt: string | null;
};
type Notice = { key: string; text: string; ok: boolean; open: () => void };

const gib = (miB: number) =>
  miB >= 1024 ? `${(miB / 1024).toFixed(1)} GiB` : `${Math.round(miB)} MiB`;
const share = (used: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

/** Job memory reserved against its budget, and what the host has free. */
function Memory({ budget }: { budget: Budget }) {
  const used = share(budget.reserved.memoryMiB, budget.budget.memoryMiB);
  const host =
    budget.machine.memoryAvailableMiB == null
      ? ""
      : ` · ${gib(budget.machine.memoryAvailableMiB)} free`;
  const cpu = (millis: number) => Number((millis / 1000).toFixed(1));
  const value = `${gib(budget.reserved.memoryMiB)} / ${gib(budget.budget.memoryMiB)}`;
  return (
    <button
      type="button"
      className="statusbar-item statusbar-memory"
      title={`${budget.machine.name}: jobs reserve ${value} of RAM and ${cpu(budget.reserved.cpuMillis)} / ${cpu(budget.budget.cpuMillis)} CPU${host ? `; the host has${host.slice(2)}` : ""} · open Jobs`}
      onClick={() => openJobs({ source: "local" })}
    >
      <span>RAM</span>
      <span
        className="statusbar-meter"
        role="meter"
        aria-label="Job RAM reserved"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={`${value} reserved`}
      >
        <span style={{ width: `${used}%` }} />
      </span>
      <span>
        {value}
        {host}
      </span>
    </button>
  );
}

const stopped = new Set(["failed", "rejected", "interrupted", "unknown"]);
const reviewActive = (r: ReviewRow) =>
  r.status === "preparing" || r.status === "running";
const reviewOutcome = (r: ReviewRow) =>
  r.status !== "completed"
    ? { ok: false, text: r.status }
    : { ok: reviewPassed(r), text: r.conclusion === "no_findings" ? "no findings" : r.conclusion === "approved_with_notes" ? "passed with suggestions" : (r.conclusion || "unknown").replace(/_/g, " ") };

const HOUR = 3_600_000;
// How far back a review can still be going: a review ends, or turns unknown,
// well within a day. Core lists reviews in the order it created them, and
// stamps createdAt then, so the first row past a day ends the search.
const REVIEW_HORIZON = 24 * HOUR;
type Page = { hasMore?: boolean; nextBefore?: string | number | null } & Record<string, unknown>;

/**
 * Reviews, newest first, read back only as far as needed: past every review
 * still followed, and on the first read past everything that could still be
 * going; never past the horizon. New reviews are always on the first page.
 */
async function recentReviews(follow: Iterable<string>, deep: boolean, signal: AbortSignal) {
  const rows: ReviewRow[] = [];
  const wanted = new Set(follow);
  let before: string | number | null = null;
  for (;;) {
    const page: Page = await api<Page>(before === null ? "/reviews" : `/reviews?before=${encodeURIComponent(String(before))}`, { signal });
    const got = Array.isArray(page?.reviews) ? (page.reviews as ReviewRow[]) : [];
    rows.push(...got);
    for (const row of got) wanted.delete(row.id);
    const last = got.at(-1);
    const within = !!last && Date.now() - Date.parse(last.createdAt) < REVIEW_HORIZON;
    if (!page?.hasMore || page.nextBefore == null || !within || !(deep || wanted.size)) return rows;
    before = page.nextBefore;
  }
}

/** The most CI list pages one read asks Core for. */
const RUN_PAGES = 6;
type Watcher = { id: string; agentId?: string; taskId?: string; active?: boolean; watch?: { observedAt?: string | null; state?: string } };
type RunPage = {
  runs?: Run[];
  hasMore?: boolean;
  nextBefore?: number | null;
  subscriptions?: Watcher[];
  subscriptionsTruncated?: boolean;
  /** Active subscriptions in scope, listed or not. */
  activeSubscriptionCount?: number;
};
/** What the status bar knows of Core's CI runs from one read to the next. */
type RunsKnown = {
  /** The newest run's cursor: anything above it is new. */
  top: number | null;
  /** Runs seen going, by id, with their cursors: followed until they end. */
  going: Map<string, number | null>;
  /** Active subscriptions whose runs were all read, with what their watch had observed then. */
  searched: Map<string, string>;
  /** Where a search of runs by agent and task stopped, for those subscriptions as they were. */
  resume: Map<string, { subs: string; before: number }>;
  /** Every run that could be going was read. */
  whole: boolean;
};
// What a subscription's watch has done that can add runs, old ones too, to
// its list: observed for the first time, or come back from failing.
const watchMark = (s: Watcher) => `${!!s.watch?.observedAt}:${s.watch?.state === "needs_attention"}`;

/**
 * Core's CI runs, read by where they are in its list, never by when GitHub
 * created them: Core lists runs in the order it first recorded them, so a
 * commit watched late puts its old runs above newer ones still going. Only
 * a watched run can be going, and only through an active subscription, so
 * the runs of every active subscription, read from that subscription's own
 * short list, hold every run going however far down Core's list it is. Each
 * read takes, in turn:
 * - Core's newest page, with the subscriptions;
 * - the page that starts at each run still followed and not on it (a run
 *   keeps its cursor), so its end is told;
 * - when not every active subscription is listed, Core's list on down to the
 *   newest run seen before (on a first read, as far as it may);
 * - the runs of each active subscription not read through since its watch
 *   last could add some; of every one when runs came in below the newest
 *   page since the last read.
 * A read asks for at most RUN_PAGES pages: a run followed but not reached
 * stays followed, and a search not finished goes on from there next time;
 * until then the count says it may not be whole.
 */
async function readRuns(known: RunsKnown | null, signal: AbortSignal) {
  const rows = new Map<string, Run>();
  // The cursor ranges of Core's whole list read: [lowest, highest].
  const covered: [number, number][] = [];
  let pages = 0;
  const read = async (before: number | null, scope?: { agentId: string; taskId: string }) => {
    pages++;
    const query = new URLSearchParams(scope);
    if (before !== null) query.set("before", String(before));
    const text = query.toString();
    const page = await api<RunPage>(text ? `/ci?${text}` : "/ci", { signal });
    const runs = Array.isArray(page?.runs) ? page.runs : [];
    for (const run of runs) rows.set(run.id, run);
    const end = !page?.hasMore || page.nextBefore == null;
    const last = runs.at(-1)?.cursor;
    const low = typeof last === "number" ? last : null;
    if (!scope) covered.push([end ? -Infinity : low ?? Infinity, before === null ? Infinity : before - 1]);
    return { page, end, next: end ? null : Number(page.nextBefore), low };
  };
  const first = await read(null);
  const top = first.page?.runs?.[0]?.cursor ?? known?.top ?? null;
  const subscriptions = Array.isArray(first.page?.subscriptions) ? first.page.subscriptions : null;
  // Every active subscription is on the newest page: Core lists the newest
  // 200 subscriptions, active or not, and counts the active ones.
  const counted = first.page?.activeSubscriptionCount;
  const listed =
    !!subscriptions &&
    (typeof counted === "number" ? subscriptions.filter((s) => s.active).length >= counted : !first.page?.subscriptionsTruncated);
  // Each followed run not on it, from the page that starts at it.
  const followed = [...(known?.going ?? [])].sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1));
  for (const [id, cursor] of followed) {
    if (rows.has(id) || typeof cursor !== "number" || pages >= RUN_PAGES) continue;
    if (!covered.some(([low, high]) => cursor >= low && cursor <= high)) await read(cursor + 1);
  }
  const seenTop = known?.top ?? -Infinity;
  let at = first;
  if (!listed) while (!at.end && pages < RUN_PAGES && (!known || (at.low ?? -Infinity) > seenTop)) at = await read(at.next);
  const reachedEnd = at.end;
  const caughtUp = reachedEnd || (!!known && at.low !== null && at.low <= seenTop);
  const searched = new Map<string, string>();
  const resume = new Map<string, { subs: string; before: number }>();
  const active = (subscriptions ?? []).filter((s) => s.active);
  const pending = new Map<string, Watcher[]>();
  for (const s of active) {
    if (reachedEnd || (caughtUp && known?.searched.get(s.id) === watchMark(s))) searched.set(s.id, watchMark(s));
    else if (s.agentId && s.taskId) {
      const key = JSON.stringify([s.agentId, s.taskId]);
      pending.set(key, [...(pending.get(key) ?? []), s]);
    }
  }
  for (const [key, subs] of pending) {
    const [agentId, taskId] = JSON.parse(key) as [string, string];
    // A search stopped by the page limit goes on where it stopped while
    // nothing can have added runs above or below: no runs came in below
    // the newest page, and the same subscriptions' watches did nothing new.
    const mark = subs.map((s) => `${s.id}=${watchMark(s)}`).sort().join(" ");
    const was = caughtUp ? known?.resume.get(key) : undefined;
    let page: { end: boolean; next: number | null } | null = was?.subs === mark ? { end: false, next: was.before } : null;
    while (pages < RUN_PAGES && !page?.end) page = await read(page?.next ?? null, { agentId, taskId });
    if (page?.end) for (const s of subs) searched.set(s.id, watchMark(s));
    else if (page?.next != null) resume.set(key, { subs: mark, before: page.next });
  }
  // Core keeps every run it has listed: a followed run not found stays
  // followed rather than taken for ended.
  const lost = new Set([...(known?.going.keys() ?? [])].filter((id) => !rows.has(id)));
  const whole =
    reachedEnd ||
    (listed && active.every((s) => searched.has(s.id))) ||
    (!listed && !!known?.whole && caughtUp);
  return { runs: [...rows.values()], lost, known: { top, searched, resume, whole } };
}

/**
 * Reviews and CI runs in progress, the job budget, and a short note when a
 * job, review or run ends while this page is open. Read on every job event.
 * A review or run seen going is followed until it ends, however many newer
 * ones come after it; a job ends when it leaves Core's unfinished set, even
 * if another takes its place.
 */
export function useBackground(revision: string, enabled: boolean) {
  const [reviews, setReviews] = useState(0);
  const [ci, setCi] = useState(0);
  // The CI count may leave out runs the bounded read could not reach.
  const [ciPartial, setCiPartial] = useState(false);
  const [budget, setBudget] = useState<Budget | null>(null);
  // Ends waiting to be told, the first shown.
  const [notices, setNotices] = useState<Notice[]>([]);
  // What ended before this page looked is not news; each end is told once.
  const since = useRef(Date.now());
  const told = useRef(new Set<string>());
  // Followed until they end; null before the first read.
  const reviewsOn = useRef<Set<string> | null>(null);
  const runsKnown = useRef<RunsKnown | null>(null);
  const jobsOn = useRef<Set<string> | null>(null);
  const tell = (next: Notice) => {
    if (told.current.has(next.key)) return;
    told.current.add(next.key);
    setNotices((queue) => [...queue, next]);
  };
  // Several ends at once each get their turn, a shorter one while others wait.
  const shown = notices[0]?.key;
  const waiting = notices.length > 1;
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setNotices((queue) => queue.slice(1)), waiting ? 4000 : 10_000);
    return () => clearTimeout(timer);
  }, [shown, waiting]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    const after = (at?: string | null) => !!at && Date.parse(at) >= since.current;
    const read = async () => {
      const [b, j, r, c] = await Promise.allSettled([
        api<Budget>("/jobs/budget", { signal }),
        api<{ jobs: Job[]; liveJobs: Job[] }>("/jobs", { signal }),
        recentReviews(reviewsOn.current ?? [], !reviewsOn.current, signal),
        readRuns(runsKnown.current, signal),
      ]);
      if (signal.aborted) return;
      if (b.status === "fulfilled" && b.value?.budget && b.value.reserved) setBudget(b.value);
      if (r.status === "fulfilled") {
        const was = reviewsOn.current;
        const on = new Set<string>();
        for (const row of r.value) {
          if (reviewActive(row)) on.add(row.id);
          else if (was?.has(row.id) || after(row.finishedAt)) {
            const outcome = reviewOutcome(row);
            tell({
              key: `review:${row.id}`,
              ok: outcome.ok,
              text: `Review of PR #${row.number}: ${outcome.text}`,
              open: () => openJobs({ source: "reviews", reviewId: row.id, taskId: row.taskId }),
            });
          }
        }
        reviewsOn.current = on;
        setReviews(on.size);
      }
      if (c.status === "fulfilled") {
        const was = runsKnown.current?.going;
        const on = new Map<string, number | null>();
        for (const run of c.value.runs) {
          if (runActive(run)) on.set(run.id, typeof run.cursor === "number" ? run.cursor : null);
          else if ((run.status === "passed" || stopped.has(run.status) || run.status === "cancelled") && (was?.has(run.id) || after(run.updatedAt)))
            tell({
              key: `ci:${run.id}`,
              ok: run.status === "passed",
              text: `${run.name} run ${run.status}`,
              open: () => openJobs({ source: "github_actions", runKey: run.id }),
            });
        }
        // A followed run this read could not reach is still going as far
        // as anyone here knows.
        for (const id of c.value.lost) on.set(id, was?.get(id) ?? null);
        runsKnown.current = { ...c.value.known, going: on };
        setCi(on.size);
        setCiPartial(!c.value.known.whole || c.value.lost.size > 0);
      }
      if (j.status === "fulfilled" && Array.isArray(j.value?.jobs) && Array.isArray(j.value.liveJobs)) {
        const page = j.value.jobs;
        const live = new Set(j.value.liveJobs.map((job) => job.id));
        // Those that left the unfinished set ended; one older than the
        // first page is read on its own.
        const left = [...(jobsOn.current ?? [])].filter((id) => !live.has(id));
        const ended = await Promise.all(
          left.map(
            (id) =>
              page.find((job) => job.id === id) ??
              api<Job>(`/jobs/${encodeURIComponent(id)}`, { signal }).catch(() => null),
          ),
        );
        if (signal.aborted) return;
        jobsOn.current = live;
        for (const job of [...ended, ...page])
          if (job?.finishedAt && (left.includes(job.id) || after(job.finishedAt)))
            tell({
              key: `job:${job.id}`,
              ok: job.status === "succeeded",
              text: `Job ${job.name} ${job.status === "succeeded" ? "finished" : stopped.has(job.status) ? "failed" : job.status}`,
              open: () => openJobs({ source: "local", jobId: job.id }),
            });
      }
    };
    // Events come in bursts; one read answers a burst.
    const timer = setTimeout(() => void read().catch(() => {}), 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [revision, enabled]);
  return { reviews, ci, ciPartial, budget, notice: notices[0] ?? null, more: Math.max(0, notices.length - 1) };
}

const PLAN_KEY = "yuzuno.claude-plan";
type Plan = {
  rateLimits: ClaudeRuntime["rateLimits"];
  rateLimitsAt: string;
  /** Whose plan: kept with the report, since another Agent may sign in as
   * someone else. */
  account?: string;
};

/**
 * Claude plan usage as Claude Code last reported it. The plan belongs to the
 * account, so the latest report from any Claude Agent stays shown while other
 * Agents are open, with whose account it is and when it came.
 */
function usePlan(runtime?: ClaudeRuntime | null) {
  const [plan, setPlan] = useState<Plan | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PLAN_KEY) || "null");
      return saved?.rateLimits && saved.rateLimitsAt ? saved : null;
    } catch {
      return null;
    }
  });
  const reported = runtime?.rateLimits && runtime.rateLimitsAt ? runtime : null;
  useEffect(() => {
    if (!reported) return;
    setPlan((old) => {
      if (old && Date.parse(old.rateLimitsAt) >= Date.parse(reported.rateLimitsAt!)) return old;
      const who = reported.account;
      const account = [who?.email || who?.organization, who?.subscriptionType].filter(Boolean).join(" · ") || undefined;
      const next = { rateLimits: reported.rateLimits, rateLimitsAt: reported.rateLimitsAt!, account };
      try {
        localStorage.setItem(PLAN_KEY, JSON.stringify(next));
      } catch {
        // Shown for this visit even without storage.
      }
      return next;
    });
  }, [reported?.rateLimitsAt]);
  if (!plan) return null;
  const now = Date.now();
  const windows = limitWindows(plan.rateLimits, now);
  if (!windows.length) return null;
  const info = plan.rateLimits || {};
  const live = typeof info.resetsAt !== "number" || info.resetsAt * 1000 > now;
  const limited = live && info.status === "rejected";
  return {
    limited,
    text: windows.map((w) => (w.expired ? `${w.name} reset` : `${w.name} ${w.percent}%`)).join(" · "),
    title: [
      plan.account
        ? `Claude plan usage for ${plan.account}, as Claude Code last reported it`
        : "Claude plan usage, as Claude Code last reported it",
      ...windows.map((w) =>
        w.expired ? `${w.name}: reset since` : `${w.name}: ${w.percent}% used${w.resets ? `, resets ${w.resets}` : ""}`,
      ),
      `Reported ${new Date(plan.rateLimitsAt).toLocaleString()}.`,
      limited ? "The limit is reached." : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * The selected Codex Agent's plan usage, from that Agent's own native
 * connection: never another Agent's report, never kept on the device, never
 * mixed with Claude's. A report older than five minutes says so; once a
 * reset time passes, the window waits for a new report; an unknown share is
 * not 0. Nothing shows until a report has windows.
 */
export function useCodex(agent: Agent | null, streamConnected: boolean) {
  const { usage, clock, connected } = useCodexUsage(agent, streamConnected, 15_000);
  if (!usage || !connected || !streamConnected) return null;
  const windows = usageWindows(usage, clock);
  if (!windows.length) return null;
  // Several limits need their names; one needs only its window lengths.
  const named = usage.buckets.length > 1;
  const labels = usage.buckets.flatMap((bucket) =>
    [bucket.primary, bucket.secondary].flatMap((w) =>
      w ? [`${named ? `${bucket.limitName || bucket.limitId} ` : ""}${duration(w.windowDurationMins)}`] : [],
    ),
  );
  const stale = windows.some((w) => w.stale && !w.expired);
  const limited =
    !stale &&
    (usage.ordinaryUsageAllowed === false || windows.some((w) => !w.expired && w.percent !== null && w.percent >= 100));
  const who = [usage.account?.label || usage.account?.type, usage.account?.planType].filter(Boolean).join(" · ");
  return {
    stale,
    limited,
    text:
      windows
        .map((w, i) => `${labels[i]} ${w.expired ? "waiting" : w.percent === null ? "unknown" : `${w.percent}%`}`)
        .join(" · ") + (stale ? " · last report" : ""),
    title: [
      `Codex plan usage${who ? ` for ${who}` : ""}, from ${usage.source.label}`,
      ...windows.map((w) => w.detail.replace(/\s+/g, " ").trim()),
      stale ? "This is the last report; refresh it from the Agent's details." : "",
      usage.ordinaryUsageAllowed === false ? "Ordinary usage is not allowed (reported)." : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Remote machines, only while an open Agent works on one (and read only
 * then): how many, and how many could not be reached at their last check or
 * have an Agent whose runtime is disconnected. A check is manual, so its age
 * is in the tip.
 */
function useMachines(revision: string, enabled: boolean, agents: Agent[]) {
  const [machines, setMachines] = useState<WorkspaceMachine[]>([]);
  const remoteInUse = agents.some((a) => !a.closedAt && !!a.remote);
  useEffect(() => {
    if (!enabled || !remoteInUse) return setMachines([]);
    const controller = new AbortController();
    void api<{ machines: WorkspaceMachine[] }>("/machines", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && Array.isArray(value?.machines)) setMachines(value.machines);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [revision, enabled, remoteInUse]);
  const remote = machines.filter((m) => m.kind === "ssh");
  if (!remote.length) return null;
  const down = remote.filter(
    (m) =>
      m.lastCheck?.reachable === false ||
      agents.some(
        (a) => !a.closedAt && a.remote?.machine.id === m.id && a.connectionState === "disconnected",
      ),
  );
  return {
    unreachable: down.length,
    text: `${remote.length} ${remote.length === 1 ? "machine" : "machines"}${down.length ? ` · ${down.length} unreachable` : ""}`,
    title: [
      ...remote.map((m) => {
        const check = m.lastCheck
          ? `${m.lastCheck.reachable ? "reachable" : "unreachable"} at its last check, ${new Date(m.lastCheck.checkedAt).toLocaleString()}`
          : "not checked yet";
        const off = agents.filter(
          (a) => !a.closedAt && a.remote?.machine.id === m.id && a.connectionState === "disconnected",
        ).length;
        return `${m.name}: ${check}${off ? `; ${off} Agent${off === 1 ? "" : "s"} disconnected` : ""}`;
      }),
      "Open Machines",
    ].join("\n"),
  };
}
