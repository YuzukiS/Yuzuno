import { ArrowUpRight, Clock3, Eye, NotebookText, Pin as PinIcon, PinOff, TriangleAlert } from "lucide-react";
import { absolute, duration, relative } from "./format";
import { SectionBody } from "./SectionBody";
import type { Pin, PinSource } from "./widget-layout";

/**
 * A Brief section the user pinned to the widget column: the same section
 * Home reads for its project, drawn by the same renderer. It shows where it
 * comes from (project, author, update time) and leads back there. Seen and
 * replies stay with the section in its project, so pinning counts nothing
 * twice. A source that is gone or now another section says so instead of
 * showing content as current.
 */
export function PinnedSection({
  pin,
  source,
  onOpen,
  onUnpin,
  onPinCurrent,
}: {
  pin: Pin;
  source: PinSource;
  onOpen: () => void;
  onUnpin: () => void;
  /** Only when the section now under the key may itself be pinned (not an ask). */
  onPinCurrent?: () => void;
}) {
  const title = source.state === "shown" ? source.section.title : pin.title;
  const projectName = source.state === "shown" ? source.projectName : pin.projectName;
  return (
    <section className="home-pinned" data-pin-state={source.state} aria-label={`${title}, pinned from ${projectName}`}>
      <header className="home-pinned-head">
        <h2>
          <NotebookText size={14} aria-hidden="true" />
          <span>{title}</span>
        </h2>
        <span className="home-pinned-from">
          {projectName}
          {source.state === "shown" && (
            <>
              {" · "}
              {source.section.owner.name}
              {" · "}
              <span title={absolute(source.section.updatedAt)}>Updated {relative(source.section.updatedAt)}</span>
            </>
          )}
        </span>
      </header>
      {source.state === "shown" ? (
        <>
          {!source.current && (
            <p className="home-pinned-note" role="status">
              <TriangleAlert size={12} aria-hidden="true" /> Not current: Home couldn't be read, so this is the last reading.
            </p>
          )}
          {source.seen && (
            <p className="home-pinned-time" role="status">
              <Eye size={12} aria-hidden="true" /> Marked seen. This is the version last written; its next update will show here.
            </p>
          )}
          {source.section.status && (
            <p className={`home-pinned-time${source.section.status.stale ? " home-stale" : ""}`} title={absolute(source.section.status.asOf)}>
              <Clock3 size={12} aria-hidden="true" />
              Data as of {absolute(source.section.status.asOf)}
              {source.section.status.stale && ` · older than its ${duration(source.section.status.validFor)} validity`}
            </p>
          )}
          <div className="home-pinned-body">
            <SectionBody section={source.section} projectId={pin.projectId} />
          </div>
          <footer className="home-pinned-foot">
            <button type="button" className="quiet-button" onClick={onOpen}>
              <ArrowUpRight size={13} /> Open in {projectName}
            </button>
          </footer>
        </>
      ) : source.state === "reading" ? (
        <p className="home-pinned-note">Reading…</p>
      ) : (
        <div className="home-pinned-gone">
          <p className="home-pinned-note" role="status">
            <TriangleAlert size={12} aria-hidden="true" />
            {
              {
                "project-gone": "Its project is no longer on Home.",
                removed: "This section is no longer on Home: it was removed, or is no longer shown.",
                replaced: "This section was removed. Another section now has the same key; it is not shown here unless you pin it.",
                "now-ask": "This section is now an ask. Answer it in Needs you or in its project.",
              }[source.state]
            }
          </p>
          <span className="home-pinned-actions">
            {onPinCurrent && (
              <button type="button" className="quiet-button" onClick={onPinCurrent}>
                <PinIcon size={13} /> Pin the new section
              </button>
            )}
            <button type="button" className="quiet-button" onClick={onUnpin}>
              <PinOff size={13} /> Unpin
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
