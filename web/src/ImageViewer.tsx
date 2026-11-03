import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { strings, useStrings } from "./i18n";
import {
  bounds,
  modeScale,
  opening,
  pan,
  percent,
  place,
  resized,
  STEP,
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
  fitLabel: "Fit to window",
  width: "Fit width",
  actual: "1:1",
  actualLabel: "Actual size 1:1",
  pointer: "Scroll to zoom · drag to move",
  touch: "Pinch to zoom · drag to move",
  keys: "Plus and minus zoom, 0 shows how it opened, 1 its actual size; arrow keys, Page Up, Page Down, Home and End move.",
}, {
  controls: "图片查看",
  zoomOut: "缩小",
  zoomIn: "放大",
  zoom: "缩放比例",
  fit: "适合窗口",
  fitLabel: "适合窗口",
  width: "适合宽度",
  actual: "1:1",
  actualLabel: "原始尺寸 1:1",
  pointer: "滚轮缩放 · 拖动移动",
  touch: "双指缩放 · 拖动移动",
  keys: "加号和减号缩放，0 回到打开时的样子，1 显示原始尺寸；方向键、Page Up、Page Down、Home 和 End 移动。",
});

const EMPTY: Size = { width: 0, height: 0 };
const ready = (size: Size | null): size is Size => !!size && size.width > 0 && size.height > 0;

/**
 * An image to read closely (T-20): the original as `src` gives it, zoomed
 * with the wheel at the pointer, a pinch or + and −, and moved by dragging
 * or with the keys. It opens whole, or a long image as wide as the viewer
 * from its top (image-view.ts). Only how it is shown changes; the file is
 * read as before and nothing is written. Input is taken only on the image
 * itself: the page is not zoomed or scrolled, and Escape is left to the
 * dialog. A new `src` should be a new viewer (`key={src}`), so nothing of
 * one image's view carries over to the next.
 */
