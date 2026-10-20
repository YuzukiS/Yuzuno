// Home's right-hand column: a free area of widgets. Which widgets show, and
// in what order, is kept on this device for each workspace (widget-layout.ts).
// Machines is the first widget; Brief sections the user pins join it. The
// area takes any widget with an id, a name and a body.
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, EyeOff, LayoutGrid, PinOff, Plus } from "lucide-react";
import type { WidgetLayout } from "./widget-layout";

export type HomeWidget = {
  id: string;
  name: string;
  /** Drawn only while the widget is on show, so a hidden one reads nothing. */
  body: ReactNode;
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
}: {
  widgets: HomeWidget[];
  /** null until this workspace's layout is read: nothing is drawn as arranged. */
  layout: WidgetLayout | null;
  /** Absent where the layout can't be changed (the design preview). */
  onChange?: (next: (current: WidgetLayout) => WidgetLayout) => void;
}) {
  const [stateArranging, setArranging] = useState(false);
  const arranging = stateArranging && !!onChange;
  const { shown, hidden } = arrangeWidgets(widgets, layout ?? { order: [], hidden: [], pins: [] });
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
  // Shown again at the end of the column.
  const show = (widget: HomeWidget) => {
    if (!layout) return;
    change(
      [...shown, widget, ...hidden.filter((other) => other !== widget)],
      layout.hidden.filter((id) => id !== widget.id),
    );
  };
  return (
    <aside className="home-widget-column" aria-label="Widgets">
      <header className="home-widget-column-head">
        <h2>
          <LayoutGrid size={14} />
          Widgets
        </h2>
        {onChange && layout && (
          <button
            type="button"
            className={`quiet-button${arranging ? " is-active" : ""}`}
            aria-pressed={arranging}
            onClick={() => setArranging((value) => !value)}
          >
            {arranging ? "Done" : "Arrange"}
          </button>
        )}
      </header>
      {!layout && <p className="home-note">Reading this workspace's layout…</p>}
      {layout && shown.map((widget, index) => (
        <div key={widget.id} className="home-widget-slot" data-widget={widget.id}>
          {arranging && (
            <div className="home-widget-tools" role="group" aria-label={`Arrange ${widget.name}`}>
              <span>{widget.name}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Move ${widget.name} up`}
                title="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Move ${widget.name} down`}
                title="Move down"
                disabled={index === shown.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Hide ${widget.name}`}
                title="Hide"
                onClick={() => hide(widget)}
              >
                <EyeOff size={13} />
              </button>
              {widget.onUnpin && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Unpin ${widget.name}`}
                  title="Unpin"
                  onClick={widget.onUnpin}
                >
                  <PinOff size={13} />
                </button>
              )}
            </div>
          )}
          {widget.body}
        </div>
      ))}
      {layout && onChange && (arranging || shown.length === 0) && (
        <div className="home-widget-column-add">
          {hidden.length ? (
            <>
              <span>{shown.length ? "Add a widget" : "No widgets on show. Add one:"}</span>
              {hidden.map((widget) => (
                <button
                  key={widget.id}
                  type="button"
                  className="home-widget-add"
                  onClick={() => show(widget)}
                >
                  <Plus size={13} /> {widget.name}
                </button>
              ))}
            </>
          ) : (
            <span>Every widget is on show.</span>
          )}
        </div>
      )}
    </aside>
  );
}
