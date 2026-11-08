import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, errorText } from "./api";
import { strings, useLanguage } from "./i18n";
import { lifecycleText, type ExecutorLifecycle } from "./executor-lifecycle";
import { elapsedText } from "./executor-display";
import { useMinute } from "./live-executors";
import type { Agent } from "./types";
import "./executor-overview.css";

/** An executor's Overview as Core reads it (GET /api/agents/{id}/executor,
 * T-43 S3): only what this tab shows. */
export type ExecutorOverviewData = {
  agentId: string;
  lifecycle: ExecutorLifecycle & { state: string };
  task: { id: string; title: string; status: string } | null;
  template?: { id?: string | null; label?: string | null; deliveryMode?: string | null } | null;
  materials: {
    capturedAt?: string | null; acceptance?: string | null; repository?: string | null; baseSha?: string | null;
    worktree?: string | null; returnRequirements?: string | null; handoverVersion?: number | null; contextSummary?: string | null;
  } | null;
  steps: Step[];
  jobs: { id: string; name?: string | null; status: string; reason?: string | null; finishedAt?: string | null }[];
  pullRequest: {
    number: number; url?: string | null; title?: string | null; state?: string | null;
    ci?: { state?: string | null } | null;
    latestReview?: { reviewId?: string | null; round?: number | null; status?: string | null; conclusion?: string | null; forCurrentHead?: boolean | null } | null;
    changes?: { additions: number; deletions: number; files: number } | null;
  } | null;
  merge: { id: string; state: string; reason?: string | null } | null;
  result: { id?: string | null; summary?: string | null; reportedAt?: string | null; status?: string | null } | null;
};
type StepState = "done" | "doing" | "blocked" | "failed" | "todo";
type Step = {
  kind: string; label?: string | null; rounds?: number | null; approver?: string | null; state: StepState;
  ref?: { kind: string; [key: string]: unknown } | null;
};

