import { forwardRef, useLayoutEffect, useRef, type RefObject } from "react";
import { clockMs, islandTime, type IslandAction, type IslandClock, type IslandForm, type IslandLine, type IslandState, type IslandStay, type IslandView } from "./agent-island";
import { detailText, executorRowText } from "./ExecutorRowState";
import { strings, useLanguage, type Language } from "./i18n";
import { useMinute } from "./live-executors";
import "./agent-island.css";

// The island's words (T-43, rail v11). What Agents and Core wrote is shown as it came.
export const islandText = strings({
  word: { idle: "Idle", working: "Working", waiting: "Needs you", done: "Done", failed: "Failed" } as Record<IslandState, string>,
  stay: {
    queued: (position: number | null) => (position ? `Queued · ${position} in line` : "Queued"),
    starting: "Starting", lead: "Lead's turn", review: "In review", changes: "Changes asked", ciFailed: "CI failed",
    ready: "Ready to merge", merged: "Merged", offline: "Offline",
  },
  colon: ": ",
  gap: " · ",
  clock: {
    working: (x: string) => `for ${x}`, waiting: (x: string) => `waiting ${x}`, live: (x: string) => `for ${x}`,
    since: (x: string) => `${x} ago`, total: (x: string) => `${x} in total`,
  },
  /** The clock on line two: "1h12m", "1m ago", "1h12m in all". */
  time: { live: (x: string) => x, since: (x: string) => `${x} ago`, total: (x: string) => `${x} in all` },
  unread: "updates unread",
  /** Where the ring goes, as its label says it. */
  go: {
    answer: "Answer its question on Home", why: "See why it failed", result: "See its result", queue: "See its place in the queue",
    task: (key: string | null) => (key ? `Open task ${key}` : "Open its task"), turn: "See the Turn that failed", reply: "Read its reply",
  },
  pill: { ciGreen: "CI green", ciFailed: "CI failed", started: "Started", merged: "Merged" },
}, {
  word: { idle: "空闲", working: "在做", waiting: "等你", done: "完成", failed: "出错" },
  stay: {
    queued: (position) => (position ? `排队 · 第 ${position} 位` : "排队"),
    starting: "启动中", lead: "等负责人", review: "审查中", changes: "要改", ciFailed: "CI 红了",
    ready: "等合并", merged: "已合入", offline: "离线",
  },
  colon: "：",
  gap: " · ",
  clock: {
    working: (x) => `已用 ${x}`, waiting: (x) => `已等 ${x}`, live: (x) => `已用 ${x}`,
    since: (x) => `${x}前`, total: (x) => `共用 ${x}`,
  },
  time: { live: (x) => x, since: (x) => `${x}前`, total: (x) => `共 ${x}` },
  unread: "有未读更新",
  go: {
    answer: "去 Home 回答提问", why: "看出错原因", result: "看结果", queue: "看排队位置",
    task: (key) => (key ? `看任务 ${key}` : "看任务"), turn: "看出错的那一轮", reply: "看它的回复",
  },
  pill: { ciGreen: "CI 绿了", ciFailed: "CI 红了", started: "开始了", merged: "已合入" },
});

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

/** A state that stays, in words: "等负责人", "排队 · 第 2 位". */
export function stayText(stay: IslandStay, language: Language): string {
  const t = islandText(language).stay;
  return stay.kind === "queued" ? t.queued(stay.position) : t[stay.kind];
}

/** How a staying state's pill is coloured: good news, bad news, work going
 * on, the lead's turn, or quiet (queued, starting, offline). */
export function stayTone(stay: IslandStay): IslandPill["tone"] {
  switch (stay.kind) {
    case "ready": case "merged": return "ok";
    case "changes": case "ciFailed": return "bad";
    case "review": return "working";
    case "lead": return "info";
    default: return "quiet";
  }
}

/** The clock as a caption: "已用 1时12分", "14分前", "共用 1时12分". */
export function clockCaption(state: IslandState, clock: IslandClock, now: number, language: Language): string {
  const t = islandText(language);
  const x = islandTime(clockMs(clock, now), language);
  if (clock.kind === "total") return t.clock.total(x);
  if (clock.kind === "since") return t.clock.since(x);
  return state === "waiting" ? t.clock.waiting(x) : state === "working" ? t.clock.working(x) : t.clock.live(x);
}

/** The clock as line two writes it: "1h12m", "1m ago", "1h12m in all". */
export function clockShort(clock: IslandClock, now: number, language: Language): string {
  return islandText(language).time[clock.kind](islandTime(clockMs(clock, now), language));
}

