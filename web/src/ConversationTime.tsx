import { Fragment } from "react";
import type { FooterPart, Moment } from "./conversation-time";
import "./conversation-time.css";

/** A quiet hours-and-minutes stamp; the full date is in the tooltip. */
export function MessageTime({ mark, className = "" }: { mark?: Moment; className?: string }) {
  if (!mark) return null;
  return (
    <time className={`message-time ${className}`.trim()} dateTime={mark.dateTime} title={mark.title}>
      {mark.label}
    </time>
  );
}

/** Finished-turn facts, read after Copy reply: elapsed, end time, shells. */
export function TurnFooter({ parts }: { parts: FooterPart[] }) {
  if (!parts.length) return null;
  return (
    <span className="turn-footer">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="turn-footer-separator" aria-hidden="true">{" · "}</span>}
          {part.kind === "time" ? (
            <span>
              {part.prefix}
              <time dateTime={part.moment.dateTime} title={part.title}>{part.moment.label}</time>
            </span>
          ) : (
            <span title={part.title}>{part.text}</span>
          )}
        </Fragment>
      ))}
    </span>
  );
}
