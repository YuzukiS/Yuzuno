import { htmlFile } from "../portal/html-file.ts";
import { firstParagraph, sectionSummary } from "./card-summary.ts";
import { summaryOf } from "./report/report-model.ts";
import type { Section, SectionAttachment } from "./types";

type Node = { type?: string; props?: Record<string, unknown>; children?: string[] };
type Body = { root?: unknown; elements?: Record<string, Node> } | null | undefined;

const CHARTS = new Set(["LineChart", "BarChart", "ScatterChart"]);
/** Rows and columns a table shows on a card, and on a large one (Dev 7, T-18; 2547). */
export const TABLE_PREVIEW = { rows: 3, columns: 3 } as const;
export const LARGE_TABLE_PREVIEW = { rows: 8, columns: 6 } as const;
/** Metrics values a large card shows in its frame (Dev 7, 2547); the page shows them all. */
export const LARGE_METRICS = 6;

/**
 * The one figure a card shows in its frame, bounded (T-18): never the
 * whole block, always read from the block itself.
 * - `block`: a chart or Metrics, drawn by its own renderer, small.
 * - `table`: its rows and columns, of which a card shows the first few
 *   (more on a large card), with how many there are.
 * - `image`: one image attachment, fitted whole: its snapshot when Core keeps
 *   one (`kept`, taken at `takenAt`), else only named, as referenced, with
 *   nothing to load.
 * - `desk`: a research desk's question and how many claims and plots it
 *   has; no claim, whose strength and conditions it would leave behind.
 * - `page`: one single-file HTML page Core keeps (YN-3), shown working on
 *   the card, sandboxed as the Portal shows it (CardPage.tsx).
 */
export type CardFigure =
  | { kind: "block"; id: string }
  | { kind: "table"; id: string; title: string; columns: { key: string; label: string }[]; rows: { id: string; cells: Record<string, unknown> }[]; totalRows: number; totalColumns: number }
  | { kind: "image"; id: string; name: string; caption: string | null; kept: boolean; takenAt: string | null }
  | { kind: "desk"; id: string; title: string; claims: number; plots: number }
  | { kind: "page"; id: string; name: string; size: number; caption: string | null; takenAt: string | null };

/** A file the body shows besides the card's picture, as a card names it (YN-3): a kept image, a page, or another file. */
export type CardFile = { name: string; kind: "image" | "page" | "file"; kept: boolean };
/** Files a card names beside its picture; past these, "+n more". */
export const CARD_FILES = 3;

/**
 * What a report or status card says on Home (T-18, Lead 2270): only a
 * summary; the whole body is read on the report page.
 * - `named`: the author named the summary. Its lead's first paragraph, the
 *   conditions it holds under (the block, shown with it), its figure.
 * - `unnamed`: the author named none. The card shows how its body opens, as
 *   a folded card does (sectionSummary): its first paragraph, verbatim; or,
 *   when the body opens with a figure a card can show instead, that block,
 *   as a small card shows figures. With neither, its title says it alone.
 *   The user asked for this (YN-3), in place of Lead 2292's "nothing taken
 *   from the body": its page has the conditions the opening may leave out.
 */
export type CardContent =
  | { kind: "named"; lead: string | null; conditions: string | null; figure: CardFigure | null; size: CardSize | null; files: CardFile[] }
  | { kind: "unnamed"; lead: string | null; figure: CardFigure | null; files: CardFile[] };

function tree(section: Section) {
  const body = section.body as Body;
  const elements = body?.elements;
  if (!elements || typeof body?.root !== "string") return null;
  return { elements, top: elements[body.root]?.children ?? [] };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

type Shown = { block: string; name: string; caption: string | null; file: SectionAttachment | undefined };

/** The files the body's Attachments blocks show, wherever they are in it, in its order; each once. */
function shownFiles(section: Section): Shown[] {
  const body = tree(section);
  if (!body) return [];
  const shown: Shown[] = [];
  const visited = new Set<string>();
  const names = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = body.elements[id];
    if (!node) return;
    if (node.type === "Attachments") {
      const items = (Array.isArray(node.props?.items) ? node.props.items : []) as { name?: unknown; caption?: unknown }[];
      for (const item of items) {
        const name = text(item.name);
        if (!name || names.has(name)) continue;
        names.add(name);
        shown.push({ block: id, name, caption: text(item.caption) || null, file: section.attachments?.find((file) => file.name === name) });
      }
    }
    (node.children ?? []).forEach(walk);
  };
  body.top.forEach(walk);
  return shown;
}

/** A shown file a card can take as its picture: a kept image, or a kept single HTML page (YN-3). */
function filePicture({ block, name, caption, file }: Shown): CardFigure | null {
  if (!file?.snapshot) return null;
  if (file.kind === "image") return { kind: "image", id: block, name, caption: caption || file.caption || null, kept: true, takenAt: file.takenAt ?? null };
  if (file.kind !== "link" && htmlFile(name)) return { kind: "page", id: block, name, size: file.size, caption: caption || file.caption || null, takenAt: file.takenAt ?? null };
  return null;
}

