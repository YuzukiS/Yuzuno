import { forwardRef, useLayoutEffect, useRef, type RefObject } from "react";
import { clockMs, islandTime, type IslandAction, type IslandClock, type IslandForm, type IslandLine, type IslandState, type IslandView } from "./agent-island";
import { detailText, executorRowText } from "./ExecutorRowState";
import { strings, useLanguage, type Language } from "./i18n";
import { useMinute } from "./live-executors";
import "./agent-island.css";

// The island's words (T-43, 灵动环 v10.2). What Agents and Core wrote is shown as it came.
export const islandText = strings({
  word: {
    idle: "Idle", working: "Working", handed: "Handed in", waiting: "Needs you", queued: "Queued",
    offline: "Offline", done: "Done", failed: "Failed", archived: "Archived",
  } as Record<IslandState, string>,
  state: {
    idle: "Idle", working: "Working", handed: "Handed in · waiting for the lead", waiting: "Needs you", queued: "Queued",
    offline: "Offline", done: "Done", failed: "Failed", archived: "Archived",
  } as Record<IslandState, string>,
  colon: ": ",
  gap: " · ",
  clock: {
    working: (x: string) => `for ${x}`, handed: (x: string) => `handed in ${x} ago`, waiting: (x: string) => `waiting ${x}`,
    queued: (x: string) => `queued ${x}`, since: (x: string) => `${x} ago`, total: (x: string) => `${x} in total`,
  },
  /** The clock on line two: "1h12m", "1m ago", "1h12m in all". */
  time: { live: (x: string) => x, since: (x: string) => `${x} ago`, total: (x: string) => `${x} in all` },
  handedWord: (pr: number | null) => (pr != null ? `Handed in #${pr}` : "Handed in"),
  lead: "waiting for the lead",
  nextSlice: (pr: number | null) => (pr != null ? `Handed in #${pr}; on the next slice` : "Handed in; on the next slice"),
  unread: (n: number) => `${n} unread`,
  /** Where the ring goes, as its label says it. */
  go: {
    answer: () => "Answer its question on Home",
    why: () => "See why it failed",
    result: (pr: number | null) => (pr != null ? `See the result of #${pr}` : "See its result"),
    queue: () => "See its place in the queue",
    task: (key: string | null) => (key ? `Open task ${key}` : "Open its task"),
    turn: () => "See the Turn that failed",
    unread: (n: number) => `Read ${n} unread`,
  },
  pill: {
    ciGreen: "CI green", ciFailed: "CI failed", messages: (n: number) => (n === 1 ? "1 new message" : `${n} new messages`),
    handedIn: (pr: number | null) => (pr != null ? `Handed in #${pr}` : "Handed in"), reviewOk: "Review passed",
    reviewChanges: "Changes asked", started: "Started", merged: (pr: number | null) => (pr != null ? `Merged #${pr}` : "Merged"),
  },
}, {
  word: {
    idle: "空闲", working: "在做", handed: "已交", waiting: "等你", queued: "排队",
    offline: "离线", done: "完成", failed: "出错", archived: "已归档",
  },
  state: {
    idle: "空闲", working: "在做", handed: "已交 · 等负责人", waiting: "等你", queued: "排队",
    offline: "离线", done: "完成", failed: "出错", archived: "已归档",
  },
  colon: "：",
  gap: " · ",
  clock: {
    working: (x) => `已用 ${x}`, handed: (x) => `已交 ${x}`, waiting: (x) => `已等 ${x}`,
    queued: (x) => `排队 ${x}`, since: (x) => `${x}前`, total: (x) => `共用 ${x}`,
  },
  time: { live: (x) => x, since: (x) => `${x}前`, total: (x) => `共 ${x}` },
  handedWord: (pr) => (pr != null ? `已交 #${pr}` : "已交"),
  lead: "等负责人",
  nextSlice: (pr) => (pr != null ? `已交 #${pr}，在做下一片` : "已交，在做下一片"),
  unread: (n) => `${n} 条未读`,
  go: {
    answer: () => "去 Home 回答提问",
    why: () => "看出错原因",
    result: (pr) => (pr != null ? `看结果 #${pr}` : "看结果"),
    queue: () => "看排队位置",
    task: (key) => (key ? `看任务 ${key}` : "看任务"),
    turn: () => "看出错的那一轮",
    unread: (n) => `看 ${n} 条未读`,
  },
  pill: {
    ciGreen: "CI 绿了", ciFailed: "CI 红了", messages: (n) => `${n} 条新消息`,
    handedIn: (pr) => (pr != null ? `已交 #${pr}` : "已交"), reviewOk: "审查通过",
    reviewChanges: "审查要改", started: "开始了", merged: (pr) => (pr != null ? `已合入 #${pr}` : "已合入"),
  },
});

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 0.2, 1)";

