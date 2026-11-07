// The Project Brief section contract (T-85): one source for a section's
// format, its checks and what Agents are told. Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BRIEF_DESCRIBED_COMPONENTS, briefComponentHints,
  BRIEF_COMPONENT_DESCRIPTIONS, BRIEF_EXAMPLES, BRIEF_GUIDE_PARTS, BRIEF_HARD_RULES, BRIEF_KEY_PATTERN, BRIEF_LIMITS, BRIEF_OUTCOME_HINT,
  BRIEF_PROBLEM_CODES, BRIEF_SCHEMA_VERSION, BRIEF_TOOL_DESCRIPTIONS, BriefError, DESCRIPTION_CAP, briefComponentProps,
  briefGuide, checkBriefSection, describeBrief, fencedBlockLines, researchReads,
} from "../src/intelligent-ui/brief-contract.ts";
import { MAX_PROBLEMS, MAX_SPEC_BYTES, ResultError, SIGNATURE_LEGEND } from "../src/intelligent-ui/contract.ts";
import { clarificationExample } from "../src/intelligent-ui/clarification.ts";
import { benchmark, doseStudy, layoutStudy } from "./research-fixtures.mjs";

const problems = (value, previousBody) => {
  try {
    checkBriefSection(value, previousBody);
  } catch (error) {
    assert.ok(error instanceof BriefError && error instanceof ResultError);
    assert.ok(error.problems.length >= 1 && error.problems.length <= MAX_PROBLEMS);
    for (const found of error.problems) {
      assert.deepEqual(Object.keys(found), ["code", "path", "reason", "guide"]);
      assert.ok(Object.hasOwn(BRIEF_PROBLEM_CODES, found.code), `${found.code} is listed in brief_guide errors`);
      assert.match(found.guide, new RegExp(`^brief_guide (${BRIEF_GUIDE_PARTS.join("|")})$`));
      assert.ok(found.reason.endsWith(`(${found.guide})`), found.reason);
    }
    return error.problems;
  }
  assert.fail("expected a BriefError");
};
const first = (value) => problems(value)[0];

/** A report with one component under the root. */
const section = (type, props, extra = {}) => ({
  key: "demo",
  kind: "report",
  title: "Demo",
  ...extra,
  body: {
    root: "body",
    elements: { body: { type: "BriefBody", props: {}, children: ["it"] }, it: { type, props } },
  },
});
const points = (n) => Array.from({ length: n }, (_, i) => [i, i * 2]);
const items = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const csv = { attachments: [{ name: "data.csv", path: "/home/me/run/data.csv" }] };

const everyComponent = {
  key: "round-12/everything",
  kind: "report",
  title: "Every component",
  attachments: [
    { name: "loss.csv", path: "/home/me/run/loss.csv" },
    { name: "plot.png", path: "/home/me/run/plot.png", caption: "Samples" },
    { name: "design", url: "https://example.com/design" },
    ...doseStudy.attachments,
  ],
  body: {
    root: "body",
    elements: {
      body: { type: "BriefBody", props: {}, children: ["intro", "split", "refs", "files", "sources", "desk", "inputs"] },
      // YN-16: inputs, and a block they show only for some values.
      inputs: { type: "Group", props: { title: "Try it" }, children: ["guests", "vegan", "view", "hint", "amounts", "reset", "flow", "photo", "how", "when"] },
      amounts: { type: "Calc", props: { items: [{ id: "flour", label: "Flour", expr: "250 * guests / 4", unit: "g", digits: 0 }, { id: "oil", label: "Oil", expr: "flour / 10", when: "vegan" }] } },
      reset: { type: "Button", props: { label: "Reset" }, on: { press: { action: "setState", params: { statePath: "/guests", value: 4 } } } },
      flow: { type: "Diagram", props: { select: "step", nodes: [{ id: "mix", label: "Mix" }, { id: "bake", label: "Bake", detail: "220°C, 12 minutes" }], edges: [{ from: "mix", to: "bake" }] } },
      photo: { type: "Figure", props: { image: "plot.png", alt: "The grid", select: "spot", hotspots: [{ id: "corner", label: "Corner", x: 10, y: 90, detail: "Where it starts." }] } },
      how: { type: "Steps", props: { title: "How", mode: "walk", steps: [{ id: "a", title: "Mix", time: "2 min" }, { id: "b", title: "Bake", text: "Until golden." }] } },
      when: { type: "Timeline", props: { items: [{ id: "t1", at: "2026-11-01", title: "Started", state: "done" }, { id: "t2", at: "Week 46", title: "Ship", state: "next", text: "Planned." }] } },
      guests: { type: "NumberInput", props: { name: "guests", label: "Guests", value: 4, min: 1, max: 12, step: 1, unit: "people", control: "both", detail: "Scales every amount" } },
      vegan: { type: "Switch", props: { name: "vegan", label: "Vegan", value: false } },
      view: { type: "Segmented", props: { name: "view", label: "View", value: 2, options: [{ value: 1, label: "One" }, { value: 2, label: "Two" }] } },
      hint: { type: "Markdown", visible: { $and: [{ $state: "/vegan" }, { $state: "/guests", gte: 6 }] }, props: { text: "Use two trays." } },
      desk: doseStudy.body.elements.desk,
      intro: { type: "Markdown", props: { text: "# Round 12\n\n```sh\nnpm test\n```" } },
      split: { type: "Columns", props: { widths: [3, 1] }, children: ["group", "side"] },
      group: { type: "Group", props: { title: "Detail" }, children: ["check", "plan", "findings", "metrics", "table", "line", "bar", "scatter"] },
      side: { type: "Group", props: { tone: "accent" }, children: ["math"] },
      math: { type: "Math", props: { tex: "e^{i\\pi}+1=0", display: true } },
      check: { type: "Checklist", props: { title: "Done when", items: [{ id: "a", text: "Tests pass", done: true }] } },
      plan: { type: "Plan", props: { steps: [{ id: "s1", text: "Build", state: "done" }, { id: "s2", text: "Ship", state: "blocked" }] } },
      findings: { type: "Findings", props: { items: [{ id: "f1", source: "review", severity: "critical", text: "Data loss" }] } },
      metrics: { type: "Metrics", props: { items: [{ label: "Loss", value: 0.4, previous: 0.5, unit: "nats", detail: "val" }, { label: "Phase", value: "eval" }] } },
      table: {
        type: "Table",
        props: {
          id: "runs",
          title: "Runs",
          columns: items(12, (i) => ({ key: `c${i}`, label: `C${i}` })),
          rows: items(200, (i) => ({ id: `r${i}`, cells: Object.fromEntries(items(12, (c) => [`c${c}`, c === 0 ? `run ${i}` : i])), sourceIds: i === 0 ? ["src"] : undefined })),
        },
      },
      line: { type: "LineChart", props: { id: "loss", title: "Loss", x: { label: "Step" }, y: { label: "Loss" }, data: { attachment: "loss.csv", x: "step", series: [{ name: "val", column: "val_loss" }] } } },
      bar: { type: "BarChart", props: { id: "bars", title: "By split", x: { label: "Split" }, y: { label: "Accuracy", unit: "%" }, series: [{ name: "acc", points: [["train", 91], ["val", 88]] }] } },
      scatter: { type: "ScatterChart", props: { id: "pts", x: { label: "Size" }, y: { label: "Time", unit: "s" }, series: [{ name: "a", points: points(250) }, { name: "b", points: points(250) }] } },
      refs: { type: "LiveRefs", props: { items: [{ kind: "task", id: "T-85" }, { kind: "pr", id: "owner/repo#63", label: "PR 63" }, { kind: "job", id: "0193-job" }, { kind: "ci", id: "123456" }, { kind: "review", id: "r-1" }, { kind: "agent", id: "a1" }, { kind: "machine", id: "local" }] } },
      files: { type: "Attachments", props: { items: [{ name: "plot.png", caption: "Grid" }, { name: "design" }] } },
      sources: { type: "Sources", props: { items: [{ id: "src", label: "Runner", href: "web/tools/run.mjs:12" }] } },
    },
  },
};

test("every component, the worked examples and every ask reply are valid", () => {
  const normalized = checkBriefSection(everyComponent);
  const used = new Set(Object.values(everyComponent.body.elements).map((node) => node.type));
  assert.deepEqual([...used].sort(), Object.keys(briefComponentProps).sort(), "the fixture uses every component");
  assert.equal(normalized.body.elements.scatter.props.title, "Chart", "a chart title is a display default");
  assert.equal(everyComponent.body.elements.scatter.props.title, undefined, "the given value is not changed");
  for (const [name, example] of Object.entries(BRIEF_EXAMPLES)) {
    const checked = checkBriefSection(example);
    assert.equal(checked.op, undefined, `${name}: the op is dropped`);
    const { op, ...rest } = example;
    assert.deepEqual(checkBriefSection(rest), checked, `${name}: with or without op:"put"`);
  }
  // A BriefBody may leave out props; the normalized body has props {}.
  const bare = section("Markdown", { text: "x" });
  delete bare.body.elements.body.props;
  assert.deepEqual(checkBriefSection(bare).body.elements.body.props, {});
  const ask = (reply) => section("Markdown", { text: "x" }, { kind: "ask", ask: { question: "Which one?", reply } });
  for (const reply of [
    { options: items(2, (i) => ({ id: `o${i}`, label: `O${i}` })) },
    { options: items(8, (i) => ({ id: `o${i}`, label: `O${i}` })) },
    { freeText: true },
    { freeText: { prompt: "Why?" } },
    { form: clarificationExample },
    { choice: { a: { id: "a", label: "Fast", detail: "Less safe" }, b: { id: "b", label: "Safe" } } },
  ])
    assert.ok(checkBriefSection(ask(reply)), JSON.stringify(reply));
  assert.ok(checkBriefSection(section("Markdown", { text: "x" }, { kind: "status", status: { asOf: "2026-10-17T08:00:00+08:00", validFor: 60 }, time: { due: "2026-10-18T00:00:00Z" } })));
});

test("ask validity: a question plus options, freeText, a form or a choice", () => {
  const ask = (value) => section("Markdown", { text: "x" }, { kind: "ask", ask: value });
  assert.equal(first(section("Markdown", { text: "x" }, { kind: "ask" })).code, "ask_required");
  const empty = first(ask({ question: "Which?", reply: {} }));
  assert.equal(empty.code, "ask_without_reply");
  assert.equal(empty.path, "ask.reply");
  assert.match(empty.reason, /options .*freeText, form or choice/);
  assert.equal(first(ask({ question: "Which?" })).code, "missing_field");
  assert.match(first(ask({ question: "Which?" })).reason, /Give options, freeText, form or choice/);
  assert.equal(first(ask({ question: "  ", reply: { freeText: true } })).path, "ask.question");
  assert.equal(first(ask({ question: "x".repeat(501), reply: { freeText: true } })).code, "too_long");
  const one = first(ask({ question: "Which?", reply: { options: [{ id: "a", label: "A" }] } }));
  assert.equal(one.path, "ask.reply.options");
  assert.match(one.reason, /has 1 item; it needs at least 2/);
  assert.equal(first(ask({ question: "Which?", reply: { options: items(9, (i) => ({ id: `o${i}`, label: "O" })) } })).code, "too_many");
  assert.equal(first(ask({ question: "Which?", reply: { options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] } })).code, "duplicate_id");
  assert.equal(first(ask({ question: "Which?", reply: { choice: { a: { id: "a", label: "A" } } } })).path, "ask.reply.choice.b");
  assert.equal(first(ask({ question: "Which?", reply: { choice: { a: { id: "a", label: "A" }, b: { id: "a", label: "B" } } } })).code, "duplicate_id");
  assert.equal(first(ask({ question: "Which?", reply: { freeText: false } })).path, "ask.reply.freeText");
  const form = { ...clarificationExample, fields: [] };
  assert.equal(first(ask({ question: "Which?", reply: { form } })).path, "ask.reply.form.fields");
  // ask and status belong to their kinds; status needs status.
  assert.equal(first(section("Markdown", { text: "x" }, { ask: { question: "Q", reply: { freeText: true } } })).code, "misplaced_field");
  assert.equal(first(section("Markdown", { text: "x" }, { kind: "status" })).code, "status_required");
  assert.equal(first(section("Markdown", { text: "x" }, { status: { asOf: "2026-10-17T08:00:00Z", validFor: 60 } })).code, "misplaced_field");
  const status = (value) => section("Markdown", { text: "x" }, { kind: "status", status: value });
  assert.equal(first(status({ asOf: "2026-10-17T08:00:00Z", validFor: 59 })).path, "status.validFor");
  assert.equal(first(status({ asOf: "2026-10-17T08:00:00Z", validFor: 31_536_001 })).path, "status.validFor");
  assert.match(first(status({ asOf: "2026-10-17 08:00", validFor: 60 })).reason, /ISO 8601 time with a time zone/);
});

test("the key is topic or topic/sub", () => {
  for (const key of ["a", "round-12", "0x", "round-12/review", "a/b", `${"a".repeat(48)}/${"b".repeat(48)}`])
    assert.ok(checkBriefSection({ ...section("Markdown", { text: "x" }), key }), key);
  for (const key of ["", "Round", "-a", "a/", "/a", "a/b/c", "a_b", "a b", "a/-b", "a".repeat(49), `a/${"b".repeat(49)}`]) {
    assert.equal(BRIEF_KEY_PATTERN.test(key), false, key);
    const found = first({ ...section("Markdown", { text: "x" }), key });
    assert.equal(found.code, "invalid_key", key);
    assert.match(found.reason, /topic or topic\/sub/);
    assert.equal(found.guide, "brief_guide sections");
  }
  assert.equal(BRIEF_LIMITS.keyPattern, BRIEF_KEY_PATTERN.source);
});