// The Overview's own words (T-43 S3). Task titles, template labels, summaries
// and reasons are shown as they came.
const text = strings({
  tabs: "This executor's session",
  tab: { overview: "Overview", conversation: "Conversation" } as Record<ExecutorPaneTab, string>,
  loading: "Reading this executor's overview…",
  failed: (error: string) => `Couldn't read this executor's overview: ${error}`,
  retry: "Try again",
  template: (label: string) => `Template ${label}`,
  general: "General executor",
  by: (name: string) => `Dispatched by ${name}`,
  byYou: "Dispatched by you",
  elapsed: (time: string) => `On it for ${time}`,
  materials: "Starting materials",
  materialsNote: "From the dispatch's snapshot · read-only",
  noMaterials: "This dispatch kept no materials.",
  acceptance: "Acceptance",
  repository: "Repository @ base",
  worktree: "Worktree",
  returns: "Return requirements",
  handover: "Handover version",
  context: "Context summary",
  steps: "Steps",
  stepsNote: "The template's steps · each read from its record",
  more: (count: number) => `${count} more`,
  fewer: "Fewer",
  stepKind: {
    materials: "Read the materials", work: "Work", result: "Submit a result", gate: "Wait for approval", job: "Run a Job",
    pr: "Pull request", review: "Review", ci: "CI", merge: "Merge",
  } as Record<string, string>,
  stepState: { done: "done", doing: "under way", blocked: "waiting for you", failed: "failed", todo: "not yet" } as Record<StepState, string>,
  reviewRounds: (rounds: number) => `${rounds} rounds`,
  ask: { open: "asked on Home", replied: "answered", resolved: "answered" } as Record<string, string>,
  approver: { user: "By you", lead: "By a lead", either: "By you or a lead" } as Record<string, string>,
  now: "Doing now",
  nothingNow: "Nothing reported yet.",
  waiting: "Needs you",
  waitingNote: "Answer here, in its conversation or on Home: one answer settles it everywhere.",
  changes: "Changes",
  changesSize: (add: number, del: number, files: number) => `+${add} −${del} · ${files} ${files === 1 ? "file" : "files"}`,
  noChanges: "No pull request yet.",
  changesUnknown: "Not read from GitHub yet.",
  evidence: "Evidence",
  evidenceNote: "Each with its own conclusion",
  noEvidence: "No Jobs, reviews or CI yet.",
  job: "Job",
  redGreen: "Red → green",
  review: "Review",
  ci: "CI",
  merge: "Merge",
  round: (n: number) => `round ${n}`,
  openTask: "Open task",
  report: "Final report",
  reported: (at: string) => `Handed in ${at}`,
  noReport: "No result handed in yet.",
}, {
  tabs: "这个执行者的会话",
  tab: { overview: "概览", conversation: "会话" },
  loading: "正在读取这个执行者的概览…",
  failed: (error) => `读取执行者概览失败：${error}`,
  retry: "重试",
  template: (label) => `模板 ${label}`,
  general: "通用执行者",
  by: (name) => `派发者 ${name}`,
  byYou: "派发者 你",
  elapsed: (time) => `已用 ${time}`,
  materials: "起始材料",
  materialsNote: "来自派发快照 · 只读",
  noMaterials: "这次派发没有留下材料快照。",
  acceptance: "验收",
  repository: "仓库@基线",
  worktree: "工作树",
  returns: "返回要求",
  handover: "交接版本",
  context: "上下文摘要",
  steps: "阶段",
  stepsNote: "模板的步骤 · 每步从它的记录读出",
  more: (count) => `还有 ${count} 步`,
  fewer: "收起",
  stepKind: {
    materials: "读材料", work: "工作", result: "提交结果", gate: "等批准", job: "跑 Job",
    pr: "PR", review: "审查", ci: "CI", merge: "合并",
  },
  stepState: { done: "完成", doing: "进行中", blocked: "等你", failed: "失败", todo: "未开始" },
  reviewRounds: (rounds) => `${rounds} 轮`,
  ask: { open: "已在 Home 提问", replied: "已回答", resolved: "已回答" },
  approver: { user: "由你批", lead: "由负责人批", either: "由你或负责人批" },
  now: "正在做",
  nothingNow: "还没有报告。",
  waiting: "等你",
  waitingNote: "在这里、会话里或 Home 回答都行，答一处各处都解决。",
  changes: "变更",
  changesSize: (add, del, files) => `+${add} −${del} · ${files} 个文件`,
  noChanges: "还没有 PR。",
  changesUnknown: "还没从 GitHub 读到。",
  evidence: "证据坞",
  evidenceNote: "每项自己的结论",
  noEvidence: "还没有 Job、审查或 CI。",
  job: "Job",
  redGreen: "红 → 绿",
  review: "审查",
  ci: "CI",
  merge: "合并",
  round: (n) => `第 ${n} 轮`,
  openTask: "打开任务",
  report: "收尾报告",
  reported: (at) => `提交于 ${at}`,
  noReport: "还没有提交结果。",
});

/** How many steps show before "more". */
const SHOWN_STEPS = 5;
const short = (sha?: string | null) => (sha ? sha.slice(0, 8) : "");
const when = (iso: string | null | undefined, language: string) => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString(language, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};
/** A record's tone, as its own conclusion says. */
const tone = (status?: string | null): "ok" | "bad" | "wait" | "none" =>
  !status ? "none"
    : ["succeeded", "success", "no_findings", "approved_with_notes", "merged", "done"].includes(status) ? "ok"
      : ["failed", "failure", "changes_requested", "stopped", "cancelled", "timed_out", "rejected", "interrupted", "error"].includes(status) ? "bad"
        : "wait";

/** What a step's record says, in a few words. */
function stepRef(step: Step, t: ReturnType<typeof text>): string {
  const ref = step.ref;
  if (!ref) return step.kind === "gate" && step.approver ? t.approver[step.approver] ?? "" : step.kind === "review" && step.rounds ? t.reviewRounds(step.rounds) : "";
  const s = (key: string) => (typeof ref[key] === "string" ? (ref[key] as string) : typeof ref[key] === "number" ? String(ref[key]) : "");
  switch (ref.kind) {
    case "mail": return "";
    case "result": return short(s("id"));
    case "job": return [s("name"), s("status")].filter(Boolean).join(" · ");
    case "pr": return `#${s("number")}`;
    case "review": return [s("round") && t.round(Number(s("round"))), s("conclusion")].filter(Boolean).join(" · ");
    case "ci": return s("state");
    case "merge": return s("state");
    // Its gate's Home Ask (T-43 S4).
    case "ask": return t.ask[s("state")] ?? "";
    default: return "";
  }
}