/** A line's words. */
export function lineText(line: IslandLine, state: IslandState, language: Language): string {
  const t = islandText(language);
  switch (line.kind) {
    case "detail": return detailText(line.detail, executorRowText(language)) ?? "";
    case "text": return line.text;
    case "handed": return state === "handed" ? t.lead : t.nextSlice(line.pr);
    case "task": return line.title;
    case "none": return "";
  }
}

/** An executor's line one: the state's word (none while it works), then
 * what it is doing. "Needs you: approve the design note", "Handed in #688 ·
 * waiting for the lead", "Slice 2: evidence Job running". */
export function islandActivity(view: IslandView, language: Language): { word: string | null; sep: string; text: string } {
  const t = islandText(language);
  const text = lineText(view.line, view.state, language);
  if (view.state === "working") return { word: text ? null : t.word.working, sep: "", text };
  if (view.state === "handed") return { word: t.handedWord(view.pr), sep: t.gap, text };
  return { word: t.word[view.state], sep: text ? t.colon : "", text };
}

/** The clock as a caption: "已用 1时12分", "14分前", "共用 1时12分". */
export function clockCaption(state: IslandState, clock: IslandClock, now: number, language: Language): string {
  const t = islandText(language);
  const x = islandTime(clockMs(clock, now), language);
  if (clock.kind === "total") return t.clock.total(x);
  if (clock.kind === "since") return t.clock.since(x);
  return state === "handed" ? t.clock.handed(x) : state === "waiting" ? t.clock.waiting(x) : state === "queued" ? t.clock.queued(x) : t.clock.working(x);
}

/** The clock as line two writes it: "1h12m", "1m ago", "1h12m in all". */
export function clockShort(clock: IslandClock, now: number, language: Language): string {
  return islandText(language).time[clock.kind](islandTime(clockMs(clock, now), language));
}

/** The whole island in words, for the ring's title: the state, its clock,
 * what it is at and the unread count. */
export function islandLabel(view: IslandView, now: number, language: Language): string {
  const t = islandText(language);
  const line = lineText(view.line, view.state, language);
  return [t.state[view.state], view.clock ? clockCaption(view.state, view.clock, now, language) : null, line || null, view.unread > 0 ? t.unread(view.unread) : null]
    .filter(Boolean).join(" · ");
}

/** Where the ring goes, in words: its label. */
export function goText(go: IslandAction, view: IslandView, language: Language): string {
  const t = islandText(language).go;
  switch (go) {
    case "answer": return t.answer();
    case "why": return t.why();
    case "result": return t.result(view.pr);
    case "queue": return t.queue();
    case "task": return t.task(view.task);
    case "turn": return t.turn();
    case "unread": return t.unread(view.unread);
  }
}

/** What a ring can show: a state, or a passing event's result. */
export type RingState = IslandState | "green" | "red";
const C = 2 * Math.PI * 9.5;

/**
 * The ring (T-43 v10.2): strokes only, and the state by itself. Working is
 * an arc that turns, its length the progress (a fixed quarter until
 * templates carry their steps); handed in, an outer arc of its review
 * rounds round an inner ring; needs you, a full ring that breathes; queued,
 * dots that turn slowly; offline, dashes; done ✓, failed ✕ and archived (a
 * box) a mark inside. Under reduced motion nothing turns or breathes.
 */
