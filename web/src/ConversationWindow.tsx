import {
  Component, Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import "./conversation-window.css";

type Memory = {
  heights: Map<string, number>;
  disclosures: Map<string, boolean>;
  seen: Set<string>;
};
type WindowContext = Memory & {
  scroll: RefObject<HTMLDivElement | null>;
  pane: HTMLDivElement | null;
  follow: RefObject<boolean>;
  /** A navigation target keeps its row mounted and opens what hides it. A
   * `hold` keeps the reader's place while history pages (T-161): it keeps the
   * row mounted but opens nothing, since opening moves what is being read. */
  target?: { turnId: string; itemId?: string; hold?: boolean } | null;
};
const Context = createContext<WindowContext | null>(null);

type AnchorProps = Pick<WindowContext, "scroll" | "follow" | "target"> & {children: ReactNode};
/** React's before-commit snapshot sees the old DOM. A layout effect alone is
 * too late to capture the reader's position when a new snapshot changes the
 * window or surrounding controls. Only mounted messages are inspected. */
class ReadingAnchor extends Component<AnchorProps> {
  getSnapshotBeforeUpdate() {
    const pane = this.props.scroll.current;
    if (!pane?.clientHeight || this.props.follow.current || this.props.target) return null;
    const box = pane.getBoundingClientRect();
    const visible = Array.from(pane.querySelectorAll<HTMLElement>("[data-item-id]"))
      .map(element => ({element, rect:element.getBoundingClientRect()}))
      .filter(({rect}) => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom);
    const anchor = visible.find(({rect}) => rect.top >= box.top) || visible[0];
    return anchor ? {element:anchor.element, top:anchor.rect.top} : null;
  }
  componentDidUpdate(_previous: AnchorProps, _state: unknown, anchor: {element: HTMLElement; top: number} | null) {
    const pane = this.props.scroll.current;
    if (pane && anchor?.element.isConnected && !this.props.follow.current && !this.props.target)
      pane.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
  }
  render() { return this.props.children; }
}

/** Only the selected conversation owns this state. No conversation DOM or
 * payload is cached here. Even a very long inspection session has a bound. */
function remember<T>(map: Map<string, T>, key: string, value: T, limit = 2000) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

export function ConversationWindow({ scroll, follow, target, children }: {
  scroll: RefObject<HTMLDivElement | null>;
  follow: RefObject<boolean>;
  target?: WindowContext["target"];
  children: ReactNode;
}) {
  const [memory] = useState<Memory>(() => ({ heights: new Map(), disclosures: new Map(), seen: new Set() }));
  // Child layout effects run before the ancestor scroll element's ref is
  // attached. Publish its ready element after that commit so every nested
  // list binds its observers and measures the initial rows, even if its
  // items and mounted keys never change.
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setPane(scroll.current); }, [scroll]);
  const value = useMemo(() => ({ ...memory, scroll, pane, follow, target }), [memory, scroll, pane, follow, target]);
  return <Context.Provider value={value}><ReadingAnchor scroll={scroll} follow={follow} target={target}>{children}</ReadingAnchor></Context.Provider>;
}

export function useConversationTarget(turnId: string) {
  const context = useContext(Context);
  return context?.target?.turnId === turnId ? context.target : null;
}
/** The target in `turnId` that may open a closed group, card or plan: not a
 * position hold. */
export function useConversationReveal(turnId: string) {
  const target = useConversationTarget(turnId);
  return target && !target.hold ? target : null;
}
export function useConversationWindowed() { return !!useContext(Context); }

/** A disclosure's user choice survives row unmounts, without retaining its
 * children. Default-open live groups can still change as a reply arrives. */
export function useConversationDisclosure(key: string, initiallyOpen: boolean) {
  const context = useContext(Context);
  const [choice, setChoice] = useState<boolean | undefined>(() => context?.disclosures.get(key));
  return [choice ?? initiallyOpen, (open: boolean) => {
    if (context) remember(context.disclosures, key, open, 500);
    setChoice(open);
  }] as const;
}

export function useFirstConversationMount(key: string) {
  const context = useContext(Context);
  const [first] = useState(() => !context?.seen.has(key));
  useLayoutEffect(() => {
    if (!context) return;
    context.seen.add(key);
    while (context.seen.size > 2000) context.seen.delete(context.seen.values().next().value!);
  }, [context, key]);
  return first;
}