test("every per-block limit is rejected with a reason to act on", () => {
  // Markdown: each fenced block at most 200 lines, the second one named.
  const fence = (n, marker = "```") => `${marker}log\n${"line\n".repeat(n)}${marker}`;
  assert.ok(checkBriefSection(section("Markdown", { text: `${fence(200)}\n\n${fence(200, "~~~")}` })));
  const block = first(section("Markdown", { text: `Intro\n\n${fence(3)}\n\n${fence(340)}` }));
  assert.equal(block.code, "block_too_long");
  assert.equal(block.path, "body.elements.it.props.text");
  assert.equal(block.reason, 'Markdown "it" code block 2 has 340 lines; the limit is 200. Keep a short excerpt here and leave the full log or code on its Task. (brief_guide content)');
  assert.equal(first(section("Markdown", { text: `\`\`\`\n${"x\n".repeat(201)}` })).code, "block_too_long", "an unclosed fence runs to the end");
  assert.deepEqual(fencedBlockLines("a\n````md\n```\ninner\n```\n````\n~~~\n1\r\n2\n~~~"), [3, 2]);
  assert.deepEqual(fencedBlockLines("``` not a `fence`\nplain"), []);
  // The body: 64,000 UTF-8 bytes of compact JSON, measured as sent.
  const big = first(section("Markdown", { text: "表".repeat(22_000) }));
  assert.equal(big.code, "too_large");
  assert.match(big.reason, /bytes of compact JSON; the limit is 64000/);
  assert.equal(BRIEF_LIMITS.bodyBytes, MAX_SPEC_BYTES);
  assert.ok(checkBriefSection(section("Markdown", { text: "表".repeat(21_000) })));
  // Lists: 30 items.
  const many = (type, key, make) => first(section(type, { [key]: items(31, make) }));
  for (const [type, key, make] of [
    ["Checklist", "items", (i) => ({ id: `i${i}`, text: "t", done: false })],
    ["Plan", "steps", (i) => ({ id: `s${i}`, text: "t", state: "todo" })],
    ["Findings", "items", (i) => ({ id: `f${i}`, source: "s", severity: "low", text: "t" })],
  ]) {
    const found = many(type, key, make);
    assert.equal(found.code, "too_many", type);
    assert.equal(found.reason.split(";")[0], `${type} "it" ${key} has 31 items`);
    assert.match(found.reason, /the limit is 30\./);
  }
  assert.match(first(section("Metrics", { items: items(13, (i) => ({ label: "m", value: i })) })).reason, /has 13 items; the limit is 12\. .*Table/);
  // Table: 200 rows, 12 columns; the full table stays on its Task (T-172).
  const table = (rows, columns) => section("Table", {
    id: "t", columns: items(columns, (i) => ({ key: `c${i}`, label: "C" })),
    rows: items(rows, (i) => ({ id: `r${i}`, cells: Object.fromEntries(items(columns, (c) => [`c${c}`, 1])) })),
  });
  const rows = first(table(201, 1));
  assert.equal(rows.path, "body.elements.it.props.rows");
  assert.match(rows.reason, /has 201 items; the limit is 200\. .*leave the full table on its Task/);
  assert.equal(rows.guide, "brief_guide content");
  assert.match(first(table(1, 13)).reason, /has 13 items; the limit is 12/);
  // Charts: 500 inline points in total, 12 series.
  const chart = (props) => section("LineChart", { id: "c", title: "C", x: { label: "x" }, y: { label: "y" }, ...props }, props.data ? csv : {});
  const total = first(chart({ series: [{ name: "a", points: points(300) }, { name: "b", points: points(201) }] }));
  assert.equal(total.code, "too_many_points");
  assert.match(total.reason, /has 501 inline points; the limit is 500 across all series\. .*data:\{attachment, x, series\}/);
  assert.equal(total.guide, "brief_guide charts");
  assert.equal(first(chart({ series: [{ name: "a", points: points(501) }] })).guide, "brief_guide charts");
  assert.equal(first(chart({ series: items(13, (i) => ({ name: `s${i}`, points: [[0, 1]] })) })).code, "too_many");
  assert.equal(first(chart({ data: { attachment: "data.csv", x: "x", series: items(13, (i) => ({ name: `s${i}`, column: "y" })) } })).code, "too_many");
  assert.ok(checkBriefSection(chart({ series: items(12, (i) => ({ name: `s${i}`, points: [[0, 1]] })) })));
  assert.equal(first(chart({})).code, "chart_data");
  assert.equal(first(chart({ series: [{ name: "a", points: [[0, 1]] }], data: { attachment: "data.csv", x: "x", series: [{ name: "a", column: "y" }] } })).code, "chart_data");
  assert.equal(first(section("ScatterChart", { id: "c", x: { label: "x" }, y: { label: "y" }, series: [{ name: "a", points: [["label", 1]] }] })).path, "body.elements.it.props.series.0.points.0.0");
  // LiveRefs: 50 per section, summed over every LiveRefs element.
  const refs = (n) => ({ type: "LiveRefs", props: { items: items(n, (i) => ({ kind: "task", id: `T-${i}` })) } });
  const twoRefs = section("LiveRefs", refs(30).props);
  twoRefs.body.elements.more = refs(21);
  twoRefs.body.elements.body.children.push("more");
  const summed = first(twoRefs);
  assert.equal(summed.code, "too_many_refs");
  assert.match(summed.reason, /51 LiveRefs items; the limit is 50 per section, across all LiveRefs/);
  twoRefs.body.elements.more = refs(20);
  assert.ok(checkBriefSection(twoRefs));
  // Attachments: 12 per section.
  const files = items(13, (i) => ({ name: `f${i}.txt`, path: `/tmp/f${i}.txt` }));
  const tooMany = first(section("Markdown", { text: "x" }, { attachments: files }));
  assert.equal(tooMany.path, "attachments");
  assert.match(tooMany.reason, /has 13 items; the limit is 12\. A section has at most 12 attachments/);
  assert.ok(checkBriefSection(section("Attachments", { items: files.slice(0, 12).map(({ name }) => ({ name })) }, { attachments: files.slice(0, 12) })));
  assert.equal(first(section("Attachments", { items: items(13, (i) => ({ name: `f${i}.txt` })) }, { attachments: files.slice(0, 12) })).code, "too_many");
  // The tree: 32 components, depth 6, one root, every element used.
  const wide = section("Markdown", { text: "x" });
  for (let i = 0; i < 31; i++) wide.body.elements[`m${i}`] = { type: "Markdown", props: { text: "x" } };
  wide.body.elements.body.children = Object.keys(wide.body.elements).filter((key) => key !== "body");
  assert.equal(first(wide).code, "component_count");
  delete wide.body.elements.m30;
  wide.body.elements.body.children.pop();
  assert.ok(checkBriefSection(wide));
  const deep = section("Markdown", { text: "x" });
  let parent = "body";
  for (let i = 0; i < 6; i++) {
    deep.body.elements[`g${i}`] = { type: "Group", props: { title: "G" }, children: [] };
    deep.body.elements[parent].children = [`g${i}`];
    parent = `g${i}`;
  }
  deep.body.elements[parent].children = ["it"];
  assert.equal(first(deep).code, "not_a_tree");
  const shared = section("Markdown", { text: "x" });
  shared.body.elements.body.children = ["it", "it"];
  assert.equal(first(shared).code, "not_a_tree");
  const unused = section("Markdown", { text: "x" });
  unused.body.elements.extra = { type: "Markdown", props: { text: "y" } };
  assert.deepEqual(first(unused), {
    code: "unused_component", path: "body.elements",
    reason: 'Element "extra" is not reachable from the root; add it as a child or remove it. (brief_guide content)',
    guide: "brief_guide content",
  });
  const missing = section("Markdown", { text: "x" });
  missing.body.elements.body.children.push("ghost");
  assert.equal(first(missing).code, "missing_component");
  assert.equal(first({ ...section("Markdown", { text: "x" }), body: { root: "it", elements: section("Markdown", { text: "x" }).body.elements } }).code, "root");
  const twoRoots = section("Markdown", { text: "x" });
  twoRoots.body.elements.inner = { type: "BriefBody", props: {} };
  twoRoots.body.elements.body.children.push("inner");
  assert.equal(first(twoRoots).code, "extra_root");
  const leaf = section("Markdown", { text: "x" });
  leaf.body.elements.it.children = ["body"];
  assert.match(first(leaf).reason, /cannot have children; only BriefBody, Group and Columns do/);
  // Columns: 2 to 4 children, one width from 1 to 4 per child when given.
  const columns = (count, props = {}) => {
    const spec = section("Columns", props);
    spec.body.elements.it.children = items(count, (i) => `c${i}`);
    for (let i = 0; i < count; i++) spec.body.elements[`c${i}`] = { type: "Group", props: { tone: "muted" }, children: [] };
    return spec;
  };
  assert.ok(checkBriefSection(columns(2)));
  assert.deepEqual(checkBriefSection(columns(4, { widths: [4, 1, 1, 2] })).body.elements.it.props.widths, [4, 1, 1, 2]);
  assert.equal(first(columns(1)).path, "body.elements.it.children");
  assert.equal(first(columns(5)).path, "body.elements.it.children");
  assert.deepEqual(first(columns(3, { widths: [2, 1] })), {
    code: "columns_widths", path: "body.elements.it.props.widths",
    reason: 'Columns "it" has 3 children but 2 widths; give one width per child, or leave widths out for equal columns. (brief_guide content)',
    guide: "brief_guide content",
  });
  assert.equal(first(columns(2, { widths: [0, 1] })).path, "body.elements.it.props.widths.0");
  assert.equal(first(columns(2, { widths: [5, 1] })).path, "body.elements.it.props.widths.0");
  assert.equal(first(columns(2, { widths: [1.5, 1] })).path, "body.elements.it.props.widths.0");
  // Group: a title and a tone are both optional; the tone is one of three.
  assert.ok(checkBriefSection(section("Group", {})));
  assert.equal(first(section("Group", { tone: "red" })).path, "body.elements.it.props.tone");
  assert.equal(first(section("Group", { tone: "accent", style: "x" })).path, "body.elements.it.props");
  // Math: 4000 characters.
  assert.equal(first(section("Math", { tex: "x".repeat(4001) })).code, "too_long");
});

test("references, ids and attachments are checked mechanically", () => {
  const files = (list) => ({ attachments: list });
  // Names in Attachments and a chart's data must exist; charts read data files with a path.
  const shown = first(section("Attachments", { items: [{ name: "plot.png" }] }, csv));
  assert.equal(shown.code, "missing_attachment");
  assert.equal(shown.path, "body.elements.it.props.items.0.name");
  const chart = (attachments) => section("BarChart", { id: "c", title: "C", x: { label: "x" }, y: { label: "y" }, data: { attachment: "data", x: "x", series: [{ name: "y", column: "y" }] } }, files(attachments));
  assert.equal(first(chart([{ name: "other", path: "/a/data.csv" }])).code, "missing_attachment");
  assert.equal(first(chart([{ name: "data", path: "/a/data.txt" }])).code, "chart_attachment");
  assert.equal(first(chart([{ name: "data", url: "https://example.com/data.csv" }])).code, "chart_attachment");
  for (const path of ["/a/data.csv", "/a/data.JSON", "/a/data.jsonl", "C:\\runs\\data.csv"]) assert.ok(checkBriefSection(chart([{ name: "data", path }])), path);
  // Attachments: exactly one of an absolute path or an https url; unique names.
  const one = (attachment) => first(section("Markdown", { text: "x" }, files([attachment])));
  assert.equal(one({ name: "a" }).code, "attachment_location");
  assert.equal(one({ name: "a", path: "/a", url: "https://example.com" }).code, "attachment_location");
  assert.equal(one({ name: "a", path: "relative/file.txt" }).path, "attachments.0.path");
  assert.equal(one({ name: "a", url: "http://example.com" }).path, "attachments.0.url");
  assert.equal(one({ name: "a", url: "https://user:pw@example.com" }).path, "attachments.0.url");
  for (const name of ["..", ".", "a/b", "", "a".repeat(81)]) assert.equal(one({ name, path: "/a" }).path, "attachments.0.name", name);
  assert.equal(first(section("Markdown", { text: "x" }, files([{ name: "a", path: "/a" }, { name: "a", path: "/b" }]))).code, "duplicate_attachment");
  // Unique ids, as result_publish.
  assert.equal(first(section("Checklist", { items: [{ id: "a", text: "t", done: true }, { id: "a", text: "u", done: false }] })).code, "duplicate_id");
  assert.equal(first(section("Plan", { steps: [{ id: "a", text: "t", state: "todo" }, { id: "a", text: "u", state: "done" }] })).code, "duplicate_id");
  const tableAndChart = section("Table", { id: "same", columns: [{ key: "c", label: "C" }], rows: [] });
  tableAndChart.body.elements.chart = { type: "LineChart", props: { id: "same", x: { label: "x" }, y: { label: "y" }, series: [{ name: "a", points: [[0, 1]] }] } };
  tableAndChart.body.elements.body.children.push("chart");
  assert.equal(first(tableAndChart).code, "duplicate_id");
  assert.equal(first(section("Table", { id: "t", columns: [{ key: "c", label: "C" }], rows: [{ id: "r", cells: {} }] })).code, "row_mismatch");
  assert.equal(first(section("Table", { id: "t", columns: [{ key: "c", label: "C" }], rows: [{ id: "r", cells: { c: 1 }, sourceIds: ["nowhere"] }] })).code, "missing_source");
  assert.equal(first(section("Sources", { items: [{ id: "s", label: "S", href: "javascript:alert(1)" }] })).code, "invalid_source");
  // Several problems come back together, at most MAX_PROBLEMS.
  const several = section("Markdown", { text: "```\n" + "x\n".repeat(201) + "```" }, files([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }, { name: "f" }]));
  assert.equal(problems(several).length, MAX_PROBLEMS);
});

