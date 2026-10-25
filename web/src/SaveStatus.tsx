import { useEffect, useRef } from "react";
import { Check, CircleAlert, Info, RotateCcw } from "lucide-react";
import { STORAGE_BLOCKED, type DeviceValueState, type SaveOutcome } from "./device-storage";
import { strings, useStrings } from "./i18n";
import "./save-status.css";

// In the interface language (T-189). The browser's own words for a refusal
// it didn't name, as a log's, are shown as it wrote them.
const text = strings({
  unsaved: "Your choice applies in this window until you close or reload it.",
  scope: (scope: string) => scope,
  reason: (failed: Extract<SaveOutcome, { saved: false }>) => failed.detail,
  notSaved: (scope: string, reason: string, unsaved: string) => `Not saved on ${scope}: ${reason}. ${unsaved}`,
  retry: "Try again",
  restore: "Restore defaults",
  restored: (scope: string) => `Defaults restored on ${scope}`,
  saved: (scope: string) => `Saved on ${scope}`,
  using: (scope: string) => `Using the choice saved on ${scope}`,
  invalid: (scope: string) => `The choice saved on ${scope} couldn’t be read, so the defaults apply. Choosing again saves a new one.`,
  none: (scope: string) => `Using the defaults; nothing is saved on ${scope} yet`,
}, {
  unsaved: "你的选择在此窗口中生效，直到关闭或重新加载它。",
  scope: (scope: string) => (scope === "this device" ? "此设备" : scope),
  reason: (failed) => {
    if (failed.reason === "full") return "此浏览器为 Yuzuno 保留的存储空间已满";
    if (failed.reason === "blocked") return "此浏览器不允许 Yuzuno 在这里保存设置";
    const refused = /^the browser refused it \((.*)\)$/.exec(failed.detail);
    return refused ? `浏览器拒绝了它（${refused[1]}）` : "浏览器没有保留它";
  },
  notSaved: (scope, reason, unsaved) => `未保存到${scope}：${reason}。${unsaved}`,
  retry: "重试",
  restore: "恢复默认",
  restored: (scope) => `已在${scope}上恢复默认`,
  saved: (scope) => `已保存到${scope}`,
  using: (scope) => `正在使用${scope}上保存的选择`,
  invalid: (scope) => `${scope}上保存的选择无法读取，因此使用默认值。重新选择会保存一个新的。`,
  none: (scope) => `正在使用默认值；${scope}上还没有保存任何选择`,
});

/**
 * Whether a preference is saved where it says (T-187). "Saved" only after a
 * write in this visit that stuck; before one, what the caller found there,
 * never a success. A refused write says so, why, and what that means for
 * the choice shown, with Try again; the choice itself is kept. Restore
 * defaults resets this scope's choice only. A refusal just said is brought
 * into view: in a short pane it can lie below the choice that caused it.
 */
export function SaveStatus({
  outcome,
  action = "save",
  attempt,
  stored,
  scope,
  unsaved,
  onRetry,
  onRestoreDefaults,
}: {
  /** This visit's last write; null before one. */
  outcome: SaveOutcome | null;
  /** What that write was: a save, or a reset to the defaults. */
  action?: "save" | "reset";
  /** Which write that was: a new number for each save or reset, so a
   * refusal said again (the same outcome) is brought into view again. */
  attempt?: number;
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
  const t = useStrings(text);
  const where = t.scope(scope);
  const restore = onRestoreDefaults && (
    <button type="button" className="quiet-button" onClick={onRestoreDefaults}>
      <RotateCcw size={13} aria-hidden="true" />
      {t.restore}
    </button>
  );
  const failed = outcome && !outcome.saved ? outcome : !outcome && stored === "unreadable" ? STORAGE_BLOCKED : null;
  const refusal = useRef<HTMLDivElement>(null);
  // For each write in this visit that was refused, also one refused the same
  // way as the last; not for storage found unreadable on opening. Focus stays
  // where it is.
  useEffect(() => {
    if (outcome && !outcome.saved) refusal.current?.scrollIntoView?.({ block: "nearest" });
  }, [outcome, action, attempt]);
  if (failed && !failed.saved)
    return (
      <div ref={refusal} className="save-status save-status-failed">
        <p role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{t.notSaved(where, t.reason(failed), unsaved ?? t.unsaved)}</span>
        </p>
        <div className="save-status-actions">
          {onRetry && (
            <button type="button" className="secondary-button" onClick={onRetry}>
              {t.retry}
            </button>
          )}
          {restore}
        </div>
      </div>
    );
  const line = outcome ? (
    <>
      <Check size={13} aria-hidden="true" />
      {action === "reset" ? t.restored(where) : t.saved(where)}
    </>
  ) : stored === "saved" ? (
    t.using(where)
  ) : stored === "invalid" ? (
    <>
      <Info size={13} aria-hidden="true" />
      {t.invalid(where)}
    </>
  ) : (
    t.none(where)
  );
  return (
    <div className="save-status" data-state={outcome ? action : stored}>
      <p role="status">{line}</p>
      {restore && <div className="save-status-actions">{restore}</div>}
    </div>
  );
}
