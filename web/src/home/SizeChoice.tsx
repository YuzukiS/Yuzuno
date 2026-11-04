import { useStrings } from "../i18n";
import { CARD_SIZES, type CardSize } from "./card-preview";
import { cardText } from "./card-text";

/**
 * A pinned widget's size, as the user chooses it (T-18, Lead 2457, 2473):
 * Agent (the card's own size, as its author names it), Small, Wide or Large.
 * - In the widget's own menu, a list: Agent names the card's size, and the
 *   size the user set says so.
 * - In Organize, one segmented row beside the widget's name and its source.
 * The choice is the widget's alone: the card in its project keeps its Agent's.
 */
export function SizeChoice({
  name,
  legend,
  value,
  own,
  variant,
  onChange,
}: {
  name: string;
  legend: string;
  /** The user's choice; null follows the Agent. */
  value: CardSize | null;
  /** The card's own size, as its Agent names it now. */
  own: CardSize;
  variant: "menu" | "row";
  onChange: (size: CardSize | null) => void;
}) {
  const t = useStrings(cardText);
  const options: (CardSize | "auto")[] = ["auto", ...CARD_SIZES];
  return (
    <fieldset className={`home-size-choice is-${variant}`}>
      <legend>{legend}</legend>
      <span className="home-size-options">
        {options.map((option) => {
          const checked = (value ?? "auto") === option;
          const aside = variant === "menu" ? (option === "auto" ? t.sizeLabel(own) : checked ? t.youSet : null) : null;
          return (
            <label key={option}>
              <input type="radio" name={name} value={option} checked={checked} onChange={() => onChange(option === "auto" ? null : option)} />
              <span>{option === "auto" ? t.sizeName.auto : variant === "menu" ? t.sizeLabel(option) : t.sizeName[option]}</span>
              {aside && <small>{aside}</small>}
            </label>
          );
        })}
      </span>
    </fieldset>
  );
}
