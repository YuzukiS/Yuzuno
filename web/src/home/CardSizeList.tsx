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
      asks: project.sections.some((section) => section.kind === "ask"),
      cards: groupSections(project.sections)
        .flatMap((group) => [...(group.parent ? [group.parent] : []), ...group.subs])
        .filter((section) => section.kind !== "ask" && sizable(section)),
    }))
    .filter((project) => project.cards.length > 0);
  return (
    <section className="home-organize-sizes" aria-label={t.cardSizes}>
      {listed.length ? (
        listed.map((project) => (
          <div key={project.id} className="home-organize-project" data-project={project.id}>
            <h3 className="home-size-group">{t.cardSizesOf(project.name)}</h3>
            {project.asks && <p className="home-size-asks">{t.asksNotListed}</p>}
            <ul className="home-size-list">
              {project.cards.map((section) => {
                const id = section.id!;
                const content = cardContent(section);
                const allowed = allowedSizes(content);
                const chosen = sizes.chosen(project.id, id);
                // As the card shows it in this visit to Home.
                const { size, source, own } = shownSize(section, content, chosen, (computed) => sizes.held(project.id, id, computed));
                const reasonId = `size-reason-${project.id}-${id}`;
                return (
                  <li key={section.key} data-size-for={section.key}>
                    <span className="home-size-title">{section.title}</span>
                    {/* A size's name and cells never part (Dev 7's v17). */}
                    <small className="home-size-source">
                      {source === "user" ? t.youSetPrefix : t.autoPrefix} <span className="home-size-unit">{t.sizeLabel(size)}</span>
                    </small>
                    <SizeChoice
                      name={`size-${project.id}-${section.key}`}
                      legend={t.sizeOf(section.title)}
                      value={chosen}
                      own={own}
                      variant="row"
                      allowed={allowed}
                      describedBy={allowed.length < 3 ? reasonId : undefined}
                      onChange={(next) => sizes.choose(project.id, id, next)}
                    />
                    {allowed.length < 3 && (
                      <span id={reasonId} className="home-size-reason">
                        {t.onlySmall}
                      </span>
                    )}
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
