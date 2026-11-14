import type { ReportLink } from "../../deep-link";
import type { ProjectPanel, Section } from "../types";
import { interactiveGroup } from "../../intelligent-ui/brief-inputs.ts";

type Node = { type?: string; props?: Record<string, unknown>; children?: string[] };
type Body = { root?: unknown; elements?: Record<string, Node> } | null | undefined;

const CHARTS = new Set(["LineChart", "BarChart", "ScatterChart"]);
/** A summary's one figure (brief-contract.ts): Attachments with exactly one item. */
const FIGURES = new Set([...CHARTS, "Metrics", "Calc", "Diagram", "Figure", "Steps", "Timeline", "Table", "ResearchDesk", "Attachments", "Collection"]);

function tree(section: Section) {
  const body = section.body as Body;
  const elements = body?.elements;
  if (!elements || typeof body?.root !== "string") return null;
  return { elements, root: elements[body.root], top: elements[body.root]?.children ?? [] };
}

/**
 * What a report opens with (T-18), as its author named it on the body's
 * root: `summary {lead, visual?, conditions?, size}`, ids of the root's own
 * blocks, which the page shows first and once, and the room its card takes
 * on Home. Core refuses any other shape; one that does not hold here is
 * taken as none. A body that names none has no summary: its page is the body
 * in the author's order, nothing lifted or guessed. A summary kept from
 * before sizes were named has no size (null).
 */
export type Summary = { lead: string; visual: string | null; conditions: string | null; size: "small" | "wide" | "large" | null };
const SIZES = new Set(["small", "wide", "large"]);

export function summaryOf(section: Section): Summary | null {
  const body = tree(section);
  const named = body?.root?.props?.summary as Record<string, unknown> | undefined;
  if (!body || !named || typeof named !== "object" || Array.isArray(named)) return null;
  const { elements, top } = body;
  const type = (id: unknown) => (typeof id === "string" && top.includes(id) ? elements[id]?.type : undefined);
  const { lead, visual, conditions, size } = named;
  if (type(lead) !== "Markdown") return null;
  // A Group is a figure as a Group of inputs the reader sets (YN-16).
  const figure = visual === undefined || (type(visual) === "Group" ? interactiveGroup(elements, visual as string) : FIGURES.has(type(visual) ?? "") &&
    (type(visual) !== "Attachments" || (elements[visual as string].props?.items as unknown[] | undefined)?.length === 1));
  const holds = conditions === undefined || type(conditions) === "Markdown" || type(conditions) === "Checklist";
  const ids = [lead, visual, conditions].filter((id) => id !== undefined);
  if (!figure || !holds || new Set(ids).size !== ids.length) return null;
  // One file is a figure only when Core keeps and shows it as an image; any
  // other stays a file among the attachments, never passed off as the figure.
  const items = type(visual) === "Attachments" ? (elements[visual as string].props?.items as { name?: unknown }[]) : null;
  const image = !items || section.attachments?.some((file) => file.name === items[0]?.name && file.kind === "image");
  return {
    lead: lead as string,
    visual: image ? ((visual as string | undefined) ?? null) : null,
    conditions: (conditions as string | undefined) ?? null,
    size: typeof size === "string" && SIZES.has(size) ? (size as Summary["size"]) : null,
  };
}

/**
 * The page's parts, each block once: the summary, the body's other
 * top-level blocks in the author's order (`flow`), and its top-level
 * Sources and Attachments, which the page keeps in view beside or after
 * the body rather than in the flow. `details` are the titled Groups the
 * author named to start folded; nothing else folds.
 */
export type ReportParts = {
  summary: Summary | null;
  flow: string[];
  sources: string[];
  attachments: string[];
  details: ReadonlySet<string>;
};

export function partsOf(section: Section): ReportParts {
  const body = tree(section);
  const summary = summaryOf(section);
  const shown = new Set(summary ? [summary.lead, summary.visual, summary.conditions] : []);
  const top = body?.top ?? [];
  const type = (id: string) => body?.elements[id]?.type;
  const named = body?.root?.props?.details;
  const details = new Set(
    (Array.isArray(named) ? named : []).filter((id): id is string =>
      typeof id === "string" && top.includes(id) && !shown.has(id) && type(id) === "Group" && !!body?.elements[id].props?.title),
  );
  const rest = top.filter((id) => !shown.has(id));
  return {
    summary,
    flow: rest.filter((id) => type(id) !== "Sources" && type(id) !== "Attachments"),
    sources: rest.filter((id) => type(id) === "Sources"),
    attachments: rest.filter((id) => type(id) === "Attachments"),
    details,
  };
}

