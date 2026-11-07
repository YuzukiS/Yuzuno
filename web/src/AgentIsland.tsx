import { forwardRef, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { clockMs, islandTime, type IslandAction, type IslandClock, type IslandState, type IslandView } from "./agent-island";
import { detailText, executorRowText } from "./ExecutorRowState";
import { strings, useLanguage, type Language } from "./i18n";
import { useMinute } from "./live-executors";
import "./agent-island.css";

// The island's words (T-43, 灵动环 v4-2). What Agents and Core wrote is shown as it came.
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
  ago: " ago",
  pre: "",
  clock: {
    working: (x: string) => `for ${x}`, handed: (x: string) => `handed in ${x} ago`, waiting: (x: string) => `waiting ${x}`,
    queued: (x: string) => `queued ${x}`, since: (x: string) => `${x} ago`, total: (x: string) => `${x} in total`,
  },
  handed: (pr: number | null) => (pr != null ? `#${pr} · the lead's turn` : "the lead's turn"),
  nextSlice: (pr: number | null) => (pr != null ? `handed in #${pr}; on the next slice` : "handed in; on the next slice"),
  unread: (n: number) => `${n} unread`,
  action: { open: "Open", home: "Answer on Home", task: "Task", result: "See result" } as Record<IslandAction, string>,
  card: (name: string) => `${name}: details`,
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
  ago: "前",
  pre: "共 ",
  clock: {
    working: (x) => `已用 ${x}`, handed: (x) => `已交 ${x}`, waiting: (x) => `已等 ${x}`,
    queued: (x) => `排队 ${x}`, since: (x) => `${x}前`, total: (x) => `共用 ${x}`,
  },
  handed: (pr) => (pr != null ? `#${pr} · 等负责人` : "等负责人"),
  nextSlice: (pr) => (pr != null ? `已交 #${pr}，在做下一片` : "已交，在做下一片"),
  unread: (n) => `${n} 条未读`,
  action: { open: "打开会话", home: "去 Home 回答", task: "看任务", result: "看结果" },
  card: (name) => `${name}：详情`,
});

export type IslandForm = "ring" | "two" | "card";

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Line two's words, after the state's word. */
export function islandLineText(view: IslandView, language: Language): string {
  const t = islandText(language);
  switch (view.line.kind) {
    case "detail": return detailText(view.line.detail, executorRowText(language)) ?? "";
    case "text": return view.line.text;
    case "handed": return view.state === "handed" ? t.handed(view.line.pr) : t.nextSlice(view.line.pr);
    case "none": return "";
  }
}

/** The clock as a caption: "已用 1时12分", "14分前", "共用 1时12分". */
export function clockCaption(state: IslandState, clock: IslandClock, now: number, language: Language): string {
  const t = islandText(language);
  const x = islandTime(clockMs(clock, now), language);
  if (clock.kind === "total") return t.clock.total(x);
  if (clock.kind === "since") return t.clock.since(x);
  return state === "handed" ? t.clock.handed(x) : state === "waiting" ? t.clock.waiting(x) : state === "queued" ? t.clock.queued(x) : t.clock.working(x);
}

/** The whole island in words, for its label and title: the state, its clock,
 * what it is at and the unread count. */
export function islandLabel(view: IslandView, now: number, language: Language): string {
  const t = islandText(language);
  const line = islandLineText(view, language);
  return [t.state[view.state], view.clock ? clockCaption(view.state, view.clock, now, language) : null, line || null, view.unread > 0 ? t.unread(view.unread) : null]
    .filter(Boolean).join(" · ");
}

/**
 * The island button at the row's right end (T-43 v4-2): a small ring while
 * nothing is going on, one line with the time while something is, two
 * lines when the Agent needs you or failed. Pressing it opens the card;
 * the rest of the row still opens the Agent. Its size morphs (280 ms) when
 * its form or state changes, clipped while it grows; still under reduced
 * motion.
 */
type IslandProps = {
  view: IslandView;
  form: IslandForm;
  name: string;
  onToggle: () => void;
  /** More for its title: an executor's task, what it waits for, who dispatched it. */
  detail?: string;
  /** An executor's template and PR chips, held in the island before its
   * clock (the user, 2026-11-07: one island per row), and their words for
   * its label. */
  facts?: ReactNode;
  factsLabel?: string | null;
  /** The runtime's own hooks, as its status carried them: the app's status
   * words for it, and its live Jobs and CI. */
  "data-status"?: string;
  "data-jobs"?: number;
  "data-ci"?: number;
  "data-combined"?: true;
};

