// Advice on how a valid Brief section reads (T-176): adjustable hints that
// refuse nothing. Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF_ADVICE_CODES, BRIEF_EXAMPLES, BRIEF_LIMITS, BRIEF_TOOL_DESCRIPTIONS, briefGuide, checkBriefSection,
} from "../src/intelligent-ui/brief-contract.ts";
import { adviceChars, adviseBriefSection } from "../src/intelligent-ui/brief-advice.ts";

const A = BRIEF_LIMITS.advice;

/** A checked report with these blocks, the root's children (by default all of them) in order. */
const section = (blocks, extra = {}, children = Object.keys(blocks)) =>
  checkBriefSection({
    key: "notes", kind: "report", title: "Notes", ...extra,
    body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children }, ...blocks } },
  });
const advise = (blocks, extra, children) => adviseBriefSection(section(blocks, extra, children));
const codes = (advice) => advice.map((one) => one.code);
const markdown = (text) => ({ type: "Markdown", props: { text } });
const table = { type: "Table", props: { id: "runs", title: "Runs", columns: [{ key: "run", label: "Run" }], rows: [{ id: "r1", cells: { run: "1" } }] } };
const refs = (...ids) => ({ type: "LiveRefs", props: { items: ids.map((id) => ({ kind: "task", id })) } });
const tasks = (from, count) => Array.from({ length: count }, (_, n) => `T-${from + n}`);

test("the guide's examples get no advice", () => {
  for (const [name, example] of Object.entries(BRIEF_EXAMPLES))
    assert.deepEqual(adviseBriefSection(checkBriefSection(example)), [], name);
});

test("every piece has a known code, names one block and points to the guide", () => {
  const advice = advise({ long: markdown("x".repeat(A.markdownChars + 1)), runs: table, refs: refs("T-1", "T-1") });
  assert.ok(advice.length >= 2);
  for (const one of advice) {
    assert.ok(one.code in BRIEF_ADVICE_CODES, one.code);
    assert.match(one.path, /^body\.elements\.[A-Za-z][\w-]*(\.|$)/);
    assert.equal(one.guide, "brief_guide content");
    assert.ok(one.reason.length > 0);
  }
});

test("an ask is never advised", () => {
  const ask = { question: "Which way?", reply: { options: [{ id: "l", label: "Left" }, { id: "r", label: "Right" }] } };
  assert.deepEqual(advise({ long: markdown("x".repeat(A.markdownChars + 1)), runs: table }, { kind: "ask", ask }), []);
});

test("long Markdown is counted in code points, per block and then in all", () => {
  assert.deepEqual(advise({ note: markdown("x".repeat(A.markdownChars)) }), []);
  // Each emoji is one character, two UTF-16 units and four bytes.
  assert.equal(adviceChars("😀".repeat(A.markdownChars)), A.markdownChars);
  assert.deepEqual(advise({ note: markdown("😀".repeat(A.markdownChars)) }), []);
  assert.deepEqual(advise({ note: markdown("字".repeat(A.markdownChars)) }), []);
  const long = advise({ note: markdown("字".repeat(A.markdownChars + 1)) });
  assert.deepEqual(long.map((one) => [one.code, one.path]), [["long_markdown", "body.elements.note.props.text"]]);
  assert.ok(long[0].reason.includes(String(A.markdownChars + 1)));
  // No block is long, but all of them are: the longest is named.
  const a = Math.floor(A.sectionMarkdownChars / 3);
  const even = { a: markdown("x".repeat(a)), b: markdown("x".repeat(a)), c: markdown("x".repeat(A.sectionMarkdownChars - 2 * a)) };
  assert.deepEqual(advise(even), []);
  const over = advise({ a: markdown("x".repeat(a)), b: markdown("x".repeat(a + 1)), c: markdown("x".repeat(A.sectionMarkdownChars - 2 * a)) });
  assert.deepEqual(over.map((one) => one.path), ["body.elements.b.props.text"]);
  // A long block is named once, not again for the section.
  const both = advise({ a: markdown("x".repeat(A.markdownChars + 1)), b: markdown("x".repeat(A.sectionMarkdownChars)) });
  assert.deepEqual(both.map((one) => one.path), ["body.elements.a.props.text", "body.elements.b.props.text"]);
});

