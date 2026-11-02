import { useContext } from "react";
import { useStrings } from "../i18n";
import { groupSections } from "./brief-layout";
import { allowedSizes, cardContent, shownSize } from "./card-preview";
import { CardSizes, sizable } from "./card-sizes";
import { cardText } from "./card-text";
import { SizeChoice } from "./SizeChoice";
import type { Section } from "./types";

/**
 * Organize's card sizes (T-18, Lead 2378; Dev 7's v12): every report and
 * status card on Home, by project and in the deck's order, with the size it
 * has and why, and the user's choice. An Ask is not listed: it always takes
 * its row.
 */
export function CardSizeList({ projects }: { projects: { id: string; name: string; sections: Section[] }[] }) {
  const sizes = useContext(CardSizes);
  const t = useStrings(cardText);
  if (!sizes) return null;
  const listed = projects
    .map((project) => ({
      ...project,
      cards: groupSections(project.sections)
        .flatMap((group) => [...(group.parent ? [group.parent] : []), ...group.subs])
        .filter((section) => section.kind !== "ask" && sizable(section)),
    }))
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
                const id = section.id!;
                const content = cardContent(section);
                const chosen = sizes.chosen(project.id, id);
                // As the card shows it in this visit to Home.
                const { size, source, own } = shownSize(section, content, chosen, (computed) => sizes.held(project.id, id, computed));
                return (
                  <li key={section.key} data-size-for={section.key}>
                    <span className="home-size-card">
                      <span>{section.title}</span>
                      <small>{source === "user" ? t.sizeFrom.user(t.sizeLabel(size)) : t.sizeFrom.auto(t.sizeLabel(size))}</small>
                    </span>
                    <SizeChoice
                      name={`size-${project.id}-${section.key}`}
                      legend={t.sizeOf(section.title)}
                      value={chosen}
                      own={own}
                      variant="row"
                      allowed={allowedSizes(content)}
                      onChange={(next) => sizes.choose(project.id, id, next)}
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
      <div className="home-size-foot">
        <button type="button" className="quiet-button home-size-reset" disabled={!sizes.count} onClick={sizes.resetAll}>
          {t.resetSizes}
        </button>
        <p className="home-note">{t.sizesSaved}</p>
      </div>
    </section>
  );
}
