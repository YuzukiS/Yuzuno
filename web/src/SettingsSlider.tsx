import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

/** Settings' slider (YN-8, design A): a drawn track whose fill is the value,
 * light ticks on a short range, and the value with its unit beside it,
 * typed there if wanted. The range input stays the control: keyboard steps
 * (arrows, Home/End, PageUp/PageDown) and assistive technology use it. */
export function SettingsSlider({
  name,
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  zero,
  ends,
  hideLabel = false,
  className = "",
  used,
  limit,
  disabled = false,
  onChange,
}: {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shown beside the value, as "px" or "GiB". */
  unit?: string;
  /** What 0 means, such as "Hidden": said beside the slider when it is 0. */
  zero?: string;
  /** Marks at the track's two ends, such as a small and a large "Aa". */
  ends?: ReactNode;
  /** When the block's legend already names it. */
  hideLabel?: boolean;
  className?: string;
  /** What is in use now, drawn on the track from its start (YN-8: a
   * machine's track is the whole machine, with what running Jobs hold). */
  used?: number;
  /** How far a typed value may go when the track is shorter than what is
   * allowed (YN-8: the track is the whole host; Core's bounds go further).
   * The track then stays at its end. */
  limit?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const shown = value === 0 && zero ? zero : unit ? `${value} ${unit}` : String(value);
  const steps = Math.round((max - min) / step);
  const share = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const usedShare = used === undefined || max <= min ? null : Math.min(1, Math.max(0, (used - min) / (max - min)));
  /** A typed value, kept to the range and its step; an empty or unreadable
   * one returns to the value in effect. */
  function commit(text: string) {
    const typed = Number(text);
    if (!text.trim() || !Number.isFinite(typed)) return setDraft(String(value));
    const next = Math.min(limit ?? max, Math.max(min, min + Math.round((typed - min) / step) * step));
    setDraft(String(next));
    if (next !== value) onChange(next);
  }
  return (
    <div className={`settings-slider${hideLabel ? " is-bare" : ""}${ends ? " has-ends" : ""} ${className}`.trim()}
      style={{ "--settings-slider-share": `${share * 100}%`, ...(usedShare === null ? {} : { "--settings-slider-used": `${usedShare * 100}%` }) } as CSSProperties}>
      <span className={hideLabel ? "sr-only" : "settings-slider-label"}>{label}</span>
      <span className="settings-slider-rail">
        <span className="settings-slider-track" aria-hidden="true">
          <span className="settings-slider-fill" />
          {usedShare !== null && <span className="settings-slider-used" />}
        </span>
        {steps > 0 && steps <= 12 && (
          <span className="settings-slider-ticks" aria-hidden="true">
            {Array.from({ length: steps + 1 }, (_, i) => <i key={i} style={{ left: `${(i / steps) * 100}%` }} />)}
          </span>
        )}
        <input
          type="range"
          name={name}
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          aria-valuetext={shown}
          disabled={disabled}
          // A drag stops at the limit too, where the track runs past it (#730 R1 P3).
          onChange={(event) => onChange(Math.min(limit ?? Infinity, Number(event.target.value)))}
        />
      </span>
      <label className="settings-slider-value">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={limit ?? max}
          step={step}
          value={draft}
          aria-label={unit ? `${label} (${unit})` : label}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
          }}
        />
        {unit && <span>{unit}</span>}
      </label>
      {/* What the value means when that needs words (0 = Hidden). */}
      <output className="settings-slider-note" aria-hidden="true">{value === 0 && zero ? zero : ""}</output>
      {ends && <span className="settings-slider-ends" aria-hidden="true">{ends}</span>}
    </div>
  );
}
