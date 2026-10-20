import { useEffect, useId, useRef, useState } from "react";
import "./context-usage.css";
import type { ContextUsage as Usage } from "./types";

export function ContextUsage({
  usedPercent = null,
  sample = false,
  usage,
}: {
  usedPercent?: number | null;
  sample?: boolean;
  usage?: Usage | null;
}) {
  if (!sample) usedPercent = usage?.usedPercent ?? null;
  const percent =
    usedPercent !== null &&
    Number.isFinite(usedPercent) &&
    usedPercent >= 0 &&
    usedPercent <= 100
      ? Math.round(usedPercent)
      : null;
  const level =
    percent === null
      ? "unknown"
      : percent >= 90
        ? "high"
        : percent >= 70
          ? "medium"
          : "low";
  const label = percent === null ? "Usage unavailable" : `${percent}% used${usage?.stale ? " · last known" : ""}`;
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setOpen(false);
      setPinned(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      // Consume Escape before the workspace's Interrupt shortcut.
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener("keydown", keyboard, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  return (
    <div
      className="context-usage"
      data-level={level}
      ref={root}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned && !root.current?.contains(document.activeElement))
          setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setPinned(false);
        }
      }}
    >
      <button
        type="button"
        className="context-usage-button"
        aria-label={`Context: ${label}${sample ? " (sample)" : ""}`}
        aria-describedby={open ? tooltipId : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => {
          setOpen(!pinned);
          setPinned(!pinned);
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle className="context-ring-track" cx="12" cy="12" r="9" />
          {percent !== null ? (
            <circle
              className="context-ring-fill"
              cx="12"
              cy="12"
              r="9"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
              transform="rotate(-90 12 12)"
            />
          ) : (
            <path className="context-ring-unknown" d="M9.5 12h5" />
          )}
        </svg>
      </button>
      {open && (
        <div className="context-usage-tooltip" id={tooltipId} role="tooltip">
          <div className="context-usage-card">
            <div className="context-usage-heading">
              <strong>Context window</strong>
              {sample && <small>Sample</small>}
            </div>
            <div className="context-usage-value">
              <span>{label}</span>
              {percent !== null && <span>{100 - percent}% remaining</span>}
            </div>
            <p>
              {percent === null
                ? "Current context usage isn't available for this conversation yet."
                : sample
                  ? "Design sample · not live conversation usage."
                  : usage?.stale
                    ? "Last known usage. Waiting for a fresh update from this conversation."
                    : "Estimated from the latest model request; updates after each response and compaction."}
            </p>
            {usage && !sample && <p>{usage.usedTokens.toLocaleString()} / {usage.windowTokens.toLocaleString()} tokens</p>}
          </div>
        </div>
      )}
    </div>
  );
}
