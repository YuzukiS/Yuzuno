import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { langTag, useLanguage, useStrings } from "../../i18n";
import { briefText } from "./brief-text";
import type { StepsProps, TimelineProps } from "./brief-catalog";

/**
 * Steps to follow (YN-16 S4): a numbered list, or, in walk mode, one step at
 * a time with Back, Next and a dot for each step. Which step is shown is this
 * block's own, never a variable of the section.
 */
export function BriefSteps({ title, mode = "list", steps }: StepsProps) {
  const t = useStrings(briefText);
  const id = useId();
  const [chosen, setAt] = useState(0);
  // The step shown, kept within the list: a later version may have fewer
  // steps than the one the reader was on (S4 R1 P3). The counter, the dots,
  // Back and Next all read this one index.
  const at = Math.max(0, Math.min(steps.length - 1, chosen));
  if (mode === "list" || steps.length === 1)
    return (
      <section className="brief-steps" aria-labelledby={title ? `${id}-title` : undefined}>
        {title && <h4 id={`${id}-title`}>{title}</h4>}
        <ol className="brief-steps-list">
          {steps.map((one, index) => (
            <li key={one.id} data-step={one.id}>
              <span className="brief-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <div className="brief-step-body">
                <strong>{one.title}</strong>
                {one.text && <p>{one.text}</p>}
              </div>
              {one.time && <span className="brief-step-time">{one.time}</span>}
            </li>
          ))}
        </ol>
      </section>
    );
  const current = steps[at];
  return (
    <section className="brief-steps" data-mode="walk" aria-labelledby={title ? `${id}-title` : undefined}>
      {title && <h4 id={`${id}-title`}>{title}</h4>}
      <div className="brief-step-card" aria-live="polite" data-step={current.id}>
        <span className="brief-step-number" aria-hidden="true">
          {at + 1}
        </span>
        <div className="brief-step-body">
          <span className="brief-step-of">{t.stepOf(at + 1, steps.length)}</span>
          <strong>{current.title}</strong>
          {current.text && <p>{current.text}</p>}
        </div>
        {current.time && <span className="brief-step-time">{current.time}</span>}
      </div>
      <div className="brief-step-nav">
        <button type="button" className="secondary-button brief-step-move" disabled={at === 0} onClick={() => setAt(at - 1)}>
          <ChevronLeft size={15} aria-hidden="true" />
          {t.stepBack}
        </button>
        <span className="brief-step-dots" role="group" aria-label={t.stepsLabel}>
          {steps.map((one, index) => (
            <button
              key={one.id}
              type="button"
              className="brief-step-dot"
              aria-label={t.stepOf(index + 1, steps.length)}
              aria-current={index === at ? "step" : undefined}
              onClick={() => setAt(index)}
            />
          ))}
        </span>
        <button type="button" className="secondary-button brief-step-move" disabled={at === steps.length - 1} onClick={() => setAt(at + 1)}>
          {t.stepNext}
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** An ISO 8601 date in the reader's language, a time in their time zone too; anything else as written. */
function when(at: string, language: string): string {
  if (DATE.test(at)) {
    const [year, month, day] = at.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(date.getTime()) ? at : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  }
  if (TIME.test(at)) {
    const time = new Date(at);
    return Number.isNaN(time.getTime()) ? at : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(time);
  }
  return at;
}

/** The narrowest an item may be for the timeline to run across. */
export const TIMELINE_ITEM_PX = 104;

/**
 * Dated events in order (YN-16 S4): across where each item has
 * TIMELINE_ITEM_PX, else down. A done event has a filled dot, now a ringed
 * one, next a dashed one and the word "planned". The reader opens an event
 * to read its text.
 */
export function BriefTimeline({ title, items }: TimelineProps) {
  const t = useStrings(briefText);
  const language = langTag(useLanguage());
  const id = useId();
  const frame = useRef<HTMLDivElement>(null);
  const [across, setAcross] = useState(false);
  const [open, setOpen] = useState("");
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setAcross(node.clientWidth > 0 && node.clientWidth / items.length >= TIMELINE_ITEM_PX);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [items.length]);
  const opened = items.find((item) => item.id === open);
  return (
    <section className="brief-timeline" data-layout={across ? "across" : "down"} aria-labelledby={title ? `${id}-title` : undefined} ref={frame}>
      {title && <h4 id={`${id}-title`}>{title}</h4>}
      <ol className="brief-timeline-items">
        {items.map((item) => {
          const state = item.state ?? "done";
          return (
            <li key={item.id} data-state={state} data-item={item.id}>
              <span className="brief-timeline-dot" aria-hidden="true" />
              {item.text ? (
                <button type="button" className="brief-timeline-item" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? "" : item.id)}>
                  <span className="brief-timeline-at">{when(item.at, language)}</span>
                  <span className="brief-timeline-title">{item.title}</span>
                  <span className="brief-timeline-state">{t.timelineState[state]}</span>
                </button>
              ) : (
                <span className="brief-timeline-item">
                  <span className="brief-timeline-at">{when(item.at, language)}</span>
                  <span className="brief-timeline-title">{item.title}</span>
                  <span className="brief-timeline-state">{t.timelineState[state]}</span>
                </span>
              )}
              {!across && open === item.id && item.text && <p className="brief-timeline-text">{item.text}</p>}
            </li>
          );
        })}
      </ol>
      {across && opened?.text && (
        <p className="brief-timeline-text" aria-live="polite">
          <strong>{opened.title}</strong> {opened.text}
        </p>
      )}
    </section>
  );
}
