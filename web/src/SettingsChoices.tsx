import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";

/** Settings' choice cards (YN-8): two to four choices of one setting, as
 * Appearance shows its theme and Agent order, a card each with its name and
 * one line. The radio stays the control, so the keyboard and assistive
 * technology use it as before. */
export function ChoiceCards<T extends string>({
  name,
  value,
  choices,
  onChange,
  className = "",
}: {
  name: string;
  value: T;
  choices: readonly { value: T; label: ReactNode; note?: ReactNode; lang?: string }[];
  onChange: (value: T) => void;
  /** Kept on each card, for the checks that find one by it. */
  className?: string;
}) {
  return (
    <div className="theme-options settings-choice-cards" style={{ "--settings-choice-cols": Math.min(choices.length, 3) } as CSSProperties}>
      {choices.map((choice) => (
        <label key={choice.value} className={`theme-choice settings-choice ${className}`.trim()}>
          <input type="radio" name={name} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
          <span className="theme-choice-name" lang={choice.lang}>
            {choice.label}
            <Check size={13} className="theme-selected" aria-hidden="true" />
          </span>
          {choice.note && <small>{choice.note}</small>}
        </label>
      ))}
    </div>
  );
}
