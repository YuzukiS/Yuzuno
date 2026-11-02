import { useContext } from "react";
import { useStrings } from "../i18n";
import { allowedSizes, cardContent, shownSize } from "./card-preview";
import { CardSizes } from "./card-sizes";
import { cardText } from "./card-text";
import { SizeChoice } from "./SizeChoice";
import type { Section } from "./types";

/**
 * Organize's card sizes (T-18, Lead 2378; Dev 7's v12): every report and
 * status card on Home, by project, with the size it has and why, and the
 * user's choice. An Ask is not listed: it always takes its row.
 */
export function CardSizeList({ projects }: { projects: { id: string; name: string; sections: Section[] }[] }) {
  const sizes = useContext(CardSizes);
  const t = useStrings(cardText);
  if (!sizes) return null;
  const listed = projects
    .map((project) => ({ ...project, cards: project.sections.filter((section) => section.kind !== "ask") }))
    .filter((project) => project.cards.length > 0);
  return (
    <section className="home-organize-sizes" aria-label={t.cardSizes}>
      <h3>{t.cardSizes}</h3>
      <p className="home-note">{t.cardSizesHelp}</p>
      {listed.length ? (
        listed.map((project) => (
          <div key={project.id} className="home-organize-project" data-project={project.id}>
            <h4>{project.name}</h4>
            <ul className="home-size-list">
              {project.cards.map((section) => {
                const content = cardContent(section);
                const chosen = sizes.chosen(project.id, section.key);
                const { size, source } = shownSize(section, content, chosen);
                return (
                  <li key={section.key} data-size-for={section.key}>
                    <span className="home-size-card">
                      <span>{section.title}</span>
                      <small>{source === "user" ? t.sizeFrom.user(t.sizeName[size]) : t.sizeFrom.auto(t.sizeName[size])}</small>
                    </span>
                    <SizeChoice
                      name={`size-${project.id}-${section.key}`}
                      legend={t.sizeOf(section.title)}
                      value={chosen}
                      allowed={allowedSizes(content)}
                      onChange={(next) => sizes.choose(project.id, section.key, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      ) : (
        <p className="home-note">{t.noCards}</p>
      )}
      <button type="button" className="quiet-button home-size-reset" disabled={!sizes.count} onClick={sizes.resetAll}>
        {t.resetSizes}
      </button>
    </section>
  );
}
