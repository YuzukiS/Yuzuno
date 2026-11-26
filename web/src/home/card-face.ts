import {
  CARD_FILES, CARD_LINES, cardContent, cardSize, LARGE_METRICS, LARGE_TABLE_PREVIEW, MORE_METRICS, selfContained,
  sizeSource, TABLE_PREVIEW, type CardContent, type CardFigure, type CardSize,
} from "./card-preview.ts";
import { firstParagraph, summaryBlock } from "./card-summary.ts";
import { summaryOf } from "./report/report-model.ts";
import type { Section } from "./types";

/**
 * What a report or status card shows on Home, told to the Agent that wrote it
 * (YN-209): Core asks Home's validator for it after brief_update checks a
 * section, and puts it in the answer. Read with Home's own rules, on the
 * section as Core keeps it (its normalized body, its attachments as Core took
 * them), so it is what SummaryCard draws:
 * - exact: which paragraph leads, which visual or fallback file is the
 *   picture, what a size draws of it (a table's rows and columns, Metrics
 *   values), the files named, Open report, the blocks left to the page;
 * - for two reference layouts (`FACE_REFERENCE`), `estimate`: lines, where
 *   the clamp cuts the lead, what fits fully or partly in the frame, height.
 *   From font metrics and Home's CSS (`FACE_CSS`), never a browser: another
 *   font, text size, a size the reader chose or a deck that widens or
 *   stretches a card changes them (card-face-check.mjs compares both with
 *   Chromium).
 * Never a check: it refuses, repairs and changes nothing.
 */

/** Bounds of one face, in code points or entries. */
export const FACE_LIMITS = { text: 120, tail: 40, name: 40, notOnCard: 6 } as const;

/** The two layouts a face describes: Home's project page at the default text size. */
export const FACE_REFERENCE = {
  /** A 1440 × 1000 window, the rail open: the page's deck is 1116 px (measured in Job eaa30fdd; card-face-check.mjs asserts it). */
  wide: { window: 1440, deck: 1116 },
  /** A 390 px phone: Home's 10 px either side (home.css, max-width 520px), touch-sized buttons. */
  phone: { window: 390, deck: 370 },
} as const;
export type FaceWidth = keyof typeof FACE_REFERENCE;

/**
 * Home's CSS a face reads, in px at the default text size (font-adjust 3px, a 16 px rem);
 * card-face.test.mjs finds each in summary-card.css, home.css or brief.css. `normal`: a line box of
 * `line-height: normal` per px of font, from the fonts' own metrics (hhea ascender + descender + gap):
 * Liberation Sans 1.149, Noto Sans SC (Yuzuno Han) 1.448, the taller wherever the line holds CJK.
 * `measured`: boxes the CSS sets only through fonts, as card-face-check.mjs measured them in Chromium
 * (Job 77eb1de5): the conditions label, a condition chip, a table row and head, the two numbers of a
 * small card, the files row, and Metrics' "more" button with its gap.
 */
export const FACE_CSS = {
  deck: { gap: 16, breaks: [560, 932, 1248], minHeight: 260 },
  card: { padX: 16, padY: 14, border: 1, gap: 8, head: 28, touchHead: 44, footPad: 4, open: 32, byline: 9 + 3 },
  title: { font: 13.5 + 3, line: 1.35 },
  lead: { font: 11 + 3, line: 1.6 },
  beside: { gap: 16 },
  frame: { wide: 140, large: 200, deckLarge: 260, padX: 10, padY: 8, chart: 125 + 9 * 3, captionGap: 4, caption: 8.5 + 3 },
  table: { font: 9 + 3, padX: 6, maxEm: 10 },
  conditions: { margin: 6, padX: 10, padY: 6, border: 1, font: 9 + 3, chipPadX: 9, chipBorder: 1, chipIcon: 12 + 4, chipGap: 6, rowGap: 6, toggle: 10 + 3, togglePadY: 2, touchToggle: 44, textFont: 0.88 * 16, textLine: 1.65, textLines: 2 * 1.6 },
  /** Metrics on a card's front (low density) in a frame narrower than 520 px (brief.css container brief-body). */
  metrics: { min: 110, gapX: 14, gapY: 12, label: 0.74 * 16, value: 1.12 * 16, lead: 2.4 * 16 * 1.1, labelGap: 2 },
  normal: { latin: 1.149, cjk: 1.448 },
  measured: { conditionsLabel: 14, chip: 21, tableRow: 24, tableHead: 23.5, numbers: 52.2, files: 8 + 8 + 21, metricsMore: 45, figureLine: 20 },
} as const;

