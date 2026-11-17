import { summaryOf } from "./report/report-model.ts";
import type { Section } from "./types";

type Node = { type?: string; props?: Record<string, unknown>; children?: string[] };

/**
 * What a folded card says about itself (T-173): the first paragraph of the
 * section's summary, or null when it names none. A body that names its
 * summary (T-18) is taken at its word: its lead, which is shown with its
 * conditions wherever it shows (sectionConditions). Otherwise the summary
 * is, in order:
 * - the first block, if it is an accent Group (the guide's "a summary
 *   first"): that Group's first Markdown;
 * - a top-level block with the id `summary`: a Markdown, or a Group whose
 *   first child is one;
 * - the first block, if it is a Markdown.
 * Nothing else is guessed at: a card that opens with another Group, a chart,
 * attachments or limits shows no summary rather than the wrong one.
 */
export function sectionSummary(section: Section): string | null {
  const id = summaryBlock(section);
  const text = id === null ? undefined : (section.body as { elements?: Record<string, Node> }).elements?.[id]?.props?.text;
  return typeof text === "string" ? firstParagraph(text) : null;
}

/** The Markdown block sectionSummary reads, by its id, or null (card-face.ts names it to the author, YN-209). */
export function summaryBlock(section: Section): string | null {
  const body = section.body as { root?: unknown; elements?: Record<string, Node> } | null | undefined;
  const elements = body?.elements;
  if (!elements || typeof body?.root !== "string") return null;
  const named = summaryOf(section);
  if (named) return named.lead;
  const top = elements[body.root]?.children ?? [];
  const markdown = (id: string | undefined) => {
    const node = id === undefined ? undefined : elements[id];
    return node?.type === "Markdown" && typeof node.props?.text === "string" ? id! : null;
  };
  const first = elements[top[0] ?? ""];
  let found: string | null = null;
  if (first?.type === "Group" && first.props?.tone === "accent")
    found = (first.children ?? []).map(markdown).find((value) => value !== null) ?? null;
  if (found === null && top.includes("summary"))
    found = markdown("summary") ?? (elements.summary?.type === "Group" ? markdown(elements.summary.children?.[0]) : null);
  if (found === null) found = markdown(top[0]);
  return found;
}

/** The block a body names as what its conclusion holds under (T-18), or null. */
export function sectionConditions(section: Section): string | null {
  return summaryOf(section)?.conditions ?? null;
}

/** The first paragraph of Markdown text, whole: the card clamps it to a few
 * lines, so emphasis and links are never cut open. */
export function firstParagraph(text: string) {
  return text.trim().split(/\n\s*\n/)[0]?.trim() || null;
}

/** Whether nobody will update this section any more: its author is not active (T-173). */
export function unmaintained(section: Section) {
  return section.kind !== "ask" && section.owner.state !== "active";
}