const fileKind = (shown: Shown): CardFile["kind"] =>
  shown.file?.kind === "image" ? "image" : shown.file && shown.file.kind !== "link" && htmlFile(shown.name) ? "page" : "file";

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
      columns: columns.slice(0, LARGE_TABLE_PREVIEW.columns), rows: rows.slice(0, LARGE_TABLE_PREVIEW.rows),
      totalRows: rows.length, totalColumns: columns.length,
    };
  }
  if (node.type === "Attachments") {
    const items = (Array.isArray(props.items) ? props.items : []) as { name?: unknown; caption?: unknown }[];
    const name = text(items[0]?.name);
    const file = section.attachments?.find((attachment) => attachment.name === name);
    if (items.length !== 1 || file?.kind !== "image") return null;
    // A referenced image (not kept: too large, or never copied) has no snapshot to ask Core for (AttachmentView.tsx).
    return { kind: "image", id, name, caption: text(items[0].caption) || file.caption || null, kept: file.snapshot === true, takenAt: file.takenAt ?? null };
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
  // A card sizes to its picture where its author named no size, as one named without a size does (YN-3).
  if (content.kind === "named" && content.size) return content.size;
  if (!content.figure) return "small";
  const figure = content.figure;
  // A picture needs area: an image, a page shown working (YN-3).
  if (figure.kind === "image" || figure.kind === "page") return "large";
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

/**
 * A card's picture, the first that applies (YN-3, YN-7 comment 6144): the
 * author's named visual; else the first kept image or kept single HTML page
 * the body shows; else, for a body with no summary named that opens with no
 * paragraph, its first figure; else none. The body's other files are named
 * beside it (`files`).
 */
export function cardContent(section: Section): CardContent {
  const body = tree(section);
  const named = summaryOf(section);
  const shown = shownFiles(section);
  const firstFile = () => {
    for (const file of shown) {
      const picture = filePicture(file);
      if (picture) return picture;
    }
    return null;
  };
  const others = (figure: CardFigure | null): CardFile[] => {
    const own = figure && (figure.kind === "image" || figure.kind === "page") ? figure.name : null;
    return shown.filter((file) => file.name !== own).map((file) => ({ name: file.name, kind: fileKind(file), kept: file.file?.snapshot === true }));
  };
  if (body && named) {
    const lead = text(body.elements[named.lead]?.props?.text);
    const figure = named.visual ? figureOf(section, named.visual) : firstFile();
    return {
      kind: "named",
      lead: lead ? firstParagraph(lead) : null,
      conditions: named.conditions,
      figure,
      size: named.size,
      files: others(figure),
    };
  }
  const lead = sectionSummary(section);
  const first = body?.top[0];
  const figure = firstFile() ?? (lead === null && first !== undefined ? figureOf(section, first) : null);
  return { kind: "unnamed", lead, figure, files: others(figure) };
}

/**
 * Whether a report's card is the whole report (YN-3, the user's rule of
 * 02:59Z): its body holds nothing beyond what the card shows. Every block of
 * the body is the card's own (the lead, one paragraph shown whole; the
 * picture, drawn whole; the conditions, all shown on asking) or an
 * Attachments block whose every file the card shows or names; no Sources, no
 * other block. Then the card has no way to a report page, which would show
 * only the same; the page itself stays at its address.
 */
export function selfContained(section: Section, content: CardContent = cardContent(section)): boolean {
  if (section.kind !== "report" || section.ask) return false;
  const body = tree(section);
  if (!body || content.files.length > CARD_FILES) return false;
  const files = (id: string) => body.elements[id]?.type === "Attachments";
  // Drawn whole on the card: an image, a page, a chart; a table or Metrics show only part of theirs.
  const whole = (figure: CardFigure | null) =>
    figure === null || figure.kind === "image" || figure.kind === "page" || (figure.kind === "block" && CHARTS.has(body.elements[figure.id]?.type ?? ""));
  const oneParagraph = (id: string | null | undefined) => {
    const value = id ? text(body.elements[id]?.props?.text).trim() : "";
    return value !== "" && firstParagraph(value) === value;
  };
  if (!whole(content.figure)) return false;
  if (content.kind === "named") {
    const named = summaryOf(section);
    if (!named || !oneParagraph(named.lead)) return false;
    const own = new Set([named.lead, named.visual, named.conditions].filter((id): id is string => !!id));
    return body.top.every((id) => own.has(id) || files(id));
  }
  // No summary named: one paragraph, or one figure, and the files.
  const rest = body.top.filter((id) => !files(id));
  if (rest.length === 0) return content.figure !== null;
  if (rest.length !== 1) return false;
  return (body.elements[rest[0]]?.type === "Markdown" && oneParagraph(rest[0])) || content.figure?.id === rest[0];
}
