// Home's "My widgets": the widgets the user keeps on Home, in a grid of two
// columns where the pane is wide and one where it is narrow, in the same
// order. Which widgets show, and in what order, is kept on this device for
// each workspace (widget-layout.ts) and changed only in Organize; an Agent's
// update changes a widget's content, never its place. Machines is a widget;
// Brief sections the user pins join it. Nothing is pinned for the user.
import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, LayoutGrid, PinOff, SlidersHorizontal } from "lucide-react";
import { Modal } from "../components";
import { useStrings } from "../i18n";
import { homeText } from "./home-text";
import type { CardSize } from "./card-preview";
import { SizeChoice } from "./SizeChoice";
import { cardText } from "./card-text";
import type { WidgetLayout } from "./widget-layout";
import type { DeckItem } from "./deck-pack.ts";
import { useDeckPacking } from "./deck-packing";
import { Tip, TipText } from "../Tip";

/** A pinned card's size on the widget column: the user's, else its Agent's (`own`). */
export type WidgetSize = { shown: CardSize; own: CardSize; chosen: CardSize | null; onChange: (size: CardSize | null) => void };

/** "Small 1×1" as one unit: a long line wraps before it, never inside it. */
const Unit = ({ children }: { children: ReactNode }) => <span className="home-size-unit">{children}</span>;

export type HomeWidget = {
  id: string;
  name: string;
  /** Drawn only while the widget is on show, so a hidden one reads nothing. */
  body: ReactNode;
  /** A pinned card with a summary has one (T-18, Dev 7's v19). */
  size?: WidgetSize;
  /** The whole row at its content's height: Machines, built in; a pin with no summary, shown in full. */
  full?: "builtin" | "legacy";
  /** A pinned section can also be unpinned: hidden, it stays pinned to show again. */
  onUnpin?: () => void;
};

/** The widgets on show in the saved order (new ones last), and the hidden ones. */
export function arrangeWidgets(widgets: HomeWidget[], layout: WidgetLayout) {
  const ids = widgets.map((widget) => widget.id);
  const placed = layout.order.filter((id) => ids.includes(id));
  const order = [...placed, ...ids.filter((id) => !placed.includes(id))];
  const byId = new Map(widgets.map((widget) => [widget.id, widget] as const));
  const pick = (hidden: boolean) =>
    order.filter((id) => layout.hidden.includes(id) === hidden).map((id) => byId.get(id)!);
  return { shown: pick(false), hidden: pick(true) };
}