/**
 * A long material, capped and scrolling inside (YN-46): the cap is
 * executor-overview.css's (about 12 lines); a short one keeps its own height.
 * While more of it is below or above, it says so with a fade at that edge,
 * and only then is it a region a keyboard can scroll.
 */
function CappedText({ text, label }: { text: string; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((was) => (was.above === above && was.below === below ? was : { above, below }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    // Its width, the text size or its card opening again change what fits.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      observer?.disconnect();
    };
  }, [text]);
  const scrolls = edges.above || edges.below;
  return (
    <div ref={box} className="executor-overview-capped" data-above={edges.above || undefined} data-below={edges.below || undefined}
      {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": label } : {})}>
      {text}
    </div>
  );
}

type Job = ExecutorOverviewData["jobs"][number];

/** Its red Job and the green one after it (T-43 S5, a red-first template's
 * evidence side by side): the first job step whose Job failed and the next
 * job step after it whose Job succeeded, as its steps read their records;
 * each as its Job list has it. None without both. */
export function redGreen(steps: Step[], jobs: Job[]): { red: Job; green: Job } | null {
  const ran = (step: Step | undefined): Job | null => {
    const ref = step?.kind === "job" && step.ref?.kind === "job" ? step.ref : null;
    if (!ref || typeof ref.id !== "string") return null;
    return jobs.find((j) => j.id === ref.id) ?? { id: ref.id, name: typeof ref.name === "string" ? ref.name : null, status: String(ref.status ?? "") };
  };
  const at = steps.findIndex((step) => ran(step)?.status === "failed");
  if (at < 0) return null;
  const red = ran(steps[at])!;
  const green = steps.slice(at + 1).map(ran).find((job) => job?.status === "succeeded");
  return green ? { red, green } : null;
}

/**
 * An executor's Overview (T-43 S3, the user's preview): its task, template
 * and dispatcher; its starting materials; its template's steps each with the
 * state its record gives; what it is doing now; a banner while it needs you;
 * its PR's changes; its evidence (its Jobs, the PR's review and CI, the merge
 * entry), each with its own conclusion; and its result. The same records as
 * its Conversation, read another way. On a wide pane its steps and what it is
 * doing now are a column of their own beside the rest (YN-46).
 */
export function ExecutorOverview({ agent, revision, requests, asks, onOpenTask }: {
  agent: Agent;
  /** Read again when this changes: a collaboration, Jobs or merge change. */
  revision: string;
  /** Its native requests' cards, answered here while this tab shows: the
   * same cards its Conversation shows otherwise. */
  requests?: ReactNode;
  /** Its gate asks on Home (T-43 S4), answered here: the same cards its
   * Conversation shows. */
  asks?: ReactNode;
  onOpenTask: (taskId: string) => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const states = lifecycleText(language);
  const now = useMinute();
  const [data, setData] = useState<ExecutorOverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [allSteps, setAllSteps] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api<ExecutorOverviewData>(`/agents/${encodeURIComponent(agent.id)}/executor`, { signal: controller.signal })
      .then(setData)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [agent.id, revision, attempt]);
  if (!data || data.agentId !== agent.id)
    return (
      <section className="executor-overview" id="executor-overview" role="tabpanel" aria-labelledby="executor-tab-overview" aria-busy={!error}>
        {error ? <p className="executor-overview-error" role="alert">{t.failed(error)} <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t.retry}</button></p>
          : <p className="executor-overview-loading">{t.loading}</p>}
      </section>
    );
  const life = data.lifecycle;
  const dispatcher = life.dispatcher;
  const started = life.dispatchedAt ? Date.parse(life.dispatchedAt) : NaN;
  const waiting = agent.pendingCount > 0 || agent.status === "waiting";
  const steps = allSteps ? data.steps : data.steps.slice(0, SHOWN_STEPS);
  const pr = data.pullRequest;
  const review = pr?.latestReview && pr.latestReview.forCurrentHead ? pr.latestReview : null;
  // A red Job and the green one after it, side by side in one row (S5).
  const pair = redGreen(data.steps, data.jobs);
  const others = pair ? data.jobs.filter((job) => job.id !== pair.red.id && job.id !== pair.green.id) : data.jobs;
  const m = data.materials;
  return (
    <section className="executor-overview" id="executor-overview" role="tabpanel" aria-labelledby="executor-tab-overview">
      <header className="executor-overview-head">
        {data.task && <h2>{data.task.id} <span>· {data.task.title}</span></h2>}
        <div className="executor-overview-chips">
          <span className="chip template">{data.template?.label ? t.template(data.template.label) : t.general}</span>
          {dispatcher && <span className="chip">{dispatcher.kind === "user" ? t.byYou : t.by(dispatcher.name || dispatcher.id)}</span>}
          <span className="chip state" data-state={life.state}>{states.states[life.state as keyof typeof states.states] ?? life.state}</span>
          {Number.isFinite(started) && <span className="chip">{t.elapsed(elapsedText(Math.max(0, now - started), language))}</span>}
          {data.task && <button type="button" className="chip link" onClick={() => onOpenTask(data.task!.id)}>{t.openTask}</button>}
        </div>
      </header>
      {/* The approvals it asked for on Home (T-43 S4), each answered in place. */}
      {asks}
      {/* Its requests' own cards say Needs you; a question it asked to be
          answered later is in the panel under this tab. */}
      {waiting && (requests ? (
        <div className="executor-overview-requests">
          {requests}
          <p className="note">{t.waitingNote}</p>
        </div>
      ) : (
        <div className="executor-overview-banner">
          <h3>{t.waiting}</h3>
          <p className="note">{t.waitingNote}</p>
        </div>
      ))}
      <details className="executor-overview-card" open>
        <summary><h3>{t.materials}</h3><span className="note">{t.materialsNote}</span></summary>
        {m ? (
          <dl className="executor-overview-kv">
            {m.acceptance && <><dt>{t.acceptance}</dt><dd><CappedText text={m.acceptance} label={t.acceptance} /></dd></>}
            {(m.repository || m.baseSha) && <><dt>{t.repository}</dt><dd>{m.repository ?? ""}{m.baseSha ? ` @ ${short(m.baseSha)}` : ""}</dd></>}
            {m.worktree && <><dt>{t.worktree}</dt><dd><code>{m.worktree}</code></dd></>}
            {m.returnRequirements && <><dt>{t.returns}</dt><dd><CappedText text={m.returnRequirements} label={t.returns} /></dd></>}
            {m.handoverVersion != null && <><dt>{t.handover}</dt><dd>v{m.handoverVersion}</dd></>}
            {m.contextSummary && <><dt>{t.context}</dt><dd className="clamped">{m.contextSummary}</dd></>}
          </dl>
        ) : <p className="empty">{t.noMaterials}</p>}
      </details>
      {/* Its steps and what it is doing now: their own column when the pane
          is wide enough, beside the rest (YN-46, executor-overview.css). */}
      <div className="executor-overview-progress">
        <section className="executor-overview-card">
          <h3>{t.steps} <span className="note">{t.stepsNote}</span></h3>
          <ol className="executor-overview-steps">
            {steps.map((step, i) => (
              <li key={i} className="step" data-state={step.state}>
                <span className="mark" aria-hidden="true" />
                {/* Its place, so "step 2" in an ask points somewhere (S5); the list says it to a screen reader. */}
                <span className="no" aria-hidden="true">{i + 1}</span>
                <span className="label">{step.label || t.stepKind[step.kind] || step.kind}</span>
                <span className="state">{t.stepState[step.state]}</span>
                <span className="ref">{stepRef(step, t)}</span>
              </li>
            ))}
          </ol>
          {data.steps.length > SHOWN_STEPS && (
            <button type="button" className="more" onClick={() => setAllSteps((v) => !v)} aria-expanded={allSteps}>
              {allSteps ? t.fewer : t.more(data.steps.length - SHOWN_STEPS)}
            </button>
          )}
        </section>
        <p className="executor-overview-now"><strong>{t.now}</strong>{agent.workSummary?.text || t.nothingNow}</p>
      </div>
      <section className="executor-overview-card">
        <h3>{t.changes} {pr?.changes && <span className="note">{t.changesSize(pr.changes.additions, pr.changes.deletions, pr.changes.files)}</span>}</h3>
        {!pr ? <p className="empty">{t.noChanges}</p>
          : <p>{pr.url ? <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}{pr.title ? ` · ${pr.title}` : ""}</a> : `#${pr.number}`}
            {!pr.changes && <span className="empty"> · {t.changesUnknown}</span>}</p>}
      </section>
      <section className="executor-overview-card">
        <h3>{t.evidence} <span className="note">{t.evidenceNote}</span></h3>
        {!data.jobs.length && !pr && !data.merge ? <p className="empty">{t.noEvidence}</p> : (
          <ul className="executor-overview-evidence">
            {pair && (
              <li className="pair"><span className="k">{t.redGreen}</span>
                <span className="n">{pair.red.name || pair.red.id} → {pair.green.name || pair.green.id}</span>
                <span className="v"><span data-tone="bad">{pair.red.status}</span> → <span data-tone="ok">{pair.green.status}</span></span></li>
            )}
            {others.map((job) => (
              <li key={job.id}><span className="k">{t.job}</span><span className="n">{job.name || job.id}</span>
                <span className="v" data-tone={tone(job.status)}>{job.status}</span></li>
            ))}
            {review && (
              <li><span className="k">{t.review}</span><span className="n">#{pr!.number}{review.round ? ` · ${t.round(review.round)}` : ""}</span>
                <span className="v" data-tone={tone(review.conclusion || review.status)}>{review.conclusion || review.status}</span></li>
            )}
            {pr?.ci?.state && (
              <li><span className="k">{t.ci}</span><span className="n">#{pr.number}</span><span className="v" data-tone={tone(pr.ci.state)}>{pr.ci.state}</span></li>
            )}
            {data.merge && (
              <li><span className="k">{t.merge}</span><span className="n">{data.merge.reason || data.merge.id.slice(0, 8)}</span>
                <span className="v" data-tone={tone(data.merge.state)}>{data.merge.state}</span></li>
            )}
          </ul>
        )}
      </section>
      <section className="executor-overview-card">
        <h3>{t.report} {data.result?.reportedAt && <span className="note">{t.reported(when(data.result.reportedAt, language))}</span>}</h3>
        {data.result?.summary ? <p className="executor-overview-report">{data.result.summary}</p> : <p className="empty">{t.noReport}</p>}
      </section>
    </section>
  );
}