export const AgentIsland = forwardRef<HTMLButtonElement, IslandProps>(
  function AgentIsland({ view, form, name, onToggle, detail, facts, factsLabel, ...hooks }, ref) {
    const language = useLanguage();
    const t = islandText(language);
    const now = useMinute();
    const own = useRef<HTMLButtonElement | null>(null);
    const size = useRef<{ w: number; h: number } | null>(null);
    const label = islandLabel(view, now, language);
    const line = islandLineText(view, language);
    const clock = view.clock ? islandTime(clockMs(view.clock, now), language) : null;
    useLayoutEffect(() => {
      const el = own.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const prev = size.current;
      size.current = { w: r.width, h: r.height };
      if (!prev || !r.width || reducedMotion() || typeof el.animate !== "function") return;
      if (prev.w === r.width && prev.h === r.height) return;
      const grow = r.width > prev.w || r.height > prev.h;
      if (grow) el.style.overflow = "hidden";
      const anim = el.animate([{ width: `${prev.w}px`, height: `${prev.h}px` }, { width: `${r.width}px`, height: `${r.height}px` }], { duration: 280, easing: EASE });
      const done = () => { el.style.overflow = ""; };
      anim.finished.then(done, done);
    }, [form, view.state, view.unread > 0, !!facts]);
    return (
      <button
        ref={(el) => { own.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }}
        type="button"
        {...hooks}
        className="agent-island"
        data-state={view.state}
        data-form={form}
        data-clock={view.clock?.kind}
        data-unread={view.unread > 0 ? (view.unread > 1 ? "count" : "dot") : undefined}
        data-facts={facts ? "" : undefined}
        aria-label={`${name} · ${label}${factsLabel ? ` · ${factsLabel}` : ""}`}
        aria-expanded={form === "card"}
        title={detail ? `${label}\n${detail}` : label}
        onClick={(event) => { event.stopPropagation(); onToggle(); }}
      >
        <span className="island-head">
          <span className="island-dot" aria-hidden="true" />
          <span className="island-word" aria-hidden="true">{t.word[view.state]}</span>
          {facts}
          {clock && (
            <span className="island-clock" aria-hidden="true">
              {view.clock?.kind === "total" && <span className="island-pre">{t.pre}</span>}
              {clock}
              {view.clock?.kind === "since" && <span className="island-ago">{t.ago}</span>}
            </span>
          )}
          {view.unread > 0 && <span className="island-unread" aria-hidden="true">{view.unread > 1 ? (view.unread > 99 ? "99+" : view.unread) : ""}</span>}
        </span>
        <span className="island-line" aria-hidden="true">{line ? `${t.word[view.state]}${t.colon}${line}` : t.state[view.state]}</span>
      </button>
    );
  },
);

/**
 * The card (T-43 v4-2, like the Dynamic Island's music player): opened in
 * the row's place, never over it. The ring becomes its cover at the top
 * left, beside the state with its clock and what the Agent is at; under
 * them the clock's line (the steps join it once templates carry them) and
 * the unread count; then its actions, which only lead somewhere. Opening
 * it moves focus to its first action; Escape closes it.
 */
export const IslandCard = forwardRef<HTMLDivElement, { view: IslandView; name: string; onAction: (action: IslandAction) => void; onClose: () => void }>(
  function IslandCard({ view, name, onAction, onClose }, coverRef) {
    const language = useLanguage();
    const t = islandText(language);
    const now = useMinute();
    const line = islandLineText(view, language);
    const ms = view.clock ? clockMs(view.clock, now) : null;
    const card = useRef<HTMLElement>(null);
    const actions = useRef<HTMLDivElement>(null);
    useEffect(() => {
      // Opened near the list's end (a phone), its actions come into view.
      card.current?.scrollIntoView?.({ block: "nearest" });
      actions.current?.querySelector("button")?.focus({ preventScroll: true });
    }, []);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    return (
      <section ref={card} className="agent-island-card" data-state={view.state} aria-label={t.card(name)} onKeyDown={onKeyDown} onClick={(event) => event.stopPropagation()}>
        <div className="island-player">
          <div ref={coverRef} className="island-cover" aria-hidden="true">
            {ms != null && view.clock?.kind !== "since" ? islandTime(ms, language, true) : <span className="island-dot" />}
          </div>
          <div className="island-title">
            {t.state[view.state]}{view.clock ? ` · ${clockCaption(view.state, view.clock, now, language)}` : ""}
          </div>
          <div className="island-sub">{line || t.state[view.state]}</div>
        </div>
        {ms != null && (
          <div className="island-scrub" aria-hidden="true">
            <span>{islandTime(ms, language)}</span>
            <span className="island-track" />
          </div>
        )}
        {view.unread > 0 && <div className="island-card-unread"><b>{view.unread > 99 ? "99+" : view.unread}</b>{t.unread(view.unread)}</div>}
        <div ref={actions} className="island-actions">
          {view.actions.map((action, i) => (
            <button key={action} type="button" className={i === 0 ? "primary" : undefined} onClick={() => onAction(action)}>
              {t.action[action]}
            </button>
          ))}
        </div>
      </section>
    );
  },
);

/** The cover's slide (T-43 v4-2): from where `from` was to where `to` is
 * now, in 320 ms; nothing under reduced motion or where it can't move. */
export function slide(from: DOMRect | null, to: HTMLElement | null) {
  if (!from || !to || reducedMotion() || typeof to.animate !== "function") return;
  const b = to.getBoundingClientRect();
  if (!from.width || !b.width || !b.height) return;
  to.animate(
    [{ transform: `translate(${from.left - b.left}px, ${from.top - b.top}px) scale(${from.height / b.height})` }, { transform: "none" }],
    { duration: 320, easing: EASE },
  );
}
