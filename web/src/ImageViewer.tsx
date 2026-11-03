import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { strings, useStrings } from "./i18n";
import {
  bounds,
  modeScale,
  opening,
  pan,
  percent,
  resized,
  STEP,
  track,
  wheelFactor,
  zoomTo,
  type Mode,
  type Point,
  type Size,
  type View,
} from "./image-view";
import "./image-viewer.css";

const text = strings({
  controls: "Image view",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoom: "Zoom",
  fit: "Fit",
  width: "Fit width",
  actual: "Actual size",
  views: (scale: string) => `Zoom ${scale}: choose a view`,
  pointer: "Scroll to zoom · Drag to move",
  touch: "Pinch to zoom · Drag to move",
  loading: "Loading image…",
  stage: (name: string, scale: string, mode: string) => `${name}, ${scale}${mode ? `, ${mode}` : ""}`,
  keys: "Plus and minus zoom; 0 fits the whole image, W its width, 1 shows it at actual size; arrow keys, Page Up, Page Down, Home and End move it.",
}, {
  controls: "图片查看",
  zoomOut: "缩小",
  zoomIn: "放大",
  zoom: "缩放比例",
  fit: "适合窗口",
  width: "适合宽度",
  actual: "原始尺寸",
  views: (scale) => `缩放 ${scale}：选择视图`,
  pointer: "滚轮缩放 · 拖动移动",
  touch: "双指缩放 · 拖动移动",
  loading: "正在载入图片…",
  stage: (name, scale, mode) => `${name}，${scale}${mode ? `，${mode}` : ""}`,
  keys: "加号和减号缩放；0 适合窗口，W 适合宽度，1 原始尺寸；方向键、Page Up、Page Down、Home 和 End 移动图片。",
});

const EMPTY: Size = { width: 0, height: 0 };
const ready = (size: Size | null): size is Size => !!size && size.width > 0 && size.height > 0;
type Fixed = Exclude<Mode, "free">;
/** The image's and the stage's sizes, once both have one. */
const sized = (at: { natural: Size | null; box: Size }) => (ready(at.natural) && ready(at.box) ? { natural: at.natural, box: at.box } : null);
const middle = (box: Size) => ({ x: box.width / 2, y: box.height / 2 });

/**
 * An image to read closely (T-20): the original as `src` gives it, zoomed
 * with the wheel at the pointer, a pinch or + and −, and moved by dragging,
 * its position bars or the keys. It opens whole, or a tall image as wide as
 * the stage from its top (image-view.ts). Only how it is shown changes; the
 * file is read as before and nothing is written. Input is taken only on the
 * stage: the page is not zoomed or scrolled, and Escape is left to the
 * dialog. A new `src` should be a new viewer (`key={src}`), so nothing of
 * one image's view carries over to the next.
 */
