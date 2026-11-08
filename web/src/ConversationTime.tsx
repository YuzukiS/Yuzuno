import { Fragment } from "react";
import type { FooterPart, Moment } from "./conversation-time";
import { Tip, TipText } from "./Tip";
import "./conversation-time.css";

/** A quiet hours-and-minutes stamp; the full date is in its tip. */
export function MessageTime({ mark, className = "" }: { mark?: Moment; className?: string }) {
  if (!mark) return null;
  return (
    <Tip content={<TipText title={mark.title} />}>
      <time className={`message-time ${className}`.trim()} dateTime={mark.dateTime}>
        {mark.label}
      </time>
    </Tip>
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
              <Tip content={<TipText title={part.title} />}>
                <time dateTime={part.moment.dateTime}>{part.label}</time>
              </Tip>
            </span>
          ) : (
            <Tip content={part.title ? <TipText body={part.title} /> : null}>
              <span>{part.text}</span>
            </Tip>
          )}
        </Fragment>
      ))}
    </span>
  );
}
