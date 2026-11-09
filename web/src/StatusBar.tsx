import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, Ellipsis, GitPullRequest, Server, ServerOff, Sparkles, Unplug, Workflow, X } from "lucide-react";
import { api } from "./api";
import { CoreBacklog, backlogWords } from "./CoreBacklog";
import { limitWindows } from "./ClaudeControls";
import { duration, usageWindows, useCodexUsage } from "./CodexPlanUsage";
import { openJobs } from "./Jobs";
import { runActive, type Run } from "./CiJobs";
import type { ReviewRow } from "./ReviewJobs";
import { reviewPassed } from "./review-outcome";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import type { Agent, ClaudeRuntime } from "./types";
import { strings, useLanguage, type Language } from "./i18n";
import { Tip, TipLines, TipText } from "./Tip";
import { useStatusbarFit, type FitItem, type Form } from "./statusbar-fit";
import "./statusbar.css";

// The bottom bar's own words (T-189). Names of jobs, runs and machines, Core's
// status values, and the plan windows' names and details (as the Agent
// panels show them) are shown as they came.
const words = strings({
  specimen: "Visual specimen",
  reconnecting: "Live updates reconnecting",
  connecting: "Live updates connecting",
  // Shorter forms for a bar without room (YN-75); the full words stay in
  // the item's name and tip.
  reconnectingShort: "Reconnecting",
  connectingShort: "Connecting",
  reviewsTip: "PR reviews in progress",
  reviews: (count: number) => `${count} ${count === 1 ? "review" : "reviews"} running`,
  ciTip: "GitHub Actions runs in progress",
  ciPartial: "Core lists more runs than the status bar read, so there may be more",
  ciUnread: "CI runs not all read",
  ci: (count: number, partial: boolean) => `${count}${partial ? "+" : ""} CI ${count === 1 && !partial ? "run" : "runs"}`,
  noticeMore: (more: number) => `${more} more after it`,
  review: (number: number, outcome: string) => `Review of PR #${number}: ${outcome}`,
  noFindings: "no findings",
  suggestions: "passed with suggestions",
  run: (name: string, status: string) => `${name} run ${status}`,
  job: (name: string, outcome: string) => `Job ${name} ${outcome}`,
  // An end said without the name, which is what can be long.
  reviewShort: (outcome: string) => `Review: ${outcome}`,
  runShort: (status: string) => `Run ${status}`,
  jobShort: (outcome: string) => `Job ${outcome}`,
  finished: "finished",
  failed: "failed",
  memoryTip: (value: string, used: number, cpu: number) => `Jobs reserve ${value} of RAM and ${used} / ${cpu} CPU`,
  hostFree: (free: string) => `The host has ${free} free`,
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
  machines: (count: number, down: number, off: number) =>
    [
      `${count} ${count === 1 ? "machine" : "machines"}`,
      down ? `${down} unreachable` : "",
      off ? `${off} ${off === 1 ? "Agent" : "Agents"} disconnected` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  checked: (reachable: boolean, when: string) => `${reachable ? "reachable" : "unreachable"} at its last check, ${when}`,
  unchecked: "not checked yet",
  machine: (name: string, check: string, off: string[]) =>
    `${name}: ${check}${off.length ? `; ${off.length === 1 ? "Agent" : "Agents"} disconnected: ${off.join(", ")}` : ""}`,
  openMachines: "Open Machines",
  // What did not fit in the bar, behind "⋯" (YN-75).
  more: (count: number) => `${count} more in the status bar`,
  moreList: "Not shown in the status bar for lack of room",
  // The way into all of this from the toolbar, where the bar itself has no
  // room to stand (T-15 V5).
  details: "Core and background work",
  detailsNeed: (count: number) => `${count} need${count === 1 ? "s" : ""} a look`,
  detailsQuiet: "nothing needs a look",
  // Core's own state, said in words: in the entry's name always, beside the
  // dot whenever it is not simply connected, and in the panel (T-15 V5).
  detailsCore: (core: string, work: string) => `${core} · ${work}`,
}, {
  specimen: "视觉样本",
  reconnecting: "实时更新正在重新连接",
  connecting: "实时更新正在连接",
  reconnectingShort: "正在重新连接",
  connectingShort: "正在连接",
  reviewsTip: "正在进行的 PR 审查",
  reviews: (count) => `${count} 个审查进行中`,
  ciTip: "正在进行的 GitHub Actions 运行",
  ciPartial: "Core 列出的运行比状态栏读取的多，因此可能还有更多",
  ciUnread: "CI 运行未全部读取",
  ci: (count, partial) => `${count}${partial ? "+" : ""} 个 CI 运行`,
  noticeMore: (more) => `之后还有 ${more} 条`,
  review: (number, outcome) => `PR #${number} 的审查：${outcome}`,
  noFindings: "无发现",
  suggestions: "通过，附建议",
  run: (name, status) => `${name} 运行 ${status}`,
  job: (name, outcome) => `Job ${name} ${outcome}`,
  reviewShort: (outcome) => `审查：${outcome}`,
  runShort: (status) => `运行 ${status}`,
  jobShort: (outcome) => `Job ${outcome}`,
  finished: "已完成",
  failed: "已失败",
  memoryTip: (value, used, cpu) => `Job 预留 ${value} 内存和 ${used} / ${cpu} CPU`,
  hostFree: (free) => `主机空闲 ${free}`,
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
  machines: (count, down, off) =>
    [`${count} 台机器`, down ? `${down} 台无法连接` : "", off ? `${off} 个 Agent 未连接` : ""].filter(Boolean).join(" · "),
  checked: (reachable, when) => `上次检查时${reachable ? "可以连接" : "无法连接"}，${when}`,
  unchecked: "尚未检查",
  machine: (name, check, off) => `${name}：${check}${off.length ? `；未连接的 Agent：${off.join("、")}` : ""}`,
  openMachines: "打开“机器”",
  more: (count) => `状态栏里还有 ${count} 项`,
  moreList: "状态栏放不下的项",
  details: "Core 与后台工作",
  detailsNeed: (count) => `${count} 个待查看`,
  detailsQuiet: "没有待查看的",
  detailsCore: (core, work) => `${core} · ${work}`,
});
type Words = ReturnType<typeof words>;

/** An item of the bar: how it gives way, and what it says in each form. */
type Entry = FitItem & {
  say: (form: Form) => ReactNode;
  /** The item as the bar draws it, around its words. Items without one
   * (news) are drawn in their place by the bar and never go behind "⋯". */
  wrap?: (words: ReactNode, form: Form) => ReactNode;
  /** Its own measuring element, when the item is not a plain one. */
  measure?: (form: Form) => ReactNode;
};
/** A shorter form: the full words are its name; what shows is the rest. */
const short = (full: string, ...shows: ReactNode[]) => (
  <>
    <span className="sr-only">{full}</span>
    <span className="statusbar-short" aria-hidden="true">
      {shows.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </span>
  </>
);
const count = (value: number | string) => <span className="statusbar-count">{value}</span>;

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
  coreLabel,
  coreHealthy,
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
  /** How Core is, in the words the toolbar says it in (coreConnection). */
  coreLabel: string;
  coreHealthy: boolean;
  onMachines: () => void;
}) {
  const language = useLanguage();
  const t = words(language);
  const background = useBackground(revision, !previewMode, language);
  const plan = usePlan(claudeRuntime, language);
  const codex = useCodex(previewMode ? null : codexAgent ?? null, eventConnection === "open", language);
  const machines = useMachines(machinesRevision, !previewMode, agents, language);
  // On a middle-sized workbench this bar costs 27px of a 669px-tall screen to
  // hold what is quiet most of the time, so there it stops being a bar and
  // becomes a panel under the toolbar, opened from the Core status entry
  // (T-15 V5). Which of the two applies is decided in CSS — statusbar.css,
  // by the same screen it is a rule about — and this subtree is mounted once
  // either way: as two copies, everything in it that reads from Core (its
  // backlog among them) would have asked Core twice.
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const entry = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("core-status-slot")), []);
  // Escape and a press outside close it, and Escape hands focus back, which
  // a press does not: the press has already chosen where it is going.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      entry.current?.focus();
    };
    const onDown = (event: PointerEvent) => {
      const at = event.target as Node | null;
      if (!at || panel.current?.contains(at) || entry.current?.contains(at)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  // The live updates, said in words when they are not simply open. Core can
  // answer while its stream is reconnecting, and the bar shows that on its
  // own line; folded into the entry it was neither counted nor announced,
  // because the entry read `coreHealthy` only (#459 new pair, P3).
  const stream =
    previewMode || eventConnection === "open"
      ? ""
      : eventConnection === "reconnecting"
        ? t.reconnecting
        : t.connecting;
  // What the entry says while it is closed, so that folding the bar away
  // hides nothing that was asking for attention. Counts of work in progress
  // (reviews, CI runs) are not in it: those are going on, not waiting.
  const needsLook =
    (background.notice && !background.notice.ok ? 1 : 0) +
    (machines?.unreachable || 0) +
    (plan?.limited ? 1 : 0) +
    (codex?.limited ? 1 : 0) +
    (stream ? 1 : 0);
  // "Simply connected" is Core answering *and* its updates open: either one
  // short of that is written out, not left to the dot's colour (row 6).
  const settled = coreHealthy && !stream;
  // Both states in the words it is read by, each said once.
  const said = [coreLabel, stream].filter(Boolean).join(" · ");

  // Every item the bar holds now, with what it says in each of its forms
  // (YN-75). When there is no room for all of them in full, the least
  // important gives way first, to a shorter form and then behind "⋯"
  // (statusbar-fit.ts); a shorter form keeps the full words as its name, and
  // its tip says everything. Ranks: within a tier, a lower rank gives way
  // first. A plan at its limit or a machine not reached is news.
  const [backlogShown, setBacklogShown] = useState(false);
  const backlogSays = backlogWords(language);
  const entries: Entry[] = [];
  if (previewMode) entries.push({ id: "specimen", side: "start", tier: "news", rank: 6, forms: [], say: () => t.specimen });
  if (stream)
    entries.push({
      id: "stream",
      side: "start",
      tier: "news",
      rank: 5,
      forms: ["compact"],
      say: (form) => (form === "full" ? stream : short(stream, eventConnection === "reconnecting" ? t.reconnectingShort : t.connectingShort)),
    });
  if (!previewMode && backlogShown)
    entries.push({
      id: "backlog",
      side: "start",
      tier: "news",
      rank: 4,
      forms: ["compact"],
      say: (form) => (form === "full" ? backlogSays.hint : backlogSays.region),
      // Measured as CoreBacklog draws it: the hint's own padding and rule,
      // from a class of its own so nothing looking for the hint finds this.
      measure: (form) => (
        <span className="statusbar-measure-item" data-fit="backlog" data-form={form}>
          <span className="statusbar-measure-backlog">{form === "full" ? backlogSays.hint : backlogSays.region}</span>
        </span>
      ),
    });
  if (background.reviews > 0) {
    const text = t.reviews(background.reviews);
    entries.push({
      id: "reviews",
      side: "start",
      tier: "work",
      rank: 2,
      forms: ["icon"],
      say: (form) =>
        form === "full" ? (
          <>
            <GitPullRequest size={12} aria-hidden="true" />
            {text}
          </>
        ) : (
          short(text, <GitPullRequest size={12} />, count(background.reviews))
        ),
      wrap: (words, form) => (
        <Tip content={<TipText title={t.reviewsTip} />}>
          <button type="button" className="statusbar-item" data-item="reviews" data-form={form} onClick={() => openJobs({ source: "reviews" })}>
            {words}
          </button>
        </Tip>
      ),
    });
  }
  if (background.ci > 0 || background.ciPartial) {
    const text = background.ci === 0 ? t.ciUnread : t.ci(background.ci, background.ciPartial);
    entries.push({
      id: "ci",
      side: "start",
      tier: "work",
      rank: 1,
      forms: ["icon"],
      say: (form) =>
        form === "full" ? (
          <>
            <Workflow size={12} aria-hidden="true" />
            {text}
          </>
        ) : (
          short(text, <Workflow size={12} />, count(`${background.ci}${background.ciPartial ? "+" : ""}`))
        ),
      wrap: (words, form) => (
        <Tip content={<TipText title={t.ciTip} body={background.ciPartial ? t.ciPartial : null} />}>
          <button type="button" className="statusbar-item" data-item="ci" data-form={form} onClick={() => openJobs({ source: "github_actions" })}>
            {words}
          </button>
        </Tip>
      ),
    });
  }
  const notice = background.notice;
  if (notice) {
    const icon = notice.ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />;
    const more = background.more > 0 ? <span className="statusbar-more"> +{background.more}</span> : null;
    entries.push({
      id: "notice",
      side: "start",
      tier: "news",
      rank: 7,
      forms: ["compact", "icon"],
      say: (form) =>
        form === "full" ? (
          <>
            {icon}
            {notice.text}
            {more}
          </>
        ) : (
          short(`${notice.text}${background.more > 0 ? ` +${background.more}` : ""}`, icon, form === "compact" ? notice.short : null, more)
        ),
      wrap: (words, form) => (
        <Tip content={<TipText title={notice.text} meta={background.more ? t.noticeMore(background.more) : null} />}>
          <button
            type="button"
            className={`statusbar-item ${notice.ok ? "is-ok" : "is-failed"}`}
            data-item="notice"
            data-form={form}
            onClick={notice.open}
          >
            {words}
          </button>
        </Tip>
      ),
    });
  }
  if (codex) {
    const text = `Codex ${codex.text}`;
    entries.push({
      id: "codex",
      side: "end",
      tier: codex.limited ? "news" : "metric",
      rank: 2,
      forms: ["compact", "icon"],
      say: (form) =>
        form === "full" ? (
          <>
            <Sparkles size={12} aria-hidden="true" />
            {text}
          </>
        ) : (
          short(text, <Sparkles size={12} />, form === "compact" ? `Codex ${codex.top}` : codex.topValue)
        ),
      wrap: (words, form) => (
        <Tip size="wide" content={<TipLines text={codex.title} />}>
          <span
            className={`statusbar-item statusbar-codex${codex.limited ? " is-failed" : ""}${codex.stale ? " is-stale" : ""}`}
            data-item="codex"
            data-form={form}
          >
            {words}
          </span>
        </Tip>
      ),
    });
  }
  if (plan) {
    const text = `Claude ${plan.text}`;
    entries.push({
      id: "claude",
      side: "end",
      tier: plan.limited ? "news" : "metric",
      rank: 3,
      // Only a window still going has a share to show alone.
      forms: plan.top ? ["compact", "icon"] : [],
      say: (form) =>
        form === "full" ? (
          <>
            <Bot size={12} aria-hidden="true" />
            {text}
          </>
        ) : (
          short(text, <Bot size={12} />, form === "compact" ? `Claude ${plan.top}` : plan.topValue)
        ),
      wrap: (words, form) => (
        <Tip size="wide" content={<TipLines text={plan.title} />}>
          <span className={`statusbar-item${plan.limited ? " is-failed" : ""}`} data-item="claude" data-form={form}>
            {words}
          </span>
        </Tip>
      ),
    });
  }
  if (machines) {
    const pairs = [
      <Fragment key="all">
        <Server size={12} />
        {count(machines.count)}
      </Fragment>,
      machines.unreachable > 0 && (
        <Fragment key="down">
          <ServerOff size={12} />
          {count(machines.unreachable)}
        </Fragment>
      ),
      machines.disconnected > 0 && (
        <Fragment key="off">
          <Unplug size={12} />
          {count(machines.disconnected)}
        </Fragment>
      ),
    ].filter(Boolean);
    entries.push({
      id: "machines",
      side: "end",
      tier: machines.unreachable ? "news" : "metric",
      rank: 1,
      forms: ["compact"],
      say: (form) =>
        form === "full" ? (
          <>
            <Server size={12} aria-hidden="true" />
            {machines.text}
          </>
        ) : (
          short(
            machines.text,
            ...pairs.flatMap((pair, i) => (i ? [<span key={`dot${i}`}>·</span>, pair] : [pair])),
          )
        ),
      wrap: (words, form) => (
        <Tip size="wide" content={<TipLines text={machines.title} />}>
          <button
            type="button"
            className={`statusbar-item${machines.unreachable ? " is-failed" : ""}`}
            data-item="machines"
            data-form={form}
            onClick={onMachines}
          >
            {words}
          </button>
        </Tip>
      ),
    });
  }
  if (background.budget) {
    const memory = memoryForms(background.budget, t);
    entries.push({
      id: "ram",
      side: "end",
      tier: "metric",
      rank: 4,
      forms: ["compact", "icon"],
      say: memory.say,
      wrap: (words, form) => (
        <Tip content={memory.tip}>
          <button
            type="button"
            className="statusbar-item statusbar-memory"
            data-item="ram"
            data-form={form}
            onClick={() => openJobs({ source: "local" })}
          >
            {words}
          </button>
        </Tip>
      ),
    });
  }
  const measure = useRef<HTMLDivElement | null>(null);
  const fit = useStatusbarFit(panel, measure, entries);
  const formOf = (id: string): Form => fit.forms[id] ?? "full";
  const shown = (id: string) => {
    const item = entries.find((e) => e.id === id);
    const form = formOf(id);
    return item?.wrap && form !== "hidden" ? <Fragment key={id}>{item.wrap(item.say(form), form)}</Fragment> : null;
  };
  // Behind "⋯": what gave way all the way, said in full and opening what it
  // opens in the bar. Escape gives focus back; a press elsewhere closes it.
  const hidden = entries.filter((e) => e.wrap && formOf(e.id) === "hidden");
  const [more, setMore] = useState(false);
  const moreAnchor = useRef<HTMLSpanElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!hidden.length) setMore(false);
  }, [hidden.length]);
  useEffect(() => {
    if (!more) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMore(false);
      moreButton.current?.focus();
    };
    const onDown = (event: PointerEvent) => {
      const at = event.target as Node | null;
      if (!at || moreAnchor.current?.contains(at)) return;
      setMore(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [more]);
  const specimen = entries.find((e) => e.id === "specimen");
  const streamItem = entries.find((e) => e.id === "stream");
  return (
    <footer className="statusbar" id="core-status-details" ref={panel} data-open={open ? "" : undefined}>
      {slot &&
        createPortal(
          <button
            type="button"
            ref={entry}
            className={`core-status-entry${needsLook ? " needs-look" : ""}`}
            aria-expanded={open}
            aria-controls="core-status-details"
            onClick={() => setOpen((was) => !was)}
          >
            {/* The dot and the chevron are one target. The toolbar's own
                `.connection` keeps data-core-status and is the one indicator
                in the page; on this screen it is not shown, and this says the
                same thing in its place rather than beside it.
                The name is read, not seen — Core's state and the count are
                both in it, and no aria-label stands in front of either. */}
            <span className="core-status-mark" data-healthy={settled ? "" : undefined} aria-hidden="true" />
            <span className="sr-only">{t.detailsCore(said, needsLook > 0 ? t.detailsNeed(needsLook) : t.detailsQuiet)}</span>
            {/* Core not answering is written out: that is not a colour a
                reader can be asked to tell apart. The stream's own state is
                not — the words are in the name above and in the panel, and
                the count below stands for it here. Measured on the screen
                this entry exists for, "Live updates reconnecting" takes the
                entry to 289px of a 413px actions area and lies over the
                toolbar's Jobs and Tasks buttons; ellipsised it still eats
                the room and says less (t15-touch, t15-status-stream). */}
            {!coreHealthy && (
              <span className="core-status-state" aria-hidden="true">{coreLabel}</span>
            )}
            {needsLook > 0 && (
              <span className="core-status-count" aria-hidden="true">{t.detailsNeed(needsLook)}</span>
            )}
            <ChevronDown className="core-status-chevron" size={14} aria-hidden="true" />
          </button>,
          slot,
        )}
      <div className="statusbar-start">
        <span className="statusbar-item statusbar-core">{coreLabel}</span>
        {specimen && (
          <span className="statusbar-item" data-item="specimen" data-form={formOf("specimen")}>
            {specimen.say(formOf("specimen"))}
          </span>
        )}
        {streamItem && (
          <span className="statusbar-item event-connection-status" role="status" data-item="stream" data-form={formOf("stream")}>
            {streamItem.say(formOf("stream"))}
          </span>
        )}
        {!previewMode && <CoreBacklog agents={agents} live={live} compact={formOf("backlog") === "compact"} onShown={setBacklogShown} />}
        {shown("reviews")}
        {shown("ci")}
        <span className="statusbar-notice" role="status" aria-live="polite">
          {shown("notice")}
        </span>
      </div>
      <div className="statusbar-end">
        {shown("codex")}
        {shown("claude")}
        {shown("machines")}
        {shown("ram")}
        {hidden.length > 0 && (
          <span className="statusbar-overflow-anchor" ref={moreAnchor}>
            <Tip content={<TipText title={t.more(hidden.length)} />}>
              <button
                type="button"
                ref={moreButton}
                className="statusbar-item statusbar-overflow"
                aria-label={t.more(hidden.length)}
                aria-expanded={more}
                aria-controls="statusbar-overflow-list"
                onClick={() => setMore((was) => !was)}
              >
                <Ellipsis size={12} aria-hidden="true" />
                <span className="statusbar-count" aria-hidden="true">
                  {hidden.length}
                </span>
              </button>
            </Tip>
            {more && (
              <div id="statusbar-overflow-list" className="statusbar-overflow-list" role="region" aria-label={t.moreList}>
                {hidden.map((e) => (
                  <Fragment key={e.id}>{e.wrap!(e.say("full"), "full")}</Fragment>
                ))}
              </div>
            )}
          </span>
        )}
      </div>
      {/* Every form of every item, where nobody sees or reaches it, to be
          measured (statusbar-fit.ts). Drawn only while the bar is laid out
          as a bar. Its own class, so nothing looking for the bar's items
          finds these. */}
      {fit.measuring && (
        <div className="statusbar-measure" aria-hidden="true" inert ref={measure}>
          <div>
            {entries.flatMap((e) =>
              (["full", ...e.forms] as Form[]).map((form) =>
                e.measure ? (
                  <Fragment key={`${e.id}:${form}`}>{e.measure(form)}</Fragment>
                ) : (
                  <span key={`${e.id}:${form}`} className="statusbar-measure-item" data-fit={e.id} data-form={form}>
                    {e.say(form)}
                  </span>
                ),
              ),
            )}
            <span className="statusbar-measure-item" data-fit="overflow" data-form="full">
              <Ellipsis size={12} />
              <span className="statusbar-count">{Math.max(entries.length, 1)}</span>
            </span>
          </div>
        </div>
      )}
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

/**
 * Job memory reserved against its budget, and what the host has free, in
 * the bar's three forms (YN-75): everything; the reservation alone, with
 * one unit when both sides have it; the meter alone. The meter and the full
 * numbers are read in every form.
 */
function memoryForms(budget: Budget, t: Words) {
  const used = share(budget.reserved.memoryMiB, budget.budget.memoryMiB);
  const free = budget.machine.memoryAvailableMiB == null ? null : gib(budget.machine.memoryAvailableMiB);
  const host = free === null ? "" : t.free(free);
  const cpu = (millis: number) => Number((millis / 1000).toFixed(1));
  const reserved = gib(budget.reserved.memoryMiB);
  const total = gib(budget.budget.memoryMiB);
  const value = `${reserved} / ${total}`;
  const unit = (text: string) => text.slice(text.lastIndexOf(" "));
  const brief = unit(reserved) === unit(total) ? `${reserved.slice(0, reserved.lastIndexOf(" "))} / ${total}` : value;
  const meter = (
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
  );
  return {
    tip: <TipText title={budget.machine.name} status={t.memoryTip(value, cpu(budget.reserved.cpuMillis), cpu(budget.budget.cpuMillis))} meta={free ? t.hostFree(free) : null} />,
    say: (form: Form): ReactNode => (
      <>
        <span>{t.ram}</span>
        {meter}
        {form === "full" ? (
          <span>
            {value}
            {host}
          </span>
        ) : (
          <>
            <span className="sr-only">
              {value}
              {host}
            </span>
            {form === "compact" && <span aria-hidden="true">{brief}</span>}
          </>
        )}
      </>
    ),
  };
}

const stopped = new Set(["failed", "rejected", "interrupted", "unknown"]);
const reviewActive = (r: ReviewRow) =>
  r.status === "preparing" || r.status === "running";
const reviewOk = (r: ReviewRow) => r.status === "completed" && reviewPassed(r);
/** What an end says, in the bar's words; Core's status values as they came.
 * Short, it leaves out the name, which is the part that can be long (YN-75). */
function endedText(what: Ended, t: Words, brief = false): string {
  if (what.kind === "run") return brief ? t.runShort(what.status) : t.run(what.name, what.status);
  if (what.kind === "job") {
    const outcome = what.status === "succeeded" ? t.finished : stopped.has(what.status) ? t.failed : what.status;
    return brief ? t.jobShort(outcome) : t.job(what.name, outcome);
  }
  const outcome =
    what.status !== "completed"
      ? what.status
      : what.conclusion === "no_findings"
        ? t.noFindings
        : what.conclusion === "approved_with_notes"
          ? t.suggestions
          : (what.conclusion || "unknown").replace(/_/g, " ");
  return brief ? t.reviewShort(outcome) : t.review(what.number, outcome);
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
  const notice = first ? { ...first, text: endedText(first.what, words(language)), short: endedText(first.what, words(language), true) } : null;
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
  // The window nearest its limit, for a bar without room for all (YN-75).
  const going = windows.filter((w) => !w.expired);
  const top = going.length ? going.reduce((a, b) => (b.percent > a.percent ? b : a)) : null;
  return {
    limited,
    top: top ? `${top.name} ${top.percent}%` : null,
    topValue: top ? `${top.percent}%` : null,
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
  const value = (w: (typeof windows)[number]) => (w.expired ? t.codexWaiting : w.percent === null ? t.codexUnknown : `${w.percent}%`);
  // The window nearest its limit, for a bar without room for all (YN-75):
  // one with a known share, else the first.
  const known = windows.map((w, i) => ({ w, i })).filter(({ w }) => !w.expired && w.percent !== null);
  const top = known.length ? known.reduce((a, b) => ((b.w.percent ?? 0) > (a.w.percent ?? 0) ? b : a)) : { w: windows[0], i: 0 };
  return {
    stale,
    limited,
    top: `${labels[top.i]} ${value(top.w)}`,
    topValue: value(top.w),
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
 * then): how many, how many could not be reached at their last check, and
 * how many open Agents on them are disconnected. Only a failed check makes a
 * machine unreachable (YN-61): one that answered while its Agents are
 * disconnected is not, and is shown in the bar's quiet colour, with the tip
 * naming those Agents under their machine. A check is manual, so its age is
 * in the tip.
 */
export function useMachines(revision: string, enabled: boolean, agents: Agent[], language: Language = "en") {
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
  const off = (m: WorkspaceMachine) =>
    agents
      .filter((a) => !a.closedAt && a.remote?.machine.id === m.id && a.connectionState === "disconnected")
      .map((a) => a.name);
  const unreachable = remote.filter((m) => m.lastCheck?.reachable === false).length;
  const disconnected = remote.reduce((sum, m) => sum + off(m).length, 0);
  const t = words(language);
  return {
    count: remote.length,
    unreachable,
    disconnected,
    text: t.machines(remote.length, unreachable, disconnected),
    title: [
      ...remote.map((m) => {
        const check = m.lastCheck
          ? t.checked(m.lastCheck.reachable, new Date(m.lastCheck.checkedAt).toLocaleString())
          : t.unchecked;
        return t.machine(m.name, check, off(m));
      }),
      t.openMachines,
    ].join("\n"),
  };
}