test("a table or chart without a summary may need one; with any, nothing is said", () => {
  const alone = advise({ runs: table });
  assert.deepEqual(alone.map((one) => [one.code, one.path]), [["summary_may_be_missing", "body.elements.runs"]]);
  assert.match(alone[0].reason, /^This section shows Table "runs"/);
  assert.match(alone[0].reason, /If its title and captions do not yet say/);
  assert.deepEqual(codes(advise({ runs: table, note: markdown("   ") })), ["summary_may_be_missing"]);
  assert.deepEqual(advise({ runs: table, note: markdown("Run 1 is the baseline.") }), []);
  assert.deepEqual(advise({ runs: table, found: { type: "Findings", props: { items: [{ id: "f", source: "run 1", severity: "info", text: "Run 1 is fastest." }] } } }), []);
  assert.deepEqual(advise({ runs: table, values: { type: "Metrics", props: { items: [{ label: "Runs", value: 1 }] } } }), []);
  // Inside a Group, as from the root.
  const grouped = advise({ box: { type: "Group", props: { title: "Runs" }, children: ["runs"] }, runs: table }, {}, ["box"]);
  assert.deepEqual(grouped.map((one) => one.path), ["body.elements.runs"]);
  // Pictures and references alone are not data.
  assert.deepEqual(advise({ refs: refs("T-1") }), []);
});

test("a target twice is advised only within one block", () => {
  const twice = advise({ note: markdown("See below."), refs: refs("T-1", "T-2", "T-1") });
  assert.deepEqual(twice.map((one) => [one.code, one.path]), [["duplicate_ref", "body.elements.refs.props.items.2"]]);
  assert.match(twice[0].reason, /items 0 and 2 are both task T-1/);
  // Citing the same task near two conclusions is fine.
  assert.deepEqual(advise({ note: markdown("See below."), a: refs("T-1"), b: refs("T-1") }), []);
  const sources = { type: "Sources", props: { items: [{ id: "a", label: "Paper", href: "https://example.com/p" }, { id: "b", label: "Same", href: "https://example.com/p" }] } };
  assert.deepEqual(codes(advise({ note: markdown("See below."), sources })), ["duplicate_ref"]);
});

test("reference entries count each target once per block, so a duplicate is said once", () => {
  assert.deepEqual(advise({ note: markdown("See below."), a: refs(...tasks(1, 8)), b: refs(...tasks(9, A.refs - 8)) }), []);
  const many = advise({ note: markdown("See below."), a: refs(...tasks(1, 8)), b: refs(...tasks(9, A.refs - 7)) });
  assert.deepEqual(many.map((one) => [one.code, one.path]), [["many_refs", "body.elements.a.props.items"]]);
  assert.ok(many[0].reason.includes(String(A.refs + 1)));
  assert.match(many[0].reason, /reference entries, each target counted once per block/);
  // The same targets in two blocks count in each, and are no duplicate.
  const near = advise({ note: markdown("See below."), a: refs(...tasks(1, 8)), b: refs(...tasks(1, A.refs - 7)) });
  assert.deepEqual(codes(near), ["many_refs"]);
  // Thirteen items in one block, twelve targets: the duplicate only.
  assert.deepEqual(codes(advise({ note: markdown("See below."), a: refs(...tasks(1, A.refs), "T-1") })), ["duplicate_ref"]);
});

test("advice never changes the checked section", () => {
  const blocks = { long: markdown("x".repeat(A.markdownChars + 1)), runs: table };
  const checked = section(blocks);
  const before = structuredClone(checked);
  adviseBriefSection(checked);
  assert.deepEqual(checked, before);
});

test("the tools and the guide say what a check writes, what advice is and both problem limits", () => {
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_update, /validateOnly:true checks without writing\./);
  // T-175's hint and preference, for Home content editors only; the preference grants nothing.
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_get, /for a Home content editor homeHint, and homePreference once the user set one: .*granting nothing\}/);
  const sections = briefGuide("sections");
  assert.match(sections, /validateOnly:true checks a brief_update as it would be sent and writes nothing: .*no requestId kept, no version reserved, and it is not your update\./);
  assert.match(sections, /checkedAll: whether this check ran to the end\..*false means later steps did not run and the problems listed may not be all\./);
  assert.match(sections, /sending the update checks everything again/);
  assert.match(briefGuide("errors"), new RegExp(`at most ${BRIEF_LIMITS.problems} for each section's format and at most ${BRIEF_LIMITS.callProblems} in all\\. moreProblems says how many more Core found past ${BRIEF_LIMITS.callProblems}`));
  const content = briefGuide("content");
  assert.match(content, new RegExp(`Advice: .*up to ${BRIEF_LIMITS.advice.items} advice .*not a score or a limit: nothing is cut, refused or rewritten`));
  assert.match(content, /Characters are Unicode code points\./);
  for (const code of Object.keys(BRIEF_ADVICE_CODES)) assert.match(content, new RegExp(`^- ${code}: `, "m"));
});
