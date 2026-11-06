// The conversation's jobs and CI runs as a timeline on the left edge,
// mirroring the turn dock on the right: a thin line threads each group and
// every run is a node on it. Where the conversation is wide enough each node
// reads its status, and its name once the pointer or focus comes to the dock;
// otherwise it names itself in a small tip. Jobs and runs open their details
// in the Jobs panel; sub-agents open a card beside the dock.
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import {
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
import { byAttention, workActivity, type WorkItem, type WorkKind } from "./work-activity.ts";
import "./work-dock.css";

// The dock's own words (T-189); labels and names come from its callers.
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
type Register = (kind: WorkKind, items: readonly WorkItem[]) => void;
const Registry = createContext<Register | null>(null);

/** Hands this kind's work to the dock, and takes it back when it goes. */
export function useWorkActivity(kind: WorkKind, items: readonly WorkItem[]) {
  const register = useContext(Registry);
  // The identity of the array changes on every render; what it says does not.
  const key = JSON.stringify(items);
  useEffect(() => {
    register?.(kind, items);
    return () => register?.(kind, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, kind, key]);
}

/**
 * Holds what the dock's kinds report, above both the dock and the head of
 * the conversation, so the one entry can stand where there is room to read
 * it rather than in the dock's own narrow column (T-15).
 */
const Activity = createContext<ReturnType<typeof workActivity> | null>(null);

export function WorkActivityProvider({ children }: { children: ReactNode }) {
  const [work, setWork] = useState<Partial<Record<WorkKind, readonly WorkItem[]>>>({});
  const register = useCallback<Register>((kind, items) => {
    setWork((was) => (was[kind] === items ? was : { ...was, [kind]: items }));
  }, []);
  const activity = useMemo(
    () => workActivity(byAttention([...(work.job ?? []), ...(work.run ?? []), ...(work.subAgent ?? [])])),
    [work],
  );
  return (
    <Registry.Provider value={register}>
      <Activity.Provider value={activity}>{children}</Activity.Provider>
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

export function WorkDock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <nav className="work-dock" aria-label={label} lang={langTag(useLanguage())}>
      {children}
    </nav>
  );
}

/**
 * One line for everything the conversation has running, instead of a column
 * of every piece of it. What needs a look is named first and always, even
 * with nothing running: it is the reason the entry is there. The list behind
 * it is unchanged, and is where the detail stays.
 */
export function WorkActivityEntry({ onOpen }: { onOpen: (from: HTMLElement) => void }) {
  const t = useStrings(entry);
  const activity = useContext(Activity);
  if (!activity?.any) return null;
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
      onClick={(event) => onOpen(event.currentTarget)}
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
  const node = useRef<HTMLSpanElement>(null);
  useSettleOnEnd(node, status);
  return (
    <button
      type="button"
      className={`work-dock-item state-${status} ${className}`.trim()}
      aria-label={[name, state, detail, when].filter(Boolean).join(" · ")}
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
      <span className="work-dock-tip" aria-hidden="true">
        <strong>{name}</strong>
        <span>{state}</span>
        {detail && <small>{detail}</small>}
        {when && <small className="work-dock-when">{when}</small>}
      </span>
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
