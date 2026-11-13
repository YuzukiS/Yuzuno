import { forwardRef, useLayoutEffect, useRef, type RefObject } from "react";
import { BriefcaseBusiness, Bot, Github, GitPullRequest, SquareTerminal, type LucideIcon } from "lucide-react";
import { clockMs, islandTime, type IslandAction, type IslandClock, type IslandForm, type IslandLine, type IslandState, type IslandStay, type IslandView, type IslandWait, type WaitKind } from "./agent-island";
import { detailText, executorRowText } from "./ExecutorRowState";
import { strings, useLanguage, type Language } from "./i18n";
import { timeFormatter, type TimeDisplay } from "./time-preferences";
import "./agent-island.css";

// The island's words (T-43, rail v11). What Agents and Core wrote is shown as it came.
export const islandText = strings({
  word: { idle: "Idle", working: "Working", waiting: "Needs you", done: "Done", failed: "Failed" } as Record<IslandState, string>,
  stay: {
    queued: (position: number | null) => (position ? `Queued · ${position} in line` : "Queued"),
    /** Waiting for a routing candidate (YN-57), from when one's reason ends. No wider than
     *  "Queued · 3 in line", with a 12-hour clock too: a longer pill leaves line one no width in a
     *  240 px rail. The card's meaning and route lines say it in full. */
    candidate: (from: string | null) => (from ? `From ${from}` : "No candidate yet"),
    starting: "Starting", lead: "Lead's turn", review: "In review", changes: "Changes asked", ciFailed: "CI failed",
    ready: "Ready to merge", merged: "Merged", offline: "Offline",
    /** Its Turn has ended (YN-92): what it left running, shorter than the card's "Waiting on …", which a 240 px rail's
     *  pill can't hold; an executor's task blocked, its result handed in, or nothing running between Turns. */
    waits: { review: "Awaits review", ci: "Awaits CI", job: "Awaits a Job", subAgent: "Awaits sub-agent", shell: "Awaits a shell" } as Record<WaitKind, string>,
    blocked: "Blocked", resultIn: "Result in", between: "Between turns",
  },
  colon: ": ",
  gap: " · ",
  /** The clock on line two: "1h12m", "1m ago", "1h12m in all". */
  time: { live: (x: string) => x, since: (x: string) => `${x} ago`, total: (x: string) => `${x} in all` },
  unread: "updates unread",
  /** Where the ring goes, as its label says it. */
  go: {
    answer: "Answer its question on Home", why: "See why it failed", result: "See its result", queue: "See its place in the queue",
    task: (key: string | null) => (key ? `Open task ${key}` : "Open its task"), turn: "See the Turn that failed", reply: "Read its reply",
  },
  pill: { ciGreen: "CI green", ciFailed: "CI failed", started: "Started", merged: "Merged" },
  /** What a turning ring waits on (YN-51): the ring's and the row's words, and the card's line. */
  wait: {
    short: { review: "Waiting on a review", ci: "Waiting on CI", job: "Waiting on a Job", subAgent: "Waiting on a sub-agent", shell: "Waiting on a shell command" } as Record<WaitKind, string>,
    review: (pr: number | null, round: number | null) => (pr ? `Waiting on a review: PR #${pr}${round ? `, round ${round}` : ""}` : "Waiting on a review"),
    ci: (pr: number | null, runs: number) => (pr ? `Waiting on CI: PR #${pr}` : `Waiting on CI: ${runs} run${runs === 1 ? "" : "s"}`),
    job: (name: string | null, count: number) => (name ? `Waiting on a Job: ${name}` : count === 1 ? "Waiting on a Job" : `Waiting on ${count} Jobs`),
    subAgent: (label: string, count: number, background: boolean) => (label ? `Waiting on a sub-agent: ${label}`
      : background ? (count === 1 ? "Waiting on a background sub-agent" : `Waiting on ${count} background sub-agents`) : "Waiting on a sub-agent"),
    shell: (label: string, count: number, background: boolean) => (label ? `Waiting on a shell command: ${label}`
      : background ? (count === 1 ? "Waiting on a background shell" : `Waiting on ${count} background shells`) : "Waiting on a shell command"),
    also: (parts: string[]) => `Also: ${parts.join(", ")}`,
    part: { review: (n: number) => (n === 1 ? "a review" : `${n} reviews`), ci: () => "CI", job: (n: number) => (n === 1 ? "1 Job" : `${n} Jobs`),
      subAgent: (n: number) => (n === 1 ? "a sub-agent" : `${n} sub-agents`), shell: (n: number) => (n === 1 ? "a shell" : `${n} shells`) } as Record<WaitKind, (n: number) => string>,
  },
}, {
  word: { idle: "空闲", working: "在做", waiting: "等你", done: "完成", failed: "出错" },
  stay: {
    queued: (position) => (position ? `排队 · 第 ${position} 位` : "排队"),
    candidate: (from) => (from ? `等候选 · ${from} 起` : "等候选"),
    starting: "启动中", lead: "等负责人", review: "审查中", changes: "要改", ciFailed: "CI 红了",
    ready: "等合并", merged: "已合入", offline: "离线",
    waits: { review: "在等审查", ci: "在等 CI", job: "在等 Job", subAgent: "在等子代理", shell: "在等 shell" },
    blocked: "受阻", resultIn: "已交结果", between: "等下一轮",
  },
  colon: "：",
  gap: " · ",
  time: { live: (x) => x, since: (x) => `${x}前`, total: (x) => `共 ${x}` },
  unread: "有未读更新",
  go: {
    answer: "去 Home 回答提问", why: "看出错原因", result: "看结果", queue: "看排队位置",
    task: (key) => (key ? `看任务 ${key}` : "看任务"), turn: "看出错的那一轮", reply: "看它的回复",
  },
  pill: { ciGreen: "CI 绿了", ciFailed: "CI 红了", started: "开始了", merged: "已合入" },
  wait: {
    short: { review: "在等审查", ci: "在等 CI", job: "在等 Job", subAgent: "在等子代理", shell: "在等 shell" },
    review: (pr, round) => (pr ? `在等审查：PR #${pr}${round ? ` 第 ${round} 轮` : ""}` : "在等审查"),
    ci: (pr, runs) => (pr ? `在等 CI：PR #${pr}` : `在等 CI：${runs} 个运行`),
    job: (name, count) => (name ? `在等 Job：${name}` : count === 1 ? "在等 Job" : `在等 ${count} 个 Job`),
    subAgent: (label, count, background) => (label ? `在等子代理：${label}`
      : background ? (count === 1 ? "在等后台子代理" : `在等 ${count} 个后台子代理`) : "在等子代理"),
    shell: (label, count, background) => (label ? `在等 shell：${label}`
      : background ? (count === 1 ? "在等后台 shell" : `在等 ${count} 个后台 shell`) : "在等 shell"),
    also: (parts) => `另有：${parts.join("、")}`,
    part: { review: (n) => (n === 1 ? "审查" : `${n} 轮审查`), ci: () => "CI", job: (n) => `${n} 个 Job`,
      subAgent: (n) => (n === 1 ? "子代理" : `${n} 个子代理`), shell: (n) => (n === 1 ? "shell" : `${n} 个 shell`) },
  },
});

