/**
 * What a Project Brief section body may contain, as the renderer reads it.
 *
 * A body is a json-render spec, `{ root, elements }`, whose root is a
 * BriefBody. Core keeps a body only after the brief contract
 * (intelligent-ui/brief-contract.ts) has accepted it, so the props here are
 * the contract's own types, already checked. They are imported as types
 * only: the renderer does not carry the contract's schemas and guide text.
 */
import type { z } from "zod";
import { API_BASE } from "../../api";
import { timeFormatter, type TimeDisplay } from "../../time-preferences";
import type { briefComponentProps, BriefComponent } from "../../intelligent-ui/brief-contract.ts";

type Props<K extends BriefComponent> = z.infer<(typeof briefComponentProps)[K]>;
export type ChartProps = Props<"LineChart"> | Props<"BarChart"> | Props<"ScatterChart">;
export type Axis = ChartProps["x"];
/** A point as drawn: x may be a category (a string); a null y is a gap. */
export type Point = [number | string, number | null];
export type Series = { name: string; points: Point[] };
export type GroupProps = Props<"Group">;
export type ColumnsProps = Props<"Columns">;
export type MarkdownProps = Props<"Markdown">;
export type MathProps = Props<"Math">;
export type ChecklistProps = Props<"Checklist">;
export type PlanProps = Props<"Plan">;
export type PlanState = PlanProps["steps"][number]["state"];
export type FindingsProps = Props<"Findings">;
export type Severity = FindingsProps["items"][number]["severity"];
export type MetricsProps = Props<"Metrics">;
export type LiveRefsProps = Props<"LiveRefs">;
export type LiveRef = LiveRefsProps["items"][number];
export type LiveRefKind = LiveRef["kind"];
export type AttachmentsProps = Props<"Attachments">;
export type SourcesProps = Props<"Sources">;
export type BriefTableProps = Props<"Table">;
export type ResearchDeskProps = Props<"ResearchDesk">;

export type BriefElement = {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
};
export type BriefSpec = { root: string; elements: Record<string, BriefElement> };

/** Every component a body may use; anything else is shown as a part that couldn't be displayed. */
export const BRIEF_COMPONENTS = [
  "BriefBody",
  "Group",
  "Columns",
  "Markdown",
  "Math",
  "Checklist",
  "Plan",
  "Findings",
  "Metrics",
  "Table",
  "LineChart",
  "BarChart",
  "ScatterChart",
  "LiveRefs",
  "Attachments",
  "Sources",
  "ResearchDesk",
] as const satisfies readonly BriefComponent[];
export const CHART_TYPES = new Set(["LineChart", "BarChart", "ScatterChart"]);

/**
 * The shape of a body, the least the renderer needs before it draws one.
 * Core has already applied the full contract; this only keeps a malformed
 * stored body from reaching the renderer.
 */
export function isBriefSpec(value: unknown): value is BriefSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const spec = value as Partial<BriefSpec>;
  if (typeof spec.root !== "string" || !spec.elements || typeof spec.elements !== "object")
    return false;
  const root = Object.hasOwn(spec.elements, spec.root) ? spec.elements[spec.root] : undefined;
  return root?.type === "BriefBody";
}

/**
 * GET /api/projects/{id}/brief/chart/{section}/{elementId}: one chart's data
 * read from its snapshot data attachment, downsampled by Core to at most
 * 5000 points per series and 12 series. `elementId` is the chart's key in
 * the body's `elements`. `sourcePoints` counts the points before
 * downsampling, over all series.
 */
export type ChartData = {
  series: Series[];
  x?: Axis;
  y?: Axis;
  downsampled: boolean;
  sourcePoints: number;
};
export const MAX_SERIES = 12;
export const MAX_SERIES_POINTS = 5000;

// Path segments are encoded one by one: a section key `topic/sub` travels as
// one segment (`topic%2Fsub`), never as two. Every read names the version
// shown: a history entry and a newer live section can share a key, and
// Core would otherwise answer with the live one.
const segment = encodeURIComponent;
/** For `api()`, which adds `${API_BASE}/api` itself. */
export const chartPath = (projectId: string, sectionKey: string, elementId: string, version: number) =>
  `/projects/${segment(projectId)}/brief/chart/${segment(sectionKey)}/${segment(elementId)}?version=${version}`;
/** One research desk's numbers read from its section version's snapshots (T-9). */
export const researchPath = (projectId: string, sectionKey: string, elementId: string, version: number) =>
  `/projects/${segment(projectId)}/brief/research/${segment(sectionKey)}/${segment(elementId)}?version=${version}`;
/** A snapshot's bytes, always from this Core; never an external URL. */
export const attachmentUrl = (projectId: string, sectionKey: string, name: string, version: number) =>
  `${API_BASE}/api/projects/${segment(projectId)}/brief/attachments/${segment(sectionKey)}/${segment(name)}?version=${version}`;

const decimals = (value: number) => {
  const [mantissa, exponent] = String(value).split(/e/i);
  const places = (mantissa.split(".")[1] || "").length - Number(exponent || 0);
  return Math.max(0, places);
};
/**
 * A metric's change from its previous version, when both values are
 * numbers: the sign, and the signed difference at the precision the values
 * were written with (0.93 − 0.91 is +0.02, not +0.020000000000000018).
 */
export function metricDelta(
  value: unknown,
  previous: unknown,
): { sign: -1 | 0 | 1; text: string } | null {
  if (
    typeof value !== "number" ||
    typeof previous !== "number" ||
    !Number.isFinite(value) ||
    !Number.isFinite(previous)
  )
    return null;
  const places = Math.min(12, Math.max(decimals(value), decimals(previous)));
  const difference = Number((value - previous).toFixed(places));
  const sign = difference > 0 ? 1 : difference < 0 ? -1 : 0;
  const magnitude = Math.abs(difference).toFixed(places);
  return { sign, text: sign === 0 ? "±0" : `${sign > 0 ? "+" : "−"}${magnitude}` };
}

const when = timeFormatter({ dateStyle: "medium", timeStyle: "short" });
/** A Core timestamp for display, with this device's clock format and time
 * zone; an unreadable one is shown as written. */
export function formatTime(iso: string, time: TimeDisplay): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? when(time).format(new Date(at)) : iso;
}
