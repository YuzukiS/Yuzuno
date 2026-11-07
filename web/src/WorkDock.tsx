// The conversation's jobs and CI runs as a timeline on the left edge,
// mirroring the turn dock on the right: a thin line threads each group and
// every run is a node on it. Where the conversation is wide enough each node
// reads its status, and its name once the pointer or focus comes to the dock;
// otherwise it names itself in a small tip. Jobs and runs open their details
// in the Jobs panel; sub-agents open a card beside the dock.
import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  BriefcaseBusiness,
  Check,
  CircleHelp,
  CircleMinus,
  Clock3,
  LoaderCircle,
  Pause,
  X,
  type LucideIcon,
} from "lucide-react";
import { langTag, strings, useLanguage, useStrings } from "./i18n";
import { animates } from "./motion";
import { byAttention, workActivity, workKinds, type WorkItem, type WorkKind } from "./work-activity.ts";
import "./work-dock.css";

// The dock's own words (T-189); labels and names come from its callers.
const column = strings({
  title: "Work activity",
  back: "Back to Agents",
  attention: "Needs a look",
  jobs: "Jobs",
  runs: "CI",
  subAgents: "Sub-agents",
  backgroundTasks: "Background tasks",
  reviews: "Reviews",
  unknown: "Not recognised",
  openList: (what: string) => `Open ${what}`,
  empty: "Nothing is running for this Agent.",
}, {
  title: "工作活动",
  back: "返回 Agent 列表",
  attention: "需要注意",
  jobs: "Jobs",
  runs: "CI",
  subAgents: "子 Agent",
  backgroundTasks: "后台任务",
  reviews: "审查",
  unknown: "无法识别",
  openList: (what) => `打开${what}`,
  empty: "这个 Agent 没有在进行的工作。",
});

const entry = strings({
  label: "Work activity",
  // Each kind says its own thing; there is never a total across them.
  running: (n: number) => `${n} running`,
  needsLook: (n: number) => `${n} need a look`,
  unknown: (n: number) => `${n} not recognised`,
  quiet: "nothing running",
  open: "Open the list",
}, {
  label: "工作活动",
  running: (n) => `${n} 个在进行`,
  needsLook: (n) => `${n} 个待查看`,
  unknown: (n) => `${n} 个无法识别`,
  quiet: "没有在进行的工作",
  open: "打开列表",
});

const text = strings({
  open: (label: string) => `${label} · open the list`,
  openLabel: (label: string) => `${label}: open the list`,
  moreTitle: (count: number) => `${count} more · open the list`,
  moreLabel: (label: string, count: number) => `${label}: ${count} more, open the list`,
  more: (count: number) => `${count} more`,
}, {
  open: (label) => `${label} · 打开列表`,
  openLabel: (label) => `${label}：打开列表`,
  moreTitle: (count) => `另有 ${count} 个 · 打开列表`,
  moreLabel: (label, count) => `${label}：另有 ${count} 个，打开列表`,
  more: (count) => `另有 ${count} 个`,
});

const marks: Record<string, LucideIcon> = {
  queued: Clock3,
  pending: Clock3,
  starting: LoaderCircle,
  running: LoaderCircle,
  cancelling: LoaderCircle,
  // A running job the user paused (T-107): frozen, still holding its capacity.
  paused: Pause,
  succeeded: Check,
  passed: Check,
  // A sub-agent whose Turn ended; how it ended is in its details.
  ended: Check,
  failed: X,
  rejected: X,
  interrupted: X,
  cancelled: CircleMinus,
  skipped: CircleMinus,
};

/**
 * A status as the dock draws its nodes, for the rows and headings of the
 * Jobs panel: one vocabulary for jobs, runs, reviews and sub-agents. Always
 * beside its status in words.
 */
export function StatusMark({
  status,
  large = false,
}: {
  status: string;
  large?: boolean;
}) {
  const Mark = marks[status] || CircleHelp;
  return (
    <span
      className={`status-mark state-${status}${large ? " is-large" : ""}`}
      aria-hidden="true"
    >
      <span className="work-dock-node">
        <Mark size={14} />
      </span>
    </span>
  );
}

