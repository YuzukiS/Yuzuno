import type { ReportLink } from "../../deep-link";
import type { ProjectPanel, Section } from "../types";

type Node = { type?: string; props?: Record<string, unknown>; children?: string[] };
type Body = { root?: unknown; elements?: Record<string, Node> } | null | undefined;

/** Blocks a summary may show as its one visual when the author names it. */
const VISUALS = new Set(["LineChart", "BarChart", "ScatterChart", "Metrics", "Table", "ResearchDesk", "Attachments"]);
/** Blocks taken as the visual when the author names none: a figure or a few values, never a table or files. */
const FIGURES = new Set(["LineChart", "BarChart", "ScatterChart", "Metrics"]);

function tree(section: Section) {
  const body = section.body as Body;
  const elements = body?.elements;
  if (!elements || typeof body?.root !== "string") return null;
  return { elements, root: elements[body.root], top: elements[body.root]?.children ?? [] };
}

/**
 * What the card and the top of the report show of a section (T-18): ids of
 * two of its top-level blocks, drawn as they are in the body, so the summary,
 * the report and Copy report read the same blocks at the same version.
 * - `lead`, the conclusion: a Markdown, or a Group with one.
 * - `visual`, the one key figure.
 * A body may name them (`summary: [lead, visual?]` on its root); otherwise
 * the lead is what a folded card already shows (card-summary.ts: an accent
 * Group first, a block with the id `summary`, a Markdown first) and the
 * visual the first top-level chart or Metrics. Nothing else is guessed.
 */
export type Summary = { lead: string | null; visual: string | null };

export function summaryOf(section: Section): Summary {
  const body = tree(section);
  if (!body) return { lead: null, visual: null };
  const { elements, root, top } = body;
  const type = (id: string | undefined) => (id === undefined ? undefined : elements[id]?.type);
  const markdown = (id: string | undefined) => type(id) === "Markdown";
  const leads = (id: string) => markdown(id) || (type(id) === "Group" && (elements[id].children ?? []).some(markdown));
  const named = root?.props?.summary;
  if (Array.isArray(named) && named.length >= 1 && named.length <= 2 && named.every((id) => typeof id === "string" && top.includes(id))) {
    const [lead, visual] = named as string[];
    if (leads(lead) && (visual === undefined || (visual !== lead && VISUALS.has(type(visual) ?? ""))))
      return { lead, visual: visual ?? null };
  }
  const first = top[0];
  let lead: string | null = null;
  if (first !== undefined && type(first) === "Group" && elements[first].props?.tone === "accent" && leads(first)) lead = first;
  else if (top.includes("summary") && (markdown("summary") || (type("summary") === "Group" && markdown(elements.summary.children?.[0]))))
    lead = "summary";
  else if (markdown(first)) lead = first;
  const visual = top.find((id) => id !== lead && FIGURES.has(type(id) ?? "")) ?? null;
  return { lead, visual };
}

/** The top-level blocks the report shows below its summary, in the author's order. */
export function restOf(section: Section, summary: Summary): string[] {
  return (tree(section)?.top ?? []).filter((id) => id !== summary.lead && id !== summary.visual);
}

/** A titled block of the report, for its outline: Groups and figures, by the author's titles. */
export type OutlineEntry = { id: string; title: string; figure: boolean };

const FIGURE_TYPES = new Set(["LineChart", "BarChart", "ScatterChart", "Table", "ResearchDesk"]);

export function outlineOf(section: Section, ids: readonly string[]): OutlineEntry[] {
  const body = tree(section);
  if (!body) return [];
  return ids.flatMap((id) => {
    const node = body.elements[id];
    const title = typeof node?.props?.title === "string" ? node.props.title.trim() : "";
    if (!title || (node?.type !== "Group" && !FIGURE_TYPES.has(node?.type ?? ""))) return [];
    return [{ id, title, figure: node.type !== "Group" }];
  });
}

/** Markdown blocks the report folds behind "Show all": most of a screen or more. */
export const LONG_LINES = 12;

/**
 * Where a report link's section is on Home now (T-18), told by its identity
 * as a reply's arrival is (home-reply-model.ts): the same through every
 * edit, a resolve and a seen card written again; another for a key written
 * anew. Core keeps only a live section's newest version, so a link to an
 * older one has no body to show.
 */
export type ReportPlace =
  /** The very version linked, live. */
  | { kind: "live"; section: Section }
  /** The same section, live at a later version. */
  | { kind: "later"; section: Section }
  /** The same section in History, with why (its `historyReason`). */
  | { kind: "history"; section: Section }
  /** Nothing on Home is provably that section: its History may have expired,
   * or another section has its key now (`current`, its version, if any). */
  | { kind: "unknown"; current: number | null }
  /** Its project is not on Home. */
  | { kind: "gone" };

export function reportPlace(link: Pick<ReportLink, "key" | "version" | "sectionId">, panel: ProjectPanel | undefined): ReportPlace {
  if (!panel) return { kind: "gone" };
  const live = [...panel.brief.sections, ...(panel.brief.teamSections ?? [])].find((s) => s.key === link.key);
  const past = panel.brief.history.filter((s) => s.key === link.key);
  const unknown: ReportPlace = { kind: "unknown", current: live?.version ?? null };
  if (link.sectionId !== undefined) {
    if (live && live.id === link.sectionId) {
      if (live.version === link.version) return { kind: "live", section: live };
      return live.version > link.version ? { kind: "later", section: live } : unknown;
    }
    const own = past.filter((s) => s.id === link.sectionId).sort((a, b) => b.version - a.version)[0];
    return own ? { kind: "history", section: own } : unknown;
  }
  // Without an identity only the very version is provably the one linked
  // (versions never repeat under a key; removing or marking seen keeps it).
  if (live?.version === link.version) return { kind: "live", section: live };
  const same = past.find((s) => s.version === link.version);
  return same ? { kind: "history", section: same } : unknown;
}

/** The report link to a section as Home shows it now. */
export function linkTo(projectId: string, section: Section): Omit<ReportLink, "workspaceId"> {
  return {
    projectId,
    key: section.key,
    version: section.version,
    ...(typeof section.id === "number" ? { sectionId: section.id } : {}),
  };
}
