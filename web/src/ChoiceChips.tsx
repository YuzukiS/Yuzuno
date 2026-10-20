// A short list of choices shown all at once, chosen with one click, as
// Appearance chooses its theme but small: in place of a dropdown when the
// options fit on a line or two. Native radios underneath, so arrow keys move
// between choices and forms and screen readers see one value.
import { useId, type ReactNode } from "react";
import "./choice-chips.css";

export type Choice = {
  value: string;
  label: ReactNode;
  /** A few quiet words after the label, such as "SSH" or "default". */
  note?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
};

export function ChoiceChips({
  label,
  name,
  value,
  choices,
  onChange,
  disabled = false,
  after,
  className = "",
}: {
  /** The group's name, read out and shown as its legend. */
  label: string;
  /** Radio name; one is made up when omitted. */
  name?: string;
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Something after the last choice, such as an "Add" button. */
  after?: ReactNode;
  className?: string;
}) {
  const generated = useId();
  const group = name || `choice-${generated}`;
  return (
    <fieldset
      className={`choice-chips ${className}`.trim()}
      role="radiogroup"
      aria-label={label}
      disabled={disabled}
    >
      <legend>{label}</legend>
      <div className="choice-chip-row">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className="choice-chip"
            title={choice.title}
            data-value={choice.value}
          >
            <input
              type="radio"
              name={group}
              value={choice.value}
              checked={value === choice.value}
              disabled={choice.disabled}
              onChange={() => onChange(choice.value)}
            />
            {choice.icon && <span className="choice-chip-icon">{choice.icon}</span>}
            <span className="choice-chip-label">{choice.label}</span>
            {choice.note && <small>{choice.note}</small>}
          </label>
        ))}
        {after}
      </div>
    </fieldset>
  );
}