/**
 * What each kind of work the dock holds has to say about itself (T-15). The
 * dock nests its groups -- jobs and runs hold the sub-agents as children --
 * so no one of them can see the others. They leave their work here instead,
 * and the dock says it once, rather than each kind summing itself and the
 * reader counting three summaries as one.
 */
/**
 * A piece of work as the column shows it: what it is, what it is doing, and
 * how to open what already exists for it. Each kind supplies its own opener,
 * so a Job reaches the Jobs panel and a sub-agent reaches its card without
 * this knowing how either is done (T-15, V9).
 */
export type WorkEntry = WorkItem & {
  name: string;
  /** Its state in words, as its own kind says it. */
  says?: string;
  onOpen?: (from: HTMLElement) => void;
};
/** How a kind opens the list it belongs to: the dock's heading and "+N more". */
export type OpenList = (from: HTMLElement) => void;
type Register = (id: string, kind: WorkKind, items: readonly WorkEntry[], openList?: OpenList, present?: boolean) => void;
const Registry = createContext<Register | null>(null);

/**
 * Hands this instance's work to the dock, and takes it back when it goes.
 *
 * Keyed by the instance, not by the kind. Two docks of the same kind are
 * ordinary — Claude's background tasks and the conversation's sub-agents are
 * both drawn by SubAgentDock — and with one slot per kind they overwrote each
 * other, while either one's cleanup wrote `[]` and cleared the other's work
 * as well. The counts in the entry and the column were then whichever
 * mounted last (#459 round 1, P1).
 *
 * `present` says this instance has work of its kind at all, counted or not.
 * Some of what the dock draws is deliberately left out of the count — a Job
 * the reader cancelled, a run a later one replaced (row 14) — and with only
 * such work there was nothing here, so the entry and the kind's "Open …" row
 * went with it. On a touched screen wider than a phone the dock takes no
 * press, so that work was drawn and out of reach (#459 R8, P3). Present, the
 * kind keeps its way into its list, without anything being counted.
 */
