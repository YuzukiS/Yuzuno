import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useStateBinding } from "@json-render/react";
import { Minus, Plus } from "lucide-react";
import { langTag, useLanguage, useStrings } from "../../i18n";
import { briefText } from "./brief-text";
import type { NumberInputProps, SegmentedProps, SwitchProps } from "./brief-catalog";

/**
 * The inputs a section's reader sets (YN-16), each writing the one variable
 * it declares, by name, in the store of the place that shows the section
 * (brief-state.tsx). They change nothing else: no request, no message, no
 * action. Every control is at least 40 px tall and wide, for touch, and
 * none of them opens the report it sits in.
 */

/** Decimals a number is written with: 0.25 has 2, 1e-3 has 3. */
export function decimalsOf(value: number): number {
  const [mantissa, exponent] = String(value).split(/e/i);
  return Math.max(0, (mantissa.split(".")[1] || "").length - Number(exponent || 0));
}

/** A value on a NumberInput's steps from its min, kept between min and max, without float noise (0.1 + 0.2). */
export function stepped(value: number, { min, max, step = 1 }: Pick<NumberInputProps, "min" | "max" | "step">): number {
  const on = min + Math.round((value - min) / step) * step;
  const kept = Math.min(max, Math.max(min, on));
  return Number(kept.toFixed(Math.min(12, Math.max(decimalsOf(step), decimalsOf(min), decimalsOf(max)))));
}

/** A typed number: spaces, group separators and full-width digits are allowed; anything else is not a number. */
export function typedNumber(text: string): number | null {
  const plain = text
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[．。]/g, ".")
    .replace(/[－−]/g, "-")
    .replace(/[\s,，_']/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(plain)) return null;
  const value = Number(plain);
  return Number.isFinite(value) ? value : null;
}

function useVariable<T>(name: string, fallback: T, accepts: (value: unknown) => value is T): [T, (value: T) => void] {
  const [stored, set] = useStateBinding<T>(`/${name}`);
  return [accepts(stored) ? stored : fallback, set];
}
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isOption = (value: unknown): value is number | string => isNumber(value) || typeof value === "string";

export function BriefNumberInput(props: NumberInputProps) {
  const { name, label, min, max, step = 1, prefix, unit, control = "stepper", detail } = props;
  const t = useStrings(briefText);
  const language = useLanguage();
  const id = useId();
  const [value, set] = useVariable(name, props.value, isNumber);
  const digits = props.digits ?? decimalsOf(step);
  const format = useMemo(
    () => new Intl.NumberFormat(langTag(language), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }),
    [language, digits],
  );
  // What the reader is typing, until they leave the field or press Enter; a
  // text that is not a number goes back to the value.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (next: number) => set(stepped(next, props));
  const finish = () => {
    if (draft === null) return;
    const typed = typedNumber(draft);
    if (typed !== null) commit(typed);
    setDraft(null);
  };
  const shown = format.format(value);
  const spoken = `${prefix ?? ""}${shown}${unit ? ` ${unit}` : ""}`;
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") finish();
    else if (event.key === "Escape" && draft !== null) {
      event.preventDefault();
      setDraft(null);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setDraft(null);
      commit(value + (event.key === "ArrowUp" ? step : -step));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setDraft(null);
      commit(event.key === "Home" ? min : max);
    }
  };
  const field = (
    <input
      id={`${id}-field`}
      className="brief-number-field"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      role="spinbutton"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={spoken}
      aria-describedby={detail ? `${id}-detail` : undefined}
      size={Math.max(2, Math.min(10, format.format(max).length, format.format(min).length + 1))}
      value={draft ?? shown}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={finish}
      onKeyDown={keys}
    />
  );
  const number = (
    <span className="brief-number-box">
      {prefix && <span className="brief-affix">{prefix}</span>}
      {field}
      {unit && <span className="brief-affix">{unit}</span>}
    </span>
  );
  return (
    <div className="brief-input brief-number" data-control={control}>
      <label htmlFor={`${id}-field`}>{label}</label>
      <div className="brief-number-row">
        {control === "slider" ? (
          number
        ) : (
          <>
            <button type="button" className="brief-step" aria-label={t.decrease(label)} disabled={value <= min} onClick={() => commit(value - step)}>
              <Minus size={16} aria-hidden="true" />
            </button>
            {number}
            <button type="button" className="brief-step" aria-label={t.increase(label)} disabled={value >= max} onClick={() => commit(value + step)}>
              <Plus size={16} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {control !== "stepper" && (
        <input
          type="range"
          className="brief-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          aria-valuetext={spoken}
          style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
          onChange={(event) => {
            setDraft(null);
            commit(Number(event.target.value));
          }}
        />
      )}
      {detail && <small id={`${id}-detail`}>{detail}</small>}
    </div>
  );
}

export function BriefSwitch(props: SwitchProps) {
  const { name, label, detail } = props;
  const t = useStrings(briefText);
  const id = useId();
  const [on, set] = useVariable(name, props.value, isBoolean);
  return (
    <div className="brief-input brief-switch">
      <button
        type="button"
        role="switch"
        id={`${id}-switch`}
        className="brief-switch-control"
        aria-checked={on}
        aria-describedby={detail ? `${id}-detail` : undefined}
        onClick={() => set(!on)}
      >
        <span className="brief-switch-track" aria-hidden="true">
          <span className="brief-switch-thumb" />
        </span>
      </button>
      <span className="brief-switch-text">
        <label className="brief-switch-label" htmlFor={`${id}-switch`}>
          {label}
        </label>
        {detail && <small id={`${id}-detail`}>{detail}</small>}
      </span>
      <span className="brief-switch-state" aria-hidden="true">
        {on ? t.on : t.off}
      </span>
    </div>
  );
}

export function BriefSegmented(props: SegmentedProps) {
  const { name, label, options } = props;
  const id = useId();
  const [value, set] = useVariable(name, props.value, isOption);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex((option) => option.value === value);
  // Arrows move the choice and the focus with it, round the ends; Tab leaves the group.
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? index + 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? index - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
      : null;
    if (next === null) return;
    event.preventDefault();
    const to = (next + options.length) % options.length;
    set(options[to].value);
    buttons.current[to]?.focus();
  };
  return (
    <div className="brief-input brief-segmented">
      {label && (
        <span id={`${id}-label`} className="brief-input-label">
          {label}
        </span>
      )}
      <div role="radiogroup" className="brief-segments" aria-labelledby={label ? `${id}-label` : undefined}>
        {options.map((option, index) => (
          <button
            key={`${typeof option.value}:${option.value}`}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            className="brief-segment"
            aria-checked={index === chosen}
            tabIndex={index === (chosen < 0 ? 0 : chosen) ? 0 : -1}
            onClick={() => set(option.value)}
            onKeyDown={(event) => keys(event, index)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