test("a body may name its summary and the details that start folded, among the root's own blocks (T-18)", () => {
  const body = (props, extra = {}) => ({
    key: "eval", kind: "report", title: "Eval",
    attachments: [{ name: "a.png", path: "/home/me/run/a.png" }, { name: "b.png", path: "/home/me/run/b.png" },
      { name: "runs.csv", path: "/home/me/run/runs.csv" }, { name: "design", url: "https://example.com/design.png" }],
    body: { root: "body", elements: {
      body: { type: "BriefBody", props, children: ["answer", "holds", "loss", "runs", "shot", "shots", "data", "link", "method", "untitled", "plan"] },
      answer: { type: "Markdown", props: { text: "B lowers loss by 4%." } },
      holds: { type: "Checklist", props: { items: [{ id: "d", text: "Definition v2", done: true }] } },
      loss: { type: "Metrics", props: { items: [{ label: "Loss", value: 0.41 }] } },
      runs: { type: "Table", props: { id: "runs", title: "Runs", columns: [{ key: "m", label: "Model" }], rows: [] } },
      shot: { type: "Attachments", props: { items: [{ name: "a.png" }] } },
      shots: { type: "Attachments", props: { items: [{ name: "a.png" }, { name: "b.png" }] } },
      data: { type: "Attachments", props: { items: [{ name: "runs.csv" }] } },
      link: { type: "Attachments", props: { items: [{ name: "design" }] } },
      method: { type: "Group", props: { title: "Method" }, children: ["method-text"] },
      "method-text": { type: "Markdown", props: { text: "Three seeds." } },
      untitled: { type: "Group", props: {}, children: ["note"] },
      note: { type: "Markdown", props: { text: "A note." } },
      plan: { type: "Plan", props: { steps: [{ id: "s", text: "Run 13", state: "todo" }] } },
      ...extra,
    } },
  });
  // Valid: none at all (every body before T-18), a lead alone, conditions without a visual, each figure kind,
  // each size an author names (Lead 2457), and a summary kept from before sizes, with none (Lead 2473).
  for (const props of [{}, { summary: { lead: "answer" } }, { summary: { lead: "answer", conditions: "holds" } },
    { summary: { lead: "answer", visual: "loss", conditions: "holds" }, details: ["method"] }, { summary: { lead: "answer", visual: "runs" } },
    { summary: { lead: "answer", visual: "shot" } }, { details: ["method"] },
    { summary: { lead: "answer", size: "small" } }, { summary: { lead: "answer", visual: "runs", size: "wide" } },
    { summary: { lead: "answer", visual: "shot", conditions: "holds", size: "large" } }])
    assert.deepEqual(checkBriefSection(body(props)).body.elements.body.props, props, JSON.stringify(props));
  const refused = (props) => problems(body(props));
  assert.deepEqual(refused({ summary: { lead: "method-text" } })[0], { code: "summary", path: "body.elements.body.props.summary.lead",
    reason: 'summary.lead "method-text" is not one of the root\'s own children; name a block directly under the root. (brief_guide content)', guide: "brief_guide content" });
  const code = (props) => refused(props).map((p) => `${p.code} ${p.path.replace("body.elements.body.props.", "")}`);
  assert.deepEqual(code({ summary: { lead: "method" } }), ["summary summary.lead"], "a Group is no lead");
  assert.deepEqual(code({ summary: { lead: "answer", visual: "plan" } }), ["summary summary.visual"]);
  assert.deepEqual(code({ summary: { lead: "answer", visual: "shots" } }), ["summary summary.visual"], "several files are not one figure");
  assert.deepEqual(code({ summary: { lead: "answer", visual: "data" } }), ["summary summary.visual"], "a data file is not a figure");
  assert.deepEqual(code({ summary: { lead: "answer", visual: "link" } }), ["summary summary.visual"], "a link is never shown as an image");
  // An image as Core classifies it (attachments.rs): by the path's extension when Core knows it, else by the name's.
  const figure = (file) => body({ summary: { lead: "answer", visual: "one" } }, { one: { type: "Attachments", props: { items: [{ name: file.name }] } } });
  const withFile = (file) => { const value = figure(file); value.attachments = [...value.attachments, file]; value.body.elements.body.children.push("one"); return value; };
  for (const file of [{ name: "shot.png", path: "/home/me/capture" }, { name: "shot.png", path: "/home/me/capture.bin" }, { name: "capture", path: "/home/me/SHOT.PNG" },
    { name: "plot.JPEG", path: "/home/me/plot" }, { name: "s", path: "/home/me/run.d/s.webp" },
    // A file named ".png" has no extension to Rust: the name decides.
    { name: "shot.png", path: "/home/me/.png" }])
    assert.equal(checkBriefSection(withFile(file)).body.elements.body.props.summary.visual, "one", JSON.stringify(file));
  for (const file of [{ name: "shot.png", path: "/home/me/data.csv" }, { name: "shot.png", path: "/home/me/page.HTML" }, { name: "notes", path: "/home/me/capture" },
    { name: "shot.png", path: "/home/me/run.d/notes.txt" }, { name: "shot.png", url: "https://example.com/shot.png" }])
    assert.deepEqual(problems(withFile(file)).map((p) => p.path), ["body.elements.body.props.summary.visual"], JSON.stringify(file));
  assert.deepEqual(code({ summary: { lead: "answer", conditions: "loss" } }), ["summary summary.conditions"]);
  assert.deepEqual(code({ summary: { lead: "answer", visual: "answer" } }), ["summary summary.visual"], "each block once");
  assert.deepEqual(code({ summary: { lead: "answer", visual: "loss", conditions: "missing" } }), ["summary summary.conditions"]);
  assert.deepEqual(code({ details: ["untitled", "plan", "note", "method", "method"] }),
    ["details details.0", "details details.1", "details details.2", "details details.4"]);
  assert.deepEqual(code({ summary: { lead: "answer" }, details: ["answer"] }), ["details details.0"]);
  // The shape is the schema's: a lead is required, nothing else is taken.
  assert.equal(refused({ summary: { visual: "loss" } })[0].code, "missing_field");
  assert.equal(refused({ summary: { lead: "answer", figure: "loss" } })[0].code, "unknown_field");
  assert.equal(refused({ summary: ["answer"] })[0].code, "invalid_field");
  // A size is one of three, as written; anything else is refused where it stands.
  for (const size of ["huge", "Wide", "1x2", 2, null])
    assert.deepEqual(refused({ summary: { lead: "answer", size } }).map((p) => `${p.code} ${p.path}`), ["invalid_field body.elements.body.props.summary.size"], JSON.stringify(size));
  assert.equal(refused({ details: [] })[0].code, "invalid_field");
  const content = briefGuide("content");
  assert.match(content, /give the BriefBody summary \{lead, visual\?, conditions\?, size\}: lead, visual and conditions are ids of the root's own blocks/);
  // The size is the author's to name with every summary; one without it is advised, not refused (Lead 2457, 2473).
  assert.match(content, /size is the room the card takes among Home's cards: small \(one column[^)]*\), wide \(two columns[^)]*\) or large \(two columns, two rows[^)]*\)\. Name it with every summary/);
  assert.match(content, /A summary without one is still accepted \(advice summary_size_missing\), and Home guesses its card's size from its figure\./);
  assert.match(content, /details lists titled Groups of supporting detail .* nothing else folds\. Without summary, the page shows the body in your order\. Either way, Sources and Attachments directly under the root show beside the body \(after it on a narrow screen\), never behind a click\./);
  assert.match(content, /^- BriefBody \{summary\?\{lead, visual\?, conditions\?, size\?="small"\|"wide"\|"large"\}, details\?\[1-32\]\(string\)\}: The root of every section body\./m);
});

test("registered screenshots need reachable exact-name uses, not prose or source links", () => {
  for (const key of ["tasks-board", "development"]) {
    const change = section("Markdown", { text: "See preview.png" }, {
      key, attachments: [{ name: "preview.png", path: "/tmp/preview.png" }],
    });
    const error = first(change);
    assert.equal(error.code, "unused_attachment");
    assert.equal(error.path, "attachments.0.name");
    assert.equal(error.guide, "brief_guide attachments");
    assert.match(error.reason, /reachable Attachments block/);
    assert.match(error.reason, /put the section without this registration/);
    assert.equal(change.attachments.length, 1, "rejection must not remove a registration");
    change.body.elements.it = { type: "Sources", props: { items: [{ id: "image", label: "Preview", href: "/tmp/preview.png" }] } };
    assert.equal(first(change).code, "unused_attachment");
    change.body.elements.image = { type: "Attachments", props: { items: [{ name: "preview.png" }] } };
    assert.equal(first(change).code, "unused_component", "an orphaned reference cannot count");
    change.body.elements.body.children.push("image");
    assert.ok(checkBriefSection(change));
    change.body.elements.image.props.items[0].name = "Preview.png";
    assert.ok(problems(change).some((p) => p.code === "missing_attachment"), "names are case-sensitive");
  }
});

test("all chart data consumers count, with or without a separate preview or another consumer", () => {
  for (const type of ["LineChart", "BarChart", "ScatterChart"]) {
    const change = section(type, { id: "chart", x: { label: "Step" }, y: { label: "Loss" },
      data: { attachment: "data.csv", x: "step", series: [{ name: "Loss", column: "loss" }] } }, csv);
    assert.ok(checkBriefSection(change), `${type}: data-only use`);
    change.body.elements.preview = { type: "Attachments", props: { items: [{ name: "data.csv" }] } };
    change.body.elements.body.children.push("preview");
    assert.ok(checkBriefSection(change), `${type}: data and preview reuse`);
    const previous = structuredClone(change.body);
    change.body.elements.it = { type: "Markdown", props: { text: "Chart removed, preview kept." } };
    assert.ok(checkBriefSection(change, previous), "removing one of two consumers is allowed");
    change.body.elements.preview = { type: "Markdown", props: { text: "Now unused." } };
    assert.equal(problems(change, previous)[0].code, "unused_attachment", "removing the last consumer is rejected");
  }
});

test("only internal edit context tolerates legacy unused attachments; puts remain strict", () => {
  const legacy = section("Markdown", { text: "Old section" }, csv);
  const previous = structuredClone(legacy.body);
  legacy.body.elements.it.props.text = "Unrelated update";
  assert.ok(checkBriefSection(legacy, previous));
  assert.equal(first(legacy).code, "unused_attachment", "full replacement must repair old omissions");
  assert.equal(first({ ...legacy, previousBody: previous }).code, "unknown_field", "Agent envelopes cannot opt out");
  const repaired = structuredClone(legacy);
  repaired.body.elements.it = { type: "Attachments", props: { items: [{ name: "data.csv" }] } };
  assert.ok(checkBriefSection(repaired, previous));
  assert.equal(problems(legacy, repaired.body)[0].code, "unused_attachment", "once repaired, it cannot regress");
  assert.match(briefGuide("attachments"), /Image preview example/);
  assert.match(briefGuide("attachments"), /Chart-only data example/);
  assert.match(briefGuide("attachments"), /unrelated edit keeps already-unused/);
});

test("schema problems name the field, the component's props and the guide part", () => {
  const unknown = first(section("Findings", { items: [{ id: "f", source: "s", severity: "low", text: "t" }], color: "red" }));
  assert.equal(unknown.code, "unknown_field");
  assert.equal(unknown.path, "body.elements.it.props");
  assert.match(unknown.reason, /Findings "it" has unknown field "color"\. Findings props: \{title\?, items\[1-30\]\{id, source, severity: info\|low\|medium\|high\|critical, text\}\}/);
  const component = first(section("Html", { html: "<b>" }));
  assert.equal(component.code, "unknown_component");
  assert.match(component.reason, /Unknown component type "Html".*Use one of: BriefBody, Group, Columns, Markdown/);
  const envelope = problems({ ...section("Markdown", { text: "x" }), kind: "note", extra: 1 });
  assert.deepEqual(envelope.map((p) => [p.code, p.path, p.guide]), [
    ["invalid_field", "kind", "brief_guide sections"],
    ["unknown_field", "", "brief_guide sections"],
  ]);
  assert.match(envelope[1].reason, /Fields: \{key, kind: ask\|report\|status, title, body\{…\}/);
  assert.equal(first({ ...section("Markdown", { text: "x" }), op: "resolve" }).code, "unknown_field", "only a put is a section");
  assert.equal(first(7).code, "invalid_section");
  const noBody = section("Markdown", { text: "x" });
  delete noBody.body;
  assert.match(first(noBody).reason, /body is required\. body is \{root, elements\} with a BriefBody root/);
  const chart = first(section("LineChart", { id: "c", x: { label: "x" }, y: {}, series: [{ name: "a", points: [[0, 1]] }] }));
  assert.equal(chart.path, "body.elements.it.props.y.label");
  assert.equal(chart.guide, "brief_guide charts");
  assert.match(first(section("Markdown", { text: "x" }, { title: "x".repeat(121) })).reason, /title has 121 characters; the limit is 120/);
  assert.match(first({ ...section("Markdown", { text: "x" }), body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["1x"] }, "1x": { type: "Markdown", props: { text: "x" } } } } }).reason, /must start with a letter/);
});

test("hard rules, tool descriptions and the guide are generated within their caps", () => {
  assert.ok(BRIEF_HARD_RULES.length <= 1500, `${BRIEF_HARD_RULES.length} characters`);
  for (const [name, description] of Object.entries(BRIEF_TOOL_DESCRIPTIONS)) {
    // brief_update carries its ops and the common components' props (YN-14); every tool stays within DESCRIPTION_CAP.
    assert.ok(description.length <= (name === "brief_update" ? DESCRIPTION_CAP : 1200), `${name}: ${description.length} characters`);
    assert.ok(description.length <= DESCRIPTION_CAP);
    assert.match(description, /brief_guide/, `${name} names the guide`);
  }
  assert.deepEqual(Object.keys(BRIEF_TOOL_DESCRIPTIONS), ["brief_get", "brief_update", "brief_guide"]);
  // T-154: no turn has to end with a Brief update; outcomes have a place.
  const rules = BRIEF_HARD_RULES.split("\n");
  assert.match(rules[1], /No Brief update is required each turn: write when something changed/);
  assert.match(rules[1], /status.*report linked to its Task.*ask; yuzuno-ui blocks never reach Home/);
  assert.doesNotMatch(BRIEF_HARD_RULES, /requiresTurnUpdate|noChange/);
  for (const description of Object.values(BRIEF_TOOL_DESCRIPTIONS)) assert.doesNotMatch(description, /requiresTurnUpdate|per turn\b|each turn then/);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_get, /keys: omit for every section with its body; \[\] for an index/);
  assert.match(briefGuide("sections"), new RegExp(`What goes where: ${BRIEF_OUTCOME_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(BRIEF_HARD_RULES, /editContent is false.*only your own Asks/);
  assert.match(briefGuide("errors"), /ask_only.*removing your own older sections.*A Project's leads edit Home; the user chooses them\./);
  // YN-2 S4: the leads edit Home; an Ask-only member may also take down its own older sections.
  assert.match(rules[3], /^3\. Leads edit Home; the user chooses leads\. If editContent is false and writeOwnAsk is true, write only your own Asks\./);
  assert.match(briefGuide(), /When editContent is false and writeOwnAsk is true, only create\/update\/resolve\/remove your own Asks, remove your own older sections, or send noChange/);
  assert.doesNotMatch(BRIEF_HARD_RULES, /selects Home content editors/);
  for (const phrase of [/expectedVersion/, /version_conflict.*re-read.*merge/, /only their own sections.*topic\/sub/, /question plus .*options, freeText, a form or a choice/, /Resolve your asks explicitly/, /never executes actions/, /brief_guide/])
    assert.match(BRIEF_HARD_RULES, phrase);
  assert.ok(rules.findIndex((line) => /never executes actions/.test(line)) < rules.findIndex((line) => /brief_guide for formats/.test(line)));
  // T-132: when a replied ask is resolved, and what a reply never grants.
  assert.match(rules[4], /A reply marks it replied\. Resolve your asks explicitly.*a preference once taken in, an authorized action only after it is done/);
  assert.match(rules[4], /A reply executes nothing itself: act on what the user authorized, a reply included, and infer no retry, merge or permission it does not grant\./);
  assert.match(briefGuide("ask"), /act on what the user has authorized, an explicit reply included, without asking for it again/);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_get, /repliedAsks \(your asks the user answered, to act on and resolve\)/);
  assert.match(briefGuide("ask"), /brief_get lists it in you\.repliedAsks.*nothing closes it for you/);
  assert.match(briefGuide("ask"), /only after that action is confirmed done.*A green CI or a whole Task being done is not that action/);
  assert.match(briefGuide("ask"), /edit keeps it replied, while put asks it again/);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_update, /expectedVersion.*requestId.*noChange:true/);
  for (const op of ["put", "edit", "patch", "resolve", "remove", "claim"]) assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_update, new RegExp(`op:"${op}"`));
  // patch, as Core applies it (YN-14 A2): RFC 6902 on the body, the whole section checked again.
  assert.match(briefGuide("sections"), /^patch \{op:"patch", key, patch:\[\.\.\.\], status\?\} changes single values .* RFC 6902 operations .* Core checks the whole section again/m);
  assert.match(briefGuide("errors"), /patch_path and patch_test/);
  // edit, as Core applies it: blocks by id, the rest kept, the root left to put.
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_update, /edit \{op:"edit", key, elements:\{<id>: block\}\} replaces only those blocks;/);
  assert.match(briefGuide("sections"), /^edit \{op:"edit", key, elements:\{<id>: \{type, props, children\?\}\}, status\?\} replaces blocks .* the root is not edited \(rearrange with put\)\./m);
  assert.match(briefGuide("errors"), /unknown_element and edit_root/);
  for (const part of BRIEF_GUIDE_PARTS) assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_guide, new RegExp(part));
  // The guide: every component with its description and props, every part, every code.
  const guide = briefGuide();
  assert.deepEqual(briefGuide(), guide, "deterministic");
  for (const [type, description] of Object.entries(BRIEF_COMPONENT_DESCRIPTIONS))
    assert.ok(guide.includes(`- ${type} {`) && guide.includes(description), type);
  // Signatures come from the formatter result_guide uses (T-86), with string limits.
  assert.match(guide, /- Table \{id, title\?(≤\d+)?, columns\[1-12\]\{key, label(≤\d+)?\}, rows\[≤200\]/);
  assert.match(guide, /points\[1-500\].*Each point is an \[x, y\] pair\./);
  for (const code of Object.keys(BRIEF_PROBLEM_CODES)) assert.ok(briefGuide("errors").includes(`- ${code}:`), code);
  for (const part of BRIEF_GUIDE_PARTS) {
    const text = briefGuide(part);
    assert.ok(text.startsWith(`## ${part}\n`), part);
    assert.ok(guide.includes(`\n\n${text}`), `${part} is a slice of the whole guide`);
  }
  assert.throws(() => briefGuide("nope"), /Unknown brief_guide part/);
  for (const example of Object.values(BRIEF_EXAMPLES)) assert.ok(briefGuide("examples").includes(JSON.stringify(example)));
  assert.match(briefGuide("examples"), /"LineChart".*"attachment":"loss.csv"/);
  assert.match(briefGuide("examples"), /"Findings"/);
  assert.match(briefGuide("examples"), /"kind":"ask".*"options"/);
  assert.match(briefGuide("examples"), /"kind":"ask".*"form":\{.*"type":"multi"/);
  // What a reference's state is, and what the two missing states ask of the Agent (T-9).
  assert.match(briefGuide("content"), /not found: check its id\. One Core could not read just then shows as couldn't read: leave it/);
  // The shared formatter's line shape, as T-86 agreed: "- Name {signature}: description notes".
  assert.match(guide, /^- Group \{title\?≤\d+, tone\?="plain"\|"accent"\|"muted"\}: A group of components with an optional title\. .* Children: at most 24\.$/m);
  // Enums come from the schema (T-131): every value a prop takes, in the legend's notation.
  assert.match(guide, /^- Findings \{title\?≤\d+, items\[1-30\]\{id, source≤\d+, severity="info"\|"low"\|"medium"\|"high"\|"critical", text≤\d+\}\}: /m);
  assert.match(guide, /^- Plan \{title\?≤\d+, steps\[1-30\]\{id, text≤\d+, state="todo"\|"doing"\|"done"\|"blocked"\}\}: /m);
  assert.ok(briefGuide("content").includes(SIGNATURE_LEGEND), "the content part explains the notation");
  assert.match(guide, /^- Columns \{widths\?\[2-4\]\(integer\)\}: Lays out its children side by side.* Children: 2-4, one per column\.$/m);
});

test("a report the user marks seen leaves brief_get, and you.recentlyLeft says which, why and when (YN-7)", () => {
  assert.equal(BRIEF_LIMITS.recentlyLeft, 20);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_get, /recentlyLeft \(your sections that left lately and why: a report the user marked seen is no longer among the sections\), recentlyLeftMore/);
  const sections = briefGuide("sections");
  assert.match(sections, /a report the user marks seen at its latest version leaves brief_get's sections and your ownsKeys at once \(a newer version stays, unseen\) .* put it again under its key to continue it on Home, as edit needs a live section/);
  assert.match(sections, /you\.recentlyLeft lists your sections that left the live Brief in the last 30 days and are not live again, newest first, at most 20: \{key, kind, title, version, reason, at\}, reason seen \(the user marked that version seen\), removed or resolved; recentlyLeftMore counts the rest\./);
  assert.match(sections, /An edit, resolve, remove or claim naming one of them is refused with not_found, saying why it left; put writes it again\./);
});

test("a LiveRefs item and a ResearchDesk plan's link may name a run of stages, and the guide says what it shows (YN-7)", () => {
  const refs = { key: "sweep", kind: "status", title: "Sweep", status: { asOf: "2026-11-07T00:00:00Z", validFor: 3600 },
    body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["refs"] },
      refs: { type: "LiveRefs", props: { items: [{ kind: "run", id: "0c2b5486-e986-4a30-864d-d3b03e73e07b", label: "lr sweep" }] } } } } };
  assert.doesNotThrow(() => checkBriefSection(refs), "a LiveRefs item may name a run of stages");
  assert.equal(checkBriefSection(refs).body.elements.refs.props.items[0].kind, "run");
  const desk = structuredClone(benchmark);
  desk.body.elements.desk.props.plans[0].links = [{ kind: "run", id: "0c2b5486-e986-4a30-864d-d3b03e73e07b" }];
  assert.doesNotThrow(() => checkBriefSection(desk), "a plan's link may name a run of stages");
  assert.equal(checkBriefSection(desk).body.elements.desk.props.plans[0].links[0].kind, "run");
  assert.match(BRIEF_COMPONENT_DESCRIPTIONS.LiveRefs, /run \(a run of stages: the runId job_run_submit returned; Yuzuno shows its status and how many stages are done\)/);
  assert.match(briefGuide("research"), /links name existing tasks, Jobs or runs of stages \(kind run, the runId job_run_submit returned\)/);
});

// YN-7 item 3: a number may be a CSV or TSV row's cell, the row named by the
// text its key columns hold; each read form only from its own kind of file.
test("a ResearchDesk number may be a CSV row's cell named by its key columns, and the guide says how it matches (YN-7)", () => {
  const cell = { from: "table.csv", row: { sport: "alpha", d: "2" }, column: "auc" };
  const withCsv = (number, path = "/home/me/study/table.csv") => {
    const copy = structuredClone(doseStudy);
    copy.attachments.push({ name: "table.csv", path });
    copy.body.elements.desk.props.plots[0].rows[0].estimate.value = number;
    return copy;
  };
  assert.doesNotThrow(() => checkBriefSection(withCsv(cell)), "a row's cell from a .csv");
  assert.doesNotThrow(() => checkBriefSection(withCsv(cell, "/home/me/study/table.TSV")), "a row's cell from a .tsv");
  assert.deepEqual(researchReads(checkBriefSection(withCsv(cell)).body.elements.desk.props)[0], { at: "low-v2.value", ...cell });
  // table.csv then holds no read and is flagged too; the read's own problem is the one here.
  const fromJson = problems(withCsv({ ...cell, from: "results.json" })).find((found) => found.code === "research_attachment");
  assert.equal(fromJson.code, "research_attachment");
  assert.match(fromJson.reason, /reads a row's cell from CSV or TSV files only/);
  assert.equal(first(withCsv({ from: "table.csv", pointer: "/0/auc" })).code, "research_attachment", "a JSON Pointer is not a CSV read");
  const wide = first(withCsv({ ...cell, row: { a: "1", b: "2", c: "3", d: "4", e: "5" } }));
  assert.equal(wide.code, "invalid_field");
  assert.match(wide.reason, /Name 1 to 4 columns/);
  assert.equal(first(withCsv({ ...cell, row: {} })).code, "invalid_field", "a row names at least one column");
  assert.equal(first(withCsv({ ...cell, column: " " })).code, "invalid_field", "a column has a name");
  assert.equal(first(withCsv({ ...cell, pointer: "/0" })).code, "invalid_field", "a pointer or a row, not both");
  assert.equal(BRIEF_PROBLEM_CODES.research_attachment, "A ResearchDesk number read from an attachment of the wrong kind: a JSON Pointer needs a .json file, a CSV row a .csv or .tsv file, each with a path.");
  const guide = briefGuide("research");
  assert.match(guide, /\{from, row, column\} for one whose path ends in \.csv or \.tsv/);
  assert.match(guide, /Cells compare as text as written, without the spaces around them: "2" does not match "2\.0"\. No matching row shows as missing, two or more as ambiguous, never a guess/);
});

test("contract.json carries the brief, generated from this file", async () => {
  const committed = JSON.parse(await readFile(new URL("../../runtimes/result-validator/contract.json", import.meta.url), "utf8"));
  const brief = describeBrief();
  assert.deepEqual(committed.brief, JSON.parse(JSON.stringify(brief)), "stale: npm run build:result-validator");
  assert.deepEqual(Object.keys(committed.brief).sort(), ["guide", "guideParts", "hardRules", "limits", "outcomeHint", "schemaVersion", "toolDescriptions"]);
  assert.equal(committed.brief.outcomeHint, BRIEF_OUTCOME_HINT);
  assert.equal(committed.brief.schemaVersion, BRIEF_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(committed.brief.guideParts), [...BRIEF_GUIDE_PARTS]);
  assert.equal(committed.brief.guide, briefGuide());
  for (const part of BRIEF_GUIDE_PARTS) assert.equal(committed.brief.guideParts[part], briefGuide(part));
});

test("a ResearchDesk: two different desks render from one contract, and every reference is checked (T-9)", () => {
  for (const fixture of [doseStudy, benchmark]) assert.ok(checkBriefSection(fixture), fixture.key);
  // Only the numbers named by a snapshot are Core's to read.
  const reads = researchReads(doseStudy.body.elements.desk.props);
  assert.equal(reads.length, 10);
  assert.deepEqual(reads[0], { at: "low-v2.value", from: "results.json", pointer: "/v2/low/diff" });
  assert.ok(!reads.some((read) => read.at.startsWith("low-v1")), "literal numbers are the Agent's own");
  assert.equal(researchReads(benchmark.body.elements.desk.props).length, 12);
  assert.equal(benchmark.body.elements.desk.props.plots[0].scale, 100, "a display scale is part of the contract");

  const desk = (change) => {
    const copy = structuredClone(doseStudy);
    change(copy.body.elements.desk.props, copy);
    return copy;
  };
  const rejected = (change) => {
    const found = first(desk(change));
    assert.equal(found.guide, found.code === "missing_attachment" ? "brief_guide attachments" : "brief_guide research", JSON.stringify(found));
    return found;
  };
  const dupe = rejected((p) => { p.plots[1].rows[0].id = "low-v2"; });
  assert.equal(dupe.code, "duplicate_id");
  assert.equal(dupe.path, "body.elements.desk.props.plots.1.rows.0.id");
  assert.match(dupe.reason, /row and part id "low-v2" is used twice/);
  assert.equal(rejected((p) => { p.claims[0].primary = "nowhere"; }).code, "missing_reference");
  assert.equal(rejected((p) => { p.claims[0].plots.push("nowhere"); }).code, "missing_reference");
  assert.equal(rejected((p) => { p.plots[0].rows[0].estimate.cite.source = "nowhere"; }).path, "body.elements.desk.props.plots.0.rows.0.estimate.cite.source");
  assert.equal(rejected((p) => { p.plots[0].rows[0].estimate.definition.version = 3; }).code, "missing_reference");
  assert.equal(rejected((p) => { p.claims[0].statements[0].basis = ["nowhere"]; }).code, "missing_reference");
  assert.equal(rejected((p) => { p.claims[0].dependsOn = [{ id: "recovery", version: 9 }]; }).code, "missing_reference");
  assert.equal(rejected((p) => { p.plans[0].inputs[0].source = "nowhere"; }).code, "missing_reference");
  const unsaved = rejected((p) => { delete p.sources[1].snapshot; });
  assert.equal(unsaved.code, "unsaved_definition");
  assert.match(unsaved.reason, /must point to a file this section keeps/);
  // A Task method record holds a definition version too (T-17): the record
  // keeps its own identity, so the section needs no attachment for it.
  // (the CS layout study: each definition version cites its own method record).
  assert.ok(checkBriefSection(layoutStudy));
  assert.deepEqual(researchReads(layoutStudy.body.elements.desk.props), [], "nothing is read from a file");
  assert.equal(first(desk((p) => { p.sources[1].task = { taskId: "17", activitySeq: 42 }; })).code, "invalid_field", "a task ID is T-n");
  // T-56: a Task record is named by T-n or a Project task key, in canonical capitals only.
  const keyed = structuredClone(layoutStudy);
  const record = keyed.body.elements.desk.props.sources[0].task;
  // The record's taskId as the contract takes it, or the first problem's code.
  const taken = () => {
    try {
      return checkBriefSection(keyed).body.elements.desk.props.sources[0].task.taskId;
    } catch {
      return first(keyed).code;
    }
  };
  record.taskId = "YN-3";
  assert.equal(taken(), "YN-3", "a Project task key names the record's task");
  for (const taskId of ["yn-3", "Y-3", "YN3"]) {
    record.taskId = taskId;
    assert.equal(taken(), "invalid_field", `${taskId} is not a task key`);
  }
  const both = rejected((p) => { p.sources[1].task = { taskId: "T-17", activitySeq: 42 }; });
  assert.equal(both.code, "invalid_field");
  assert.match(both.reason, /names both a snapshot and a Task record/);
  assert.equal(rejected((p) => { p.definitions[0].versions[1].version = 1; }).code, "duplicate_id");
  assert.equal(rejected((p) => { p.revisions[0].definition = { id: "recovery", from: 2, to: 1 }; }).code, "definition_order");
  assert.equal(rejected((p) => { p.revisions[0].claim = "nowhere"; }).code, "missing_reference");
  // Numbers come only from this section's attachments; a JSON Pointer only from a JSON file.
  const unregistered = rejected((p) => { p.plots[0].rows[0].estimate.value.from = "other.json"; });
  assert.equal(unregistered.code, "missing_attachment");
  assert.equal(unregistered.path, "body.elements.desk.props.plots.0.rows.0.estimate.value.from");
  const csv = rejected((p, copy) => {
    copy.attachments.push({ name: "table.csv", path: "/home/me/study/table.csv" });
    p.plots[0].rows[0].estimate.value.from = "table.csv";
  });
  assert.equal(csv.code, "research_attachment");
  assert.equal(first(desk((p) => { p.plots[0].rows[0].estimate.value.pointer = "v2/low"; })).code, "invalid_field", "a pointer starts with /");
  // A plan's links count as LiveRefs of the section.
  const links = desk((p, copy) => {
    p.plans[0].links = [{ kind: "task", id: "T-1" }];
    copy.body.elements.body.children.push("refs");
    copy.body.elements.refs = { type: "LiveRefs", props: { items: items(50, (i) => ({ kind: "task", id: `T-${i + 2}` })) } };
  });
  assert.equal(first(links).code, "too_many_refs");
  // A desk's files count as used; a file nothing reads is still flagged.
  const unused = desk((p, copy) => { copy.attachments.push({ name: "spare.json", path: "/home/me/study/spare.json" }); });
  assert.equal(first(unused).code, "unused_attachment");
  // The guide has a part of its own, and content points to it.
  assert.ok(BRIEF_GUIDE_PARTS.includes("research"));
  assert.match(briefGuide("research"), /A Job that succeeded is not a result that holds/);
  assert.match(briefGuide("research"), /Neither is a check of the research/);
  assert.match(briefGuide("content"), /- ResearchDesk: see research\./);
});

// T-29: two rules a desk is refused for are stated in the guide an Agent reads
// before writing one, as the check applies them: a source's revision is a
// commit hash, and row and part ids are one namespace across the whole desk.
test("the guide says when to pre-check, how a settled claim leaves a status for a report, and what a claim's primary names (YN-7 S1)", () => {
  // Item 2: the write makes the same checks, so a section sent now needs no pre-check.
  const sections = briefGuide("sections");
  assert.match(sections, /brief_update itself makes the same checks and writes nothing when it refuses, so a section you mean to send now needs no pre-check: send it, fix what the rejection lists and send again with a new requestId\. Use validateOnly to check without writing, e\.g\. a draft you will not send in this Turn\./);
  assert.doesNotMatch(briefGuide(), /Use it for a complex section/);
  // Item 5: a moving conclusion in a status, a settled claim in a report.
  assert.match(sections, /While a conclusion still moves, keep it in a status and refresh it with new facts; once a claim settles, write it as a report under its own key linked to its Task, which the user marks seen and history keeps, and let the status point to it or drop it\. A status keeps only its current version: putting it again replaces the earlier wording\./);
  // Item 6: primary is a row id, and the rejection says so, naming a plot or part id given instead.
  assert.match(briefGuide("research"), /Claims: primary is the id of one row of the desk's plots \(plots\[\]\.rows\[\]\.id\), the row the claim leads with; not a plot or part id\. plots lists plot ids\./);
  const primary = (id) => {
    const copy = structuredClone(doseStudy);
    copy.body.elements.desk.props.claims[0].primary = id;
    return first(copy);
  };
  for (const [id, said] of [["recovery-v2", `; "recovery-v2" is a plot id.`], ["low-v2-arm", `; "low-v2-arm" is a part id.`], ["nowhere", "."]]) {
    const found = primary(id);
    assert.equal(found.code, "missing_reference", id);
    assert.equal(found.path, "body.elements.desk.props.claims.0.primary", id);
    assert.ok(found.reason.includes(`primary "${id}" is not a row of its plots: primary is a row id (plots[].rows[].id)${said}`), found.reason);
  }
});

test("the research guide states the revision form and the desk-wide row and part ids, as checked (T-29)", () => {
  const guide = briefGuide("research");
  assert.match(guide, /revision is a commit hash, 7 to 64 lowercase hexadecimal characters \(not a branch, tag or other name\)/);
  assert.match(guide, /Row and part ids share one namespace across the whole desk, every plot included: each is used once/);
  const desk = (change) => {
    const copy = structuredClone(doseStudy);
    change(copy.body.elements.desk.props);
    return copy;
  };
  for (const hash of ["0f3a9c1", "a".repeat(40), "b".repeat(64)])
    assert.ok(checkBriefSection(desk((p) => { p.sources[0].revision = hash; })), hash);
  for (const name of ["main", "v1.2", "0F3A9C1", "0f3a9c", "a".repeat(65)])
    assert.equal(first(desk((p) => { p.sources[0].revision = name; })).path, "body.elements.desk.props.sources.0.revision", name);
  // A part may not take a row's id, in its own plot or in another.
  for (const [plot, id] of [[0, "high-v2"], [0, "low-v1"]]) {
    const found = first(desk((p) => { p.plots[plot].rows[0].parts[0].id = id; }));
    assert.equal(found.code, "duplicate_id", id);
    assert.match(found.reason, new RegExp(`row and part id "${id}" is used twice`), id);
  }
});

// YN-3 PR C2: Agents read on the guide that an attached HTML page shows on its card, and when a card is the whole report.
test("YN-3 the guide says a card with no visual shows its first kept image or HTML page, working, and that a card holding all its body is the whole report", () => {
  const content = briefGuide("content");
  assert.match(content, /A card with no visual shows instead the first kept image or single HTML page \(\.html or \.htm\) its Attachments show, and names up to three other files under it; an HTML page shows working on the card, in the same sandbox as its Preview, and opens large from there\./);
  assert.match(content, /A report whose body holds only its lead \(one paragraph\), the card's picture and files, and its conditions is the whole report: its card has no Open report\./);
  assert.match(content, /large \(two columns, two rows: an image, a scatter chart, an HTML page\)/);
});

test("a put with markdown instead of body gets the body Core builds for it (YN-14 A3)", () => {
  const text = "**core.25** is out; the two regressions are fixed in core.26.";
  const report = checkBriefSection({ op: "put", key: "release", kind: "report", title: "core.25", markdown: text });
  assert.deepEqual(report.body, { root: "body", elements: {
    body: { type: "BriefBody", props: {}, children: ["text"] },
    text: { type: "Markdown", props: { text } },
  } });
  assert.equal(report.markdown, undefined, "the stored section has its body, not markdown");
  // With attachments, size, and for an ask and a status.
  const files = checkBriefSection({ key: "design", kind: "report", title: "Design", markdown: text, size: "wide",
    attachments: [{ name: "preview.html", path: "/home/me/preview.html" }, { name: "note.md", path: "/home/me/note.md" }] });
  assert.deepEqual(files.body.elements.body, { type: "BriefBody", props: { summary: { lead: "text", size: "wide" } }, children: ["text", "files"] });
  assert.deepEqual(files.body.elements.files, { type: "Attachments", props: { items: [{ name: "preview.html" }, { name: "note.md" }] } });
  assert.equal(files.size, undefined);
  const ask = checkBriefSection({ key: "q", kind: "ask", title: "Q", markdown: "Why: it costs a day.",
    ask: { question: "Run it?", reply: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } } });
  assert.equal(ask.body.elements.text.props.text, "Why: it costs a day.");
  const status = checkBriefSection({ key: "s", kind: "status", title: "S", markdown: "Green.", status: { asOf: "2026-11-07T08:00:00Z", validFor: 600 } });
  assert.equal(status.body.elements.text.props.text, "Green.");
  // What is refused, before anything is built.
  const at = (value) => { const [found] = problems(value); return [found.code, found.path]; };
  assert.deepEqual(at({ key: "r", kind: "report", title: "R", markdown: text, body: report.body }), ["invalid_field", "markdown"]);
  assert.deepEqual(at({ key: "r", kind: "report", title: "R", markdown: "  " }), ["invalid_field", "markdown"]);
  assert.deepEqual(at({ key: "r", kind: "report", title: "R", markdown: 3 }), ["invalid_field", "markdown"]);
  assert.deepEqual(at({ key: "r", kind: "report", title: "R", markdown: text, size: "huge" }), ["invalid_field", "size"]);
  assert.deepEqual(at({ ...report, size: "wide" }), ["invalid_field", "size"], "size goes with markdown");
  assert.deepEqual(at({ key: "r", kind: "report", title: "R" }), ["missing_field", "body"], "neither is still a missing body");
  assert.match(briefGuide("sections"), /^- markdown instead of body, for a section that is text: Core makes the body one Markdown block "text"/m);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_update, /body\|markdown/);
});

test("brief_update's description names the common components with their props, generated from the catalog (YN-14 A4)", () => {
  const hints = briefComponentHints();
  assert.ok(BRIEF_TOOL_DESCRIPTIONS.brief_update.includes(`elements are {type, props, children?}: ${hints}; the rest in brief_guide content.`));
  for (const type of BRIEF_DESCRIBED_COMPONENTS) {
    assert.ok(Object.hasOwn(briefComponentProps, type), type);
    const shape = briefComponentProps[type].shape;
    const shown = hints.match(new RegExp(`(?:^| )${type}\\{(.*?)\\}(?= [A-Z]|$)`))?.[1] ?? "";
    for (const prop of Object.keys(shape).filter((prop) => !["sourceIds", "selectable"].includes(prop)))
      assert.match(shown, new RegExp(`\\b${prop}\\b`), `${type} shows ${prop}`);
  }
  assert.match(hints, /Findings\{title\?, items\[\{id, source, severity: info\|low\|medium\|high\|critical, text\}\]\}/);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_update, /reply: options\[\{id, label\}\]/);
  // Truthful about HTML in Markdown (YN-14 S4): sanitized, not refused.
  assert.match(BRIEF_COMPONENT_DESCRIPTIONS.Markdown, /HTML written in it is sanitized/);
  assert.doesNotMatch(briefGuide(), /Raw HTML is not supported/);
});

// YN-16 S1: inputs, the variables they declare and the visible conditions
// that read them, as the contract checks them for Core.

/** A report whose root holds one Group of these blocks. */
const inGroup = (elements, extra = {}) => ({
  key: "demo", kind: "report", title: "Demo", ...extra,
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: {}, children: ["box"] },
    box: { type: "Group", props: {}, children: Object.keys(elements) },
    ...elements,
  } },
});
const guests = { type: "NumberInput", props: { name: "guests", label: "Guests", value: 4, min: 1, max: 12 } };
const vegan = { type: "Switch", props: { name: "vegan", label: "Vegan", value: false } };
const view = { type: "Segmented", props: { name: "view", label: "View", value: "side", options: [{ value: "side", label: "Side" }, { value: "top", label: "Top" }] } };
const shown = (visible) => ({ type: "Markdown", visible, props: { text: "Shown for some values." } });
const withProps = (node, props) => ({ ...node, props: { ...node.props, ...props } });
const codes = (found) => found.map((one) => [one.code, one.path]);

