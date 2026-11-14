import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useStrings } from "../../i18n";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { attachmentUrl, type CollectionItem, type CollectionProps } from "./brief-catalog";
import { useBrief } from "./BriefContext";
import { briefText } from "./brief-text";
import { useKeptImagePreview } from "./image-preview";
import { CAROUSEL_DOTS, cardItems, cardLeavesOut, FILTER_TAGS, itemShows, tagsOf, type CollectionFace } from "./collection-model";
import "./collection.css";

type Strings = ReturnType<typeof briefText>;

/**
 * Items of one kind (YN-128, YN-113 §3.6): each a title with an optional
 * picture, line, meta, link and tags, laid out as a carousel, a grid or a
 * list. On its page every item shows, and a grid or a list whose items have
 * tags is filtered by tag, a list also searched; on a card (`face`, the
 * card's size) as many as the card holds (collection-model.ts cardItems),
 * with how many there are, and no filter or search. Nothing moves by
 * itself (WCAG 2.2.2). A picture is the section's own attachment, read from
 * this Core at the section's version and opened whole in the image viewer;
 * a link opens in a new window, never in Home.
 */
export function BriefCollection({ title, layout, items, face }: CollectionProps & { face?: CollectionFace }) {
  const t = useStrings(briefText);
  const id = useId();
  const onCard = face !== undefined;
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [moreTags, setMoreTags] = useState(false);
  // Filters and search are the page's, for a grid or a list.
  const tags = onCard || layout === "carousel" ? [] : tagsOf(items);
  const searchable = !onCard && layout === "list";
  // A tag a later version no longer has is no filter.
  const chosen = tag !== null && tags.includes(tag) ? tag : null;
  const shown = items.filter((item) => itemShows(item, chosen, searchable ? query : ""));
  const limit = face ? cardItems(layout, face) : null;
  const drawn = limit === null ? shown : shown.slice(0, limit);
  const filtered = chosen !== null || (searchable && query.trim() !== "");
  const heading = !onCard && title ? <h4 id={`${id}-title`}>{title}</h4> : null;
  const total = face && cardLeavesOut(layout, face, items.length) ? <p className="brief-collection-total">{t.collectionTotal(items.length)}</p> : null;
  if (layout === "carousel" && face !== "small")
    return (
      <section className="brief-collection" data-layout="carousel" data-face={face} aria-labelledby={heading ? `${id}-title` : undefined}>
        {heading}
        <Carousel items={items} label={title ?? t.collection} t={t} />
      </section>
    );
  const visibleTags = moreTags ? tags : [...tags.slice(0, FILTER_TAGS), ...(chosen !== null && tags.indexOf(chosen) >= FILTER_TAGS ? [chosen] : [])];
  return (
    <section className="brief-collection" data-layout={layout} data-face={face} aria-labelledby={heading ? `${id}-title` : undefined}>
      {heading}
      {(tags.length > 0 || searchable) && (
        <div className="brief-collection-tools">
          {tags.length > 0 && (
            <div className="brief-collection-filters" role="group" aria-label={t.collectionFilter}>
              <button type="button" aria-pressed={chosen === null} onClick={() => setTag(null)}>
                {t.collectionAll}
              </button>
              {visibleTags.map((one) => (
                <button key={one} type="button" aria-pressed={chosen === one} data-tag={one} onClick={() => setTag(one)}>
                  {one}
                </button>
              ))}
              {tags.length > FILTER_TAGS && (
                <button type="button" className="brief-collection-more-tags" aria-expanded={moreTags} onClick={() => setMoreTags(!moreTags)}>
                  {moreTags ? t.collectionFewerTags : t.collectionMoreTags(tags.length - FILTER_TAGS)}
                </button>
              )}
            </div>
          )}
          {searchable && (
            <label className="brief-collection-search">
              <Search size={13} aria-hidden="true" />
              <input value={query} maxLength={200} placeholder={t.collectionSearch} aria-label={t.collectionSearch} onChange={(event) => setQuery(event.target.value)} />
              {query && (
                <button type="button" aria-label={t.collectionClearSearch} onClick={() => setQuery("")}>
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </label>
          )}
        </div>
      )}
      {filtered && (
        <p className="brief-collection-shown" role="status">
          {t.collectionShown(shown.length, items.length)}
        </p>
      )}
      {drawn.length === 0 ? (
        <p className="brief-collection-none">{t.collectionNone}</p>
      ) : (
        <ul className="brief-collection-items">
          {drawn.map((item) => (
            <li key={item.id} data-item={item.id}>
              {layout === "list" ? <Row item={item} /> : <Tile item={item} />}
            </li>
          ))}
        </ul>
      )}
      {total}
    </section>
  );
}

/**
 * One page per item side by side, the next one's edge showing; arrows, a dot
 * per page (past CAROUSEL_DOTS, "n / N" alone), a swipe or the wheel, and
 * ← and → while focus is in it. The page shown is the one the track is
 * scrolled to, this block's own.
 */
function Carousel({ items, label, t }: { items: CollectionItem[]; label: string; t: Strings }) {
  const track = useRef<HTMLDivElement>(null);
  const trackId = useId();
  const [chosen, setAt] = useState(0);
  const total = items.length;
  // Kept within the items: a later version may have fewer (as Steps does).
  const at = Math.max(0, Math.min(total - 1, chosen));
  const go = (index: number) => {
    const next = Math.max(0, Math.min(total - 1, index));
    setAt(next);
    const list = track.current;
    const page = list?.children[next] as HTMLElement | undefined;
    // CSS scrolls smoothly, or at once under reduced motion; snapping keeps a page's edge at the start.
    if (list && page) list.scrollLeft = page.offsetLeft;
  };
  const onScroll = () => {
    const list = track.current;
    if (!list) return;
    const pages = [...list.children] as HTMLElement[];
    // Scrolled to its end, the last page is the one shown, however many fit.
    if (list.scrollLeft + list.clientWidth >= list.scrollWidth - 1) return setAt(total - 1);
    let nearest = 0;
    pages.forEach((page, index) => {
      if (Math.abs(page.offsetLeft - list.scrollLeft) < Math.abs(pages[nearest].offsetLeft - list.scrollLeft)) nearest = index;
    });
    setAt(nearest);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    go(at + (event.key === "ArrowRight" ? 1 : -1));
  };
  return (
    <div className="brief-carousel" role="region" aria-roledescription={t.carousel} aria-label={label} onKeyDown={onKeyDown}>
      {/* Focusable, so the keyboard reaches a track that scrolls; its pages' links and pictures follow. */}
      <div id={trackId} ref={track} className="brief-carousel-track" tabIndex={0} aria-label={label} onScroll={onScroll}>
        {items.map((item, index) => (
          <div key={item.id} className="brief-carousel-page" data-item={item.id} role="group" aria-roledescription={t.slide} aria-label={t.slideOf(index + 1, total)} data-current={index === at || undefined}>
            <Tile item={item} />
          </div>
        ))}
      </div>
      <div className="brief-carousel-nav">
        <button type="button" className="icon-button brief-carousel-move" aria-label={t.carouselPrevious} aria-controls={trackId} disabled={at === 0} onClick={() => go(at - 1)}>
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        {total <= CAROUSEL_DOTS && (
          <ol className="brief-carousel-dots" aria-hidden="true">
            {items.map((item, index) => (
              <li key={item.id} data-current={index === at || undefined} />
            ))}
          </ol>
        )}
        <button type="button" className="icon-button brief-carousel-move" aria-label={t.carouselNext} aria-controls={trackId} disabled={at === total - 1} onClick={() => go(at + 1)}>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <span className="brief-carousel-count" aria-live="polite">
          {t.slideOf(at + 1, total)}
        </span>
      </div>
    </div>
  );
}

/** A tile, as a grid and a carousel draw one: the picture over the text. */
function Tile({ item }: { item: CollectionItem }) {
  return (
    <article className="brief-collection-tile">
      <Picture item={item} />
      <div className="brief-collection-text">
        {item.meta && <span className="brief-collection-meta">{item.meta}</span>}
        <Title item={item} />
        {item.text && <p className="brief-collection-line">{item.text}</p>}
        <Tags item={item} />
      </div>
    </article>
  );
}

/** A row, as a list draws one: a small picture beside the text. */
function Row({ item }: { item: CollectionItem }) {
  return (
    <article className="brief-collection-row">
      <Picture item={item} />
      <div className="brief-collection-text">
        <div className="brief-collection-row-head">
          <Title item={item} />
          {item.meta && <span className="brief-collection-meta">{item.meta}</span>}
        </div>
        {item.text && <p className="brief-collection-line">{item.text}</p>}
        <Tags item={item} />
      </div>
    </article>
  );
}

/** The title, a link to the item's https address in a new window when it has one. */
function Title({ item }: { item: CollectionItem }) {
  const target = item.href ? sourceTarget(item.href) : null;
  const href = target?.kind === "web" && /^https:/i.test(target.path) ? target.path : null;
  return (
    <p className="brief-collection-title">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {item.title}
        </a>
      ) : (
        item.title
      )}
    </p>
  );
}

