// How an image sits in its viewer (T-20): the scale and where its top-left
// corner is, in the stage's own pixels. A point of the image at (u, v) is
// shown at (x + scale·u, y + scale·v). Only what is shown changes here; the
// image's own pixels, and so Point & Fix's coordinates, never do.

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type View = { scale: number; x: number; y: number };
/** Fit: the whole image. Width: as wide as the stage. Actual: one image
 * pixel to one CSS pixel. Free: as the person zoomed it. */
export type Mode = "fit" | "width" | "actual" | "free";

/** The closest the viewer goes: four times the image's own size, or Fit or
 * Fit width if a tiny image's is more. */
export const MAX_SCALE = 4;
/** One step of + and −. */
export const STEP = 1.25;

const usable = (size: Size) => size.width > 0 && size.height > 0;

/** The scale at which the whole image fits. */
export function fitScale(image: Size, box: Size): number {
  if (!usable(image) || !usable(box)) return 1;
  return Math.min(box.width / image.width, box.height / image.height);
}

/** The scale at which the image is as wide as the stage. */
export function widthScale(image: Size, box: Size): number {
  if (!usable(image) || !usable(box)) return 1;
  return box.width / image.width;
}

/** How far out and in this image can be zoomed on this stage: out to the
 * whole image (or its own size, if that is smaller), in to MAX_SCALE (or a
 * mode's scale, if that is closer still, so each mode stays in reach). */
export function bounds(image: Size, box: Size): { min: number; max: number } {
  const fit = fitScale(image, box);
  return { min: Math.min(fit, 1), max: Math.max(MAX_SCALE, widthScale(image, box), fit) };
}

/** The scale each mode shows: just what it says, enlarging a small image
 * too when asked. */
export function modeScale(mode: Exclude<Mode, "free">, image: Size, box: Size): number {
  if (mode === "actual") return 1;
  return mode === "width" ? widthScale(image, box) : fitScale(image, box);
}

/**
 * How an image opens. A tall image, whose height to width is more than
 * twice the stage's, opens as wide as the stage from its top, where it can
 * be read; any other image opens whole and centred. Either way, a mode that
 * would enlarge the image opens at its actual size instead.
 */
export function opening(image: Size, box: Size): { mode: Exclude<Mode, "free">; view: View } {
  const tall = usable(image) && usable(box) && image.height / image.width > (2 * box.height) / box.width;
  const mode = tall ? "width" : "fit";
  const scale = modeScale(mode, image, box);
  // y at 0 is the image's first row at the stage's top; place() centres
  // whatever is smaller than the stage.
  return scale > 1
    ? { mode: "actual", view: place({ scale: 1, x: 0, y: 0 }, image, box) }
    : { mode, view: place({ scale, x: 0, y: 0 }, image, box) };
}

/**
 * The view kept inside its bounds. Along each side, an image smaller than
 * the stage is centred; a larger one cannot be moved so far that the stage
 * shows past its edge.
 */
export function place(view: View, image: Size, box: Size): View {
  const axis = (at: number, shown: number, room: number) =>
    shown <= room ? (room - shown) / 2 : Math.min(0, Math.max(room - shown, at));
  return {
    scale: view.scale,
    x: axis(view.x, image.width * view.scale, box.width),
    y: axis(view.y, image.height * view.scale, box.height),
  };
}

/** Zoomed to `scale` (kept within bounds) with the image's point under
 * `at` staying under it, as far as the edges allow. */
export function zoomTo(view: View, scale: number, at: Point, image: Size, box: Size): View {
  const { min, max } = bounds(image, box);
  const next = Math.min(max, Math.max(min, scale));
  if (!(view.scale > 0)) return place({ scale: next, x: 0, y: 0 }, image, box);
  const u = (at.x - view.x) / view.scale;
  const v = (at.y - view.y) / view.scale;
  return place({ scale: next, x: at.x - u * next, y: at.y - v * next }, image, box);
}

/**
 * The view after the stage changed size: a mode is kept (Fit still shows
 * the whole image), a free zoom keeps its scale within the new bounds, and
 * the point at the middle stays in the middle.
 */
export function resized(view: View, mode: Mode, image: Size, before: Size, after: Size): View {
  const { min, max } = bounds(image, after);
  const scale = mode === "free" ? Math.min(max, Math.max(min, view.scale)) : modeScale(mode, image, after);
  if (!(view.scale > 0)) return place({ scale, x: 0, y: 0 }, image, after);
  const u = (before.width / 2 - view.x) / view.scale;
  const v = (before.height / 2 - view.y) / view.scale;
  return place({ scale, x: after.width / 2 - u * scale, y: after.height / 2 - v * scale }, image, after);
}

/** Moved by (dx, dy) stage pixels, kept within bounds. */
export function pan(view: View, dx: number, dy: number, image: Size, box: Size): View {
  return place({ ...view, x: view.x + dx, y: view.y + dy }, image, box);
}

/**
 * A wheel's turn as a zoom factor, following its delta so a trackpad's
 * stream of small deltas zooms smoothly: a mouse wheel's notch (about
 * 100 px) is about one step. A trackpad pinch, which browsers send as a
 * wheel with Ctrl held and much smaller deltas, zooms as the fingers move.
 * Lines and pages are counted in pixels first. One event never more than
 * doubles or halves, so a fast spin stays under control.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean, page = 800): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * page : deltaY;
  const factor = Math.exp(-pixels * (pinch ? 0.01 : 0.0015));
  return Math.min(2, Math.max(0.5, factor));
}

/**
 * Where the stage's position bar sits along one side: the share of the
 * image in view, and how far along it the view is, both 0–1. Null when the
 * whole side is in view and there is nothing to move to.
 */
export function track(at: number, shown: number, room: number): { size: number; start: number } | null {
  if (!(shown > room + 0.5) || !(room > 0)) return null;
  const size = room / shown;
  return { size, start: Math.min(1 - size, Math.max(0, -at / shown)) };
}

/** The scale as a whole percentage of the image's own size. */
export const percent = (scale: number) => `${Math.round(scale * 100)}%`;

/** Whether two views show the same thing, to within a pixel's rounding. */
export const same = (a: View, b: View) =>
  Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