export function useWorkActivity(kind: WorkKind, items: readonly WorkEntry[], openList?: OpenList, present = false) {
  const register = useContext(Registry);
  // Stable for the life of this component, and different per instance.
  const id = useId();
  // The identity of the array changes on every render; what it says does not.
  const key = JSON.stringify(items);
  // The opener is a new function on every render; registering it directly
  // would re-register on each one. A stable wrapper calls the latest.
  const latest = useRef(openList);
  latest.current = openList;
  const has = !!openList;
  const open = useCallback<OpenList>((from) => latest.current?.(from), []);
  useEffect(() => {
    register?.(id, kind, items, has ? open : undefined, present);
    return () => register?.(id, kind, [], undefined, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, id, kind, key, has, open, present]);
}

/**
 * Holds what the dock's kinds report, above both the dock and the head of
 * the conversation, so the one entry can stand where there is room to read
 * it rather than in the dock's own narrow column (T-15).
 */
const Activity = createContext<ReturnType<typeof workActivity> | null>(null);
/** The same work, in the order it should be looked at. */
const Entries = createContext<readonly WorkEntry[]>([]);
/** Each kind's way into its own whole list, where it offered one. */
const Lists = createContext<Partial<Record<WorkKind, OpenList>>>({});
/** Kinds with work and none of it counted: only their list is offered. */
const Held = createContext<readonly WorkKind[]>([]);

export function WorkActivityProvider({ children }: { children: ReactNode }) {
  const [work, setWork] = useState<Record<string, { kind: WorkKind; items: readonly WorkEntry[]; openList?: OpenList; present: boolean }>>({});
  const register = useCallback<Register>((id, kind, items, openList, present = false) => {
    setWork((was) => {
      // Nothing at all is this instance going away, or having nothing: its
      // own slot goes, and no other.
      if (!items.length && !present) {
        if (!(id in was)) return was;
        const next = { ...was };
        delete next[id];
        return next;
      }
      const had = was[id];
      if (had && had.kind === kind && had.items === items && had.openList === openList && had.present === present) return was;
      return { ...was, [id]: { kind, items, openList, present } };
    });
  }, []);
  const sorted = useMemo(() => {
    const slots = Object.values(work);
    // Every instance of a kind together, kinds in the order they are read.
    const ofKind = (kind: WorkKind) =>
      slots.filter((slot) => slot.kind === kind).flatMap((slot) => slot.items);
    return byAttention(workKinds.flatMap(ofKind)) as WorkEntry[];
  }, [work]);
  const lists = useMemo(() => {
    const found: Partial<Record<WorkKind, OpenList>> = {};
    for (const slot of Object.values(work))
      if (slot.openList && !found[slot.kind]) found[slot.kind] = slot.openList;
    return found;
  }, [work]);
  // A kind with work and nothing of it counted, which can still be opened.
  const held = useMemo(() => workKinds.filter((kind) => {
    const slots = Object.values(work).filter((slot) => slot.kind === kind);
    return slots.some((slot) => slot.present && slot.openList) && !slots.some((slot) => slot.items.length);
  }), [work]);
  const activity = useMemo(() => workActivity(sorted), [sorted]);
  return (
    <Registry.Provider value={register}>
      <Activity.Provider value={activity}>
        <Entries.Provider value={sorted}>
          <Lists.Provider value={lists}>
            <Held.Provider value={held}>{children}</Held.Provider>
          </Lists.Provider>
        </Entries.Provider>
      </Activity.Provider>
    </Registry.Provider>
  );
}

/** Statuses a run ends in; "unknown" is not one: it must never look settled. */
const ENDED = new Set(["succeeded", "passed", "ended", "failed", "rejected", "interrupted", "cancelled", "skipped"]);
/** Of those, the ones drawn as a filled node; cancelled and skipped are a ring. */
const FILLED = new Set(["succeeded", "passed", "ended", "failed", "rejected", "interrupted"]);

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** A duration token in milliseconds; its value in styles.css where none is read. */
const tokenMs = (name: string, otherwise: number) => {
  const value = token(name);
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : otherwise;
};

/**
 * A node whose run ends while the dock shows it settles once (T-19 CV:WD-05):
 * its new fill fades in over small, and a run that succeeded also springs
 * .96 → 1, overshooting to 1.02, over micro. A poll that reads the same status
 * again plays nothing, nor does a node that first shows ended. An unknown
 * status is passed over: the run is judged against what it was before it, so
 * one already ended does not settle again once it is read. Queued, cancelling
 * and paused get no cue. Under reduced motion, or without the Web Animations
 * API, nothing plays.
 */
function useSettleOnEnd(node: RefObject<HTMLElement | null>, status: string) {
  const known = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (status === "unknown") return;
    const was = known.current;
    known.current = status;
    const element = node.current;
    if (was === null || was === status || ENDED.has(was) || !ENDED.has(status) || !element || !animates()) return;
    const easing = token("--ease-standard") || "cubic-bezier(0.2, 0.8, 0.2, 1)";
    const small = tokenMs("--motion-small", 180);
    if (FILLED.has(status)) {
      // From the paper the node is cut out of to its own fill, left implicit:
      // the item's colour is itself still fading to the new status.
      const hole = getComputedStyle(element).getPropertyValue("--node-hole").trim() || token("--paper") || "transparent";
      element.animate([{ backgroundColor: hole, offset: 0 }], { duration: small, easing, id: "dock-settle-fill" });
    } else {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: small, easing, id: "dock-settle-fill" });
    }
    if (status === "succeeded" || status === "passed")
      element.animate([{ scale: "0.96" }, { scale: "1.02", offset: 0.6 }, { scale: "1" }],
        { duration: tokenMs("--motion-micro", 120), easing, id: "dock-settle-spring" });
  }, [node, status]);
}

/**
 * This Agent's work in the rail, in place of the Agents: what needs a look
 * first, then the Jobs, the checks and the sub-agents, each opening the
 * detail it already has. The entry in the head counts exactly these, so the
 * number on it and what opens here are the same work (T-15, V9).
 */