function Tags({ item }: { item: CollectionItem }) {
  if (!item.tags?.length) return null;
  return (
    <ul className="brief-collection-tags">
      {item.tags.map((tag) => (
        <li key={tag}>{tag}</li>
      ))}
    </ul>
  );
}

/**
 * An item's picture: an image of this section Core keeps, opened whole in
 * the image viewer. Only referenced (not kept), not an image, or failing to
 * load, there is none and the item is its text.
 */
function Picture({ item }: { item: CollectionItem }) {
  const t = useStrings(briefText);
  const { projectId, section } = useBrief();
  const file = item.image ? section.attachments.find((one) => one.name === item.image) : undefined;
  const kept = file?.kind === "image" && file.snapshot ? file : undefined;
  const viewer = useKeptImagePreview(projectId, section, kept, item.alt ?? item.title);
  const src = kept ? attachmentUrl(projectId, section.key, kept.name, section.version) : "";
  const [failed, setFailed] = useState("");
  if (!kept || failed === src) return null;
  return (
    <>
      <button type="button" className="brief-collection-picture" aria-label={t.openImage(item.alt ?? kept.name)} onClick={viewer.open}>
        <img src={src} alt={item.alt ?? ""} loading="lazy" decoding="async" onError={() => setFailed(src)} />
      </button>
      {viewer.dialog}
    </>
  );
}