test("YN-16 inputs declare variables of their own name, and visible reads them", () => {
  for (const blocks of [
    { guests }, { vegan }, { view },
    { view: withProps(view, { value: 2, options: [{ value: 1, label: "1" }, { value: 2, label: "2" }, { value: 3.5, label: "3.5" }] }) },
    { guests: withProps(guests, { step: 0.25, value: 1.75, digits: 2, prefix: "¥", control: "slider" }) },
  ])
    assert.ok(checkBriefSection(inGroup(blocks)), JSON.stringify(blocks));
  for (const visible of [
    { $state: "/vegan" }, { $state: "/vegan", not: true }, { $state: "/vegan", eq: true }, { $state: "/vegan", neq: false },
    { $state: "/guests", eq: 4 }, { $state: "/guests", neq: 4 }, { $state: "/guests", gt: 2 }, { $state: "/guests", gte: 2 },
    { $state: "/guests", lt: 2 }, { $state: "/guests", lte: 2, not: true }, { $state: "/view", eq: "top" }, { $state: "/view", neq: "side" },
    [{ $state: "/vegan" }, { $state: "/guests", gte: 6 }],
    { $and: [{ $state: "/vegan" }, { $or: [{ $state: "/view", eq: "top" }, { $state: "/guests", gt: 1 }] }] },
    { $or: [[{ $state: "/vegan" }, { $state: "/guests", gt: 1 }], { $state: "/view", eq: "top" }] },
    { $or: [{ $state: "/vegan" }, { $state: "/guests", lt: 3 }] },
  ])
    assert.ok(checkBriefSection(inGroup({ guests, vegan, view, note: shown(visible) })), JSON.stringify(visible));
  // In a Group inside Columns, and on a Group or Columns inside a Group.
  const nested = {
    key: "demo", kind: "report", title: "Demo",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["cols"] },
      cols: { type: "Columns", props: {}, children: ["left", "right"] },
      left: { type: "Group", props: {}, children: ["vegan", "inner"] },
      right: { type: "Group", props: {}, children: ["note"] },
      vegan,
      note: shown({ $state: "/vegan" }),
      inner: { type: "Columns", visible: { $state: "/vegan", not: true }, props: {}, children: ["a", "b"] },
      a: { type: "Markdown", props: { text: "a" } },
      b: { type: "Group", props: {}, children: [] },
    } },
  };
  assert.ok(checkBriefSection(nested));
  // The interactive example of the guide is a valid section that uses all three kinds of condition.
  assert.ok(checkBriefSection(BRIEF_EXAMPLES.interactive));
});

