// The parts every source of the Jobs panel shares, so local jobs, Actions
// runs and reviews read as one list: a heading like a Settings section, rows
// grouped into what is still going and what has ended, and the dock's
// status marks.
import { Fragment, useState, type ReactNode } from "react";
import { StatusMark } from "./WorkDock";

/** Where a row belongs: still going, or ended however it ended. */
export type Placement = "active" | "done";
const groups: { key: Placement; title: string }[] = [
  { key: "active", title: "Running and queued" },
  { key: "done", title: "Finished" },
];
/** Finished rows shown before the rest fold behind "Show N more". */
const FOLDED = 10;

/** A moment as a clock time, with its date when it is not today. */
export function clock(at: string | null | undefined, now = new Date()) {
  const date = new Date(at || "");
  if (!at || Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
/** "Queued 14:01 · Finished 14:35": the moments that are known. */
export function moments(parts: [label: string, at: string | null | undefined][]) {
  const known = parts.flatMap(([label, at]) => {
    const text = clock(at);
    return text ? [`${label} ${text}`] : [];
  });
  return known.length ? known.join(" · ") : null;
}

/** A source's heading, as a Settings section starts. */
export function JobsSourceHeading({
  id,
  title,
  children,
  actions,
}: {
  id: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="jobs-source-heading">
      <div>
        <h3 id={id}>{title}</h3>
        <p>{children}</p>
      </div>
      {actions && <div className="jobs-source-actions">{actions}</div>}
    </header>
  );
}

/**
 * The rows of a source in its groups, each keeping the order it came in.
 * Finished rows fold after a few, unless the chosen one is further down.
 */
export function StateGroups<T extends { id: string }>({
  label,
  items,
  place,
  selected,
  row,
  empty,
  children,
  historyLabel = "Finished",
}: {
  label: string;
  items: readonly T[];
  place: (item: T) => Placement;
  selected: string;
  row: (item: T) => ReactNode;
  /** What the list says before it has any rows. */
  empty: ReactNode;
  /** After the groups, such as the button for an earlier page; hidden
   * while finished rows are folded. */
  children?: ReactNode;
  /** CI history can contain runs whose monitoring stopped before completion. */
  historyLabel?: string;
}) {
  const [unfolded, setUnfolded] = useState(false);
  let folded = false;
  return (
    <div className="job-list" role="group" aria-label={label}>
      {items.length
        ? groups.map(({ key, title }) => {
            if (key === "done") title = historyLabel;
            const rows = items.filter((item) => place(item) === key);
            if (!rows.length) return null;
            const folds =
              key === "done" &&
              !unfolded &&
              rows.findIndex((item) => item.id === selected) < FOLDED;
            const shown = folds ? rows.slice(0, FOLDED) : rows;
            folded ||= shown.length < rows.length;
            return (
              <section
                key={key}
                className={`job-group job-group-${key}`}
                aria-label={title}
              >
                <h4 className="job-group-title">
                  {title}
                  <span>{rows.length}</span>
                </h4>
                <div className="job-group-rows">
                  {shown.map((item) => (
                    <Fragment key={item.id}>{row(item)}</Fragment>
                  ))}
                </div>
                {shown.length < rows.length && (
                  <button
                    type="button"
                    className="job-group-more"
                    onClick={() => setUnfolded(true)}
                  >
                    Show {rows.length - shown.length} more
                  </button>
                )}
              </section>
            );
          })
        : empty}
      {/* An earlier page only once every row loaded shows. */}
      {!folded && children}
    </div>
  );
}

/** One row: its mark, its name and time, then its status and source. */
export function JobRow({
  status,
  state,
  name,
  meta,
  note,
  time,
  timeTitle,
  moments,
  selected,
  onSelect,
}: {
  status: string;
  state: string;
  name: string;
  meta: (string | null | false | undefined)[];
  note?: ReactNode;
  time?: string | null;
  timeTitle?: string;
  /** When it was queued and, once it has, finished. */
  moments?: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`job-row${selected ? " selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <StatusMark status={status} />
      <span className="job-row-main">
        <span className="job-row-title">
          <strong>{name}</strong>
          {time && (
            <span className="job-row-time" title={timeTitle}>
              {time}
            </span>
          )}
        </span>
        <small>
          <span className={`job-state state-${status}`}>{state}</span>
          {meta.filter(Boolean).map((part, index) => (
            <Fragment key={index}> · {part}</Fragment>
          ))}
        </small>
        {note && <small className="job-row-note">{note}</small>}
        {moments && <small className="job-row-moments">{moments}</small>}
      </span>
    </button>
  );
}

/** The top of a detail: its mark, name and status, and its one action. */
export function JobDetailHeading({
  status,
  state,
  title,
  role,
  children,
}: {
  status: string;
  state: string;
  title: string;
  /** "status" while it may still change, so it is read out. */
  role?: "status";
  children?: ReactNode;
}) {
  return (
    <header className="job-detail-heading">
      <StatusMark status={status} large />
      <div className="job-detail-title">
        <h3>{title}</h3>
        <p className={`job-state state-${status}`} role={role}>
          {state}
        </p>
      </div>
      {children && <div className="job-detail-actions">{children}</div>}
    </header>
  );
}

/** A card of the detail, with an optional small heading. */
export function JobCard({
  title,
  aside,
  className = "",
  children,
}: {
  title?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`job-card ${className}`.trim()}>
      {title && (
        <div className="job-card-heading">
          <strong>{title}</strong>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