/** The whole island in words, for the ring's title: the state, what stays,
 * its clock, what it is at and whether a lead has updates unread. */
export function islandLabel(view: IslandView, now: number, language: Language): string {
  const t = islandText(language);
  const line = lineText(view.line, language);
  return [t.word[view.state], view.stay ? stayText(view.stay, language) : null, view.clock ? clockCaption(view.state, view.clock, now, language) : null,
    line || null, view.dot ? t.unread : null]
    .filter(Boolean).join(" · ");
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
 * arc that turns; needs you a full ring that breathes, orange; done ✓ and
 * failed ✕ a mark inside; idle a thin grey ring. Under reduced motion
 * nothing turns or breathes.
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
  /** More for its title: an executor's task and template, who dispatched it. */
  detail?: string;
  /** The runtime's own hooks, as its status carried them: the app's status
   * words for it, and its live Jobs and CI. */
  "data-status"?: string;
  "data-jobs"?: number;
  "data-ci"?: number;
  "data-combined"?: true;
};

/**
 * The ring at the row's top right (T-43). With somewhere to go, it is a
 * button labelled with where ("Answer its question on Home"): its hit area
 * is larger than the ring (28 px with a mouse, 40 on touch) with nothing
 * drawn, and on hover or focus the ring scales up a little in place (a
 * thicker stroke under reduced motion). With nowhere of its own, it is part
 * of the row, whose click opens the conversation.
 */
export const AgentIsland = forwardRef<HTMLButtonElement, IslandProps>(
  function AgentIsland({ view, form, name, pill, onGo, detail, ...hooks }, ref) {
    const language = useLanguage();
    const now = useMinute();
    const label = islandLabel(view, now, language);
    const ring: RingState = form === "pill" && pill?.ring ? pill.ring : view.state;
    const go = view.go;
    const body = (
      <>
        {form === "pill" && pill && (
          <span className="island-pill" data-tone={pill.tone} data-event={pill.event || undefined} aria-hidden="true">{pill.text}</span>
        )}
        <span className="island-ringbox" data-ring={ring}>
          <IslandRing state={ring} />
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
    // Nowhere of its own: part of the row, whose link says the state.
    if (!go) return <span {...shared} title={label} aria-hidden="true">{body}</span>;
    const where = goText(go, view, language);
    return (
      <button
        ref={ref}
        type="button"
        {...shared}
        aria-label={`${name} · ${where}`}
        title={`${label}\n${where}${detail ? `\n${detail}` : ""}`}
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
 * circle, the pill round its words and the ring, or the whole row. */
function shellBox(row: HTMLElement, form: IslandForm): Box | null {
  const ringbox = row.querySelector<HTMLElement>(":scope > .agent-island .island-ringbox");
  const rb = row.getBoundingClientRect();
  if (!ringbox || !rb.width) return null;
  const ox = rb.left + row.clientLeft, oy = rb.top + row.clientTop;
  const g = ringbox.getBoundingClientRect();
  const ring = { left: g.left - ox, top: g.top - oy, width: g.width, height: g.height, radius: g.width / 2 };
  if (form === "ring") return ring;
  if (form === "pill") {
    const p = row.querySelector<HTMLElement>(":scope > .agent-island .island-pill")?.getBoundingClientRect();
    if (!p) return ring;
    const h = 28;
    return { left: p.left - ox - 9, top: ring.top + ring.height / 2 - h / 2, width: g.right - p.left + 12, height: h, radius: h / 2 };
  }
  return { left: -row.clientLeft, top: -row.clientTop, width: rb.width, height: rb.height, radius: parseFloat(getComputedStyle(row).borderTopLeftRadius) || 9 };
}

/**
 * The outline (T-43 v10.2): one border that grows out of the ring into a
 * pill or the whole row, and shrinks back into the ring. Its rest is CSS's
 * (the row's box); a pill's box is set here. Each change of form animates
 * from the ring's circle, or from where it was, and back into the ring;
 * nothing moves under reduced motion.
 */
export function useIslandShell(row: RefObject<HTMLElement | null>, shell: RefObject<HTMLElement | null>, form: IslandForm, words: string | null = null) {
  const last = useRef<{ form: IslandForm; box: Box | null } | null>(null);
  useLayoutEffect(() => {
    const el = row.current, outline = shell.current;
    if (!el || !outline) return;
    const box = shellBox(el, form);
    if (form === "pill" && box) Object.assign(outline.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: `${box.radius}px` });
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
}