test("YN-16 a variable's name is a lower-case word, declared once, at most 16 in a section", () => {
  for (const name of ["Guests", "1a", "a-b", "a".repeat(33), "constructor", "toString"]) {
    const found = first(inGroup({ guests: withProps(guests, { name }) }));
    assert.deepEqual([found.code, found.path, found.guide], ["invalid_field", "body.elements.guests.props.name", "brief_guide interactive"], name);
  }
  const twice = first(inGroup({ guests, again: withProps(vegan, { name: "guests" }) }));
  assert.deepEqual([twice.code, twice.path], ["duplicate_id", "body.elements.again.props.name"]);
  assert.match(twice.reason, /Switch "again" declares the variable "guests", which another input of this section declares too/);
  const many = Object.fromEntries(items(17, (i) => [`v${i}`, withProps(vegan, { name: `v${i}` })]));
  const over = first(inGroup(many));
  assert.deepEqual([over.code, over.path], ["too_many", "body.elements"]);
  assert.match(over.reason, /declare 17 variables; the limit is 16/);
  assert.ok(checkBriefSection(inGroup(Object.fromEntries(items(16, (i) => [`v${i}`, withProps(vegan, { name: `v${i}` })])))));
});

test("YN-16 a NumberInput's range and a Segmented's options are checked, with the field to change", () => {
  const number = (props) => problems(inGroup({ guests: withProps(guests, props) }));
  assert.deepEqual(codes(number({ min: 12, max: 12 })), [["invalid_field", "body.elements.guests.props.max"]]);
  assert.deepEqual(codes(number({ min: 5, value: 4 })), [["invalid_field", "body.elements.guests.props.value"]]);
  assert.deepEqual(codes(number({ value: 13 })), [["invalid_field", "body.elements.guests.props.value"]]);
  assert.deepEqual(codes(number({ step: 0 })), [["invalid_field", "body.elements.guests.props.step"]]);
  assert.deepEqual(codes(number({ step: -1 })), [["invalid_field", "body.elements.guests.props.step"]]);
  const steps = number({ min: 0, max: 1000, step: 0.001 });
  assert.deepEqual(codes(steps), [["invalid_field", "body.elements.guests.props.step"]]);
  assert.match(steps[0].reason, /takes 1000000 steps of 0.001 from min to max; the limit is 100000/);
  assert.ok(checkBriefSection(inGroup({ guests: withProps(guests, { min: 0, max: 100, step: 0.001 }) })), "exactly 100000 steps");
  assert.match(first(inGroup({ guests: withProps(guests, { control: "dial" }) })).reason, /control must be "stepper" or "slider" or "both"/);
  assert.equal(first(inGroup({ guests: withProps(guests, { value: Number.NaN }) })).code, "invalid_field");
  const segmented = (props) => problems(inGroup({ view: withProps(view, props) }));
  const mixed = segmented({ options: [{ value: "side", label: "Side" }, { value: 2, label: "Two" }] });
  assert.deepEqual(codes(mixed), [["invalid_field", "body.elements.view.props.options"]]);
  assert.match(mixed[0].reason, /options mix numbers and texts/);
  assert.deepEqual(codes(segmented({ options: [{ value: "side", label: "Side" }, { value: "side", label: "Again" }] })), [["duplicate_id", "body.elements.view.props.options"]]);
  const missing = segmented({ value: "front" });
  assert.deepEqual(codes(missing), [["invalid_field", "body.elements.view.props.value"]]);
  assert.match(missing[0].reason, /value "front" is not one of its options' values: "side", "top"/);
  assert.equal(segmented({ options: [{ value: "side", label: "Side" }] })[0].code, "invalid_field", "fewer than 2 options");
  assert.equal(segmented({ options: items(7, (i) => ({ value: `o${i}`, label: `O${i}` })), value: "o0" })[0].code, "too_many", "more than 6 options");
  for (const found of [...number({ min: 12, max: 12 }), ...mixed, ...missing]) assert.equal(found.guide, "brief_guide interactive");
});

test("YN-16 visible is refused unless it reads a declared variable with a value of its kind, inside a Group", () => {
  const refused = (visible) => problems(inGroup({ guests, vegan, view, note: shown(visible) }));
  for (const [visible, code, path, reason] of [
    [{ $item: "x" }, "unknown_field", "body.elements.note.visible", /unknown field "\$item"; a condition is \{"\$state": "\/<variable>"/],
    [{ $index: true }, "unknown_field", "body.elements.note.visible", /"\$index"/],
    [{ $state: "/vegan", $bindState: "/vegan" }, "unknown_field", "body.elements.note.visible", /"\$bindState"/],
    [{ $cond: { $state: "/vegan" } }, "unknown_field", "body.elements.note.visible", /"\$cond"/],
    [{ $state: "vegan" }, "invalid_field", "body.elements.note.visible.$state", /"\$state": "\/" and a variable's name.*variables: \/guests, \/vegan, \/view/],
    [{ $state: "/salt" }, "invalid_field", "body.elements.note.visible.$state", /reads "\/salt", which no input of this section declares/],
    [{ $state: "/vegan", gt: 1 }, "invalid_field", "body.elements.note.visible.gt", /gt compares a number variable with a number; "\/vegan" is a boolean variable: use eq or neq/],
    [{ $state: "/guests", gt: "2" }, "invalid_field", "body.elements.note.visible.gt", /"2" is not a number/],
    [{ $state: "/guests", eq: "4" }, "invalid_field", "body.elements.note.visible.eq", /"\/guests" is a number variable; eq needs a number, not "4"/],
    [{ $state: "/vegan", eq: "yes" }, "invalid_field", "body.elements.note.visible.eq", /boolean variable/],
    [{ $state: "/view", eq: "front" }, "invalid_field", "body.elements.note.visible.eq", /"front" is none of its options' values: "side", "top"/],
    [{ $state: "/view", eq: { $state: "/view" } }, "invalid_field", "body.elements.note.visible.eq", /text variable/],
    [{ $state: "/guests" }, "invalid_field", "body.elements.note.visible", /"\/guests" is a number variable: compare it, e\.g\. \{"\$state": "\/guests", "gte": 2\}/],
    [{ $state: "/view" }, "invalid_field", "body.elements.note.visible", /compare it, e\.g\. \{"\$state": "\/view", "eq": "side"\}/],
    [{ $state: "/guests", gt: 1, lt: 9 }, "invalid_field", "body.elements.note.visible", /compares with gt and lt; one comparison per condition/],
    [{ $state: "/vegan", not: false }, "invalid_field", "body.elements.note.visible.not", /not is true, to negate it, or left out/],
    [true, "invalid_field", "body.elements.note.visible", /is a condition, e\.g\. \{"\$state": "\/vegan"\}.*not true/],
    [[], "invalid_field", "body.elements.note.visible", /An array in "note" visible is empty/],
    [[[{ $state: "/vegan" }]], "invalid_field", "body.elements.note.visible.0", /holds only conditions/],
    [[{ $or: [{ $state: "/vegan" }] }], "invalid_field", "body.elements.note.visible.0", /holds only conditions/],
    [{ $and: [] }, "invalid_field", "body.elements.note.visible.$and", /lists one or more conditions/],
    [{ $and: [{ $state: "/vegan" }], $or: [] }, "unknown_field", "body.elements.note.visible", /has "\$or" beside it/],
    [{ $and: [{ $or: [{ $and: [{ $state: "/vegan" }] }] }] }, "invalid_field", "body.elements.note.visible.$and.0.$or.0.$and.0", /nests deeper than 3 levels/],
    [items(9, () => ({ $state: "/vegan" })), "too_many", "body.elements.note.visible", /has 9 conditions; the limit is 8/],
  ]) {
    const found = refused(visible);
    assert.deepEqual([found[0].code, found[0].path, found[0].guide], [code, path, "brief_guide interactive"], JSON.stringify(visible));
    assert.match(found[0].reason, reason, JSON.stringify(visible));
  }
  assert.ok(checkBriefSection(inGroup({ vegan, note: shown(items(8, () => ({ $state: "/vegan" }))) })), "8 conditions");
  // Only a block inside a Group: never the root's own blocks, a Columns' columns or the root.
  const top = section("Markdown", { text: "x" });
  top.body.elements.it.visible = { $state: "/vegan" };
  const onTop = first(top);
  assert.deepEqual([onTop.code, onTop.path], ["invalid_field", "body.elements.it.visible"]);
  assert.match(onTop.reason, /"it" has visible, which only a block inside a Group may have: the root's own blocks are always shown/);
  const column = inGroup({ vegan });
  column.body.elements.body.children.push("cols");
  Object.assign(column.body.elements, {
    cols: { type: "Columns", props: {}, children: ["a", "b"] },
    a: shown({ $state: "/vegan" }),
    b: { type: "Markdown", props: { text: "b" } },
  });
  assert.match(first(column).reason, /the root's own blocks and the columns of a Columns are always shown/);
  const root = inGroup({ vegan });
  root.body.elements.body.visible = { $state: "/vegan" };
  assert.deepEqual(codes([first(root)]), [["unknown_field", "body.elements.body"]]);
});

test("YN-16 S1 still refuses events, watches, repeats, spec state and expressions in props", () => {
  for (const extra of [
    { on: { press: { action: "setState", params: { statePath: "/vegan", value: true } } } },
    { watch: { "/vegan": { action: "setState", params: { statePath: "/guests", value: 2 } } } },
    { repeat: { statePath: "/items" } },
  ]) {
    const found = first(inGroup({ vegan, note: { ...shown(undefined), ...extra } }));
    assert.deepEqual([found.code, found.path], ["unknown_field", "body.elements.note"], JSON.stringify(extra));
    assert.match(found.reason, /Elements are \{type, props, children\?, visible\?\}/);
  }
  const state = inGroup({ vegan });
  state.body.state = { vegan: true };
  assert.deepEqual(codes([first(state)]), [["unknown_field", "body"]]);
  const expression = first(inGroup({ guests, m: { type: "Metrics", props: { items: [{ label: "Guests", value: { $state: "/guests" } }] } } }));
  assert.equal(expression.code, "invalid_field");
  assert.equal(expression.path, "body.elements.m.props.items.0.value");
  assert.equal(first(inGroup({ guests: withProps(guests, { value: { $state: "/guests" } }) })).code, "invalid_field");
});

test("YN-16 a summary may name a Group of inputs as its visual, the card's own figure", () => {
  const card = (box) => ({
    key: "demo", kind: "report", title: "Demo",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "box", size: "wide" } }, children: ["lead", "box"] },
      lead: { type: "Markdown", props: { text: "Try the amounts." } },
      box,
      guests, vegan, note: shown({ $state: "/vegan" }), m: { type: "Metrics", props: { items: [{ label: "a", value: 1 }] } },
      inner: { type: "Group", props: {}, children: [] },
    } },
  });
  const group = (children) => ({ type: "Group", props: {}, children });
  const used = (box) => {
    const value = card(box);
    for (const key of ["guests", "vegan", "note", "m", "inner"]) if (!box.children.includes(key)) delete value.body.elements[key];
    return value;
  };
  assert.ok(checkBriefSection(used(group(["guests", "vegan", "note", "m"]))));
  assert.ok(checkBriefSection(used(group(["vegan"]))), "one input alone");
  for (const [children, why] of [
    [["note", "m"], "no input"],
    [["guests", "inner"], "a Group inside"],
  ]) {
    const found = first(used(group(children)));
    assert.deepEqual([found.code, found.path, found.guide], ["summary", "body.elements.body.props.summary.visual", "brief_guide interactive"], why);
    assert.match(found.reason, /summary\.visual "box" is a Group, which is a figure only as a Group of inputs: 1-6 blocks of its own, each NumberInput, Switch, Segmented, Button, Calc, Diagram, Figure, Steps, Timeline, Markdown, Metrics, at least one an input/);
  }
  const seven = used(group(["guests", "vegan", "note", "m"]));
  Object.assign(seven.body.elements, Object.fromEntries(items(3, (i) => [`x${i}`, { type: "Markdown", props: { text: `${i}` } }])));
  seven.body.elements.box.children.push("x0", "x1", "x2");
  assert.equal(first(seven).code, "summary", "7 blocks");
  // A summary block is the root's own: it is always shown.
  const hidden = used(group(["guests"]));
  hidden.body.elements.box.visible = { $state: "/guests", gt: 1 };
  assert.equal(first(hidden).path, "body.elements.box.visible");
});

test("YN-16 the guide's interactive part states what the checks check", () => {
  const part = briefGuide("interactive");
  for (const type of ["NumberInput", "Switch", "Segmented"]) assert.ok(part.includes(`- ${type} {name, `), type);
  assert.match(part, /never saved, never sent to you and never runs anything/);
  assert.match(part, /a letter a-z, then up to 31 letters or digits.*declared once per section, at most 16 in all/);
  assert.match(part, /takes at most 100000 steps from min to max; digits is how many decimals are shown \(default: as many as step, min or max has\)/);
  assert.match(part, /only a block inside a Group has one, as the root's own blocks are always shown/);
  assert.match(part, /eq or neq a value of the variable's kind \(for a Segmented, one of its options' values\), or gt, gte, lt or lte a number/);
  assert.match(part, /at most 8 conditions and 3 levels\. Nothing else is read: no \$item, \$index, \$cond, \$bindState or \$computed/);
  assert.match(part, /name a Group of inputs as the summary's visual: 1-6 blocks of its own, each NumberInput, Switch, Segmented, Button, Calc, Diagram, Figure, Steps, Timeline, Markdown, Metrics, at least one an input/);
  assert.ok(part.includes(JSON.stringify(BRIEF_EXAMPLES.interactive)));
  assert.match(briefGuide("content"), /\{type, props, children\?, visible\?\} \(visible: see interactive\)/);
  assert.match(briefGuide("content"), /or a Group of inputs the reader sets on the card, see interactive\)/);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_guide, /research, interactive, attachments/);
  assert.equal(BRIEF_LIMITS.variables, 16);
});