export function ImageViewer({
  src,
  alt,
  onError,
  onSize,
  actions,
}: {
  src: string;
  alt: string;
  onError?: () => void;
  /** The image's own size, once it has loaded. */
  onSize?: (size: Size) => void;
  /** Controls after the view's own, such as Mark up. */
  actions?: ReactNode;
}) {
  const t = useStrings(text);
  const keysId = useId();
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>(EMPTY);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [mode, setMode] = useState<Mode>("fit");
  const [opened, setOpened] = useState<Fixed | null>(null);
  const [dragging, setDragging] = useState(false);
  // A button's or key's change glides; a gesture follows the hand at once.
  const [animate, setAnimate] = useState(false);
  const [coarse] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  // What the handlers read: the newest, without waiting for a render.
  const now = useRef({ natural, box, view, mode, opened });
  now.current = { natural, box, view, mode, opened };

  // The stage's size, as it is laid out now and whenever it changes.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setBox((was) => (was.width === next.width && was.height === next.height ? was : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Opened once both the image and its stage have a size; after that, a new
  // stage size keeps the mode chosen and the point in the middle.
  const laidOut = useRef<Size>(EMPTY);
  useEffect(() => {
    if (!ready(natural) || !ready(box)) return;
    if (!now.current.opened) {
      const first = opening(natural, box);
      setOpened(first.mode);
      setMode(first.mode);
      setView(first.view);
    } else if (laidOut.current !== box) {
      const before = ready(laidOut.current) ? laidOut.current : box;
      setAnimate(false);
      setView((was) => resized(was, now.current.mode, natural, before, box));
    }
    laidOut.current = box;
  }, [natural, box]);

  // The focus starts on the image, so the keys work at once; Escape still
  // closes the dialog around it.
  useEffect(() => {
    stage.current?.focus({ preventScroll: true });
  }, []);

  const zoomBy = useCallback((factor: number, at?: Point, glide = false) => {
    const size = sized(now.current);
    if (!size || factor === 1) return;
    setAnimate(glide);
    setView((was) => zoomTo(was, was.scale * factor, at ?? middle(size.box), size.natural, size.box));
    setMode("free");
  }, []);
  const moveBy = useCallback((dx: number, dy: number, glide = false) => {
    const size = sized(now.current);
    if (!size) return;
    setAnimate(glide);
    setView((was) => pan(was, dx, dy, size.natural, size.box));
  }, []);
  const choose = useCallback((next: Fixed, at?: Point) => {
    const size = sized(now.current);
    if (!size) return;
    setAnimate(true);
    setView((was) => zoomTo(was, modeScale(next, size.natural, size.box), at ?? middle(size.box), size.natural, size.box));
    setMode(next);
  }, []);
  // Double-click or double-tap: actual size at that point, or back to how it
  // opened (or, for one that opened at actual size, the whole of it).
  const toggle = (at: Point) => {
    const size = sized(now.current);
    if (!size) return;
    if (Math.abs(now.current.view.scale - 1) > 1e-3) return choose("actual", at);
    const back = now.current.opened && now.current.opened !== "actual" ? now.current.opened : "fit";
    const first = opening(size.natural, size.box);
    if (back === first.mode) {
      setAnimate(true);
      setView(first.view);
      setMode(first.mode);
    } else choose(back, at);
  };

  // The wheel, and Safari's trackpad pinch, are taken only here, and their
  // default (scrolling the page behind, zooming the whole page) is stopped.
  // React's own wheel listener is passive and could not stop it.
  const pointers = useRef(new Map<number, Point>());
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const local = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left - element.clientLeft, y: event.clientY - rect.top - element.clientTop };
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) return moveBy(-event.deltaX, 0);
      zoomBy(wheelFactor(event.deltaY, event.deltaMode, event.ctrlKey, element.clientHeight), local(event));
    };
    let gesture = 1;
    const gestureStart = (event: Event) => {
      event.preventDefault();
      gesture = 1;
    };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      // A touch pinch arrives as pointers too: only a trackpad's is taken here.
      if (pointers.current.size) return;
      const scale = (event as Event & { scale?: number }).scale ?? 1;
      zoomBy(scale / gesture, local(event as unknown as MouseEvent));
      gesture = scale;
    };
    const gestureEnd = (event: Event) => event.preventDefault();
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", gestureStart);
    element.addEventListener("gesturechange", gestureChange);
    element.addEventListener("gestureend", gestureEnd);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", gestureStart);
      element.removeEventListener("gesturechange", gestureChange);
      element.removeEventListener("gestureend", gestureEnd);
    };
  }, [moveBy, zoomBy]);

  // Dragging moves the image; two fingers pinch and move it together. The
  // pointer is captured, so letting go outside the stage still ends it.
  const pinch = useRef<{ distance: number; middle: Point } | null>(null);
  const lastTap = useRef<{ at: Point; time: number } | null>(null);
  const local = (event: React.PointerEvent | React.MouseEvent) => {
    const element = stage.current!;
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left - element.clientLeft, y: event.clientY - rect.top - element.clientTop };
  };
  const measure = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const press = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = local(event);
    pointers.current.set(event.pointerId, at);
    pinch.current = pointers.current.size >= 2 ? measure() : null;
    setDragging(true);
    // A double-tap: two quick taps close together, one finger.
    if (event.pointerType === "touch" && pointers.current.size === 1) {
      const tap = lastTap.current;
      if (tap && event.timeStamp - tap.time < 300 && Math.hypot(at.x - tap.at.x, at.y - tap.at.y) < 24) {
        lastTap.current = null;
        toggle(at);
      } else lastTap.current = { at, time: event.timeStamp };
    }
  };
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    const was = pointers.current.get(event.pointerId);
    if (!was) return;
    const at = local(event);
    pointers.current.set(event.pointerId, at);
    if (pointers.current.size >= 2) {
      const next = measure();
      const before = pinch.current;
      pinch.current = next;
      const size = sized(now.current);
      if (!before || !size || !(before.distance > 0)) return;
      const factor = next.distance / before.distance;
      setAnimate(false);
      setView((view) => pan(zoomTo(view, view.scale * factor, before.middle, size.natural, size.box),
        next.middle.x - before.middle.x, next.middle.y - before.middle.y, size.natural, size.box));
      if (factor !== 1) setMode("free");
      return;
    }
    moveBy(at.x - was.x, at.y - was.y);
  };
  const release = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    pinch.current = pointers.current.size >= 2 ? measure() : null;
    if (!pointers.current.size) setDragging(false);
  };

  // A position bar's thumb, dragged along its side, moves the image there:
  // the thumb's share of its bar is the view's share of the image.
  const held = useRef<{ axis: "x" | "y"; from: number } | null>(null);
  const thumb = (axis: "x" | "y") => {
    const coordinate = (event: React.PointerEvent) => (axis === "x" ? event.clientX : event.clientY);
    const stop = () => (held.current = null);
    return {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        held.current = { axis, from: coordinate(event) };
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const size = sized(now.current);
        if (held.current?.axis !== axis || !size) return;
        const shown = (axis === "x" ? size.natural.width : size.natural.height) * now.current.view.scale;
        const room = axis === "x" ? size.box.width : size.box.height;
        const delta = -((coordinate(event) - held.current.from) * shown) / room;
        held.current.from = coordinate(event);
        moveBy(axis === "x" ? delta : 0, axis === "y" ? delta : 0);
      },
      onPointerUp: stop,
      onPointerCancel: stop,
    };
  };

  // The keys, while the focus is in the viewer. Moving is for the image
  // itself; zooming and the views work from its buttons too. Anything else,
  // Escape included, is left to the page and the dialog.
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const { box } = now.current;
    const across = box.width * 0.1, down = box.height * 0.1, page = box.height * 0.9;
    const views: Record<string, () => void> = {
      "+": () => zoomBy(STEP, undefined, true),
      "=": () => zoomBy(STEP, undefined, true),
      "-": () => zoomBy(1 / STEP, undefined, true),
      "_": () => zoomBy(1 / STEP, undefined, true),
      "0": () => choose("fit"),
      w: () => choose("width"),
      W: () => choose("width"),
      "1": () => choose("actual"),
    };
    // Home and End go to the image's top and bottom: as far as it moves.
    const moves: Record<string, () => void> = {
      ArrowLeft: () => moveBy(across, 0, true),
      ArrowRight: () => moveBy(-across, 0, true),
      ArrowUp: () => moveBy(0, down, true),
      ArrowDown: () => moveBy(0, -down, true),
      PageUp: () => moveBy(0, page, true),
      PageDown: () => moveBy(0, -page, true),
      Home: () => moveBy(0, Infinity, true),
      End: () => moveBy(0, -Infinity, true),
    };
    const act = views[event.key] ?? (event.target === stage.current ? moves[event.key] : undefined);
    if (!act) return;
    event.preventDefault();
    event.stopPropagation();
    act();
  };

  const shown = ready(natural) && ready(box) && opened !== null;
  const limits = shown ? bounds(natural, box) : null;
  const scale = shown ? percent(view.scale) : "–";
  const names: Record<Fixed, string> = { fit: t.fit, width: t.width, actual: t.actual };
  // What a screen reader is told of the view, once a gesture has settled.
  const [spoken, setSpoken] = useState(alt);
  useEffect(() => {
    const said = shown ? t.stage(alt, scale, mode === "free" ? "" : names[mode]) : alt;
    const timer = setTimeout(() => setSpoken(said), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, alt, scale, mode, t]);
  const bars = shown ? {
    x: track(view.x, natural.width * view.scale, box.width),
    y: track(view.y, natural.height * view.scale, box.height),
  } : { x: null, y: null };
  const movable = !!(bars.x || bars.y);
  return (
    <div className="input-image-dialog image-viewer" onKeyDown={key}>
      <div className="image-viewer-bar" role="group" aria-label={t.controls}>
        <div className="image-viewer-zoom">
          <button type="button" aria-label={t.zoomOut} title={`${t.zoomOut} (−)`}
            disabled={!limits || view.scale <= limits.min + 1e-6} onClick={() => zoomBy(1 / STEP, undefined, true)}>
            <Minus size={16} aria-hidden="true" />
          </button>
          <span className="image-viewer-scale">
            <output aria-label={t.zoom}>{scale}</output>
            {/* On a phone the views are a menu on the scale (image-viewer.css). */}
            <ChevronDown className="image-viewer-menu-mark" size={13} aria-hidden="true" />
            <select
              className="image-viewer-menu"
              aria-label={t.views(scale)}
              value={shown && mode !== "free" ? mode : ""}
              disabled={!shown}
              onChange={(event) => event.target.value && choose(event.target.value as Fixed)}
            >
              <option value="" disabled hidden>{scale}</option>
              <option value="fit">{t.fit}</option>
              <option value="width">{t.width}</option>
              <option value="actual">{t.actual}</option>
            </select>
          </span>
          <button type="button" aria-label={t.zoomIn} title={`${t.zoomIn} (+)`}
            disabled={!limits || view.scale >= limits.max - 1e-6} onClick={() => zoomBy(STEP, undefined, true)}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="image-viewer-modes">
          {(["fit", "width", "actual"] as const).map((each) => (
            <button key={each} type="button" aria-pressed={shown && mode === each} disabled={!shown}
              title={`${names[each]} (${{ fit: "0", width: "W", actual: "1" }[each]})`} onClick={() => choose(each)}>
              {names[each]}
            </button>
          ))}
        </div>
        <span className="image-viewer-hint" aria-hidden="true">{coarse ? t.touch : t.pointer}</span>
        {actions && <div className="image-viewer-actions">{actions}</div>}
      </div>
      <div
        ref={stage}
        className="image-viewer-stage"
        tabIndex={0}
        role="group"
        aria-label={spoken}
        aria-describedby={keysId}
        data-movable={movable || undefined}
        data-dragging={dragging || undefined}
        data-animate={animate || undefined}
        onPointerDown={press}
        onPointerMove={drag}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onDoubleClick={(event) => shown && toggle(local(event))}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => {
            const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
            setNatural(size);
            onSize?.(size);
          }}
          onError={onError}
          style={shown ? {
            width: natural.width,
            height: natural.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          } : { visibility: "hidden" }}
        />
        {!shown && <span className="image-viewer-loading">{t.loading}</span>}
        {(["x", "y"] as const).map((axis) => {
          const bar = bars[axis];
          if (!bar) return null;
          const along = axis === "x" ? { left: `${bar.start * 100}%`, width: `${bar.size * 100}%` } : { top: `${bar.start * 100}%`, height: `${bar.size * 100}%` };
          return (
            <div key={axis} className="image-viewer-track" data-axis={axis} aria-hidden="true">
              <div className="image-viewer-thumb" style={along} {...thumb(axis)} />
            </div>
          );
        })}
      </div>
      <p id={keysId} className="sr-only">{t.keys}</p>
    </div>
  );
}
