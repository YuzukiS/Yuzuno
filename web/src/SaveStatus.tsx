import { Check, CircleAlert, Info, RotateCcw } from "lucide-react";
import { STORAGE_BLOCKED, type DeviceValueState, type SaveOutcome } from "./device-storage";
import "./save-status.css";

/**
 * Whether a preference is saved where it says (T-187). "Saved" only after a
 * write in this visit that stuck; before one, what the caller found there,
 * never a success. A refused write says so, why, and what that means for
 * the choice shown, with Try again; the choice itself is kept. Restore
 * defaults resets this scope's choice only.
 */
export function SaveStatus({
  outcome,
  action = "save",
  stored,
  scope,
  unsaved = "Your choice applies in this window until you close or reload it.",
  onRetry,
  onRestoreDefaults,
}: {
  /** This visit's last write; null before one. */
  outcome: SaveOutcome | null;
  /** What that write was: a save, or a reset to the defaults. */
  action?: "save" | "reset";
  /** Before a write, what the caller read there: a saved choice, none (the
   * defaults), one it couldn't read (the defaults apply), or storage it
   * can't read at all. */
  stored: DeviceValueState;
  /** Where it is saved, as the user knows it: "this device". */
  scope: string;
  /** What an unsaved choice means for what is shown. */
  unsaved?: string;
  onRetry?: () => void;
  onRestoreDefaults?: () => void;
}) {
  const restore = onRestoreDefaults && (
    <button type="button" className="quiet-button" onClick={onRestoreDefaults}>
      <RotateCcw size={13} aria-hidden="true" />
      Restore defaults
    </button>
  );
  const failed = outcome && !outcome.saved ? outcome : !outcome && stored === "unreadable" ? STORAGE_BLOCKED : null;
  if (failed && !failed.saved)
    return (
      <div className="save-status save-status-failed">
        <p role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>
            Not saved on {scope}: {failed.detail}. {unsaved}
          </span>
        </p>
        <div className="save-status-actions">
          {onRetry && (
            <button type="button" className="secondary-button" onClick={onRetry}>
              Try again
            </button>
          )}
          {restore}
        </div>
      </div>
    );
  const line = outcome ? (
    <>
      <Check size={13} aria-hidden="true" />
      {action === "reset" ? `Defaults restored on ${scope}` : `Saved on ${scope}`}
    </>
  ) : stored === "saved" ? (
    `Using the choice saved on ${scope}`
  ) : stored === "invalid" ? (
    <>
      <Info size={13} aria-hidden="true" />
      {`The choice saved on ${scope} couldn’t be read, so the defaults apply. Choosing again saves a new one.`}
    </>
  ) : (
    `Using the defaults; nothing is saved on ${scope} yet`
  );
  return (
    <div className="save-status" data-state={outcome ? action : stored}>
      <p role="status">{line}</p>
      {restore && <div className="save-status-actions">{restore}</div>}
    </div>
  );
}
