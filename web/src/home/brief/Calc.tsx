import { useMemo } from "react";
import { useStateStore } from "@json-render/react";
import { calcResults, type FormulaValue } from "../../intelligent-ui/brief-formula.ts";
import { langTag, useLanguage, useStrings } from "../../i18n";
import { briefText } from "./brief-text";
import type { ButtonProps, CalcProps } from "./brief-catalog";

/** The variables a place holds now, as formulas read them. */
function variablesOf(state: Record<string, unknown>): Record<string, FormulaValue> {
  const values: Record<string, FormulaValue> = {};
  for (const [name, value] of Object.entries(state))
    if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || typeof value === "string") values[name] = value;
  return values;
}

/**
 * Numbers worked out from the section's variables (YN-16 S2), again each
 * time the reader sets one: each item's formula, by brief-formula.ts, never
 * eval; shown in the interface language with its prefix, unit and digits. One
 * that cannot be computed shows a dash and says why, never NaN or Infinity.
 */
export function BriefCalc({ title, layout = "list", items }: CalcProps) {
  const { state } = useStateStore();
  const t = useStrings(briefText);
  const language = useLanguage();
  const results = useMemo(() => calcResults(items, variablesOf(state)), [items, state]);
  const shown = items.map((item, index) => ({ item, result: results[index] })).filter(({ result }) => result.shown);
  const format = (value: number, digits: number | undefined) =>
    new Intl.NumberFormat(langTag(language), digits === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const value = (item: CalcProps["items"][number], number: number) =>
    Number.isNaN(number) ? (
      <span className="brief-calc-none" title={t.notComputed}>
        —<span className="sr-only"> {t.notComputed}</span>
      </span>
    ) : (
      <>
        {item.prefix && <span className="brief-calc-affix">{item.prefix}</span>}
        {format(number, item.digits)}
        {item.unit && <span className="brief-unit">{item.unit}</span>}
      </>
    );
  return (
    <section className="brief-calc" data-layout={layout}>
      {title && <h4>{title}</h4>}
      <dl className={layout === "metrics" ? "brief-metrics" : "brief-calc-list"} aria-live="polite">
        {shown.map(({ item, result }) => (
          <div key={item.id} data-emphasis={item.emphasis || undefined} data-item={item.id}>
            <dt>{item.label}</dt>
            <dd>{value(item, result.value)}</dd>
            {item.detail && <small>{item.detail}</small>}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** What a Button's press sets: variables of its section, to fixed values (setState only, checked by the contract). */
export type Press = { statePath: string; value: number | boolean | string }[];

/** A button that sets variables of its place to fixed values; nothing else runs from it. */
export function BriefButton({ label, tone, yuzunoPress }: ButtonProps & { yuzunoPress?: Press }) {
  const { update } = useStateStore();
  return (
    <div className="brief-button-row">
      <button
        type="button"
        className={`${tone === "accent" ? "primary-button" : "secondary-button"} brief-button`}
        onClick={() => update(Object.fromEntries((yuzunoPress ?? []).map((one) => [one.statePath, one.value])))}
      >
        {label}
      </button>
    </div>
  );
}