export function ImageViewer({
  src,
  alt,
  onError,
  actions,
}: {
  src: string;
  alt: string;
  onError?: () => void;
  /** More controls at the end of the bar, such as Mark up. */
  actions?: ReactNode;
}) {
  const t = useStrings(text);
  const keysId = useId();
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>(EMPTY);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [mode, setMode] = useState<Mode>("fit");
  const [dragging, setDragging] = useState(false);
  const [coarse] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  // What the event handlers read: the newest, without waiting for a render.
  const now = useRef({ natural, box, view, mode });
  now.current = { natural, box, view, mode };
  const opened = useRef(false);

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
    if (!opened.current) {
      opened.current = true;
      const first = opening(natural, box);
      setMode(first.mode);
      setView(first.view);
    } else if (laidOut.current !== box) {
      const before = laidOut.current;
      setView((was) => resized(was, now.current.mode, natural, ready(before) ? before : box, box));
    }
    laidOut.current = box;
  }, [natural, box]);

  // The focus starts on the image, so the keys work at once; Escape still
  // closes the dialog around it.
  useEffect(() => {
    stage.current?.focus({ preventScroll: true });
  }, []);

  const zoomBy = useCallback((factor: number, at?: Point) => {
    const { natural, box } = now.current;
    if (!ready(natural) || !ready(box) || factor === 1) return;
    const point = at ?? { x: box.width / 2, y: box.height / 2 };
    setView((was) => zoomTo(was, was.scale * factor, point, natural, box));
    setMode("free");
  }, []);
  const moveBy = useCallback((dx: number, dy: number) => {
    const { natural, box } = now.current;
    if (!ready(natural) || !ready(box)) return;
    setView((was) => pan(was, dx, dy, natural, box));
  }, []);
  const choose = useCallback((next: Exclude<Mode, "free">, at?: Point) => {
    const { natural, box } = now.current;
    if (!ready(natural) || !ready(box)) return;
    const point = at ?? { x: box.width / 2, y: box.height / 2 };
    setView((was) => zoomTo(was, modeScale(next, natural, box), point, natural, box));
    setMode(next);
  }, []);
  const reset = useCallback(() => {
    const { natural, box } = now.current;
    if (!ready(natural) || !ready(box)) return;
    const first = opening(natural, box);
    setView(first.view);
    setMode(first.mode);
  }, []);

  // The wheel, and Safari's trackpad pinch, are taken only here, and their
  // default (scrolling the page behind, zooming the whole page) is stopped.
  // React's own wheel listener is passive and could not stop it.
  const pointers = useRef(new Map<number, Point>());
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const local = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        moveBy(-event.deltaX, 0);
        return;
      }
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
  // pointer is captured, so letting go outside the image still ends it.
  const pinch = useRef<{ distance: number; middle: Point } | null>(null);
  const local = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const measure = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const press = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    pinch.current = pointers.current.size >= 2 ? measure() : null;
    setDragging(true);
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
      const { natural, box } = now.current;
      if (!before || !ready(natural) || !ready(box) || !(before.distance > 0)) return;
      const factor = next.distance / before.distance;
      setView((view) => pan(zoomTo(view, view.scale * factor, before.middle, natural, box),
        next.middle.x - before.middle.x, next.middle.y - before.middle.y, natural, box));
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

  // The keys, while the focus is in the viewer. Moving is for the image
  // itself; zooming works from its buttons too. Anything else, Escape
  // included, is left to the page and the dialog.
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 160 : 40;
    const page = now.current.box.height * 0.9;
    const zooms: Record<string, () => void> = {
      "+": () => zoomBy(STEP),
      "=": () => zoomBy(STEP),
      "-": () => zoomBy(1 / STEP),
      "_": () => zoomBy(1 / STEP),
      "0": reset,
      "1": () => choose("actual"),
    };
    // Home and End go to the image's top and bottom: as far as it moves.
    const moves: Record<string, () => void> = {
      ArrowLeft: () => moveBy(step, 0),
      ArrowRight: () => moveBy(-step, 0),
      ArrowUp: () => moveBy(0, step),
      ArrowDown: () => moveBy(0, -step),
      PageUp: () => moveBy(0, page),
      PageDown: () => moveBy(0, -page),
      Home: () => moveBy(0, Infinity),
      End: () => moveBy(0, -Infinity),
    };
    const act = zooms[event.key] ?? (event.target === stage.current ? moves[event.key] : undefined);
    if (!act) return;
    event.preventDefault();
    event.stopPropagation();
    act();
  };

  const limits = ready(natural) && ready(box) ? bounds(natural, box) : null;
  const shown = ready(natural) && ready(box) && opened.current;
  const movable = shown && (natural.width * view.scale > box.width + 0.5 || natural.height * view.scale > box.height + 0.5);
  const fixed = place(view, natural ?? EMPTY, box);
  return (
    <div className="input-image-dialog image-viewer" onKeyDown={key}>
      <div className="image-viewer-bar" role="group" aria-label={t.controls}>
        <div className="image-viewer-zoom">
          <button type="button" className="icon-button" aria-label={t.zoomOut} title={`${t.zoomOut} (−)`}
            disabled={!limits || view.scale <= limits.min + 1e-6} onClick={() => zoomBy(1 / STEP)}>
            <Minus size={15} />
          </button>
          <output aria-label={t.zoom}>{shown ? percent(view.scale) : "–"}</output>
          <button type="button" className="icon-button" aria-label={t.zoomIn} title={`${t.zoomIn} (+)`}
            disabled={!limits || view.scale >= limits.max - 1e-6} onClick={() => zoomBy(STEP)}>
            <Plus size={15} />
          </button>
        </div>
        <div className="image-viewer-modes">
          <button type="button" aria-pressed={shown && mode === "fit"} aria-label={t.fitLabel} title={`${t.fitLabel} (0)`}
            disabled={!shown} onClick={() => choose("fit")}>
            {t.fit}
          </button>
          <button type="button" aria-pressed={shown && mode === "width"} disabled={!shown} onClick={() => choose("width")}>
            {t.width}
          </button>
          <button type="button" aria-pressed={shown && mode === "actual"} aria-label={t.actualLabel} title={`${t.actualLabel} (1)`}
            disabled={!shown} onClick={() => choose("actual")}>
            {t.actual}
          </button>
        </div>
        <span className="image-viewer-hint" aria-hidden="true">{coarse ? t.touch : t.pointer}</span>
        {actions && <div className="image-viewer-actions">{actions}</div>}
      </div>
      <div
        ref={stage}
        className="image-viewer-stage"
        tabIndex={0}
        role="group"
        aria-label={alt}
        aria-describedby={keysId}
        data-movable={movable || undefined}
        data-dragging={dragging || undefined}
        onPointerDown={press}
        onPointerMove={drag}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onDoubleClick={(event) => {
          if (!shown) return;
          if (mode === "actual") reset();
          else choose("actual", local(event));
        }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={onError}
          style={shown ? {
            width: natural.width,
            height: natural.height,
            transform: `translate(${fixed.x}px, ${fixed.y}px) scale(${fixed.scale})`,
          } : { visibility: "hidden" }}
        />
      </div>
      <p id={keysId} className="sr-only">{t.keys}</p>
    </div>
  );
}