export function IslandRing({ state, progress }: { state: RingState; progress: number | null }) {
  const circle = (className: string, extra: Record<string, string> = {}, r = 9.5) => <circle cx="12" cy="12" r={r} className={className} {...extra} />;
  let body;
  switch (state) {
    case "idle": body = circle("r-idle"); break;
    case "working": {
      const len = progress == null ? 0.25 : Math.max(0.08, Math.min(1, progress));
      body = <>{circle("r-track")}<g className="r-spin">{circle("r-arc", { strokeDasharray: `${C * len} ${C}`, transform: "rotate(-90 12 12)" })}</g></>;
      break;
    }
    case "handed": {
      const len = Math.max(0, Math.min(1, progress ?? 0));
      const outer = 2 * Math.PI * 10.5;
      body = <>{circle("r-faint", {}, 10.5)}{len > 0 && circle("r-rounds", { strokeDasharray: `${outer * len} ${outer * 2}`, transform: "rotate(-90 12 12)" }, 10.5)}{circle("r-inner", {}, 6.8)}</>;
      break;
    }
    case "waiting": body = circle("r-breathe"); break;
    case "queued": body = <g className="r-march">{circle("r-dots", { strokeDasharray: "0.1 4.2" })}</g>; break;
    case "offline": body = circle("r-dashed", { strokeDasharray: "4.5 3" }); break;
    case "done": case "green": body = <>{circle("r-full")}<path className="r-mark" d="M7.6 12.3 L10.6 15.2 L16.4 8.9" /></>; break;
    case "failed": case "red": body = <>{circle("r-full")}<path className="r-mark" d="M8.6 8.6 L15.4 15.4 M15.4 8.6 L8.6 15.4" /></>; break;
    case "archived": body = <>{circle("r-idle r-archived")}<path className="r-mark r-box" d="M7.5 9.2 H16.5 M8.4 9.2 V15.6 H15.6 V9.2 M10.6 11.8 H13.4" /></>; break;
  }
  return <svg viewBox="0 0 24 24" className="island-ring" data-ring={state} aria-hidden="true" focusable="false">{body}</svg>;
}

/** A passing event, said for a few seconds in a pill grown left out of the
 * ring: its words, the ring it shows (✓ or ✕ for a result) and its colour. */
export type IslandPill = { text: string; ring: RingState | null; tone: "ok" | "bad" | "info" | "working" };

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
 * The ring at the row's top right (T-43 v10.2). With somewhere to go, it is
 * a button labelled with where ("Answer its question on Home"): its hit
 * area is larger than the ring (28 px with a mouse, 40 on touch) with
 * nothing drawn, and on hover or focus the ring scales up a little in
 * place (a thicker stroke under reduced motion). With nowhere of its own,
 * it is part of the row, whose click opens the conversation.
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
        {form === "pill" && pill && <span className="island-pill" data-tone={pill.tone} aria-hidden="true">{pill.text}</span>}
        <span className="island-ringbox" data-ring={ring}>
          <IslandRing state={ring} progress={view.progress} />
          {view.unread > 0 && <span className="island-notch" aria-hidden="true">{view.unread > 99 ? "99+" : view.unread}</span>}
        </span>
      </>
    );
    const shared = {
      ...hooks,
      className: "agent-island",
      "data-state": view.state,
      "data-form": form,
      "data-go": go ?? undefined,
      "data-clock": view.clock?.kind,
      "data-unread": view.unread > 0 ? (view.unread > 1 ? "count" : "dot") : undefined,
    };
    // Nowhere of its own: part of the row, whose link says the state.
    if (!go) return <span {...shared} aria-hidden="true">{body}</span>;
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
export function useIslandShell(row: RefObject<HTMLElement | null>, shell: RefObject<HTMLElement | null>, form: IslandForm) {
  const last = useRef<{ form: IslandForm; box: Box | null } | null>(null);
  useLayoutEffect(() => {
    const el = row.current, outline = shell.current;
    if (!el || !outline) return;
    const box = shellBox(el, form);
    if (form === "pill" && box) Object.assign(outline.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: `${box.radius}px` });
    else outline.removeAttribute("style");
    const prev = last.current;
    last.current = { form, box };
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
  }, [form]);
}
