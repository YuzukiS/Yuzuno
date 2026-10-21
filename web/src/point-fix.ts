import { createContext, useContext } from "react";

/**
 * Point & Fix (T-167): areas marked on an image, each with a note, kept in
 * the image's own pixels. The shown image may be zoomed or drawn at any
 * device pixel ratio; an area stays on the same pixels of the original.
 */
export interface Region {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
}
export interface Size {
  width: number;
  height: number;
}

export const MAX_REGIONS = 20;
export const MAX_NOTE = 1000;
/** Smaller drags are taken as clicks, not areas. */
export const MIN_SIDE = 4;
/** Core keeps input images within 8192 px per side and 24 megapixels. */
const MAX_SIDE = 8192;
const MAX_PIXELS = 24_000_000;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The area kept inside the image, on whole pixels, with a bounded note. */
export function clampRegion(region: Region, size: Size): Region {
  const x = clamp(Math.round(region.x) || 0, 0, size.width - 1);
  const y = clamp(Math.round(region.y) || 0, 0, size.height - 1);
  return {
    ...region,
    x,
    y,
    width: clamp(Math.round(region.width) || 1, 1, size.width - x),
    height: clamp(Math.round(region.height) || 1, 1, size.height - y),
    note: region.note.slice(0, MAX_NOTE),
  };
}

/** Where a point on the shown image falls on the original, or null off it. */
export function imagePoint(
  client: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  size: Size,
) {
  if (box.width <= 0 || box.height <= 0) return null;
  return {
    x: clamp(((client.x - box.left) / box.width) * size.width, 0, size.width),
    y: clamp(((client.y - box.top) / box.height) * size.height, 0, size.height),
  };
}

/** The area two points span, or null when it is too small to be one. */
export function spanRegion(id: number, a: { x: number; y: number }, b: { x: number; y: number }, size: Size): Region | null {
  const width = Math.abs(a.x - b.x), height = Math.abs(a.y - b.y);
  if (width < MIN_SIDE || height < MIN_SIDE) return null;
  return clampRegion({ id, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height, note: "" }, size);
}

/** A new area for those who mark without a pointer: the middle quarter. */
export function centeredRegion(id: number, size: Size): Region {
  const width = Math.max(MIN_SIDE, Math.round(size.width / 4));
  const height = Math.max(MIN_SIDE, Math.round(size.height / 4));
  return clampRegion({ id, x: (size.width - width) / 2, y: (size.height - height) / 2, width, height, note: "" }, size);
}

/** How much the annotated image is reduced to stay within Core's limits. */
export function outputScale(size: Size) {
  return Math.min(1, MAX_SIDE / size.width, MAX_SIDE / size.height, Math.sqrt(MAX_PIXELS / (size.width * size.height)));
}

/**
 * The text added to the draft with the annotated image: where the image came
 * from, apart from what the user says about each area.
 */
export function feedbackText({ name, provenance, regions, size, original, annotated = size }: {
  name: string;
  provenance: string;
  regions: readonly Region[];
  size: Size;
  /** Attached with it, already in the same draft at that place (from 1), or neither. */
  original: boolean | { position: number };
  /** The annotated image's own size, when it had to be reduced. */
  annotated?: Size;
}) {
  const areas = `${regions.length} marked area${regions.length === 1 ? "" : "s"}`;
  const reduced = annotated.width !== size.width || annotated.height !== size.height;
  return [
    `Point & Fix feedback on “${name}” (${size.width}×${size.height} px): ${areas} in the attached annotated image${typeof original === "object" ? `; the original is attached image ${original.position} (“${name}”)` : original ? ", with the original image attached" : ""}.`,
    `Source: ${provenance}`,
    ...(reduced
      ? [`The annotated image is reduced to ${annotated.width}×${annotated.height} px; the areas below are in the original’s ${size.width}×${size.height} pixels.`]
      : []),
    "",
    ...regions.map((region, index) =>
      `${index + 1}. Area at x ${region.x}, y ${region.y}, ${region.width}×${region.height} px: ${region.note.trim() || "(no comment)"}`),
  ].join("\n");
}

/** An image to mark: one the user may already read here, or chose. */
export interface PointFixSource {
  name: string;
  /** Whose work it is: offered first as the Agent to tell. */
  ownerId: string | null;
  /** Where the original is, for the Agent: a path, a message link. */
  provenance: string;
  /** The original's bytes, read without changing it. */
  load(signal: AbortSignal): Promise<Blob>;
  /** The original is already an image in this Agent's draft (pasted or
   * attached there): marking it up never adds it to that draft again. */
  inDraft?: { agentId: string; id: string };
}
export const PointFixOpen = createContext<((source: PointFixSource) => void) | null>(null);
export const usePointFix = () => useContext(PointFixOpen);
