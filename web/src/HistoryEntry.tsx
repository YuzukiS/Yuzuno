import { History, LoaderCircle } from "lucide-react";
import "./history-entry.css";

/**
 * The one way to earlier messages at the top of a conversation (T-6): a
 * quiet Load earlier messages, and what history covers behind About history.
 * Which earlier part it reads is App's: the saved window before the shown
 * one while there is one, then the session's own earlier turns where the
 * saved conversation starts. Beginning of conversation only when both say
 * nothing comes earlier.
 */
export function HistoryEntry({ more, loading, busy, error, added, beginning, session, unchecked, onLoad }: {
  /** Something earlier can be loaded from here. */
  more: boolean;
  /** Earlier messages are being read. */
  loading: boolean;
  /** Any read of this conversation is in flight: no second one is started. */
  busy: boolean;
  /** Why the last read of earlier messages failed; empty when it did not. */
  error: string;
  /** Turns the last read of the session's earlier turns added, if one was. */
  added: number | null;
  /** Both say nothing comes earlier. */
  beginning: boolean;
  /** The session keeps its own earlier turns, read past the saved start. */
  session: boolean;
  /** The session's earlier turns are offered here, unchecked for questions. */
  unchecked: boolean;
  onLoad: () => void;
}) {
  const result = loading || added === null ? ""
    : added ? `Loaded ${added} earlier ${added === 1 ? "turn" : "turns"}.` : "No new earlier messages in that page.";
  const failed = !!error && !loading;
  return (
    <div className="history-entry" data-state={loading ? "loading" : failed ? "error" : more ? "ready" : "beginning"}>
      {more ? (
        <div className="history-entry-row">
          <button type="button" className="secondary-button history-entry-load" disabled={busy} onClick={onLoad}>
            {loading ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <History size={15} aria-hidden="true" />}
            {loading ? "Loading earlier messages…" : failed ? "Try again" : "Load earlier messages"}
          </button>
          <details className="history-entry-about">
            <summary>About history</summary>
            <p>Search finds saved messages. Copy turn includes the full turn. Text selection covers the messages on screen.</p>
            {session && <p>Earlier turns of this session become available when you reach the start of the saved conversation.</p>}
          </details>
        </div>
      ) : beginning ? (
        <div className="history-entry-beginning">Beginning of conversation</div>
      ) : null}
      {unchecked && more && <p className="history-entry-note">Earlier history has not been checked for questions.</p>}
      {failed && (
        <p role="alert" className="history-entry-error">
          Couldn’t load earlier messages. Your place is kept. <span className="history-entry-reason">{error}</span>
        </p>
      )}
      <p role="status" className="history-entry-result">{result}</p>
      <span className="sr-only" aria-live="polite">{loading ? "Loading earlier messages." : ""}</span>
    </div>
  );
}
