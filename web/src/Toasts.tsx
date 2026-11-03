import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert } from "lucide-react";
import { animates } from "./motion";

/** A toast's text, with a serial that changes each time it is set, even to
    the same text: it shows again, for its full time. */
export type ToastText = { text: string; serial: number };

/** Gone by then even if its animationend never comes. */
const FALLBACK_MS = 400;

type Leaving = { key: string; text: string; error: boolean };

/**
 * The notice and error toasts (T-19 M3). In <body>, beside Radix's dialogs:
 * #root isolates its stacking, so a toast inside it could never show above an
 * open dialog. aria-live also keeps it out of the aria-hidden Radix puts on
 * the rest of the page.
 *
 * Each toast enters as it is set. One replaced or timed out leaves through a
 * copy, aria-hidden, that fades out above the toasts shown now, so they keep
 * their place. No copy under reduced motion or without Web Animations.
 */
export function ToastStack({ notice, error }: { notice: ToastText; error: ToastText }) {
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const remove = (key: string) => setLeaving((list) => list.filter((toast) => toast.key !== key));
  useLeaving(notice, false, setLeaving, remove);
  useLeaving(error, true, setLeaving, remove);
  return createPortal(
    <div className="toast-stack" aria-live="polite">
      {leaving.map((toast) => (
        <div key={toast.key} className={`toast toast-leaving${toast.error ? " toast-error" : ""}`} aria-hidden="true"
          onAnimationEnd={() => remove(toast.key)}>
          {toast.error ? <CircleAlert size={15} /> : <Check size={15} />}
          {toast.text}
        </div>
      ))}
      {notice.text && (
        <div key={`notice-${notice.serial}`} className="toast" role="status">
          <Check size={15} />
          {notice.text}
        </div>
      )}
      {error.text && (
        <div key={`error-${error.serial}`} className="toast toast-error" role="alert">
          <CircleAlert size={15} />
          {error.text}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** When `current` replaces a shown toast, keep a copy of that one leaving. */
function useLeaving(current: ToastText, error: boolean, setLeaving: (update: (list: Leaving[]) => Leaving[]) => void,
  remove: (key: string) => void) {
  const previous = useRef(current);
  // Before paint, so the copy is there in the frame the toast goes.
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = current;
    if (was.serial === current.serial || !was.text || !animates()) return;
    const key = `${error ? "error" : "notice"}-${was.serial}-leaving`;
    setLeaving((list) => [...list, { key, text: was.text, error }]);
    setTimeout(() => remove(key), FALLBACK_MS);
  }, [current]);
}
