// The conversation's jobs and CI runs as a timeline on the left edge,
// mirroring the turn dock on the right: a thin line threads each group and
// every run is a node on it. Where the conversation is wide enough each node
// reads its status, and its name once the pointer or focus comes to the dock;
// otherwise it names itself in a small tip. Jobs and runs open their details
// in the Jobs panel; sub-agents open a card beside the dock.
import type { ReactNode } from "react";
import {
  Check,
  CircleHelp,
  CircleMinus,
  Clock3,
  LoaderCircle,
  Pause,
  X,
  type LucideIcon,
} from "lucide-react";
import { strings, useStrings } from "./i18n";
import "./work-dock.css";

// The dock's own words (T-189); labels and names come from its callers.
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

export function WorkDock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <nav className="work-dock" aria-label={label}>
      {children}
    </nav>
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
  return (
    <button
      type="button"
      className={`work-dock-item state-${status} ${className}`.trim()}
      aria-label={[name, state, detail, when].filter(Boolean).join(" · ")}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="work-dock-node" aria-hidden="true">
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