/** A face for an Agent: see `cardFace`. */
export type CardFace = {
  key: string;
  size: CardSize;
  /** The author's size; a card that refreshes itself is wide; else from its picture (card-preview.ts cardSize). */
  sizeFrom: "author" | "refresh" | "figure";
  summary: "named" | "unnamed";
  /** Slots of the summary the author sent that the card does not use, and why. */
  dropped?: { slot: "lead" | "visual" | "conditions"; block: string; reason: string }[];
  lead: { block: string | null; text: string; chars: number; otherParagraphs: number } | null;
  conditions?: { block: string; type: string; items?: number };
  visual: {
    from: "named" | "file" | "opening" | "none";
    block?: string;
    type?: string;
    file?: string;
    kept?: boolean;
    drawn?: Drawn;
  };
  files?: { named: string[]; more: number };
  opensReport: boolean;
  notOnCard: { block: string; type: string; items?: number; chars?: number }[];
  moreNotOnCard?: number;
  wide: FaceLayout;
  phone: FaceLayout;
};
/** What the card's size draws of its picture, whatever the window (exact). */
export type Drawn =
  | { as: "table"; rows: number; ofRows: number; columns: number; ofColumns: number }
  | { as: "values"; shown: number; of: number }
  | { as: "image" | "chart" | "page" | "desk" | "interactive"; whole: boolean }
  | { as: "collection"; layout: string; of: number }
  | { as: "line" | "button" };
export type FaceLayout = {
  columns: number;
  cardPx: number;
  textPx: number;
  layout: "beside" | "under" | "line" | "none";
  estimate: {
    lead?: { lines: number; shownLines: number; cut: boolean; endsWith?: string; hiddenChars?: number };
    conditions?: { shown: number; hidden: number } | { lines: number; cut: boolean };
    table?: { rows: { full: number; partial: number }; columns: { full: number; partial: number } };
    metrics?: { full: number; partial: number; firstNotFull?: string };
    heightPx: number;
    /** The figure grows to its content, which a face does not lay out: the card is at least this tall. */
    heightAtLeast?: true;
  };
};

/** Told once with the faces: what is exact and what each reference is. */
export const FACE_NOTE =
  "cards: each report or status card the update writes, as Home shows it: Home's own rules (card-preview.ts) on the section as Core keeps it, so its lead, its visual or fallback file, what its size draws, its files and Open report are exact. wide and phone are references, not the reader's device: Home's project page at the default text size, a 1440 px window (deck 1116 px, 3 columns) and a 390 px touch phone (one column), each card at its own span and height. Their estimate (lines, where the lead is cut, what of a table or Metrics is fully or partly inside the frame, height) comes from font metrics and Home's CSS, not a browser: other fonts, text size or window, a size the reader chose, a table's column widths, or a deck that widens a card or stretches it to its row change it. Asks have no card face here.";

type Node = { type?: string; props?: Record<string, unknown>; children?: string[] };
type Elements = Record<string, Node>;
/** The summary the author sent, by its ids, before Core normalized or repaired the section. */
export type RequestedSummary = { lead?: unknown; visual?: unknown; conditions?: unknown; forYou?: unknown; progress?: unknown; relay?: unknown } | null | undefined;
/** A section as Core keeps it, as much of it as a face reads. */
export type FaceSection = Pick<Section, "key" | "kind" | "title" | "body" | "attachments">;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const points = (value: string) => [...value];
const cut = (value: string, most: number) => (points(value).length > most ? `${points(value).slice(0, most - 1).join("")}…` : value);
const name = (value: unknown) => cut(text(value), FACE_LIMITS.name);