// YN-16 S2: Calc formulas and a Button's press.
const calc = (items, extra = {}) => ({ type: "Calc", props: { items, ...extra } });
const press = (on) => ({ type: "Button", props: { label: "Reset" }, on });
const setState = (statePath, value) => ({ action: "setState", params: { statePath, value } });

test("YN-16 S2 a Calc's formulas read the section's variables and its earlier items, and give their type", () => {
  const items = [
    { id: "flour", label: "Flour", expr: "250 * guests / 4", unit: "g", digits: 0 },
    { id: "fat", label: "Fat", expr: "vegan ? flour / 10 : flour / 8" },
    { id: "trays", label: "Trays", expr: "ceil(guests / 6)", when: "trays > 1 && view == 'top'", emphasis: true },
  ];
  assert.ok(checkBriefSection(inGroup({ guests, vegan, view, sums: calc(items, { layout: "metrics", title: "Amounts" }) })));
  assert.ok(checkBriefSection(BRIEF_EXAMPLES.calculator));
  const refusedAt = (item, field) => {
    const found = problems(inGroup({ guests, vegan, view, sums: calc([items[0], item]) }));
    assert.equal(found[0].guide, "brief_guide interactive");
    assert.equal(found[0].path, `body.elements.sums.props.items.1.${field}`);
    return found[0];
  };
  for (const [expr, reason] of [
    ["fetch('x')", /item "x" expr "fetch\('x'\)", at character 1: fetch\(\) is not a formula function/],
    ["flour = 2", /at character 7: = assigns/],
    ["window.location", /at character 7: \. reads a property/],
    ["salt * 2", /at character 1: "salt" is neither a variable of this section nor an earlier item of this Calc; it may use guests, vegan, view, flour/],
    ["x + 1", /"x" is neither/],
    ["vegan", /expr gives a boolean; expr gives a number/],
    ["view", /expr gives a text/],
    ["guests +", /the formula ends where a value is expected/],
  ]) {
    const found = refusedAt({ id: "x", label: "X", expr }, "expr");
    assert.equal(found.code, "formula", expr);
    assert.match(found.reason, reason, expr);
  }
  assert.match(refusedAt({ id: "x", label: "X", expr: "1", when: "guests" }, "when").reason, /when gives a number; when gives true or false/);
  assert.equal(refusedAt({ id: "x", label: "X", expr: "1", when: "later > 1" }, "when").code, "formula");
  assert.match(briefGuide("errors"), /^- formula: A Calc expr or when that does not parse.*the reason says at which character \(see interactive\)\.$/m);
  // An item reads only earlier items: a later one, or one of another Calc, is unknown.
  const order = problems(inGroup({ guests, sums: calc([{ id: "a", label: "A", expr: "b + 1" }, { id: "b", label: "B", expr: "2" }]) }));
  assert.match(order[0].reason, /"b" is neither a variable of this section nor an earlier item/);
  const other = problems(inGroup({ guests, one: calc([{ id: "a", label: "A", expr: "1" }]), two: calc([{ id: "b", label: "B", expr: "a" }]) }));
  assert.equal(other[0].path, "body.elements.two.props.items.0.expr");
});

