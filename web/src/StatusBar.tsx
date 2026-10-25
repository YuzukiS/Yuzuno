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
import { strings, useLanguage, type Language } from "./i18n";
import "./statusbar.css";

// The bottom bar's own words (T-189). Names of jobs, runs and machines, Core's
// status values, and the plan windows' names and details (as the Agent
// panels show them) are shown as they came.
const words = strings({
  specimen: "Visual specimen",
  reconnecting: "Live updates reconnecting",
  connecting: "Live updates connecting",
  reviewsTitle: "Reviews in progress · open Jobs",
  reviews: (count: number) => `${count} ${count === 1 ? "review" : "reviews"} running`,
  ciTitle: (partial: boolean) => `GitHub Actions runs in progress${partial ? "; Core lists more runs than the status bar read, so there may be more" : ""} · open Jobs`,
  ciUnread: "CI runs not all read",
  ci: (count: number, partial: boolean) => `${count}${partial ? "+" : ""} CI ${count === 1 && !partial ? "run" : "runs"}`,
  noticeTitle: (text: string, more: number) => `${text}${more ? ` · ${more} more after it` : ""} · open Jobs`,
  review: (number: number, outcome: string) => `Review of PR #${number}: ${outcome}`,
  noFindings: "no findings",
  suggestions: "passed with suggestions",
  run: (name: string, status: string) => `${name} run ${status}`,
  job: (name: string, outcome: string) => `Job ${name} ${outcome}`,
  finished: "finished",
  failed: "failed",
  memoryTitle: (machine: string, value: string, used: number, cpu: number, free: string | null) =>
    `${machine}: jobs reserve ${value} of RAM and ${used} / ${cpu} CPU${free ? `; the host has ${free} free` : ""} · open Jobs`,
  ram: "RAM",
  ramLabel: "Job RAM reserved",
  reserved: (value: string) => `${value} reserved`,
  free: (value: string) => ` · ${value} free`,
  planFor: (account: string) => `Claude plan usage for ${account}, as Claude Code last reported it`,
  plan: "Claude plan usage, as Claude Code last reported it",
  windowReset: (name: string) => `${name} reset`,
  windowResetSince: (name: string) => `${name}: reset since`,
  windowUsed: (name: string, percent: number | null, resets: string | null) => `${name}: ${percent}% used${resets ? `, resets ${resets}` : ""}`,
  reported: (when: string) => `Reported ${when}.`,
  limited: "The limit is reached.",
  codexWaiting: "waiting",
  codexUnknown: "unknown",
  lastReport: " · last report",
  codexTitle: (who: string, source: string) => `Codex plan usage${who ? ` for ${who}` : ""}, from ${source}`,
  codexStale: "This is the last report; refresh it from the Agent's details.",
  codexNotAllowed: "Ordinary usage is not allowed (reported).",
  machines: (count: number, down: number) => `${count} ${count === 1 ? "machine" : "machines"}${down ? ` · ${down} unreachable` : ""}`,
  checked: (reachable: boolean, when: string) => `${reachable ? "reachable" : "unreachable"} at its last check, ${when}`,
  unchecked: "not checked yet",
  machine: (name: string, check: string, off: number) => `${name}: ${check}${off ? `; ${off} Agent${off === 1 ? "" : "s"} disconnected` : ""}`,
  openMachines: "Open Machines",
}, {
  specimen: "视觉样本",
  reconnecting: "实时更新正在重新连接",
  connecting: "实时更新正在连接",
  reviewsTitle: "正在进行的审查 · 打开 Job",
  reviews: (count) => `${count} 个审查进行中`,
  ciTitle: (partial) => `正在进行的 GitHub Actions 运行${partial ? "；Core 列出的运行比状态栏读取的多，因此可能还有更多" : ""} · 打开 Job`,
  ciUnread: "CI 运行未全部读取",
  ci: (count, partial) => `${count}${partial ? "+" : ""} 个 CI 运行`,
  noticeTitle: (text, more) => `${text}${more ? ` · 之后还有 ${more} 条` : ""} · 打开 Job`,
  review: (number, outcome) => `PR #${number} 的审查：${outcome}`,
  noFindings: "无发现",
  suggestions: "通过，附建议",
  run: (name, status) => `${name} 运行 ${status}`,
  job: (name, outcome) => `Job ${name} ${outcome}`,
  finished: "已完成",
  failed: "已失败",
  memoryTitle: (machine, value, used, cpu, free) => `${machine}：Job 预留 ${value} 内存和 ${used} / ${cpu} CPU${free ? `；主机空闲 ${free}` : ""} · 打开 Job`,
  ram: "内存",
  ramLabel: "Job 预留的内存",
  reserved: (value) => `已预留 ${value}`,
  free: (value) => ` · 空闲 ${value}`,
  planFor: (account) => `${account} 的 Claude 套餐用量，按 Claude Code 上次的报告`,
  plan: "Claude 套餐用量，按 Claude Code 上次的报告",
  windowReset: (name) => `${name} 已重置`,
  windowResetSince: (name) => `${name}：此后已重置`,
  windowUsed: (name, percent, resets) => `${name}：已用 ${percent}%${resets ? `，${resets} 重置` : ""}`,
  reported: (when) => `报告于 ${when}。`,
  limited: "已达到限额。",
  codexWaiting: "等待中",
  codexUnknown: "未知",
  lastReport: " · 上次报告",
  codexTitle: (who, source) => `Codex 套餐用量${who ? `（${who}）` : ""}，来自 ${source}`,
  codexStale: "这是上次的报告；请在 Agent 的详情中刷新。",
  codexNotAllowed: "不允许普通用量（据报告）。",
  machines: (count, down) => `${count} 台机器${down ? ` · ${down} 台无法连接` : ""}`,
  checked: (reachable, when) => `上次检查时${reachable ? "可以连接" : "无法连接"}，${when}`,
  unchecked: "尚未检查",
  machine: (name, check, off) => `${name}：${check}${off ? `；${off} 个 Agent 已断开` : ""}`,
  openMachines: "打开“机器”",
});
type Words = ReturnType<typeof words>;

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
  const language = useLanguage();
  const t = words(language);
  const background = useBackground(revision, !previewMode, language);
  const plan = usePlan(claudeRuntime, language);
  const codex = useCodex(previewMode ? null : codexAgent ?? null, eventConnection === "open", language);
  const machines = useMachines(machinesRevision, !previewMode, agents, language);
  return (
    <footer className="statusbar">
      <div className="statusbar-start">
        {previewMode && <span className="statusbar-item">{t.specimen}</span>}
        {!previewMode && eventConnection !== "open" && (
          <span className="statusbar-item event-connection-status" role="status">
            {eventConnection === "reconnecting" ? t.reconnecting : t.connecting}
          </span>
        )}
        {!previewMode && <CoreBacklog agents={agents} live={live} />}
        {background.reviews > 0 && (
          <button
            type="button"
            className="statusbar-item"
            title={t.reviewsTitle}
            onClick={() => openJobs({ source: "reviews" })}
          >
            <GitPullRequest size={12} aria-hidden="true" />
            {t.reviews(background.reviews)}
          </button>
        )}
        {(background.ci > 0 || background.ciPartial) && (
          <button
            type="button"
            className="statusbar-item"
            title={t.ciTitle(background.ciPartial)}
            onClick={() => openJobs({ source: "github_actions" })}
          >
            <Workflow size={12} aria-hidden="true" />
            {background.ci === 0 ? t.ciUnread : t.ci(background.ci, background.ciPartial)}
          </button>
        )}
        <span className="statusbar-notice" role="status" aria-live="polite">
          {background.notice && (
            <button
              type="button"
              className={`statusbar-item ${background.notice.ok ? "is-ok" : "is-failed"}`}
              title={t.noticeTitle(background.notice.text, background.more)}
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
        {background.budget && <Memory budget={background.budget} t={t} />}
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
/** An end to tell, kept as what ended and worded where it is shown. */
type Ended =
  | { kind: "review"; number: number; status: string; conclusion: string | null }
  | { kind: "run"; name: string; status: string }
  | { kind: "job"; name: string; status: string };
type Notice = { key: string; what: Ended; ok: boolean; open: () => void };

const gib = (miB: number) =>
  miB >= 1024 ? `${(miB / 1024).toFixed(1)} GiB` : `${Math.round(miB)} MiB`;
const share = (used: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

/** Job memory reserved against its budget, and what the host has free. */
function Memory({ budget, t }: { budget: Budget; t: Words }) {
  const used = share(budget.reserved.memoryMiB, budget.budget.memoryMiB);
  const free = budget.machine.memoryAvailableMiB == null ? null : gib(budget.machine.memoryAvailableMiB);
  const host = free === null ? "" : t.free(free);
  const cpu = (millis: number) => Number((millis / 1000).toFixed(1));
  const value = `${gib(budget.reserved.memoryMiB)} / ${gib(budget.budget.memoryMiB)}`;
  return (
    <button
      type="button"
      className="statusbar-item statusbar-memory"
      title={t.memoryTitle(budget.machine.name, value, cpu(budget.reserved.cpuMillis), cpu(budget.budget.cpuMillis), free)}
      onClick={() => openJobs({ source: "local" })}
    >
      <span>{t.ram}</span>
      <span
        className="statusbar-meter"
        role="meter"
        aria-label={t.ramLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={t.reserved(value)}
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
const reviewOk = (r: ReviewRow) => r.status === "completed" && reviewPassed(r);
/** What an end says, in the bar's words; Core's status values as they came. */
function endedText(what: Ended, t: Words): string {
  if (what.kind === "run") return t.run(what.name, what.status);
  if (what.kind === "job")
    return t.job(what.name, what.status === "succeeded" ? t.finished : stopped.has(what.status) ? t.failed : what.status);
  const outcome =
    what.status !== "completed"
      ? what.status
      : what.conclusion === "no_findings"
        ? t.noFindings
        : what.conclusion === "approved_with_notes"
          ? t.suggestions
          : (what.conclusion || "unknown").replace(/_/g, " ");
  return t.review(what.number, outcome);
}

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
export function useBackground(revision: string, enabled: boolean, language: Language = "en") {
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
            tell({
              key: `review:${row.id}`,
              ok: reviewOk(row),
              what: { kind: "review", number: row.number, status: row.status, conclusion: row.conclusion ?? null },
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
              what: { kind: "run", name: run.name, status: run.status },
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
              what: { kind: "job", name: job.name, status: job.status },
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
  // Worded now, so a language change rewords the end on show.
  const first = notices[0];
  const notice = first ? { ...first, text: endedText(first.what, words(language)) } : null;
  return { reviews, ci, ciPartial, budget, notice, more: Math.max(0, notices.length - 1) };
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
function usePlan(runtime?: ClaudeRuntime | null, language: Language = "en") {
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
  const t = words(language);
  return {
    limited,
    text: windows.map((w) => (w.expired ? t.windowReset(w.name) : `${w.name} ${w.percent}%`)).join(" · "),
    title: [
      plan.account ? t.planFor(plan.account) : t.plan,
      ...windows.map((w) => (w.expired ? t.windowResetSince(w.name) : t.windowUsed(w.name, w.percent, w.resets || null))),
      t.reported(new Date(plan.rateLimitsAt).toLocaleString()),
      limited ? t.limited : "",
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
export function useCodex(agent: Agent | null, streamConnected: boolean, language: Language = "en") {
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
  const t = words(language);
  return {
    stale,
    limited,
    text:
      windows
        .map((w, i) => `${labels[i]} ${w.expired ? t.codexWaiting : w.percent === null ? t.codexUnknown : `${w.percent}%`}`)
        .join(" · ") + (stale ? t.lastReport : ""),
    title: [
      t.codexTitle(who, usage.source.label),
      ...windows.map((w) => w.detail.replace(/\s+/g, " ").trim()),
      stale ? t.codexStale : "",
      usage.ordinaryUsageAllowed === false ? t.codexNotAllowed : "",
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
function useMachines(revision: string, enabled: boolean, agents: Agent[], language: Language = "en") {
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
  const t = words(language);
  return {
    unreachable: down.length,
    text: t.machines(remote.length, down.length),
    title: [
      ...remote.map((m) => {
        const check = m.lastCheck
          ? t.checked(m.lastCheck.reachable, new Date(m.lastCheck.checkedAt).toLocaleString())
          : t.unchecked;
        const off = agents.filter(
          (a) => !a.closedAt && a.remote?.machine.id === m.id && a.connectionState === "disconnected",
        ).length;
        return t.machine(m.name, check, off);
      }),
      t.openMachines,
    ].join("\n"),
  };
}