/** Each wait's icon (YN-51): the ones the conversation's work dock and the
 * Jobs panel already use for these kinds, so an icon means one thing. */
export const WAIT_ICONS: Record<WaitKind, LucideIcon> = {
  review: GitPullRequest, ci: Github, job: BriefcaseBusiness, subAgent: Bot, shell: SquareTerminal,
};

/** A wait in words: what the ring says (`short`), the card's line, and the others it waits on too. */
export function waitText(wait: IslandWait, language: Language): { short: string; line: string; also: string | null } {
  const t = islandText(language).wait;
  const label = wait.label?.trim() ?? "";
  const line = wait.kind === "review" ? t.review(wait.pr ?? null, wait.round ?? null)
    : wait.kind === "ci" ? t.ci(wait.pr ?? null, wait.count)
      : wait.kind === "job" ? t.job(wait.name ?? null, wait.count)
        : t[wait.kind](label, wait.count, !!wait.background);
  return { short: t.short[wait.kind], line, also: wait.also.length ? t.also(wait.also.map((a) => t.part[a.kind](a.count))) : null };
}

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Line two's words. */
export function lineText(line: IslandLine, language: Language): string {
  switch (line.kind) {
    case "detail": return detailText(line.detail, executorRowText(language)) ?? "";
    case "text": return line.text;
    case "none": return "";
  }
}

