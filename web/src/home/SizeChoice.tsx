import { useId } from "react";
import { useStrings } from "../i18n";
import { CARD_SIZES, type CardSize } from "./card-preview";
import { cardText } from "./card-text";

/**
 * A card's size, as the user chooses it (T-18, Lead 2378): Auto, Small,
 * Wide or Large, in a card's More actions and in Organize. A size the card
 * cannot take is there, disabled, with the reason said beside it.
 */
export function SizeChoice({
  name,
  legend,
  value,
  allowed,
  onChange,
}: {
  name: string;
  legend: string;
  /** The user's choice; null is Auto. */
  value: CardSize | null;
  allowed: readonly CardSize[];
  onChange: (size: CardSize | null) => void;
}) {
  const t = useStrings(cardText);
  const reasonId = useId();
  const limited = CARD_SIZES.some((size) => !allowed.includes(size));
  const options: (CardSize | "auto")[] = ["auto", ...CARD_SIZES];
  return (
    <fieldset className="home-size-choice" aria-describedby={limited ? reasonId : undefined}>
      <legend>{legend}</legend>
      <span className="home-size-options">
        {options.map((option) => {
          const disabled = option !== "auto" && !allowed.includes(option);
          return (
            <label key={option} className={disabled ? "is-disabled" : undefined}>
              <input
                type="radio"
                name={name}
                value={option}
                checked={(value ?? "auto") === option}
                disabled={disabled}
                onChange={() => onChange(option === "auto" ? null : option)}
              />
              {t.sizeName[option]}
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