export function HomeWidgets({
  widgets,
  layout,
  onChange,
  onResetSizes,
}: {
  widgets: HomeWidget[];
  /** null until this workspace's layout is read: nothing is drawn as arranged. */
  layout: WidgetLayout | null;
  /** Absent where the layout can't be changed (the design preview). */
  onChange?: (next: (current: WidgetLayout) => WidgetLayout) => void;
  /** Gives every pinned widget back to its Agent's size. */
  onResetSizes?: () => void;
}) {
  const t = useStrings(homeText);
  const c = useStrings(cardText);
  const [organizing, setOrganizing] = useState(false);
  const { shown, hidden } = arrangeWidgets(widgets, layout ?? { order: [], hidden: [], pins: [] });
  // With no holes, in the user's order, as the deck is (deck-pack.ts, YN-3).
  const grid = useRef<HTMLDivElement>(null);
  useDeckPacking(grid, (el) => Array.from(el.children) as HTMLElement[], widgetSlot);
  function change(order: HomeWidget[], hiddenIds: string[]) {
    onChange?.((current) => ({ ...current, order: order.map((widget) => widget.id), hidden: hiddenIds }));
  }
  function move(index: number, by: -1 | 1) {
    if (!layout) return;
    const order = [...shown];
    [order[index], order[index + by]] = [order[index + by], order[index]];
    change([...order, ...hidden], layout.hidden);
  }
  const hide = (widget: HomeWidget) => {
    if (!layout) return;
    change([...shown, ...hidden], [...layout.hidden.filter((id) => id !== widget.id), widget.id]);
  };
  // Shown again after the others on show.
  const show = (widget: HomeWidget) => {
    if (!layout) return;
    change(
      [...shown, widget, ...hidden.filter((other) => other !== widget)],
      layout.hidden.filter((id) => id !== widget.id),
    );
  };
  const unpin = (widget: HomeWidget) =>
    widget.onUnpin && (
      <Tip content={<TipText title={t.unpinShort} />} describe={false}>
        <button
          type="button"
          className="icon-button"
          aria-label={t.unpinWidget(widget.name)}
          onClick={widget.onUnpin}
        >
          <PinOff size={13} />
        </button>
      </Tip>
    );
  const canOrganize = !!onChange && !!layout;
  return (
    <section className="home-widget-column" aria-label={t.widgets}>
      <header className="home-widget-column-head">
        <h2>
          <LayoutGrid size={14} />
          {t.widgets}
        </h2>
        {layout && <span className="home-widget-count">{t.pinnedCount(layout.pins.length)}</span>}
        {canOrganize && (
          <button type="button" className="quiet-button home-widget-organize" aria-haspopup="dialog" onClick={() => setOrganizing(true)}>
            <SlidersHorizontal size={13} />
            {t.organize}
          </button>
        )}
      </header>
      {!layout && <p className="home-note">{t.readingLayout}</p>}
      {layout && shown.length > 0 && (
        <div ref={grid} className="home-widget-grid">
          {shown.map((widget) => (
            <div
              key={widget.id}
              className={`home-widget-slot${widget.size ? ` size-${widget.size.shown}` : ""}${widget.full ? " is-full" : ""}`}
              data-widget={widget.id}
              data-widget-size={widget.size?.shown}
            >
              {widget.body}
            </div>
          ))}
        </div>
      )}
      {layout && !shown.length && <p className="home-note home-widget-empty">{t.noWidgets}</p>}
      {canOrganize && (
        <Modal
          open={organizing}
          onOpenChange={setOrganizing}
          title={t.organizeTitle}
          description={t.organizeHelp}
          className="home-organize"
        >
          <h3>{t.onShow}</h3>
          <p className="home-note home-widget-sizes-note">{c.widgetSizesNote}</p>
          {shown.length ? (
            <ol className="home-organize-list">
              {shown.map((widget, index) => (
                <li key={widget.id} data-widget={widget.id} className="home-widget-row">
                  <span className="home-widget-name">{widget.name}</span>
                  {/* Where a widget's size comes from (Dev 7's v19); only a pinned card with a summary has one to choose. */}
                  {widget.size ? (
                    <>
                      <small className="home-size-source">
                        {widget.size.chosen ? (
                          <>
                            {c.youSetPrefix} <Unit>{c.sizeLabel(widget.size.shown)}</Unit> · {c.cardStays} <Unit>{c.sizeLabel(widget.size.own)}</Unit>
                          </>
                        ) : (
                          <>
                            {c.followPrefix} <Unit>{c.sizeLabel(widget.size.shown)}</Unit>
                          </>
                        )}
                      </small>
                      <SizeChoice
                        name={`size-${widget.id}`}
                        legend={c.sizeOf(widget.name)}
                        value={widget.size.chosen}
                        own={widget.size.own}
                        variant="row"
                        onChange={widget.size.onChange}
                      />
                    </>
                  ) : (
                    widget.full && <small className="home-size-source is-note">{widget.full === "builtin" ? c.builtIn : c.shownInFull}</small>
                  )}
                  <span className="home-organize-tools" role="group" aria-label={t.arrangeWidget(widget.name)}>
                    <Tip content={<TipText title={t.moveUpTitle} />} describe={false}>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t.moveUp(widget.name)}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp size={13} />
                      </button>
                    </Tip>
                    <Tip content={<TipText title={t.moveDownTitle} />} describe={false}>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t.moveDown(widget.name)}
                        disabled={index === shown.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown size={13} />
                      </button>
                    </Tip>
                    <Tip content={<TipText title={t.hide} />} describe={false}>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t.hideWidget(widget.name)}
                        onClick={() => hide(widget)}
                      >
                        <EyeOff size={13} />
                      </button>
                    </Tip>
                    {unpin(widget)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="home-note">{t.noneOnShow}</p>
          )}
          <p className="home-note">{t.organizeNote}</p>
          <h3>{t.hiddenWidgets}</h3>
          {hidden.length ? (
            <ul className="home-organize-list">
              {hidden.map((widget) => (
                <li key={widget.id} data-widget={widget.id}>
                  <span>{widget.name}</span>
                  <span className="home-organize-tools" role="group" aria-label={t.arrangeWidget(widget.name)}>
                    <button type="button" className="quiet-button" aria-label={t.showWidget(widget.name)} onClick={() => show(widget)}>
                      <Eye size={13} />
                      {t.show}
                    </button>
                    {unpin(widget)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="home-note">{t.noneHidden}</p>
          )}
          <p className="home-note">{t.addFromProject}</p>
          {onResetSizes && (
            <div className="home-size-foot">
              <button
                type="button"
                className="quiet-button home-size-reset"
                disabled={!layout?.pins.some((pin) => pin.size)}
                onClick={onResetSizes}
              >
                {c.resetWidgetSizes}
              </button>
              <p className="home-note">{c.widgetSizesSaved}</p>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="primary-button" onClick={() => setOrganizing(false)}>
              {t.reorderDone}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** A widget as a deck item: a pinned card at its size; null for one that takes its row (Machines, a pin shown in full). */
function widgetSlot(slot: HTMLElement): DeckItem | null {
  if (slot.classList.contains("is-full")) return null;
  switch (slot.dataset.widgetSize) {
    case "small":
      return { span: 1 };
    case "wide":
      return { span: 2 };
    case "large":
      return { span: 2, tall: true };
    default:
      return null;
  }
}