function tree(section: FaceSection) {
  const body = section.body as { root?: unknown; elements?: Elements } | null | undefined;
  if (!body?.elements || typeof body.root !== "string") return null;
  return { elements: body.elements, root: body.elements[body.root], top: body.elements[body.root]?.children ?? [] };
}
const itemsOf = (node: Node | undefined) => {
  const list = node?.props?.items ?? node?.props?.rows ?? node?.props?.steps ?? node?.props?.claims;
  return Array.isArray(list) ? list.length : undefined;
};

// ---- Text widths -----------------------------------------------------------------------------

/**
 * Advance widths in thousandths of an em, code points 32–126, of Liberation Sans Regular and Bold
 * (metric-compatible with Arial; hmtx of the 2.x fonts). Home's Latin falls to the system's sans:
 * Liberation where Chromium checks it; another platform's font (SF, Segoe UI, Inter) is wider or
 * narrower, and so is its line breaking.
 */
const LATIN = {
  regular: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  bold: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};
const LATIN_MORE: Record<string, [number, number]> = {
  " ": [278, 278], "°": [400, 400], "±": [549, 549], "·": [333, 333], "×": [584, 584], "–": [556, 556], "—": [1000, 1000],
  "‘": [222, 278], "’": [222, 278], "“": [333, 500], "”": [333, 500], "•": [350, 350], "…": [1000, 1000], "→": [1000, 1000], "≤": [549, 549], "≥": [549, 549],
};
/** Full-width scripts: CJK, kana, Hangul, their punctuation and full-width forms; and emoji. Each 1 em. */
const WIDE = /[ᄀ-ᇿ⺀-〿぀-㏿㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3ffff}\u{1f300}-\u{1faff}]/u;
export const wideChar = (ch: string) => WIDE.test(ch);

/** One character's advance in em. */
export function advance(ch: string, bold = false): number {
  if (wideChar(ch)) return 1;
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return (bold ? LATIN.bold : LATIN.regular)[code - 32] / 1000;
  const more = LATIN_MORE[ch];
  if (more) return more[bold ? 1 : 0] / 1000;
  if (/\p{M}/u.test(ch)) return 0;
  return 0.6;
}
export const textWidth = (value: string, font: number, bold = false) => points(value).reduce((sum, ch) => sum + advance(ch, bold) * font, 0);

type Run = { text: string; bold: boolean; breakBefore: boolean };
/**
 * Markdown's visible text, as runs: emphasis and code marks, link targets and images dropped; a
 * soft break is a space; a list item or heading starts a line of its own.
 */
export function visibleRuns(markdown: string): Run[] {
  const runs: Run[] = [];
  const lines = markdown.trim().split(/\n/);
  lines.forEach((raw, index) => {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+/.test(raw) || /^\s*#{1,6}\s/.test(raw);
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*#{1,6}\s+/, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`+/g, "").replace(/~~/g, "").trim();
    let breakBefore = index > 0 && item;
    if (index > 0 && !item && runs.length) runs.push({ text: " ", bold: false, breakBefore: false });
    line.split(/(\*\*|__)/).reduce((bold, part) => {
      if (part === "**" || part === "__") return !bold;
      const plain = part.replace(/(^|[^\w])[*_](?=\S)|(?<=\S)[*_](?=$|[^\w])/g, "$1");
      if (plain) runs.push({ text: plain, bold, breakBefore });
      breakBefore = false;
      return bold;
    }, false);
  });
  return runs;
}
export const runsText = (runs: Run[]) => runs.map((run) => run.text).join("");