/** A candidate's time as a pill says it: "04:00", in the user's clock format and time zone. */
const candidateAt = timeFormatter({ hour: "2-digit", minute: "2-digit" });

/** A state that stays, in words: "等负责人", "排队 · 第 2 位", "等候选 · 04:00 起" (`time`: the user's clock and zone);
 * a Turn ended (YN-92): "在等 Job", "核对 Job", "等下一轮". */
export function stayText(stay: IslandStay, language: Language, time?: TimeDisplay): string {
  const t = islandText(language).stay;
  if (stay.kind === "queued") return t.queued(stay.position);
  if (stay.kind === "candidate") return t.candidate(stay.earliest != null ? candidateAt(time).format(stay.earliest) : null);
  if (stay.kind === "waits") return t.waits[stay.on];
  // The Agent list's own words for a Job or CI to check (live-jobs.ts, live-ci.ts).
  if (stay.kind === "check") return stay.label;
  return t[stay.kind];
}

/** How a staying state's pill is coloured: good news, bad news, work going
 * on (a review round; what an Agent at rest left running, YN-92), for
 * someone to look at (the lead's turn, a Job or CI to check, a task blocked,
 * a result handed in), or quiet (queued, starting, offline, between Turns). */
export function stayTone(stay: IslandStay): IslandPill["tone"] {
  switch (stay.kind) {
    case "ready": case "merged": return "ok";
    case "changes": case "ciFailed": return "bad";
    case "review": case "waits": return "working";
    case "lead": case "check": case "blocked": case "resultIn": return "info";
    default: return "quiet";
  }
}

/** The clock as line two writes it: "1h12m", "1m ago", "1h12m in all". */
export function clockShort(clock: IslandClock, now: number, language: Language): string {
  return islandText(language).time[clock.kind](islandTime(clockMs(clock, now), language));
}

/** Where the ring goes, in words: its label. */
export function goText(go: IslandAction, view: IslandView, language: Language): string {
  const t = islandText(language).go;
  return go === "task" ? t.task(view.task) : t[go];
}

/** What a ring can show: one of its five states, or a passing event's result. */
export type RingState = IslandState | "green" | "red";
const C = 2 * Math.PI * 9.5;

/**
 * The ring (T-43 rail v11): five states a glance tells apart. Working is an
 * arc that turns, only while a Turn runs; needs you a full ring that
 * breathes, orange; done ✓ and failed ✕ a mark inside; idle a thin grey
 * ring. An Agent at rest is idle, still, whatever it left running (YN-92):
 * its pill says what holds it, and the wait's icon sits in the grey ring.
 * Under reduced motion nothing turns or breathes.
 */
export function IslandRing({ state }: { state: RingState }) {
  const circle = (className: string, extra: Record<string, string> = {}) => <circle cx="12" cy="12" r="9.5" className={className} {...extra} />;
  let body;
  switch (state) {
    case "idle": body = circle("r-idle"); break;
    case "working":
      body = <>{circle("r-track")}<g className="r-spin">{circle("r-arc", { strokeDasharray: `${C * 0.25} ${C}`, transform: "rotate(-90 12 12)" })}</g></>;
      break;
    case "waiting": body = circle("r-breathe"); break;
    case "done": case "green": body = <>{circle("r-full")}<path className="r-mark" d="M7.6 12.3 L10.6 15.2 L16.4 8.9" /></>; break;
    case "failed": case "red": body = <>{circle("r-full")}<path className="r-mark" d="M8.6 8.6 L15.4 15.4 M15.4 8.6 L8.6 15.4" /></>; break;
  }
  return <svg viewBox="0 0 24 24" className="island-ring" data-ring={state} aria-hidden="true" focusable="false">{body}</svg>;
}

/** A pill beside the ring, which takes its width from line one: a state
 * that stays (its phrase, for as long as it holds), or a passing event for
 * a few seconds in its place (its words and the ring it shows: ✓ or ✕). */