test("YN-16 S2 a Calc item's id is a name, once in its Calc and none of the variables; formulas are bounded", () => {
  const item = (id, expr = "1") => ({ id, label: id, expr });
  assert.equal(first(inGroup({ guests, sums: calc([item("total-sum")]) })).path, "body.elements.sums.props.items.0.id");
  const twice = first(inGroup({ guests, sums: calc([item("a"), item("a")]) }));
  assert.deepEqual([twice.code, twice.path], ["duplicate_id", "body.elements.sums.props.items.1.id"]);
  const shadow = first(inGroup({ guests, sums: calc([item("guests")]) }));
  assert.deepEqual([shadow.code, shadow.path], ["duplicate_id", "body.elements.sums.props.items.0.id"]);
  assert.match(shadow.reason, /has the name of a variable of this section/);
  assert.ok(checkBriefSection(inGroup({ one: calc([item("a")]), two: calc([item("a")]) })), "each Calc has its own ids");
  assert.equal(first(inGroup({ sums: calc(items(13, (i) => item(`a${i}`))) })).code, "too_many");
  // 48 formulas in a section, expr and when together.
  const many = (count) => Object.fromEntries(items(Math.ceil(count / 12), (c) => [`c${c}`, calc(items(Math.min(12, count - c * 12), (i) => item(`a${i}`)))]));
  assert.ok(checkBriefSection(inGroup(many(48))));
  const over = first(inGroup(many(49)));
  assert.deepEqual([over.code, over.path], ["too_many", "body.elements"]);
  assert.match(over.reason, /49 Calc formulas \(expr and when\); the limit is 48/);
  assert.equal(first(inGroup({ sums: calc([item("a", "1+".repeat(120) + "1")]) })).code, "too_long", "the schema's own length");
});

