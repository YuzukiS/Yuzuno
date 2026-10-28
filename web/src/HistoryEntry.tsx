import { useId, useState } from "react";
import { ChevronRight, History, LoaderCircle } from "lucide-react";
import "./history-entry.css";

/**
 * The one way to earlier messages at the top of a conversation (T-6): a
 * quiet Load earlier messages, and what history covers behind About history.
 * Which earlier part it reads is App's: the saved window before the shown
 * one while there is one, then the session's own earlier turns where the
 * saved conversation starts. Nothing is said to be all loaded unless both
 * say there is nothing earlier.
 */
export function HistoryEntry({ more, loading, busy, error, added, beginning, unchecked, onLoad }: {
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
  /** Earlier turns are offered that were not checked for questions. */
  unchecked: boolean;
  onLoad: () => void;
}) {
  const [open, setOpen] = useState(false);
  const about = useId();
  const result = loading || added === null ? ""
    : added ? `Loaded ${added} earlier ${added === 1 ? "turn" : "turns"}.` : "No new earlier messages in that page.";
  return (
    <div className="history-entry" data-state={loading ? "loading" : error ? "error" : more ? "more" : beginning ? "beginning" : "start"}>
      <div className="history-entry-row">
        {more ? (
          <button type="button" className="inline-link history-entry-load" disabled={busy} onClick={onLoad}>
            {loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
            {loading ? "Loading earlier messages…" : "Load earlier messages"}
          </button>
        ) : beginning ? (
          <span className="history-entry-beginning">Beginning of conversation</span>
        ) : null}
        <span role="status" className="history-entry-result">{result}</span>
        <button type="button" className="history-entry-about-toggle" aria-expanded={open} aria-controls={about}
          onClick={() => setOpen((value) => !value)}>
          <ChevronRight size={12} aria-hidden="true" />
          About history
        </button>
      </div>
      {error && <p role="alert" className="inline-error history-entry-error">{error}</p>}
      <div id={about} className="history-entry-about" hidden={!open}>
        <ul>
          <li>Earlier messages load a page at a time, above the one you are reading. After a few pages the newest
            make room, and Continue to newer messages brings them back.</li>
          <li>Search finds every saved message, not only the ones loaded here.</li>
          <li>Copy turn copies the whole turn; selected text covers only what is shown.</li>
          {unchecked && <li>Earlier history has not been checked for questions.</li>}
        </ul>
      </div>
    </div>
  );
}
