// Advice on how a valid Project Brief section reads (T-176): a few
// adjustable hints from lengths and counts, with their thresholds in
// BRIEF_LIMITS.advice. Never a readability score or a limit: nothing is cut,
// refused or rewritten, and an accepted section stays accepted. Only report
// and status sections are advised, never an ask. Each piece names the one
// block it is about, so that Core can keep, for a block edit, only those on
// the blocks it replaced; Core also sends at most three with an answer.
import { BRIEF_ADVICE_CODES, BRIEF_LIMITS, type BriefProblem, type BriefSection } from "./brief-contract.ts";

const A = BRIEF_LIMITS.advice;

/** A stable code, the block it is about, a reason and the guide part to read. */
export type BriefAdvice = BriefProblem;

type Block = { type: string; props: Record<string, unknown>; children?: string[] };

/** Data a reader may need told what it shows. Metrics are labelled values, a summary themselves. */
const DATA = new Set(["Table", "LineChart", "BarChart", "ScatterChart"]);

/** Characters as the guide counts them: Unicode code points. */
export const adviceChars = (text: string) => [...text].length;

/** The blocks reached from the root, in body order. */
function reached(section: BriefSection): [string, Block][] {
  const elements = section.body.elements as unknown as Record<string, Block>;
  const found: [string, Block][] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    const block = elements[key];
    if (!block || seen.has(key)) return;
    seen.add(key);
    found.push([key, block]);
    for (const child of block.children ?? []) visit(child);
  };
  visit(section.body.root);
  return found;
}

function hint(code: keyof typeof BRIEF_ADVICE_CODES, path: string, reason: string): BriefAdvice {
  return { code, path, reason, guide: "brief_guide content" };
}

/** Advice on a section checkBriefSection returned, in rule then body order. */
export function adviseBriefSection(section: BriefSection): BriefAdvice[] {
  if (section.kind !== "report" && section.kind !== "status") return [];
  const blocks = reached(section);
  const at = (key: string, tail = "") => `body.elements.${key}${tail}`;
  const advice: BriefAdvice[] = [];

  // Long Markdown: each long block; otherwise, when all of it is long, the longest.
  const markdown = blocks.filter(([, block]) => block.type === "Markdown")
    .map(([key, block]) => [key, adviceChars(String(block.props.text ?? ""))] as const);
  const long = markdown.filter(([, chars]) => chars > A.markdownChars);
  for (const [key, chars] of long)
    advice.push(hint("long_markdown", at(key, ".props.text"),
      `Markdown "${key}" is ${chars} characters (advice starts above ${A.markdownChars}). A reader finds the point sooner when it comes first and the detail stays on its Task.`));
  const total = markdown.reduce((sum, [, chars]) => sum + chars, 0);
  if (!long.length && total > A.sectionMarkdownChars) {
    const [key] = markdown.reduce((most, one) => (one[1] > most[1] ? one : most));
    advice.push(hint("long_markdown", at(key, ".props.text"),
      `The section's Markdown is ${total} characters in all (advice starts above ${A.sectionMarkdownChars}), the most in "${key}". A reader finds the point sooner when it comes first and the detail stays on its Task.`));
  }

  // Data with no summary beside it: maybe its title and captions already say it.
  const data = blocks.find(([, block]) => DATA.has(block.type));
  const summary = blocks.some(([, block]) =>
    (block.type === "Markdown" && String(block.props.text ?? "").trim() !== "")
    || ((block.type === "Findings" || block.type === "Metrics") && Array.isArray(block.props.items) && block.props.items.length > 0));
  if (data && !summary)
    advice.push(hint("summary_may_be_missing", at(data[0]),
      `This section shows ${data[1].type} "${data[0]}" with no Markdown, Findings or Metrics block. If its title and captions do not yet say what the data shows and any important limit, a short conclusion would; if they do, it is fine as it is.`));

  // References: a target twice in one block; over the threshold in all,
  // each target counted once per block, so that a duplicate in one block is
  // not counted again. The same target in two blocks counts in each: citing
  // it beside two conclusions is not a duplicate.
  let refs = 0;
  let most: [string, number] | undefined;
  for (const [key, block] of blocks) {
    if (block.type !== "LiveRefs" && block.type !== "Sources") continue;
    const items = (Array.isArray(block.props.items) ? block.props.items : []) as { kind?: string; id?: string; href?: string }[];
    const targets = items.map((item) => (block.type === "LiveRefs" ? `${item.kind} ${item.id}` : String(item.href)));
    const again = targets.findIndex((target, index) => targets.indexOf(target) !== index);
    if (again >= 0) {
      const first = targets.indexOf(targets[again]);
      const what = block.type === "LiveRefs" ? targets[again] : "the same href";
      advice.push(hint("duplicate_ref", at(key, `.props.items.${again}`),
        `${block.type} "${key}" items ${first} and ${again} are both ${what}; one is enough.`));
    }
    const different = new Set(targets).size;
    refs += different;
    if (!most || different > most[1]) most = [key, different];
  }
  if (refs > A.refs && most)
    advice.push(hint("many_refs", at(most[0], ".props.items"),
      `The section has ${refs} reference entries, each target counted once per block (advice starts above ${A.refs}), the most in "${most[0]}". Those that support its conclusion are easier to find when the rest stay on its Task.`));
  return advice;
}