test("YN-16 S2 only a Button takes on, and its press only sets declared variables to values they take", () => {
  const ok = (on) => assert.ok(checkBriefSection(inGroup({ guests, vegan, view, reset: press(on) })), JSON.stringify(on));
  ok({ press: setState("/guests", 4) });
  ok({ press: [setState("/guests", 1), setState("/vegan", true), setState("/view", "top"), setState("/guests", 12)] });
  const refusedOn = (on) => problems(inGroup({ guests, vegan, view, reset: press(on) }))[0];
  for (const [on, code, path, reason] of [
    [undefined, "missing_field", "body.elements.reset.on", /Button "reset" needs on: \{"press": \{"action": "setState"/],
    [{ click: setState("/guests", 4) }, "unknown_field", "body.elements.reset.on", /on has one event, press/],
    [{ press: [] }, "invalid_field", "body.elements.reset.on.press", /press has 0 actions; give 1 to 4/],
    [{ press: items(5, () => setState("/guests", 4)) }, "too_many", "body.elements.reset.on.press", /press has 5 actions/],
    [{ press: { action: "pushState", params: { statePath: "/guests", value: 4 } } }, "invalid_field", "body.elements.reset.on.press", /can only setState/],
    [{ press: { action: "fetch", params: { url: "https://example.com" } } }, "invalid_field", "body.elements.reset.on.press", /nothing else runs from a section/],
    [{ press: { ...setState("/guests", 4), confirm: true } }, "unknown_field", "body.elements.reset.on.press", /unknown field "confirm"/],
    [{ press: { action: "setState", params: { statePath: "/guests", value: 4, extra: 1 } } }, "invalid_field", "body.elements.reset.on.press.params", /params are \{"statePath"/],
    [{ press: setState("/salt", 4) }, "invalid_field", "body.elements.reset.on.press.params.statePath", /sets "\/salt", which is not "\/" and a variable an input of this section declares/],
    [{ press: setState("guests", 4) }, "invalid_field", "body.elements.reset.on.press.params.statePath", /which is not "\/"/],
    [{ press: setState("/guests", "4") }, "invalid_field", "body.elements.reset.on.press.params.value", /"\/guests" is a number variable; Button "reset" sets it to "4"/],
    [{ press: setState("/guests", 13) }, "invalid_field", "body.elements.reset.on.press.params.value", /from 1 to 12; 13 is outside/],
    [{ press: setState("/view", "front") }, "invalid_field", "body.elements.reset.on.press.params.value", /"front" is none of its options' values/],
    [{ press: [setState("/guests", 4), setState("/vegan", 1)] }, "invalid_field", "body.elements.reset.on.press.1.params.value", /boolean variable/],
  ]) {
    const found = refusedOn(on);
    assert.deepEqual([found.code, found.path, found.guide], [code, path, "brief_guide interactive"], JSON.stringify(on));
    assert.match(found.reason, reason, JSON.stringify(on));
  }
  // Any other block with on is refused by its shape, as before.
  const calcOn = first(inGroup({ guests, sums: { ...calc([{ id: "a", label: "A", expr: "1" }]), on: { press: setState("/guests", 4) } } }));
  assert.deepEqual([calcOn.code, calcOn.path], ["unknown_field", "body.elements.sums"]);
});

test("YN-16 S2 a Calc may be a summary's visual, and a Group of inputs may hold a Calc and a Button", () => {
  const body = (visual, box) => ({
    key: "demo", kind: "report", title: "Demo",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", visual, size: "wide" } }, children: ["lead", "box"] },
      lead: { type: "Markdown", props: { text: "Amounts." } },
      box, guests, sums: calc([{ id: "a", label: "A", expr: "guests * 2" }]), reset: press({ press: setState("/guests", 4) }),
    } },
  });
  const group = { type: "Group", props: {}, children: ["guests", "sums", "reset"] };
  assert.ok(checkBriefSection(body("box", group)));
  // A Calc alone as the visual: its inputs elsewhere, the card works it out from the starting values.
  const alone = body("sums", { type: "Group", props: {}, children: ["guests", "reset"] });
  alone.body.elements.body.children = ["lead", "sums", "box"];
  assert.ok(checkBriefSection(alone));
});

test("YN-16 S2 the guide gives the formula language, the functions and the Button's press as checked", () => {
  const part = briefGuide("interactive");
  for (const type of ["Calc", "Button"]) assert.ok(part.includes(`- ${type} {`), type);
  assert.match(part, /with \+ - \* \/ % \^ \(power, right to left: -2\^2 is -4\), < <= > >= == !=, && \|\| !, cond \? a : b/);
  assert.match(part, /round\(1-2\), floor\(1\), ceil\(1\), abs\(1\), sqrt\(1\), min\(2-4\), max\(2-4\), clamp\(3\)/);
  assert.match(part, /round\(1\.005, 2\) is 1\.01/);
  assert.match(part, /no =, no \. or \[ \], no other names or functions\. At most 240 characters, 80 parts and 8 levels each, 48 formulas per section, 12 items per Calc/);
  assert.match(part, /when may also use the item's own/);
  assert.match(part, /on: \{"press": action or a list of 1-4\}, each \{"action": "setState", "params": \{"statePath": "\/<name>", "value": v\}\}.*Nothing else runs from a Button, and no other block takes on\./);
  assert.ok(part.includes(JSON.stringify(BRIEF_EXAMPLES.calculator)));
  // Every figure the check accepts is named where the guide says what a visual may be (S4 R1 P3).
  assert.match(briefGuide("content"), /visual one figure \(a chart, Metrics, Calc, Diagram, Figure, Steps, Timeline, Table, ResearchDesk, Attachments with one image file, or a Group of inputs/);
  assert.equal(BRIEF_LIMITS.formulas, 48);
});

// YN-16 S3: a Diagram's nodes and edges, and the variable its select names.
const diagram = (props = {}) => ({ type: "Diagram", props: {
  nodes: [{ id: "frame", label: "Frame" }, { id: "chain", label: "Chain", detail: "Moves the wheel." }, { id: "gear", label: "Rear gears", shape: "diamond", tone: "accent" }],
  edges: [{ from: "frame", to: "chain" }, { from: "chain", to: "gear", label: "drives", style: "dashed" }, { from: "gear", to: "chain" }],
  ...props,
} });

test("YN-16 S3 a Diagram's edges join two different nodes it has, once each way", () => {
  assert.ok(checkBriefSection(section("Diagram", diagram().props)));
  assert.ok(checkBriefSection(BRIEF_EXAMPLES.flowchart));
  const edges = (list) => problems(section("Diagram", diagram({ edges: list }).props))[0];
  for (const [list, code, path, reason] of [
    [[{ from: "frame", to: "wheel" }], "invalid_field", "body.elements.it.props.edges.0", /edge 1 joins "wheel", which no node of the Diagram has/],
    [[{ from: "frame", to: "frame" }], "invalid_field", "body.elements.it.props.edges.0", /goes from "frame" to itself/],
    [[{ from: "frame", to: "chain" }, { from: "frame", to: "chain", label: "again" }], "duplicate_id", "body.elements.it.props.edges.1", /two edges from "frame" to "chain"/],
  ]) {
    const found = edges(list);
    assert.deepEqual([found.code, found.path, found.guide], [code, path, "brief_guide interactive"], JSON.stringify(list));
    assert.match(found.reason, reason);
  }
  const twice = first(section("Diagram", diagram({ nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }], edges: [] }).props));
  assert.equal(twice.code, "duplicate_id");
  assert.equal(first(section("Diagram", diagram({ nodes: items(41, (i) => ({ id: `n${i}`, label: `N${i}` })), edges: [] }).props)).code, "too_many");
  assert.equal(first(section("Diagram", diagram({ edges: items(61, () => ({ from: "frame", to: "chain" })) }).props)).code, "too_many");
  assert.equal(first(section("Diagram", diagram({ nodes: [{ id: "a", label: "x".repeat(61) }], edges: [] }).props)).code, "too_long");
  assert.equal(first(section("Diagram", diagram({ direction: "up" }).props)).code, "invalid_field");
});

test("YN-16 S3 select names a variable of the Diagram's own, or a Segmented's that names every node", () => {
  // Its own: visible and a Button read and set it, "" being nothing selected.
  const own = inGroup({
    parts: diagram({ select: "part" }),
    about: shown({ $state: "/part", eq: "chain" }),
    none: shown({ $state: "/part", eq: "" }),
    reset: press({ press: setState("/part", "") }),
  });
  assert.ok(checkBriefSection(own));
  assert.match(first(inGroup({ parts: diagram({ select: "part" }), about: shown({ $state: "/part", eq: "wheel" }) })).reason, /"wheel" is none of its options' values: "", "frame", "chain", "gear"/);
  // A Segmented's: the segments and the nodes select together.
  const segments = (values) => ({ type: "Segmented", props: { name: "part", value: values[0], options: values.map((value) => ({ value, label: value })) } });
  assert.ok(checkBriefSection(inGroup({ pick: segments(["frame", "chain", "gear"]), parts: diagram({ select: "part" }) })));
  const short = first(inGroup({ pick: segments(["frame", "chain"]), parts: diagram({ select: "part" }) }));
  assert.deepEqual([short.code, short.path], ["invalid_field", "body.elements.parts.props.select"]);
  assert.match(short.reason, /whose options do not name "gear"/);
  const numbers = first(inGroup({ guests, parts: diagram({ select: "guests" }) }));
  assert.match(numbers.reason, /selects into "\/guests", a number variable/);
  assert.equal(first(inGroup({ parts: diagram({ select: "Part" }) })).path, "body.elements.parts.props.select");
  // It counts among the section's 16 variables.
  const many = Object.fromEntries(items(16, (i) => [`v${i}`, withProps(vegan, { name: `v${i}` })]));
  assert.match(first(inGroup({ ...many, parts: diagram({ select: "part" }) })).reason, /inputs and selects declare 17 variables/);
});

test("YN-16 S3 a Diagram may be a summary's visual and part of a Group of inputs; the guide says how it is laid out", () => {
  const body = (visual) => ({ key: "demo", kind: "report", title: "Demo", body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual, size: "large" } }, children: ["lead", "flow", "box"] },
    lead: { type: "Markdown", props: { text: "How it goes." } },
    flow: diagram({ select: "step" }),
    box: { type: "Group", props: {}, children: ["view", "flow2"] },
    view, flow2: diagram(),
  } } });
  assert.ok(checkBriefSection(body("flow")));
  assert.ok(checkBriefSection(body("box")));
  const part = briefGuide("interactive");
  assert.ok(part.includes("- Diagram {"));
  assert.match(part, /you give nodes and edges only; Yuzuno lays them out \(top to bottom, or left to right with direction right, turned top to bottom where the window is too narrow\)/);
  assert.match(part, /A node's shape diamond is a decision, round a start or an end/);
  assert.match(part, /At most 40 nodes and 60 edges/);
  assert.match(part, /select names a variable that then holds the selected node's id \(\"\" while none is\)/);
  assert.ok(part.includes(JSON.stringify(BRIEF_EXAMPLES.flowchart)));
  assert.match(briefGuide("content"), /^- NumberInput, Switch, Segmented, Calc, Button, Diagram, Figure, Steps, Timeline: see interactive\.$/m);
});

// YN-16 S4: a Figure over an image of the section, Steps and a Timeline.
const shot = { attachments: [{ name: "bike.png", path: "/home/me/run/bike.png" }, { name: "notes.txt", path: "/home/me/run/notes.txt" }] };
const figure = (props = {}) => ({ type: "Figure", props: { image: "bike.png", alt: "A seven-speed bike", hotspots: [{ id: "frame", label: "Frame", x: 40, y: 50 }, { id: "chain", label: "Chain", x: 55, y: 70, detail: "Moves the wheel." }], ...props } });

test("YN-16 S4 a Figure shows an image of the section with its hotspots, and counts as showing it", () => {
  const put = (props, extra = shot) => ({ ...section("Figure", figure(props).props), ...extra });
  // Not refused as unused: the Figure shows bike.png; notes.txt is shown by Attachments.
  const both = put({});
  both.body.elements.body.children.push("files");
  both.body.elements.files = { type: "Attachments", props: { items: [{ name: "notes.txt" }] } };
  assert.ok(checkBriefSection(both));
  const alone = put({}, { attachments: [shot.attachments[0]] });
  assert.ok(checkBriefSection(alone));
  for (const [props, extra, code, path, reason] of [
    [{ image: "gone.png" }, { attachments: [shot.attachments[0]] }, "missing_attachment", "body.elements.it.props.image", /"gone.png" is not in this section's attachments/],
    [{ image: "notes.txt" }, { attachments: [shot.attachments[1]] }, "invalid_field", "body.elements.it.props.image", /shows "notes.txt", which is not an image kept with a path/],
    [{ hotspots: [{ id: "a", label: "A", x: 1, y: 1 }, { id: "a", label: "B", x: 2, y: 2 }] }, { attachments: [shot.attachments[0]] }, "duplicate_id", "body.elements.it.props.hotspots", /hotspot id "a" is used twice/],
    [{ hotspots: [{ id: "a", label: "A", x: 101, y: 1 }] }, { attachments: [shot.attachments[0]] }, "invalid_field", "body.elements.it.props.hotspots.0.x", /the most is 100/],
  ]) {
    const found = first(put(props, extra));
    assert.deepEqual([found.code, found.path], [code, path], JSON.stringify(props));
    assert.match(found.reason, reason);
  }
  assert.equal(first(put({ hotspots: items(13, (i) => ({ id: `h${i}`, label: `H${i}`, x: i, y: i })) }, { attachments: [shot.attachments[0]] })).code, "too_many");
  // select: its own variable, or a Segmented's naming every hotspot.
  const parts = { type: "Segmented", props: { name: "part", value: "frame", options: [{ value: "frame", label: "Frame" }, { value: "chain", label: "Chain" }] } };
  assert.ok(checkBriefSection({ ...inGroup({ parts, photo: figure({ select: "part" }) }), ...shot, attachments: [shot.attachments[0]] }));
  const short = first({ ...inGroup({ parts: withProps(parts, { options: [{ value: "frame", label: "Frame" }, { value: "wheel", label: "Wheel" }] }), photo: figure({ select: "part" }) }), attachments: [shot.attachments[0]] });
  assert.match(short.reason, /Figure "photo" selects into "\/part", whose options do not name "chain"/);
});

test("YN-16 S4 Steps and a Timeline: unique ids, their limits, and as a summary's visual", () => {
  const steps = (list, mode) => section("Steps", { ...(mode ? { mode } : {}), steps: list });
  assert.ok(checkBriefSection(steps([{ id: "a", title: "One" }], "walk")));
  assert.equal(first(steps([{ id: "a", title: "One" }, { id: "a", title: "Two" }])).code, "duplicate_id");
  assert.equal(first(steps(items(31, (i) => ({ id: `s${i}`, title: `S${i}` })))).code, "too_many");
  assert.equal(first(steps([{ id: "a", title: "One", time: "x".repeat(25) }])).code, "too_long");
  assert.equal(first(steps([{ id: "a", title: "One" }], "carousel")).code, "invalid_field");
  const timeline = (list) => section("Timeline", { items: list });
  assert.ok(checkBriefSection(timeline([{ id: "a", at: "2026-11-07T08:00:00Z", title: "A", state: "now" }, { id: "b", at: "Week 46", title: "B", state: "next" }])));
  assert.equal(first(timeline([{ id: "a", at: "x", title: "A" }, { id: "a", at: "y", title: "B" }])).code, "duplicate_id");
  assert.equal(first(timeline([{ id: "a", at: "x".repeat(33), title: "A" }])).code, "too_long");
  assert.equal(first(timeline([{ id: "a", at: "x", title: "A", state: "later" }])).code, "invalid_field");
  assert.ok(checkBriefSection(BRIEF_EXAMPLES.timeline));
  for (const visual of ["when", "how"]) {
    const example = JSON.parse(JSON.stringify(BRIEF_EXAMPLES.timeline));
    example.body.elements.body.props.summary.visual = visual;
    assert.ok(checkBriefSection(example), visual);
  }
});

test("YN-16 S4 the guide says how a Figure, Steps and a Timeline are written and read", () => {
  const part = briefGuide("interactive");
  for (const type of ["Figure", "Steps", "Timeline"]) assert.ok(part.includes(`- ${type} {`), type);
  assert.match(part, /image names an image attachment of this section \(see attachments\), which the Figure shows, so it needs no Attachments block/);
  assert.match(part, /x and y, percentages of the image's width and height from its top left corner/);
  assert.match(part, /mode walk shows one step at a time with Back and Next.*For work and its state \(todo, doing, done, blocked\) use Plan\./);
  assert.match(part, /next is a plan, not a promise: say so in its text/);
  assert.ok(part.includes(JSON.stringify(BRIEF_EXAMPLES.timeline)));
  assert.match(briefGuide("attachments"), /as LineChart\/BarChart\/ScatterChart data\.attachment, or as a Figure's image/);
});

test("YN-16 S3 R1 P3: a second Diagram or Figure selecting into the same variable with other ids is told to use a different one", () => {
  const flow = (ids) => ({ type: "Diagram", props: { select: "part", nodes: ids.map((id) => ({ id, label: id })), edges: [] } });
  // Two Diagrams, other ids: the second is told; one set of both is never made.
  const two = problems(inGroup({ one: flow(["frame", "chain"]), two: flow(["frame", "wheel"]) }));
  assert.deepEqual([two[0].code, two[0].path, two[0].guide], ["invalid_field", "body.elements.two.props.select", "brief_guide interactive"]);
  assert.match(two[0].reason, /^Diagram "two" selects into "\/part", but another Diagram or Figure \("one"\) already selects into \/part; use a different variable\./);
  assert.doesNotMatch(two[0].reason, /Segmented/);
  // A Diagram, then a Figure with other ids: the same.
  const mixed = problems({ ...inGroup({ one: flow(["frame", "wheel"]), photo: figure({ select: "part" }) }), attachments: [shot.attachments[0]] });
  assert.match(mixed[0].reason, /^Figure "photo" selects into "\/part", but another Diagram or Figure \("one"\) already selects into \/part; use a different variable\./);
  // The same ids: two views of one choice, accepted.
  assert.ok(checkBriefSection(inGroup({ one: flow(["frame", "chain"]), two: flow(["chain", "frame"]) })));
  // A Segmented's variable missing an id still says so, naming the Segmented.
  const parts = { type: "Segmented", props: { name: "part", value: "frame", options: [{ value: "frame", label: "Frame" }, { value: "chain", label: "Chain" }] } };
  assert.match(first(inGroup({ parts, two: flow(["frame", "wheel"]) })).reason, /whose options do not name "wheel"; give its Segmented an option for every node or hotspot/);
});