export type ExecutorPaneTab = "overview" | "conversation";
const PANE_TABS: ExecutorPaneTab[] = ["overview", "conversation"];

/** An executor's two tabs (T-43 S3): its Overview and its Conversation, two
 * readings of the same records. The Conversation's panel is App's
 * conversation body, id executor-conversation. */
export function ExecutorPaneTabs({ tab, onChoose }: { tab: ExecutorPaneTab; onChoose: (tab: ExecutorPaneTab) => void }) {
  const t = text(useLanguage());
  const refs = useRef<Partial<Record<ExecutorPaneTab, HTMLButtonElement | null>>>({});
  const keys = (event: KeyboardEvent, from: ExecutorPaneTab) => {
    const i = PANE_TABS.indexOf(from);
    const to = event.key === "ArrowRight" ? PANE_TABS[(i + 1) % PANE_TABS.length]
      : event.key === "ArrowLeft" ? PANE_TABS[(i + PANE_TABS.length - 1) % PANE_TABS.length]
        : event.key === "Home" ? PANE_TABS[0] : event.key === "End" ? PANE_TABS[PANE_TABS.length - 1] : null;
    if (!to) return;
    event.preventDefault();
    onChoose(to);
    refs.current[to]?.focus();
  };
  return (
    <div className="executor-tabs" role="tablist" aria-label={t.tabs}>
      {PANE_TABS.map((value) => (
        <button key={value} type="button" role="tab" id={`executor-tab-${value}`} aria-selected={tab === value}
          aria-controls={value === "overview" ? "executor-overview" : "executor-conversation"} tabIndex={tab === value ? 0 : -1}
          ref={(element) => { refs.current[value] = element; }} onKeyDown={(event) => keys(event, value)} onClick={() => onChoose(value)}>
          {t.tab[value]}
        </button>
      ))}
    </div>
  );
}