export type IslandPill = { text: string; ring: RingState | null; tone: "ok" | "bad" | "info" | "working" | "quiet"; event: boolean };

type IslandProps = {
  view: IslandView;
  form: IslandForm;
  name: string;
  pill?: IslandPill | null;
  /** Where the ring goes; it is a button only when it goes somewhere. */
  onGo: (go: IslandAction) => void;
  /** The runtime's own hooks, as its status carried them: the app's status
   * words for it, and its live Jobs and CI. */
  "data-status"?: string;
  "data-jobs"?: number;
  "data-ci"?: number;
  "data-combined"?: true;
};

/**
 * The ring at the row's right, centred on its lines (T-43, YN-41). With
 * somewhere to go, it is a button labelled with where ("Answer its question
 * on Home"): its hit area is larger than the ring (28 px with a mouse, 40 on
 * touch) with nothing drawn, and on hover or focus the ring scales up a
 * little in place (a thicker stroke under reduced motion). With nowhere of
 * its own, it is part of the row, whose click opens the conversation.
 */
export const AgentIsland = forwardRef<HTMLButtonElement, IslandProps>(
  function AgentIsland({ view, form, name, pill, onGo, ...hooks }, ref) {
    const language = useLanguage();
    const ring: RingState = form === "pill" && pill?.ring ? pill.ring : view.state;
    // The turning ring holds it, and a ring at rest whose Agent waits only on
    // what it left running (YN-92); not a passing event's ✓ or ✕ in the ring's place.
    const wait = ring === "working" || (ring === "idle" && view.stay?.kind === "waits") ? view.wait : null;
    const Wait = wait ? WAIT_ICONS[wait.kind] : null;
    const go = view.go;
    const body = (
      <>
        {form === "pill" && pill && (
          <span className="island-pill" data-tone={pill.tone} data-event={pill.event || undefined} aria-hidden="true">{pill.text}</span>
        )}
        <span className="island-ringbox" data-ring={ring} data-wait={wait?.kind}>
          <IslandRing state={ring} />
          {/* What the ring waits on (YN-51; at rest too, YN-92): still, in its colour; the ring stays the state. */}
          {Wait && <Wait className="island-wait" size={11} strokeWidth={2.4} aria-hidden="true" focusable="false" />}
          {view.dot && <span className="island-dot" aria-hidden="true" />}
        </span>
      </>
    );
    const shared = {
      ...hooks,
      className: "agent-island",
      "data-state": view.state,
      "data-stay": view.stay?.kind,
      "data-form": form,
      "data-go": go ?? undefined,
      "data-clock": view.clock?.kind,
      "data-dot": view.dot || undefined,
    };
    // Nowhere of its own: part of the row, whose link says the state. What
    // the ring says in full is the row's card (AgentRowCard.tsx).
    if (!go) return <span {...shared} aria-hidden="true">{body}</span>;
    const where = goText(go, view, language);
    const waits = wait ? `${waitText(wait, language).short} · ` : "";
    return (
      <button
        ref={ref}
        type="button"
        {...shared}
        aria-label={`${name} · ${waits}${where}`}
        onClick={(event) => { event.stopPropagation(); onGo(go); }}
      >
        {body}
      </button>
    );
  },
);

type Box = { left: number; top: number; width: number; height: number; radius: number };
const frame = (b: Box, opacity = 1) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, borderRadius: `${b.radius}px`, opacity });

/** The outline's box for a form, in the row's padding box: the ring's
 * circle, the pill round its words and the ring (9 px left of the words,
 * 3 px right of the ring, 28 px tall on the ring's middle), or the whole
 * row. Read from the island's own layout box, not the ring's: the ring
 * grows a little under the pointer by a transform, the island doesn't. In
 * the row's own pixels: a transform on the row (a held row presses in)
 * scales what the screen shows, not what the outline's style means. */
