import type { Section } from "./types";

type Node = { type?: string; props?: Record<string, unknown>; children?: string[] };

/**
 * What a folded card says about itself (T-173): the first paragraph of the
 * section's summary, or null when it names none. The summary is, in order:
 * - the first block, if it is an accent Group (the guide's "a summary
 *   first"): that Group's first Markdown;
 * - a top-level block with the id `summary`: a Markdown, or a Group whose
 *   first child is one;
 * - the first block, if it is a Markdown.
 * Nothing else is guessed at: a card that opens with another Group, a chart,
 * attachments or limits shows no summary rather than the wrong one.
 */
export function sectionSummary(section: Section): string | null {
  const body = section.body as { root?: unknown; elements?: Record<string, Node> } | null | undefined;
  const elements = body?.elements;
  if (!elements || typeof body?.root !== "string") return null;
  const top = elements[body.root]?.children ?? [];
  const markdown = (id: string | undefined) => {
    const node = id === undefined ? undefined : elements[id];
    return node?.type === "Markdown" && typeof node.props?.text === "string" ? (node.props.text as string) : null;
  };
  const first = elements[top[0] ?? ""];
  let text: string | null = null;
  if (first?.type === "Group" && first.props?.tone === "accent")
    text = (first.children ?? []).map(markdown).find((value) => value !== null) ?? null;
  if (text === null && top.includes("summary"))
    text = markdown("summary") ?? (elements.summary?.type === "Group" ? markdown(elements.summary.children?.[0]) : null);
  if (text === null) text = markdown(top[0]);
  return text === null ? null : firstParagraph(text);
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