export function WorkActivityColumn({ onBack }: { onBack: () => void }) {
  const t = useStrings(column);
  const language = useLanguage();
  const entries = useContext(Entries);
  // The same definition the entry counts by: exceptions are what needs a
  // look, and work this build has no word for is shown apart rather than
  // folded in. The column said exception-or-unrecognised, so its heading
  // could count more than the entry did (#459 round 1, P3a).
  const needsLook = entries.filter((e) => e.state === "exception");
  const unknown = entries.filter((e) => e.state === "unrecognized");
  const rest = (kind: WorkKind) =>
    entries.filter((e) => e.kind === kind && e.state !== "exception" && e.state !== "unrecognized");
  // Each kind's own way into its whole list, which by touch the dock itself
  // no longer offers: its heading and its "+N more" are 28x24 and the dock
  // takes no presses there, so the column carries them instead (#459 round
  // 1, P2a). The mixed groups have no single list to open.
  const lists = useContext(Lists);
  // A kind whose work is all uncounted still has its group, holding only the
  // way into its list: nothing in it is counted, and it is still reachable.
  const held = useContext(Held);
  const every: { id: string; kind?: WorkKind; label: string; items: readonly WorkEntry[]; openList?: OpenList }[] = [
    { id: "attention", label: t.attention, items: needsLook, openList: undefined },
    { id: "jobs", kind: "job", label: t.jobs, items: rest("job"), openList: lists.job },
    { id: "runs", kind: "run", label: t.runs, items: rest("run"), openList: lists.run },
    { id: "subAgents", kind: "subAgent", label: t.subAgents, items: rest("subAgent"), openList: lists.subAgent },
    { id: "backgroundTasks", kind: "backgroundTask", label: t.backgroundTasks, items: rest("backgroundTask"), openList: lists.backgroundTask },
    { id: "reviews", kind: "review", label: t.reviews, items: rest("review"), openList: lists.review },
    { id: "unknown", label: t.unknown, items: unknown, openList: undefined },
  ];
  const groups = every.filter((group) => group.items.length > 0 || (!!group.kind && held.includes(group.kind) && !!group.openList));
  return (
    <div className="work-activity-column" lang={langTag(language)}>
      <div className="work-activity-column-top">
        <button type="button" className="quiet-button work-activity-column-back" onClick={onBack}>
          <ArrowLeft size={13} aria-hidden="true" />
          {t.back}
        </button>
      </div>
      <h2 className="work-activity-column-title">
        <BriefcaseBusiness size={13} aria-hidden="true" />
        {t.title}
      </h2>
      {groups.length === 0 ? (
        <p className="work-activity-column-empty">{t.empty}</p>
      ) : (
        <div className="work-activity-column-list">
          {groups.map((group) => (
            <section key={group.id} aria-label={group.label}>
              <h3 data-attention={group.id === "attention" || undefined}>{group.label}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <button
                      type="button"
                      className="work-activity-row"
                      data-state={item.state}
                      disabled={!item.onOpen}
                      onClick={(event) => item.onOpen?.(event.currentTarget)}
                    >
                      <span className="work-activity-row-name">{item.name}</span>
                      {item.says && <span className="work-activity-row-says">{item.says}</span>}
                    </button>
                  </li>
                ))}
                {group.openList && (
                  <li>
                    <button
                      type="button"
                      className="work-activity-row work-activity-row-list"
                      onClick={(event) => group.openList?.(event.currentTarget)}
                    >
                      <span className="work-activity-row-name">{t.openList(group.label)}</span>
                    </button>
                  </li>
                )}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkDock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  // The scrolling is an inner box, so the dock itself clips nothing: its
  // hover strip (`.work-dock::before`, inset -20px) and each item's tip live
  // outside the dock's 40px, and a scroll container on the dock clipped both
  // — a non-visible overflow on one axis makes the other non-visible too, so
  // `overflow-y: auto` cost the tip its place (#459 new pair, P2).
  return (
    <nav className="work-dock" aria-label={label} lang={langTag(useLanguage())}>
      <div className="work-dock-scroll">{children}</div>
    </nav>
  );
}

/**
 * One line for everything the conversation has running, instead of a column
 * of every piece of it. What needs a look is named first and always, even
 * with nothing running: it is the reason the entry is there. The list behind
 * it is unchanged, and is where the detail stays.
 */
export function WorkActivityEntry({
  onOpen,
  expanded,
  drawer = false,
}: {
  onOpen: (from: HTMLElement) => void;
  /** Whether the view it opens is on screen, which is not the same as having
   * been asked for: the rail it lives in can be collapsed (#459 R1, P2). */
  expanded?: boolean;
  /** What it opens is the dock itself, as a phone's drawer, rather than the column. */
  drawer?: boolean;
}) {
  const t = useStrings(entry);
  const activity = useContext(Activity);
  const entries = useContext(Entries);
  const lists = useContext(Lists);
  const held = useContext(Held);
  if (!activity || (!activity.any && !held.length)) return null;
  // A phone's drawer is the dock, which draws what Appearance lets it and
  // nothing more, while this counts everything. With the counted work's kinds
  // set to 0 there, the press opened a drawer with nothing in it. It opens the
  // list of what it counted instead, the most pressing kind first (#459 R8,
  // P3). The dock's own box is the one the drawer shows.
  const open = (from: HTMLElement) => {
    const dock = document.querySelector(".conversation-body > .work-dock > .work-dock-scroll");
    if (drawer && !expanded && (!dock || dock.childElementCount === 0)) {
      const kind = entries[0]?.kind ?? held[0];
      const list = (kind && lists[kind]) || Object.values(lists)[0];
      if (list) return list(from);
    }
    onOpen(from);
  };
  // Said apart, never added up: these are different kinds of fact.
  const parts = [
    activity.exception > 0 ? t.needsLook(activity.exception) : null,
    activity.current > 0 ? t.running(activity.current) : null,
    activity.unrecognized > 0 ? t.unknown(activity.unrecognized) : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      className="work-activity-entry"
      data-needs-look={activity.exception > 0 || undefined}
      // The name is read from what is inside, so the counts a reader can see
      // are the counts a screen reader says and the words voice control
      // listens for. An aria-label would be a second copy of them, free to
      // drift from the first (T-15, Dev 7).
      title={t.label}
      aria-expanded={expanded}
      onClick={(event) => open(event.currentTarget)}
    >
      <BriefcaseBusiness size={13} aria-hidden="true" />
      <span className="sr-only">{t.label}: </span>
      <span className="work-activity-counts">{parts.join(" · ") || t.quiet}</span>
    </button>
  );
}

export function WorkDockGroup({
  label,
  icon,
  onOpen,
  children,
}: {
  label: string;
  icon: ReactNode;
  onOpen: (from: HTMLElement) => void;
  children: ReactNode;
}) {
  const t = useStrings(text);
  return (
    <div className="work-dock-group" role="group" aria-label={label}>
      <button
        type="button"
        className="work-dock-heading"
        title={t.open(label)}
        aria-label={t.openLabel(label)}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="work-dock-node" aria-hidden="true">
          {icon}
        </span>
        <span className="work-dock-label" aria-hidden="true">
          <strong>{label}</strong>
        </span>
      </button>
      {children}
    </div>
  );
}

export function WorkDockItem({
  status,
  state,
  name,
  sub,
  detail,
  when,
  className = "",
  onOpen,
}: {
  /** Status key, which picks the mark and its colour. */
  status: string;
  /** The status as people read it. */
  state: string;
  name: string;
  /** A few words under the name; the status by default. */
  sub?: string;
  detail?: string;
  /** Its latest moment, such as "Started 14:02", shown quietly with the name. */
  when?: string | null;
  className?: string;
  onOpen: (from: HTMLElement) => void;
}) {
  const Mark = marks[status] || CircleHelp;
  const language = useLanguage();
  const node = useRef<HTMLSpanElement>(null);
  const self = useRef<HTMLButtonElement>(null);
  useSettleOnEnd(node, status);
  // Where the tip goes, in the page's own coordinates. It is drawn into the
  // body because the dock's scrolling box would clip it, and because the
  // dock's `translate` makes it a containing block, so `position: fixed`
  // inside the dock would not escape either.
  const [tip, setTip] = useState<{
    top: number;
    left?: number;
    right?: number;
    maxWidth: number;
    /** Whether the conversation is wide enough to say the time beside the
     * node already, so the tip need not repeat it. A flag, because the tip
     * is drawn into the page: `@container conversation` cannot reach it
     * there, and the rule that used to hide it simply stopped matching
     * (#459 R6, P3). */
    wide: boolean;
  } | null>(null);
  const place = useCallback(() => {
    const button = self.current;
    if (!button) return;
    // The phone shows this dock as a drawer with the names already on it, and
    // hid the tip with a descendant rule the page-level tip escapes.
    if (button.closest('.app.phone .conversation-body[data-phone-dock="work"]')) return setTip(null);
    const r = button.getBoundingClientRect();
    const room = window.innerWidth - r.right - 20;
    const top = Math.round(r.top + r.height / 2);
    // The conversation's own width, read where the container query reads it
    // (`.main-panel` carries `container-name: conversation`). 760px is that
    // query's own threshold, kept in one place by being measured here rather
    // than asked of a stylesheet the tip cannot see.
    const wide = (button.closest(".main-panel")?.getBoundingClientRect().width ?? 0) >= 760;
    // Beside the dock where there is room for it; on its other side where
    // there is not, so the tip is always wholly on screen.
    setTip(room >= 140
      ? { top, wide, left: Math.round(r.right + 8), maxWidth: Math.min(280, Math.floor(room)) }
      : { top, wide, right: Math.round(window.innerWidth - r.left + 8), maxWidth: Math.min(280, Math.max(120, Math.floor(r.left - 20))) });
  }, []);
  // While it shows, the dock may scroll under it and the window may change.
  useEffect(() => {
    if (!tip) return;
    const again = () => place();
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    return () => {
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  }, [tip, place]);
  return (
    <button
      ref={self}
      type="button"
      className={`work-dock-item state-${status} ${className}`.trim()}
      aria-label={[name, state, detail, when].filter(Boolean).join(" · ")}
      onPointerEnter={place}
      onPointerLeave={() => setTip(null)}
      onFocus={place}
      onBlur={() => setTip(null)}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="work-dock-node" aria-hidden="true" ref={node}>
        <Mark
          size={14}
          className={Mark === LoaderCircle ? "spin" : undefined}
        />
      </span>
      <span className="work-dock-label" aria-hidden="true">
        <strong>{name}</strong>
        <small>{sub ?? state}</small>
        {when && <small className="work-dock-when">{when}</small>}
      </span>
      {tip &&
        createPortal(
          <span
            className="work-dock-tip"
            aria-hidden="true"
            // Both of these are the nav's, and the body is not inside it:
            // the language so CJK breaks and renders as the reader's own,
            // and the width so the rule below knows what the container
            // query can no longer tell it (#459 R6, P3).
            lang={langTag(language)}
            data-wide={tip.wide ? "" : undefined}
            style={{ top: tip.top, left: tip.left, right: tip.right, maxWidth: tip.maxWidth }}
          >
            <strong>{name}</strong>
            <span>{state}</span>
            {detail && <small>{detail}</small>}
            {when && <small className="work-dock-when">{when}</small>}
          </span>,
          document.body,
        )}
    </button>
  );
}

/** The end of a group that had more runs than the dock shows. */
export function WorkDockMore({
  label,
  count,
  onOpen,
}: {
  label: string;
  count: number;
  onOpen: (from: HTMLElement) => void;
}) {
  const t = useStrings(text);
  return (
    <button
      type="button"
      className="work-dock-more"
      title={t.moreTitle(count)}
      aria-label={t.moreLabel(label, count)}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="work-dock-node" aria-hidden="true">
        +{count}
      </span>
      <span className="work-dock-label" aria-hidden="true">
        <small>{t.more(count)}</small>
      </span>
    </button>
  );
}