/** First row whose end is after y. Positions are estimates until measured. */
export function rowAt(offsets: readonly number[], y: number) {
  let low = 0, high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Variable-height rows sharing the conversation's scroll container. There
 * are spacer gaps, never one hidden DOM subtree per historical row. Nesting
 * this at Turn, message-block and tool-row boundaries also bounds one huge
 * Turn. A mounted selection is held until the selection is released. */
export function ConversationRows<T>({ id, items, itemKey, estimate, targetKey, children, onReading }: {
  id: string;
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  estimate: (item: T, index: number) => number;
  targetKey?: string;
  children: (item: T, index: number) => ReactNode;
  onReading?: (item: T) => void;
}) {
  const context = useContext(Context);
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, origin: 0, height: 800, layout: typeof ResizeObserver !== "undefined" });
  const [revision, measureAgain] = useState(0);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const selectedRows = useRef<Set<string>>(new Set());
  const keys = items.map(itemKey);
  const offsets = [0];
  for (let index = 0; index < items.length; index++)
    offsets.push(offsets[index] + (context?.heights.get(`${id}/${keys[index]}`) ?? Math.max(1, estimate(items[index], index))));
  const target = targetKey === undefined ? -1 : keys.indexOf(targetKey);
  const enabled = !!context && view.layout && items.length > 8;
  const top = target >= 0 ? offsets[target] : context?.follow.current ? Math.max(0, offsets.at(-1)! - view.height)
    : (context?.scroll.current?.scrollTop ?? view.top) - view.origin;
  const overscan = Math.max(400, view.height);
  const start = enabled ? rowAt(offsets, Math.max(0, top - overscan)) : 0;
  const end = enabled ? Math.min(items.length, rowAt(offsets, top + view.height + overscan) + 1) : items.length;
  // Text selection is a native DOM range. Keep its existing mounted rows
  // while it is active; do not manufacture a selection across unloaded text.
  const mounted = new Set(Array.from({ length: end - start }, (_, i) => start + i));
  for (const key of selectedRows.current) {
    const at = keys.indexOf(key);
    if (at >= 0) mounted.add(at);
  }
  // A navigation target may retain keyboard focus after its one-shot mount
  // hint is cleared. Removing that row would silently send focus to <body>.
  for (const [key, row] of rows.current) {
    if (row.contains(document.activeElement)) {
      const at = keys.indexOf(key);
      if (at >= 0) mounted.add(at);
    }
  }
  const indices = [...mounted].sort((a, b) => a - b);
  const mountedKey = indices.map(index => keys[index]).join("\u0000");
  const snapshot = useRef({ keys, offsets, start, end });
  snapshot.current = { keys, offsets, start, end };
  const read = useRef(onReading);
  read.current = onReading;
  const values = useRef(items);
  values.current = items;

  useLayoutEffect(() => {
    const el = root.current, pane = context?.pane;
    if (!el || !pane) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const paneTop = pane.getBoundingClientRect().top;
      const relativeTop = paneTop - el.getBoundingClientRect().top;
      // Non-layout test environments keep the ordinary tree. A hidden real
      // browser pane must not suddenly mount the whole saved conversation.
      const layout = typeof ResizeObserver !== "undefined";
      const origin = pane.scrollTop - relativeTop;
      setView(previous => previous.top === relativeTop && previous.origin === origin && previous.height === pane.clientHeight && previous.layout === layout
        ? previous : { top: relativeTop, origin, height: pane.clientHeight, layout });
      if (layout && read.current && values.current.length && pane.clientHeight) {
        // At the end of the conversation the last row is the one being
        // read, however short it is: a Turn that has just begun must not
        // leave the marker on the one before (the turn dock's own rule).
        const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 8;
        read.current(values.current[atEnd ? values.current.length - 1 : rowAt(snapshot.current.offsets, relativeTop + 32)]);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const selection = () => {
      const range = window.getSelection();
      const selected = new Set<string>();
      if (range && !range.isCollapsed && range.rangeCount) {
        const native = range.getRangeAt(0);
        for (const [key, row] of rows.current)
          if (native.intersectsNode(row)) selected.add(key);
      }
      selectedRows.current = selected;
      schedule();
    };
    update();
    pane.addEventListener("scroll", schedule, { passive: true });
    pane.addEventListener("focusin", schedule);
    pane.addEventListener("focusout", schedule);
    document.addEventListener("selectionchange", selection);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(pane);
    observer?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      pane.removeEventListener("scroll", schedule);
      pane.removeEventListener("focusin", schedule);
      pane.removeEventListener("focusout", schedule);
      document.removeEventListener("selectionchange", selection);
      observer?.disconnect();
    };
  }, [context?.pane, id]);

  useLayoutEffect(() => {
    const pane = context?.pane;
    if (!context || !pane || !pane.clientHeight) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const paneTop = pane.getBoundingClientRect().top;
      // If this entire nested list is above the reader, its parent row owns
      // the correction. Both levels correcting would count the same height
      // change twice and move otherwise unchanged visible content.
      const ownsCorrection = !!root.current && root.current.getBoundingClientRect().bottom > paneTop;
      let correction = 0, changed = false;
      for (const [key, row] of rows.current) {
        const at = snapshot.current.keys.indexOf(key);
        if (at < 0) continue;
        const box = row.getBoundingClientRect();
        const oldHeight = snapshot.current.offsets[at + 1] - snapshot.current.offsets[at];
        if (box.height > 0 && Math.abs(oldHeight - box.height) > 0.5) {
          remember(context.heights, `${id}/${key}`, box.height);
          changed = true;
          // Only rows entirely above the viewport move the reading anchor.
          // Nested lists never both compensate the row containing the reader.
          if (ownsCorrection && box.bottom <= paneTop) correction += box.height - oldHeight;
        }
      }
      if (changed) {
        if (!context.follow.current && correction) pane.scrollTop += correction;
        measureAgain(value => value + 1);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const row of rows.current.values()) observer?.observe(row);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [context, id, mountedKey, items, revision]);

  if (!context) return <>{items.map(children)}</>;
  return <div ref={root} className="conversation-window" data-window={id}>
    {indices.map((index, position) => {
      const item = items[index], key = keys[index];
      const previousEnd = position ? indices[position - 1] + 1 : 0;
      return <Fragment key={key}>
        {index > previousEnd && <div aria-hidden="true" style={{ height: offsets[index] - offsets[previousEnd] }} />}
        <div className="conversation-window-row" data-window-key={key}
        ref={element => { if (element) rows.current.set(key, element); else rows.current.delete(key); }}>
        {children(item, index)}
        </div>
      </Fragment>;
    })}
    {!!indices.length && indices.at(-1)! + 1 < items.length && <div aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[indices.at(-1)! + 1] }} />}
  </div>;
}
