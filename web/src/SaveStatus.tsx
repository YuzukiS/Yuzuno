import { Check, CircleAlert, RotateCcw } from "lucide-react";
import type { SaveOutcome } from "./device-storage";
import "./save-status.css";

/**
 * Whether a preference is saved where it says (T-187): "Saved on this
 * device" only after a write that stuck. A refused write says so, why, and
 * what that means for the choice shown, with Try again; the choice itself
 * is kept. Restore defaults resets this scope's choice only.
 */
export function SaveStatus({
  outcome,
  scope,
  unsaved = "Your choice applies in this window until you close or reload it.",
  onRetry,
  onRestoreDefaults,
}: {
  /** The last save; null when nothing was saved in this visit. */
  outcome: SaveOutcome | null;
  /** Where it is saved, as the user knows it: "this device". */
  scope: string;
  /** What a refused save means for what is shown. */
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
  if (outcome && !outcome.saved)
    return (
      <div className="save-status save-status-failed">
        <p role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>
            Not saved on {scope}: {outcome.detail}. {unsaved}
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
  return (
    <div className="save-status">
      <p role="status">
        <Check size={13} aria-hidden="true" /> Saved on {scope}
      </p>
      {restore && <div className="save-status-actions">{restore}</div>}
    </div>
  );
}
