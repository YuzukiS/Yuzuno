// The Project Brief section contract (T-85): one source for a section's
// format, its checks and what Agents are told. Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BRIEF_COMPONENT_DESCRIPTIONS, BRIEF_EXAMPLES, BRIEF_GUIDE_PARTS, BRIEF_HARD_RULES, BRIEF_KEY_PATTERN, BRIEF_LIMITS, BRIEF_OUTCOME_HINT,
  BRIEF_PROBLEM_CODES, BRIEF_SCHEMA_VERSION, BRIEF_TOOL_DESCRIPTIONS, BriefError, DESCRIPTION_CAP, briefComponentProps,
  briefGuide, checkBriefSection, describeBrief, fencedBlockLines, researchReads,
} from "../src/intelligent-ui/brief-contract.ts";
import { MAX_PROBLEMS, MAX_SPEC_BYTES, ResultError, SIGNATURE_LEGEND } from "../src/intelligent-ui/contract.ts";
import { clarificationExample } from "../src/intelligent-ui/clarification.ts";
import { benchmark, doseStudy } from "./research-fixtures.mjs";

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
      body: { type: "BriefBody", props: {}, children: ["intro", "split", "refs", "files", "sources", "desk"] },
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
    assert.ok(description.length <= 1200, `${name}: ${description.length} characters`);
    assert.ok(description.length <= DESCRIPTION_CAP);
    assert.match(description, /brief_guide/, `${name} names the guide`);
  }
  assert.deepEqual(Object.keys(BRIEF_TOOL_DESCRIPTIONS), ["brief_get", "brief_update", "brief_guide"]);
  // T-154: no turn has to end with a Brief update; outcomes have a place.
  const rules = BRIEF_HARD_RULES.split("\n");
  assert.match(rules[1], /No Brief update is required each turn: write when something changed/);
  assert.match(rules[1], /status.*report linked to its Task.*ask; result_publish never reaches Home/);
  assert.doesNotMatch(BRIEF_HARD_RULES, /requiresTurnUpdate|noChange/);
  for (const description of Object.values(BRIEF_TOOL_DESCRIPTIONS)) assert.doesNotMatch(description, /requiresTurnUpdate|per turn\b|each turn then/);
  assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_get, /keys: omit for every section with its body; \[\] for an index/);
  assert.match(briefGuide("sections"), new RegExp(`What goes where: ${BRIEF_OUTCOME_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(BRIEF_HARD_RULES, /editContent is false.*only your own Asks/);
  assert.match(briefGuide("errors"), /ask_only.*Only the user/);
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
  for (const op of ["put", "edit", "resolve", "remove", "claim"]) assert.match(BRIEF_TOOL_DESCRIPTIONS.brief_update, new RegExp(`op:"${op}"`));
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
  assert.equal(researchReads(benchmark.body.elements.desk.props).length, 20);

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
  assert.equal(rejected((p) => { p.definitions[0].versions[1].version = 1; }).code, "duplicate_id");
  assert.equal(rejected((p) => { p.revisions[0].definition = { id: "recovery", from: 2, to: 1 }; }).code, "definition_order");
  assert.equal(rejected((p) => { p.revisions[0].claim = "nowhere"; }).code, "missing_reference");
  // Numbers come only from this section's JSON attachments.
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
