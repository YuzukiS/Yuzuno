import { firstParagraph } from "./card-summary.ts";
import { summaryOf } from "./report/report-model.ts";
import type { Section } from "./types";

type Node = { type?: string; props?: Record<string, unknown>; children?: string[] };
type Body = { root?: unknown; elements?: Record<string, Node> } | null | undefined;

const CHARTS = new Set(["LineChart", "BarChart", "ScatterChart"]);
/** Rows and columns a table shows on a card (Dev 7, T-18). */
export const TABLE_PREVIEW = { rows: 3, columns: 3 } as const;

/**
 * The one figure a card shows in its frame, bounded (T-18): never the
 * whole block, always read from the block itself.
 * - `block`: a chart or Metrics, drawn by its own renderer, small.
 * - `table`: its first rows and columns, with how many there are.
 * - `image`: one image attachment, fitted whole.
 * - `desk`: a research desk's question and how many claims and plots it
 *   has; no claim, whose strength and conditions it would leave behind.
 */
export type CardFigure =
  | { kind: "block"; id: string }
  | { kind: "table"; id: string; title: string; columns: { key: string; label: string }[]; rows: { id: string; cells: Record<string, unknown> }[]; totalRows: number; totalColumns: number }
  | { kind: "image"; id: string; name: string; caption: string | null }
  | { kind: "desk"; id: string; title: string; claims: number; plots: number };

/**
 * What a report or status card says on Home (T-18, Lead 2270): only a
 * summary; the whole body is read on the report page.
 * - `named`: the author named the summary. Its lead's first paragraph, the
 *   conditions it holds under (the block, shown with it), its figure.
 * - `unnamed`: the author named none. The card shows no paragraph or figure
 *   of its own choosing (Lead 2292): a conclusion taken from the body could
 *   leave behind the conditions it holds under. Its title and page say the rest.
 */
export type CardContent =
  | { kind: "named"; lead: string | null; conditions: string | null; figure: CardFigure | null; size: CardSize | null }
  | { kind: "unnamed" };

function tree(section: Section) {
  const body = section.body as Body;
  const elements = body?.elements;
  if (!elements || typeof body?.root !== "string") return null;
  return { elements, top: elements[body.root]?.children ?? [] };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A block as the card's bounded figure, or null when it is none of those a card shows. */
export function figureOf(section: Section, id: string): CardFigure | null {
  const node = tree(section)?.elements[id];
  if (!node) return null;
  const props = node.props ?? {};
  if (CHARTS.has(node.type ?? "") || node.type === "Metrics") return { kind: "block", id };
  if (node.type === "Table") {
    const columns = (Array.isArray(props.columns) ? props.columns : []) as { key: string; label: string }[];
    const rows = (Array.isArray(props.rows) ? props.rows : []) as { id: string; cells: Record<string, unknown> }[];
    return {
      kind: "table", id, title: text(props.title),
      columns: columns.slice(0, TABLE_PREVIEW.columns), rows: rows.slice(0, TABLE_PREVIEW.rows),
      totalRows: rows.length, totalColumns: columns.length,
    };
  }
  if (node.type === "Attachments") {
    const items = (Array.isArray(props.items) ? props.items : []) as { name?: unknown; caption?: unknown }[];
    const name = text(items[0]?.name);
    const file = section.attachments?.find((attachment) => attachment.name === name);
    if (items.length !== 1 || file?.kind !== "image") return null;
    return { kind: "image", id, name, caption: text(items[0].caption) || file.caption || null };
  }
  if (node.type === "ResearchDesk") {
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    return { kind: "desk", id, title: text(props.title), claims: count(props.claims), plots: count(props.plots) };
  }
  return null;
}

/**
 * A card's size on Home's deck, as iOS widgets have (T-18, Lead 2377;
 * Dev 7's v12):
 * - `small`: one column and one row;
 * - `wide`: two columns, one row;
 * - `large`: two columns, two rows.
 *
 * The author names it, with the summary (`summary.size`, Lead 2457): a card
 * is the size its author gave it (`cardSize`). Only a card kept from before
 * sizes were named has its size from the figure the author named, never how
 * long the text is, nor any live value, so a refresh lays out the same:
 * - a figure that needs width (a table, a line or bar chart, Metrics with
 *   more values than a small card holds, a research desk) is wide;
 * - one that needs area (an image, a scatter chart) is large;
 * - no figure, or no summary named, is small.
 * The card grows to fit its conditions, so no size cuts them. Only a card
 * pinned to the user's widgets takes the user's size (`shownSize`).
 */
export type CardSize = "small" | "wide" | "large";
export const CARD_SIZES: readonly CardSize[] = ["small", "wide", "large"];
/** Metrics with at most this many values stay small. */
export const SMALL_METRICS = 2;

/** Where a card's own size comes from: its author, or (kept from before sizes were named) its figure. */
export const sizeSource = (content: CardContent) => (content.kind === "named" && content.size ? "author" : "content");

/**
 * The size a card is shown at, and why: on the user's widgets, the user's
 * choice where they made one; else the card's own (`hold`, where given, keeps
 * the one already shown in this visit to Home).
 */
export function shownSize(section: Section, content: CardContent, chosen: CardSize | null | undefined, hold?: (size: CardSize) => CardSize) {
  const computed = cardSize(section, content);
  const own = hold ? hold(computed) : computed;
  if (chosen) return { size: chosen, source: "user" as const, own };
  return { size: own, source: sizeSource(content), own };
}

export function cardSize(section: Section, content: CardContent = cardContent(section)): CardSize {
  if (content.kind === "unnamed") return "small";
  if (content.size) return content.size;
  if (!content.figure) return "small";
  const figure = content.figure;
  if (figure.kind === "image") return "large";
  if (figure.kind === "block") {
    const node = tree(section)?.elements[figure.id];
    if (node?.type === "ScatterChart") return "large";
    if (node?.type === "Metrics") {
      const items = node.props?.items;
      return (Array.isArray(items) ? items.length : 0) <= SMALL_METRICS ? "small" : "wide";
    }
  }
  return "wide";
}

export function cardContent(section: Section): CardContent {
  const body = tree(section);
  const named = summaryOf(section);
  if (body && named) {
    const lead = text(body.elements[named.lead]?.props?.text);
    return {
      kind: "named",
      lead: lead ? firstParagraph(lead) : null,
      conditions: named.conditions,
      figure: named.visual ? figureOf(section, named.visual) : null,
      size: named.size,
    };
  }
  return { kind: "unnamed" };
}
