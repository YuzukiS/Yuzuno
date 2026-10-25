import { useEffect, useId, useRef, useState } from "react";
import "./context-usage.css";
import type { ContextUsage as Usage } from "./types";
import { strings, useStrings } from "./i18n";

// The meter's own words (T-189); the counts as the conversation reports them.
const text = strings({
  unavailable: "Usage unavailable",
  used: (percent: number, stale: boolean) => `${percent}% used${stale ? " · last known" : ""}`,
  button: (label: string, sample: boolean) => `Context: ${label}${sample ? " (sample)" : ""}`,
  heading: "Context window",
  sample: "Sample",
  remaining: (percent: number) => `${percent}% remaining`,
  none: "Current context usage isn't available for this conversation yet.",
  design: "Design sample · not live conversation usage.",
  stale: "Last known usage. Waiting for a fresh update from this conversation.",
  live: "Estimated from the latest model request; updates after each response and compaction.",
  tokens: (used: string, window: string) => `${used} / ${window} tokens`,
}, {
  unavailable: "用量不可用",
  used: (percent, stale) => `已用 ${percent}%${stale ? " · 上次已知" : ""}`,
  button: (label, sample) => `上下文：${label}${sample ? "（示例）" : ""}`,
  heading: "上下文窗口",
  sample: "示例",
  remaining: (percent) => `剩余 ${percent}%`,
  none: "此会话的当前上下文用量暂不可用。",
  design: "设计示例 · 不是会话的实时用量。",
  stale: "上次已知的用量。正在等待此会话的新更新。",
  live: "根据最近一次模型请求估算；每次回复和压缩后更新。",
  tokens: (used, window) => `${used} / ${window} 个 token`,
});

export function ContextUsage({
  usedPercent = null,
  sample = false,
  usage,
}: {
  usedPercent?: number | null;
  sample?: boolean;
  usage?: Usage | null;
}) {
  const t = useStrings(text);
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
  const label = percent === null ? t.unavailable : t.used(percent, !!usage?.stale);
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
        aria-label={t.button(label, sample)}
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
              <strong>{t.heading}</strong>
              {sample && <small>{t.sample}</small>}
            </div>
            <div className="context-usage-value">
              <span>{label}</span>
              {percent !== null && <span>{t.remaining(100 - percent)}</span>}
            </div>
            <p>
              {percent === null ? t.none : sample ? t.design : usage?.stale ? t.stale : t.live}
            </p>
            {usage && !sample && <p>{t.tokens(usage.usedTokens.toLocaleString(), usage.windowTokens.toLocaleString())}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