/** A titled part of the page and the figures and tables in it, for its outline and rail. */
export type OutlineEntry = { id: string; title: string };
export type FigureEntry = { id: string; title: string; kind: "chart" | "table" | "desk"; rows?: number };

const title = (node: Node | undefined) => (typeof node?.props?.title === "string" ? node.props.title.trim() : "");

/** Titled Groups and titled figures among `ids`, the top-level blocks shown; a Tabs by its label (YN-113 R6). */
export function outlineOf(section: Section, ids: readonly string[]): OutlineEntry[] {
  const body = tree(section);
  if (!body) return [];
  return ids.flatMap((id) => {
    const node = body.elements[id];
    if (node?.type === "Tabs") {
      const label = typeof node.props?.label === "string" ? node.props.label.trim() : "";
      return label ? [{ id, title: label }] : [];
    }
    const name = title(node);
    if (!name || (node?.type !== "Group" && !CHARTS.has(node?.type ?? "") && node?.type !== "Table" && node?.type !== "ResearchDesk")) return [];
    return [{ id, title: name }];
  });
}

/** Every titled chart, table and research desk under `ids`, nested ones by the top-level block that holds them. */
export function figuresOf(section: Section, ids: readonly string[]): FigureEntry[] {
  const body = tree(section);
  if (!body) return [];
  const found: FigureEntry[] = [];
  const walk = (id: string, at: string, depth: number) => {
    const node = body.elements[id];
    if (!node || depth > 8) return;
    const kind = CHARTS.has(node.type ?? "") ? "chart" : node.type === "Table" ? "table" : node.type === "ResearchDesk" ? "desk" : null;
    if (kind && title(node))
      found.push({ id: at, title: title(node), kind, ...(kind === "table" && Array.isArray(node.props?.rows) ? { rows: node.props.rows.length } : {}) });
    for (const child of node.children ?? []) walk(child, at, depth + 1);
  };
  for (const id of ids) walk(id, id, 0);
  return found;
}

/**
 * Where a report link's version is on Home now (T-18). Only that very
 * version is shown: Core keeps a live section's newest version, and
 * History its kept rows, each at its own version. The section is told by
 * its identity, as a reply's arrival is (home-reply-model.ts): the same
 * through every edit, a resolve and a seen card written again; another for
 * a key written anew.
 */
export type ReportPlace =
  /** The very version linked, live or in History; `newer`, the same section live at a later version. */
  | { kind: "found"; section: Section; newer: Section | null }
  /** That section is on Home, but not at the version linked: the versions it is at. */
  | { kind: "unavailable"; versions: Section[] }
  /** Nothing on Home is provably that section (its History may have expired,
   * or another section has its key now: `current`, its version). */
  | { kind: "unknown"; current: number | null }
  /** Its project is not on Home. */
  | { kind: "gone" };

export function reportPlace(link: Pick<ReportLink, "key" | "version" | "sectionId">, panel: ProjectPanel | undefined): ReportPlace {
  if (!panel) return { kind: "gone" };
  const live = [...panel.brief.sections, ...(panel.brief.teamSections ?? [])].find((s) => s.key === link.key);
  const past = panel.brief.history.filter((s) => s.key === link.key);
  const unknown: ReportPlace = { kind: "unknown", current: live?.version ?? null };
  if (link.sectionId === undefined) {
    // Without an identity only the very version is provably the one linked
    // (versions never repeat under a key; removing or marking seen keeps it).
    const same = live?.version === link.version ? live : past.find((s) => s.version === link.version);
    return same ? { kind: "found", section: same, newer: null } : unknown;
  }
  const own = [...(live?.id === link.sectionId ? [live] : []), ...past.filter((s) => s.id === link.sectionId)];
  if (!own.length) return unknown;
  const newer = live?.id === link.sectionId && live.version > link.version ? live : null;
  const exact = own.find((s) => s.version === link.version);
  if (exact) return { kind: "found", section: exact, newer: exact === live ? null : newer };
  return { kind: "unavailable", versions: own.sort((a, b) => b.version - a.version) };
}

/** The report link to a section as Home shows it. */
export function linkTo(projectId: string, section: Section): Omit<ReportLink, "workspaceId"> {
  return {
    projectId,
    key: section.key,
    version: section.version,
    ...(typeof section.id === "number" ? { sectionId: section.id } : {}),
  };
}
