// How an image sits in its viewer (T-20): the scale and where its top-left
// corner is, in the viewer's own pixels. A point of the image at (u, v) is
// shown at (x + scale·u, y + scale·v). Only what is shown changes here; the
// image's own pixels, and so Point & Fix's coordinates, never do.

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type View = { scale: number; x: number; y: number };
/** Fit: the whole image. Width: as wide as the viewer. Actual: one image
 * pixel to one CSS pixel. Free: as the person zoomed it. */
export type Mode = "fit" | "width" | "actual" | "free";

/** The closest the viewer goes: eight times the image's own size, or as
 * wide as the viewer if that is more. */
export const MAX_SCALE = 8;
/** One step of + and −, and of the keys. */
export const STEP = 1.25;

const usable = (size: Size) => size.width > 0 && size.height > 0;

/** The scale at which the whole image fits, enlarged too. */
export function fitScale(image: Size, box: Size): number {
  if (!usable(image) || !usable(box)) return 1;
  return Math.min(box.width / image.width, box.height / image.height);
}

/** The scale at which the image is as wide as the viewer. */
export function widthScale(image: Size, box: Size): number {
  if (!usable(image) || !usable(box)) return 1;
  return box.width / image.width;
}

/** How far out and in this image can be zoomed in this viewer: out to the
 * whole image (or its own size, if that is smaller), in to MAX_SCALE (or the
 * viewer's width, if that is closer still). */
export function bounds(image: Size, box: Size): { min: number; max: number } {
  const fit = fitScale(image, box);
  return { min: Math.min(fit, 1), max: Math.max(MAX_SCALE, widthScale(image, box), fit) };
}

/** The scale a mode shows. Fit never enlarges a small image; Fit width
 * always fills the width, as asked. */
export function modeScale(mode: Exclude<Mode, "free">, image: Size, box: Size): number {
  if (mode === "actual") return 1;
  if (mode === "width") return widthScale(image, box);
  return Math.min(fitScale(image, box), 1);
}

/**
 * How an image opens. The whole of it, never enlarged; but a long image,
 * one that fitting would shrink to less than half the viewer's width, opens
 * as wide as the viewer (never enlarged) from its top, where it can be read.
 */
export function opening(image: Size, box: Size): { mode: Exclude<Mode, "free">; view: View } {
  const fit = Math.min(fitScale(image, box), 1);
  const long = usable(image) && usable(box) && fit < 1 && image.width * fit < box.width / 2;
  if (!long) return { mode: "fit", view: place({ scale: fit, x: 0, y: 0 }, image, box) };
  // Narrower than the viewer, it opens at its own size; otherwise as wide as
  // the viewer. Either way y at 0: its first row at the viewer's top.
  const narrow = widthScale(image, box) > 1;
  return { mode: narrow ? "actual" : "width", view: place({ scale: narrow ? 1 : widthScale(image, box), x: 0, y: 0 }, image, box) };
}

/**
 * The view kept inside its bounds. Along each side, an image smaller than
 * the viewer is centred; a larger one cannot be moved so far that the
 * viewer shows past its edge.
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
 * `at` staying under it. */
export function zoomTo(view: View, scale: number, at: Point, image: Size, box: Size): View {
  const { min, max } = bounds(image, box);
  const next = Math.min(max, Math.max(min, scale));
  if (!(view.scale > 0)) return place({ scale: next, x: 0, y: 0 }, image, box);
  const u = (at.x - view.x) / view.scale;
  const v = (at.y - view.y) / view.scale;
  return place({ scale: next, x: at.x - u * next, y: at.y - v * next }, image, box);
}

/**
 * The view after the viewer changed size: a chosen mode is kept (Fit still
 * shows the whole image), a free zoom keeps its scale within the new bounds,
 * and the point at the middle stays in the middle.
 */
export function resized(view: View, mode: Mode, image: Size, before: Size, after: Size): View {
  const { min, max } = bounds(image, after);
  const scale = mode === "free" ? Math.min(max, Math.max(min, view.scale)) : modeScale(mode, image, after);
  if (!(view.scale > 0)) return place({ scale, x: 0, y: 0 }, image, after);
  const u = (before.width / 2 - view.x) / view.scale;
  const v = (before.height / 2 - view.y) / view.scale;
  return place({ scale, x: after.width / 2 - u * scale, y: after.height / 2 - v * scale }, image, after);
}

/** Moved by (dx, dy) viewer pixels, kept within bounds. */
export function pan(view: View, dx: number, dy: number, image: Size, box: Size): View {
  return place({ ...view, x: view.x + dx, y: view.y + dy }, image, box);
}

/**
 * A wheel's turn as a zoom factor: a notch of a mouse wheel (about 100 px)
 * is about one step; a trackpad's pinch, which browsers send as a wheel with
 * Ctrl held and small deltas, zooms as fast as the fingers move. Lines and
 * pages are counted in pixels first. One event never more than doubles or
 * halves, so a fast spin stays under control.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean, page = 800): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * page : deltaY;
  const factor = Math.exp(-pixels * (pinch ? 0.01 : 0.0022));
  return Math.min(2, Math.max(0.5, factor));
}

/** The scale as a whole percentage of the image's own size. */
export const percent = (scale: number) => `${Math.round(scale * 100)}%`;

/** Whether two views show the same thing, to within a pixel's rounding. */
export const same = (a: View, b: View) =>
  Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