function shellBox(row: HTMLElement, form: IslandForm): Box | null {
  const island = row.querySelector<HTMLElement>(":scope > .agent-island");
  const ringbox = island?.querySelector<HTMLElement>(".island-ringbox");
  const rb = row.getBoundingClientRect();
  if (!island || !ringbox || !rb.width || !row.offsetWidth || !row.offsetHeight) return null;
  const sx = rb.width / row.offsetWidth, sy = rb.height / row.offsetHeight;
  const b = island.getBoundingClientRect();
  const g = { left: (b.left - rb.left) / sx - row.clientLeft, top: (b.top - rb.top) / sy - row.clientTop, width: b.width / sx, height: b.height / sy };
  // The ring at the island's right end, on its middle.
  const rw = ringbox.offsetWidth, rh = ringbox.offsetHeight;
  const ring = { left: g.left + g.width - rw, top: g.top + (g.height - rh) / 2, width: rw, height: rh, radius: rw / 2 };
  if (form === "ring") return ring;
  if (form === "pill") {
    if (!island.querySelector(".island-pill")) return ring;
    const h = 28;
    return { left: g.left - 9, top: ring.top + rh / 2 - h / 2, width: g.width + 12, height: h, radius: h / 2 };
  }
  return { left: -row.clientLeft, top: -row.clientTop, width: row.offsetWidth, height: row.offsetHeight, radius: parseFloat(getComputedStyle(row).borderTopLeftRadius) || 9 };
}

/**
 * The outline (T-43 v10.2): one border that grows out of the ring into a
 * pill or the whole row, and shrinks back into the ring. Its rest is CSS's
 * (the row's box); a pill's box is set here. Each change of form animates
 * from the ring's circle, or from where it was, and back into the ring;
 * nothing moves under reduced motion. While a pill shows, its box follows
 * its words and ring, at once, whatever moves them without a new render
 * (YN-41): the row's size (a narrower rail, a scroll bar, lines that wrap
 * anew round the centred ring) and the island's (its words in a font that
 * just loaded, a larger text size, a zoom).
 */
export function useIslandShell(row: RefObject<HTMLElement | null>, shell: RefObject<HTMLElement | null>, form: IslandForm, words: string | null = null) {
  const last = useRef<{ form: IslandForm; box: Box | null } | null>(null);
  useLayoutEffect(() => {
    const el = row.current, outline = shell.current;
    if (!el || !outline) return;
    const box = shellBox(el, form);
    if (form === "pill" && box) place(outline, box);
    else outline.removeAttribute("style");
    const prev = last.current;
    last.current = { form, box };
    // A pill whose words changed is drawn round them at once, without a motion.
    if (!prev || prev.form === form || !box || reducedMotion() || typeof outline.animate !== "function") return;
    if (form === "ring") {
      // Back into the ring.
      if (prev.box) outline.animate([frame(prev.box), frame(box)], { duration: 300, easing: EASE_IN });
      return;
    }
    // Out of the ring, or on from where it was (a pill always starts at the ring).
    const ring = shellBox(el, "ring");
    const from = prev.form === "ring" || form === "pill" || !prev.box ? ring : prev.box;
    if (from) outline.animate([frame(from), frame(box)], { duration: 320, easing: EASE_OUT });
    el.querySelector<HTMLElement>(":scope > .agent-island .island-pill")?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 120, fill: "backwards" });
  }, [form, words]);
  useLayoutEffect(() => {
    const el = row.current, outline = shell.current;
    if (form !== "pill" || !el || !outline || typeof ResizeObserver !== "function") return;
    const follow = new ResizeObserver(() => {
      const box = shellBox(el, "pill");
      if (!box) return;
      place(outline, box);
      if (last.current?.form === "pill") last.current.box = box;
    });
    // The row and its island; an island put in its place (a ring that
    // became a button) is watched instead.
    const watch = () => {
      follow.disconnect();
      follow.observe(el);
      const island = el.querySelector(":scope > .agent-island");
      if (island) follow.observe(island);
    };
    watch();
    const swapped = typeof MutationObserver === "function" ? new MutationObserver(watch) : null;
    swapped?.observe(el, { childList: true });
    return () => {
      follow.disconnect();
      swapped?.disconnect();
    };
  }, [form]);
}

function place(outline: HTMLElement, box: Box) {
  Object.assign(outline.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: `${box.radius}px` });
}
