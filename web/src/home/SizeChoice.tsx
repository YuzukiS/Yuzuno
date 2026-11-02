import { useId } from "react";
import { useStrings } from "../i18n";
import { CARD_SIZES, type CardSize } from "./card-preview";
import { cardText } from "./card-text";

/**
 * A card's size, as the user chooses it (T-18, Lead 2378, 2415; Dev 7's
 * v15): Auto, Small, Wide or Large.
 * - In a card's More actions, a list: Auto names the card's own size, and the
 *   size the user set says so.
 * - In Organize, one segmented row beside the card's name and its source.
 * A size the card cannot take is there, disabled, with the reason said beside it.
 */
export function SizeChoice({
  name,
  legend,
  value,
  own,
  allowed,
  variant,
  onChange,
}: {
  name: string;
  legend: string;
  /** The user's choice; null is Auto. */
  value: CardSize | null;
  /** The card's own size, as Auto shows it now. */
  own: CardSize;
  allowed: readonly CardSize[];
  variant: "menu" | "row";
  onChange: (size: CardSize | null) => void;
}) {
  const t = useStrings(cardText);
  const reasonId = useId();
  const limited = CARD_SIZES.some((size) => !allowed.includes(size));
  const options: (CardSize | "auto")[] = ["auto", ...CARD_SIZES];
  return (
    <fieldset className={`home-size-choice is-${variant}`} aria-describedby={limited ? reasonId : undefined}>
      <legend>{legend}</legend>
      <span className="home-size-options">
        {options.map((option) => {
          const disabled = option !== "auto" && !allowed.includes(option);
          const checked = (value ?? "auto") === option;
          const aside = variant === "menu" ? (option === "auto" ? t.sizeLabel(own) : checked ? t.youSet : null) : null;
          return (
            <label key={option} className={disabled ? "is-disabled" : undefined}>
              <input
                type="radio"
                name={name}
                value={option}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(option === "auto" ? null : option)}
              />
              <span>{option === "auto" ? t.sizeName.auto : variant === "menu" ? t.sizeLabel(option) : t.sizeName[option]}</span>
              {aside && <small>{aside}</small>}
            </label>
          );
        })}
      </span>
      {limited && (
        <span id={reasonId} className="home-size-reason">
          {t.onlySmall}
        </span>
      )}
    </fieldset>
  );
}