/** Characters no line starts with (closing punctuation) or ends with (opening), as Chromium breaks CJK. */
const NO_START = /[、。，．：；？！）〕］｝」』】〉》’”…—·%,.:;?!)\]}]/u;
const NO_END = /[（〔［｛「『【〈《‘“([{]/u;

/**
 * Lines of `runs` at `width` px: greedy, as a browser fills them. Breaks after a space, between two
 * full-width characters, beside a full-width one (but not before closing or after opening
 * punctuation), and anywhere in a word longer than the line. `ends[i]` is the code points through
 * line i.
 */
export function wrap(runs: Run[], width: number, font: number): { lines: number; ends: number[] } {
  const chars: { ch: string; w: number; hard: boolean }[] = [];
  for (const run of runs) points(run.text).forEach((ch, i) => chars.push({ ch, w: advance(ch, run.bold) * font, hard: run.breakBefore && i === 0 }));
  const ends: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let x = 0, lastBreak = -1, i = start;
    for (; i < chars.length; i++) {
      const { ch, w, hard } = chars[i];
      if (hard && i > start) break;
      const prev = chars[i - 1]?.ch ?? "";
      if (i > start && (prev === " " || ((wideChar(ch) || wideChar(prev)) && ch !== " ")) && !NO_START.test(ch) && !NO_END.test(prev)) lastBreak = i;
      if (ch !== " " && x + w > width + 0.01 && i > start) {
        i = lastBreak > start ? lastBreak : i;
        break;
      }
      x += w;
    }
    ends.push(i);
    start = i;
    while (start < chars.length && chars[start].ch === " ") start++;
  }
  return { lines: Math.max(1, ends.length), ends: ends.length ? ends : [0] };
}

// ---- The face --------------------------------------------------------------------------------

/**
 * The face of a report or status section as Core keeps it; null for an Ask. `refreshes`: the card
 * refreshes itself (Core's, never the section's). `requested`: the summary's ids as the author sent
 * them, before Core normalized or repaired the section, so a slot that was dropped can be named.
 * Never throws on a body it can read: an unreadable one has no lead and no picture.
 */
export function cardFace(section: FaceSection, options: { refreshes?: boolean; requested?: RequestedSummary } = {}): CardFace | null {
  if (section.kind !== "report" && section.kind !== "status") return null;
  const card = { ...section, attachments: Array.isArray(section.attachments) ? section.attachments : [], ...(options.refreshes ? { refresh: {} } : {}) } as unknown as Section;
  const content = cardContent(card);
  const size = cardSize(card, content);
  const body = tree(card);
  const named = summaryOf(card);
  const leadId = summaryBlock(card);
  const figure = content.figure;
  const drawn = figure ? drawnOf(card, figure, size) : undefined;
  const files = content.files;
  // A refreshing card keeps its page (SummaryCard): its past issues are read there.
  const opens = !!options.refreshes || !selfContained(card, content, size);
  const face: CardFace = {
    key: section.key,
    size,
    sizeFrom: sizeSource(content) === "author" ? "author" : options.refreshes ? "refresh" : "figure",
    summary: content.kind,
    ...droppedOf(card, options.requested),
    lead: leadOf(card, leadId),
    ...(content.kind === "named" && content.conditions ? { conditions: conditionsOf(body?.elements[content.conditions], content.conditions) } : {}),
    visual: figure ? {
      from: named?.visual ? "named" : figure.kind === "image" || figure.kind === "page" ? "file" : "opening",
      block: name(figure.id),
      type: figure.kind === "image" || figure.kind === "page" ? figure.kind : text(body?.elements[figure.id]?.type) || figure.kind,
      ...(figure.kind === "image" || figure.kind === "page" ? { file: name(figure.name) } : {}),
      ...(figure.kind === "image" ? { kept: figure.kept } : {}),
      drawn,
    } : { from: "none" },
    ...(files.length ? { files: { named: files.slice(0, CARD_FILES).map((file) => name(file.name)), more: Math.max(0, files.length - CARD_FILES) } } : {}),
    opensReport: opens,
    ...notOnCard(card, leadId, content),
    wide: layoutAt(card, content, size, drawn, opens, "wide"),
    phone: layoutAt(card, content, size, drawn, opens, "phone"),
  };
  return face;
}

function leadOf(section: Section, id: string | null): CardFace["lead"] {
  const node = id ? tree(section)?.elements[id] : undefined;
  const whole = text(node?.props?.text);
  const first = firstParagraph(whole);
  if (!first) return null;
  const visible = runsText(visibleRuns(first));
  return {
    block: id ? name(id) : null,
    text: cut(visible, FACE_LIMITS.text),
    chars: points(visible).length,
    otherParagraphs: Math.max(0, whole.trim().split(/\n\s*\n/).filter((part) => part.trim()).length - 1),
  };
}

function conditionsOf(node: Node | undefined, id: string): NonNullable<CardFace["conditions"]> {
  const items = node?.type === "Checklist" ? itemsOf(node) : undefined;
  return { block: name(id), type: text(node?.type), ...(items !== undefined ? { items } : {}) };
}

/** What the summary the author sent named that the card does not use, with why; never a path or a file's content. */
function droppedOf(section: Section, requested: RequestedSummary): { dropped?: CardFace["dropped"] } {
  const body = tree(section);
  const kept = body?.root?.props?.summary as Record<string, unknown> | undefined;
  const named = summaryOf(section);
  const sent = requested && typeof requested === "object" ? requested : kept;
  if (!sent || typeof sent !== "object") return {};
  const dropped: NonNullable<CardFace["dropped"]> = [];
  for (const slot of ["lead", "visual", "conditions"] as const) {
    const id = sent[slot];
    if (typeof id !== "string") continue;
    const now = slot === "lead" ? named?.lead : slot === "visual" ? named?.visual : named?.conditions;
    if (now === id) continue;
    let reason: string;
    if (!kept || typeof kept !== "object") reason = "Core removed the summary to accept the section (its repairs say why): the card shows how the body opens";
    else if (kept[slot] !== id) reason = `Core removed summary.${slot} to accept the section (its repairs say why)`;
    else if (!named) reason = "Home does not take this summary";
    else if (body?.elements[id]?.type !== "Attachments") reason = `a ${name(body?.elements[id]?.type) || "missing block"} is not a figure a card shows`;
    else {
      const items = body?.elements[id]?.props?.items as { name?: unknown }[] | undefined;
      const file = section.attachments.find((attachment) => attachment.name === items?.[0]?.name);
      reason = file
        ? `"${name(file.name)}" is kept as ${file.kind === "link" ? "a link" : `a ${file.kind} file`}; a card's picture is one image`
        : "it names no attachment of the section";
    }
    dropped.push({ slot, block: name(id), reason });
  }
  return dropped.length ? { dropped } : {};
}

/** What the card's size draws of its picture (SummaryCard's FigureFrame and the small card's line). */
function drawnOf(section: Section, figure: CardFigure, size: CardSize): Drawn {
  const node = tree(section)?.elements[figure.id];
  const values = node?.type === "Metrics" ? itemsOf(node) ?? 0 : null;
  if (figure.kind === "interactive") return { as: "interactive", whole: true };
  if (figure.kind === "collection") return { as: "collection", layout: figure.layout, of: figure.total };
  if (size === "small") {
    if (values !== null) return { as: "values", shown: Math.min(2, values), of: values };
    if (figure.kind === "image" && figure.kept) return { as: "button" };
    return { as: "line" };
  }
  if (figure.kind === "table") {
    const shape = size === "large" ? LARGE_TABLE_PREVIEW : TABLE_PREVIEW;
    return { as: "table", rows: Math.min(shape.rows, figure.totalRows), ofRows: figure.totalRows, columns: Math.min(shape.columns, figure.totalColumns), ofColumns: figure.totalColumns };
  }
  if (values !== null) return { as: "values", shown: Math.min(size === "large" ? LARGE_METRICS : 1 + MORE_METRICS, values), of: values };
  if (figure.kind === "image") return { as: "image", whole: figure.kept };
  if (figure.kind === "page" || figure.kind === "desk") return { as: figure.kind, whole: figure.kind === "page" };
  return { as: node?.type === "LineChart" || node?.type === "BarChart" || node?.type === "ScatterChart" ? "chart" : "interactive", whole: true };
}

/** The root's blocks the card leaves to its page, with how much each holds. */
function notOnCard(section: Section, leadId: string | null, content: CardContent): Pick<CardFace, "notOnCard" | "moreNotOnCard"> {
  const body = tree(section);
  if (!body) return { notOnCard: [] };
  const named = summaryOf(section);
  const on = new Set([named?.lead, named?.visual, named?.conditions, content.figure?.id].filter((id): id is string => !!id));
  const holds = (id: string, inside: string): boolean => id === inside || (body.elements[id]?.children ?? []).some((child) => holds(child, inside));
  const rest = body.top.filter((id) => !on.has(id) && body.elements[id]?.type !== "Attachments" && !(leadId && holds(id, leadId)))
    .map((id) => {
      const node = body.elements[id];
      const items = itemsOf(node);
      const chars = node?.type === "Markdown" ? points(text(node.props?.text)).length : undefined;
      return { block: name(id), type: text(node?.type), ...(items !== undefined ? { items } : {}), ...(chars !== undefined ? { chars } : {}) };
    });
  return { notOnCard: rest.slice(0, FACE_LIMITS.notOnCard), ...(rest.length > FACE_LIMITS.notOnCard ? { moreNotOnCard: rest.length - FACE_LIMITS.notOnCard } : {}) };
}

// ---- Layouts ---------------------------------------------------------------------------------

const C = FACE_CSS;
const columnsAt = (deck: number) => 1 + C.deck.breaks.filter((at) => deck >= at).length;
/** A `line-height: normal` line of `font` px holding `text` (CJK makes it taller); `cjk` for chrome in the reader's language, which a face does not know. */
const normalLine = (font: number, text = "中") => font * (points(text).some(wideChar) ? C.normal.cjk : C.normal.latin);

/** Metrics as a card's front lays them out (Blocks.tsx, low density): the first across, then rows of `perRow`. */
function metricsLayout(labels: string[], width: number) {
  const perRow = Math.max(1, Math.floor((width + C.metrics.gapX) / (C.metrics.min + C.metrics.gapX)));
  const item = (label: string, lead: boolean) => normalLine(C.metrics.label, label) + C.metrics.labelGap + (lead ? C.metrics.lead : normalLine(C.metrics.value, "0"));
  const boxes: { top: number; bottom: number }[] = [];
  let top = 0;
  labels.forEach((label, index) => {
    if (index === 0) {
      boxes.push({ top: 0, bottom: item(label, true) });
      top = item(label, true) + C.metrics.gapY;
      return;
    }
    const row = labels.slice(1 + Math.floor((index - 1) / perRow) * perRow, 1 + Math.floor((index - 1) / perRow) * perRow + perRow);
    const height = Math.max(...row.map((one) => item(one, false)));
    boxes.push({ top, bottom: top + height });
    if ((index - 1) % perRow === perRow - 1 || index === labels.length - 1) top += height + C.metrics.gapY;
  });
  return { boxes, height: boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0 };
}

function layoutAt(section: Section, content: CardContent, size: CardSize, drawn: Drawn | undefined, opens: boolean, width: FaceWidth): FaceLayout {
  const deck = FACE_REFERENCE[width].deck;
  const touch = width === "phone";
  const columns = columnsAt(deck);
  const column = (deck - (columns - 1) * C.deck.gap) / columns;
  const span = columns === 1 || size === "small" ? 1 : 2;
  const cardPx = span * column + (span - 1) * C.deck.gap;
  const inner = cardPx - 2 * C.card.padX - 2 * C.card.border;
  const framed = !!drawn && !["line", "button"].includes(drawn.as) && !(drawn.as === "values" && size === "small");
  const beside = framed && columns >= 2 && size === "wide" && drawn!.as !== "collection";
  const textPx = beside ? (inner - C.beside.gap) / 2 : inner;
  const layout: FaceLayout["layout"] = framed ? (beside ? "beside" : "under") : drawn ? "line" : "none";
  const estimate: FaceLayout["estimate"] = { heightPx: 0 };
  const node = content.figure ? tree(section)?.elements[content.figure.id] : undefined;
  // The text: the title, the lead's first paragraph, the conditions.
  const titleRuns = wrap([{ text: section.title, bold: true, breakBefore: false }], textPx, C.title.font).lines;
  // The title is clamped where it opens the report page (summary-card.css .home-summary-title-link).
  const titleLines = opens ? Math.min(CARD_LINES.title, titleRuns) : titleRuns;
  let textHeight = titleLines * C.title.font * C.title.line;
  if (content.lead) {
    const runs = visibleRuns(content.lead);
    const { lines, ends } = wrap(runs, textPx, C.lead.font);
    const most = size === "large" ? CARD_LINES.largeLead : CARD_LINES.lead;
    const shownLines = Math.min(lines, most);
    const all = points(runsText(runs));
    const end = ends[shownLines - 1];
    estimate.lead = lines > most
      ? { lines, shownLines, cut: true, endsWith: `…${all.slice(Math.max(0, end - FACE_LIMITS.tail), end).join("")}`, hiddenChars: all.length - end }
      : { lines, shownLines, cut: false };
    // Where the deck has two columns or more, three lines are kept for a lead that is not large, so a row lines up.
    const kept = columns >= 2 && size !== "large" ? CARD_LINES.lead : 0;
    textHeight += C.card.gap + Math.max(shownLines, kept) * C.lead.font * C.lead.line;
  }
  if (content.kind === "named" && content.conditions) {
    const conditions = tree(section)?.elements[content.conditions];
    const box = textPx - 2 * C.conditions.padX - 2 * C.conditions.border;
    const toggle = touch ? C.conditions.touchToggle : 2 * C.conditions.togglePadY + normalLine(C.conditions.toggle);
    let inside = C.measured.conditionsLabel + C.conditions.rowGap;
    if (conditions?.type === "Checklist") {
      const items = (Array.isArray(conditions.props?.items) ? conditions.props.items : []) as { text?: unknown; done?: unknown }[];
      const ordered = [...items.filter((item) => !item.done), ...items.filter((item) => item.done)];
      const most = size === "large" ? CARD_LINES.largeConditions : CARD_LINES.conditions;
      const chip = (item: { text?: unknown }) => textWidth(text(item.text), C.conditions.font) + 2 * C.conditions.chipPadX + 2 * C.conditions.chipBorder + C.conditions.chipIcon;
      let line = 0, x = 0;
      const lineOfChip = ordered.map((item) => {
        const w = Math.min(chip(item), box);
        if (x > 0 && x + C.conditions.chipGap + w > box) {
          line += 1;
          x = w;
        } else x += (x > 0 ? C.conditions.chipGap : 0) + w;
        return line;
      });
      // CardConditions: past its lines, chips are folded behind a button, but never one alone.
      let hidden = lineOfChip.filter((at) => at >= most).length;
      if (hidden === 1) hidden = 0;
      const lines = ordered.length ? (hidden ? most : line + 1) : 0;
      estimate.conditions = { shown: ordered.length - hidden, hidden };
      inside += lines * C.measured.chip + Math.max(0, lines - 1) * C.conditions.chipGap + (hidden ? C.conditions.rowGap + toggle : 0);
    } else {
      const { lines } = wrap(visibleRuns(text(conditions?.props?.text)), box, C.conditions.textFont);
      const most = C.conditions.textLines * C.conditions.textFont;
      const full = lines * C.conditions.textFont * C.conditions.textLine;
      const cut = full > most + 0.5;
      estimate.conditions = { lines, cut };
      inside += Math.min(full, most) + (cut ? C.conditions.rowGap + toggle : 0);
    }
    textHeight += C.card.gap + C.conditions.margin + 2 * C.conditions.border + 2 * C.conditions.padY + inside;
  }
  // The figure in its frame. A wide card's frame under its text is 140 px and clips what is taller; beside the
  // text, and on a large card, the frame grows to hold its figure (summary-card.css), so nothing drawn is cut there.
  let bodyHeight = textHeight;
  let atLeast = false;
  if (framed && drawn) {
    const chart = drawn.as === "chart";
    const fixed = size === "wide" && !beside;
    const least = chart ? (size === "large" ? Math.max(columns >= 2 ? C.frame.deckLarge : C.frame.large, C.frame.chart) : C.frame.chart)
      : size === "large" ? (columns >= 2 ? C.frame.deckLarge : C.frame.large) : C.frame.wide;
    const frameWidth = (beside ? textPx : inner) - 2 * C.frame.padX;
    // What is drawn, and how tall: a table's head and rows; Metrics and their "more" button; an image is fitted.
    let drawnHeight: number | null = null;
    const table = content.figure?.kind === "table" ? content.figure : null;
    if (drawn.as === "table" && table) drawnHeight = C.measured.tableHead + drawn.rows * C.measured.tableRow;
    const labels = node?.type === "Metrics" && drawn.as === "values" && size !== "large"
      ? ((Array.isArray(node.props?.items) ? node.props.items : []) as { label?: unknown }[]).slice(0, drawn.shown).map((item) => text(item.label))
      : null;
    const metrics = labels ? metricsLayout(labels, frameWidth) : null;
    if (metrics && drawn.as === "values") drawnHeight = metrics.height + (drawn.of > drawn.shown ? C.measured.metricsMore : 0);
    if (drawn.as === "image") drawnHeight = 0;
    atLeast = drawnHeight === null && !chart;
    const frame = fixed ? least : Math.max(least, (drawnHeight ?? 0) + 2 * C.frame.padY, beside ? textHeight : 0);
    // The frame clips at its own edge, its padding inside it: what starts after the top and left padding shows
    // down to the bottom edge and across to the right one.
    const down = frame - C.frame.padY;
    const across = frameWidth + C.frame.padX;
    if (drawn.as === "table" && table) {
      const rowsFit = (down - C.measured.tableHead) / C.measured.tableRow;
      const full = Math.max(0, Math.min(drawn.rows, Math.floor(rowsFit + 0.01)));
      const columnWidths = table.columns.slice(0, drawn.columns).map((column) => {
        const cells = [column.label, ...table.rows.slice(0, drawn.rows).map((row) => String(row.cells[column.key] ?? "—"))];
        const widest = Math.max(...cells.map((cell) => textWidth(cell, C.table.font)));
        return Math.min(widest, C.table.maxEm * C.table.font) + 2 * C.table.padX;
      });
      let x = 0, fullColumns = 0, partialColumns = 0;
      for (const w of columnWidths) {
        if (x + w <= across + 0.5) fullColumns += 1;
        else if (x < across) partialColumns += 1;
        x += w;
      }
      estimate.table = { rows: { full, partial: full < drawn.rows && rowsFit > full ? 1 : 0 }, columns: { full: fullColumns, partial: partialColumns } };
    }
    if (metrics && labels) {
      // Content taller than its frame starts at the top (safe center); shorter, all of it shows.
      const full = metrics.boxes.filter((box) => box.bottom <= down + 0.5).length;
      const partial = metrics.boxes.filter((box) => box.bottom > down + 0.5 && box.top < down).length;
      estimate.metrics = { full, partial, ...(full < labels.length ? { firstNotFull: name(labels[full]) } : {}) };
    }
    const caption = drawn.as === "table" || (content.figure?.kind === "image" && content.figure.caption) || (drawn.as === "values" && size === "large" && drawn.of > LARGE_METRICS);
    const figureHeight = frame + (caption ? C.frame.captionGap + normalLine(C.frame.caption) : 0);
    bodyHeight = beside ? Math.max(textHeight, figureHeight) : textHeight + C.card.gap + figureHeight;
  } else if (drawn) {
    bodyHeight += C.card.gap + (drawn.as === "values" ? C.measured.numbers : C.measured.figureLine);
  }
  const head = touch ? C.card.touchHead : C.card.head;
  // "Open report" sets the foot's height; without it, the byline's line does.
  const foot = C.card.footPad + (opens ? C.card.open : normalLine(C.card.byline));
  let height = 2 * C.card.padY + 2 * C.card.border + head + C.card.gap + bodyHeight + C.card.gap + foot + (content.files.length ? C.measured.files : 0);
  if (columns >= 2) height = Math.max(height, C.deck.minHeight);
  estimate.heightPx = Math.round(height);
  if (atLeast) estimate.heightAtLeast = true;
  return { columns, cardPx: Math.round(cardPx), textPx: Math.round(textPx), layout, estimate };
}
