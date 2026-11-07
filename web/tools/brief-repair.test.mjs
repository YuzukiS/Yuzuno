// Repair-accept for Project Brief sections (YN-14 A1): what Core repairs,
// what it still refuses as sent, and that a valid section is never touched.
// Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF_EXAMPLES, BRIEF_LIMITS, BRIEF_REPAIR_CODES, BriefError, briefGuide, checkBriefSection,
} from "../src/intelligent-ui/brief-contract.ts";
import { acceptBriefSection, fixReported, MAX_REPAIRS } from "../src/intelligent-ui/brief-repair.ts";

const md = (text) => ({ type: "Markdown", props: { text } });
/** A report whose root has `elements` as children, or `children` when given. */
const report = (elements, extra = {}, children = Object.keys(elements)) => ({
  key: "demo", kind: "report", title: "Demo", ...extra,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children }, ...elements } },
});
const finding = (item) => ({ type: "Findings", props: { items: [item] } });

/** The repairs of an accepted section, each checked for its shape; the section must pass the strict check as returned. */
function repaired(value, previousBody) {
  const { section, repairs } = acceptBriefSection(value, previousBody);
  assert.ok(repairs.length >= 1, "repaired, not valid as sent");
  for (const repair of repairs) {
    assert.deepEqual(Object.keys(repair), ["code", "path", "reason", "guide"]);
    assert.ok(Object.hasOwn(BRIEF_REPAIR_CODES, repair.code), `${repair.code} is listed in brief_guide errors`);
    assert.ok(repair.reason.endsWith(`(${repair.guide})`), repair.reason);
  }
  // What Core stores passes the contract as it is, with nothing left to repair.
  assert.deepEqual(acceptBriefSection(section, previousBody), { section: checkBriefSection(section, previousBody), repairs: [] });
  return { section, repairs, codes: repairs.map((repair) => repair.code) };
}

/** The rejection of a section Core does not repair: exactly checkBriefSection's for the section as sent. */
function refused(value, previousBody) {
  let expected;
  try {
    checkBriefSection(value, previousBody);
  } catch (error) {
    expected = error;
  }
  assert.ok(expected instanceof BriefError, "invalid as sent");
  assert.throws(() => acceptBriefSection(value, previousBody), (error) => {
    assert.ok(error instanceof BriefError);
    assert.deepEqual(error.problems, expected.problems);
    return true;
  });
  return expected.problems.map((problem) => problem.code);
}

test("a section valid as sent is returned as the strict check returns it, with no repairs", () => {
  for (const [name, example] of Object.entries(BRIEF_EXAMPLES))
    assert.deepEqual(acceptBriefSection(example), { section: checkBriefSection(example), repairs: [] }, name);
});

test("an unknown component becomes Markdown of its text, never markup, or a Group when it has children", () => {
  const code = repaired(report({ log: { type: "Code", props: { language: "text", code: "FAIL x\n``` inside" } } }));
  assert.deepEqual(code.codes, ["component_to_markdown"]);
  assert.equal(code.section.body.elements.log.type, "Markdown");
  assert.equal(code.section.body.elements.log.props.text, "````text\nFAIL x\n``` inside\n````", "a fence longer than any run inside");

  const html = repaired(report({ note: { type: "Html", props: { title: "<b>Note</b>", text: "<script>alert(1)</script> & more" } } }));
  assert.equal(html.section.body.elements.note.props.text, "**&lt;b>Note&lt;/b>**\n\n&lt;script>alert(1)&lt;/script> &amp; more");

  const fields = repaired(report({ tip: { type: "Callout", text: "Outside props" } }));
  assert.equal(fields.section.body.elements.tip.props.text, "Outside props");

  const list = repaired(report({ l: { type: "List", props: { items: ["One", { text: "Two" }] } } }));
  assert.equal(list.section.body.elements.l.props.text, "- One\n- Two");

  const group = repaired(report({ part: { type: "Section", props: { title: "Part" }, children: ["a"] }, a: md("A.") }, {}, ["part"]));
  assert.deepEqual(group.codes, ["component_to_group"]);
  assert.deepEqual(group.section.body.elements.part, { type: "Group", props: { title: "Part" }, children: ["a"] });

  const empty = repaired(report({ a: md("A."), rule: { type: "Divider", props: {} } }));
  assert.equal(empty.section.body.elements.rule, undefined, "no text: removed");
  assert.deepEqual(empty.section.body.elements.body.children, ["a"]);
});

test("fields: aliases are moved, unknown ones dropped, ids filled, enums normalized, two neutral defaults", () => {
  const alias = repaired(report({ f: finding({ id: "f1", file: "a.rs:1", severity: "low", text: "X." }) }));
  assert.deepEqual(alias.codes, ["renamed_field"]);
  assert.equal(alias.section.body.elements.f.props.items[0].source, "a.rs:1");

  const dropped = repaired(report({ a: { type: "Markdown", props: { text: "A.", format: "gfm" } } }));
  assert.deepEqual(dropped.codes, ["dropped_field"]);
  assert.deepEqual(dropped.section.body.elements.a.props, { text: "A." });

  const severity = repaired(report({ f: finding({ id: "f1", source: "a.rs:1", text: "X." }) }));
  assert.deepEqual(severity.codes, ["filled_default"]);
  assert.equal(severity.section.body.elements.f.props.items[0].severity, "info");
  assert.match(severity.repairs[0].reason, /severity set to info/);

  const cell = repaired(report({ t: { type: "Table", props: { id: "t", title: "T", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    rows: [{ id: "r1", cells: { a: "1" } }, { id: "r2", cells: { a: "2", b: "3", c: "4" } }] } } }));
  assert.deepEqual(cell.codes, ["filled_default", "dropped_field"]);
  assert.deepEqual(cell.section.body.elements.t.props.rows.map((row) => row.cells), [{ a: "1", b: "" }, { a: "2", b: "3" }]);

  const states = repaired(report({ p: { type: "Plan", props: { steps: [{ id: "s1", text: "Run", status: "In_Progress" }, { id: "s2", text: "Ship", state: "Done" }] } } }));
  assert.deepEqual(states.section.body.elements.p.props.steps.map((step) => step.state), ["doing", "done"]);

  const ids = repaired(report({ c: { type: "Checklist", props: { items: [{ text: "A", done: true }, { id: "i2", text: "B", done: false }, { text: "C", done: false }] } } }));
  assert.deepEqual(ids.section.body.elements.c.props.items.map((item) => item.id), ["i1", "i2", "i3"]);
  const twice = repaired(report({ c: { type: "Checklist", props: { items: [{ id: "a", text: "A", done: true }, { id: "a", text: "B", done: false }] } } }));
  assert.deepEqual(twice.section.body.elements.c.props.items.map((item) => item.id), ["a", "a-2"]);
  const tableId = repaired(report({ runs: { type: "Table", props: { columns: [{ key: "a", label: "A" }], rows: [] } } }));
  assert.equal(tableId.section.body.elements.runs.props.id, "runs");
});

test("ask reply options given as text or with other field names become {id, label}", () => {
  const ask = (options) => ({ key: "q", kind: "ask", title: "Q", ask: { question: "Go?", reply: { options } }, body: report({ why: md("Why.") }).body });
  const strings = repaired(ask(["Yes", "No"]));
  assert.deepEqual(strings.codes, ["reply_options"]);
  assert.deepEqual(strings.section.ask.reply.options, [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }]);
  const fields = repaired(ask([{ value: "keep", text: "Keep it", description: "The default" }, { id: "drop", label: "Drop it" }]));
  assert.deepEqual(fields.section.ask.reply.options, [{ label: "Keep it", id: "keep" }, { id: "drop", label: "Drop it" }]);
  assert.match(fields.repairs[0].reason, /removed description/);
  assert.equal(fields.repairs[0].guide, "brief_guide ask");
});

test("the tree and layout are mended; a put shows what nothing showed, an edit drops what it unlinked", () => {
  const orphan = repaired(report({ a: md("A."), b: md("B.") }, {}, ["a"]));
  assert.deepEqual(orphan.section.body.elements.body.children, ["a", "b"]);
  const ghost = repaired(report({ a: md("A.") }, {}, ["a", "ghost"]));
  assert.deepEqual(ghost.section.body.elements.body.children, ["a"]);
  const inner = repaired(report({ inner: { type: "BriefBody", props: {}, children: ["a"] }, a: md("A.") }, {}, ["inner"]));
  assert.equal(inner.section.body.elements.inner.type, "Group");
  const widths = repaired(report({ cols: { type: "Columns", props: { widths: [2, 1, 1] }, children: ["x", "y"] }, x: md("X."), y: md("Y.") }, {}, ["cols"]));
  assert.deepEqual(widths.section.body.elements.cols.props, {});
  const summary = {
    key: "s", kind: "report", title: "S",
    body: { root: "body", elements: { body: { type: "BriefBody", props: { summary: { lead: "a", visual: "b", size: "small" } }, children: ["a", "b"] }, a: md("A."), b: md("B.") } },
  };
  assert.deepEqual(repaired(summary).section.body.elements.body.props, { summary: { lead: "a", size: "small" } });

  const shot = report({ a: md("A.") }, { attachments: [{ name: "shot.png", path: "/home/me/shot.png" }] });
  const shown = repaired(shot);
  assert.deepEqual(shown.codes, ["showed_attachment"]);
  assert.deepEqual(shown.section.body.elements.files, { type: "Attachments", props: { items: [{ name: "shot.png" }] } });
  assert.deepEqual(shown.section.body.elements.body.children, ["a", "files"]);

  // A block edit (Core passes the stored body): what it unlinked goes; it never shows an attachment.
  const stored = report({ g: { type: "Group", props: { title: "G" }, children: ["a", "b"] }, a: md("A."), b: md("B.") }, {}, ["g"]).body;
  const edited = report({ g: { type: "Group", props: { title: "G" }, children: ["a"] }, a: md("A."), b: md("B.") }, {}, ["g"]);
  const unlinked = repaired(edited, stored);
  assert.equal(unlinked.section.body.elements.b, undefined);
  assert.match(unlinked.repairs[0].reason, /"b", which the edit no longer shows/);
  const showing = report({ a: md("A."), files: { type: "Attachments", props: { items: [{ name: "shot.png" }] } } }).body;
  assert.deepEqual(refused(shot, showing), ["unused_attachment"], "an edit that stops showing a file is not mended");
});

test("what Core never repairs is refused exactly as sent", () => {
  assert.deepEqual(refused({ key: "q", kind: "ask", title: "Q", ask: { question: "Go?", reply: {} }, body: report({ why: md("Why.") }).body }), ["ask_without_reply"]);
  const many = Array.from({ length: BRIEF_LIMITS.listItems + 1 }, (_, i) => ({ id: `f${i}`, source: "s", severity: "low", text: "X." }));
  assert.deepEqual(refused(report({ f: { type: "Findings", props: { items: many } } })), ["too_many"]);
  assert.deepEqual(refused(report({ a: md("```text\n" + "line\n".repeat(BRIEF_LIMITS.codeBlockLines + 1) + "```") })), ["block_too_long"]);
  assert.deepEqual(refused(report({ f: finding({ id: "f1", severity: "low", text: "X." }) })), ["missing_field"], "a source is never invented");
  assert.deepEqual(refused(report({ a: { type: "Attachments", props: { items: [{ name: "x.png" }] } } }, { attachments: [{ name: "x.png", path: "shots/x.png" }] })), ["attachment_location"]);
  assert.deepEqual(refused(report({ c: { type: "LineChart", props: { id: "c", title: "C", x: { label: "x" }, y: { label: "y" } } } })), ["chart_data"]);
  assert.deepEqual(refused(report({ a: { type: "Attachments", props: { items: [{ name: "gone.png" }] } } })), ["missing_attachment"]);
  // The envelope is the Agent's own: no field of it is dropped or renamed.
  assert.deepEqual(refused({ ...report({ a: md("A.") }), summary: "extra" }), ["unknown_field"]);
  // A repair of what it can, with something it cannot, is no repair at all.
  assert.deepEqual(refused(report({ log: { type: "Code", props: { code: "x" } }, f: finding({ id: "f1", severity: "low", text: "X." }) })), ["unknown_component", "missing_field"]);
});

test("ResearchDesk, Sources and element fields a later contract may use get no repairs", () => {
  assert.deepEqual(refused(report({ s: { type: "Sources", props: { items: [{ id: "a", label: "A", href: "https://example.com", note: "x" }] } } })), ["unknown_field"]);
  // visible (YN-16 S1): a block's condition is checked strictly and never repaired; here it sits under the root, not in a
  // Group, and reads a variable no input declares, so it is refused as sent.
  assert.deepEqual(refused(report({ a: { type: "Markdown", props: { text: "A." }, visible: { $state: "/open" } } })), ["invalid_field"]);
  assert.deepEqual(refused(report({ g: { type: "Group", props: {}, children: ["a"] }, a: { type: "Markdown", props: { text: "A.", extra: 1 }, visible: { $state: "/open" } } }, {}, ["g"])), ["unknown_field"]);
  assert.deepEqual(refused(report({ g: { type: "Group", props: {}, children: ["a"] }, a: { type: "Markdown", props: { text: "A." }, visible: { $state: "/open" } } }, {}, ["g"])), ["invalid_field"]);
  assert.deepEqual(refused(report({ a: { type: "Widget", props: { text: "A." }, on: { press: "x" } } })), ["unknown_component"]);
});

test(`a section that needs more than ${MAX_REPAIRS} repairs is refused as sent`, () => {
  const elements = Object.fromEntries(Array.from({ length: MAX_REPAIRS + 1 }, (_, i) => [`m${i}`, { type: "Markdown", props: { text: "A.", extra: i } }]));
  assert.deepEqual([...new Set(refused(report(elements)))], ["unknown_field"]);
  const fits = Object.fromEntries(Object.entries(elements).slice(0, MAX_REPAIRS));
  assert.equal(repaired(report(fits)).repairs.length, MAX_REPAIRS);
});

test("brief_guide errors lists every repair code and what is never repaired", () => {
  const errors = briefGuide("errors");
  for (const code of Object.keys(BRIEF_REPAIR_CODES)) assert.ok(errors.includes(`- ${code}: `), code);
  assert.match(errors, /Outside the body Core repairs only an ask's reply options \(reply_options\)/);
  assert.match(errors, /it never repairs key, kind, title, the ask's question or its other replies, status, time or an attachment's registration/);
  assert.match(errors, /an edit removes those of the blocks it replaces, and those of the section as a whole .* stay until a put/);
  // What the attachments part says matches: a put's unused registration is shown, an edit's refused.
  const attachments = briefGuide("attachments");
  assert.match(attachments, /a put's registration nothing uses is added to an Attachments block at the end of the root and listed in repairs \(showed_attachment\), never refused/);
  assert.match(attachments, /An edit is never repaired that way/);
  assert.doesNotMatch(attachments, /must be used by a reachable/);
  assert.match(errors, new RegExp(`more than ${BRIEF_LIMITS.repairsPerSection} is refused as sent`));
});

test("no fix touches an element that carries visible, on, watch, state or repeat, nor its container (YN-14 S2)", () => {
  const reported = (code, path) => [{ code, path, reason: "", guide: "" }];
  const table = { type: "Table", props: { id: "t", title: "T", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }], rows: [{ id: "r1", cells: { a: "1" } }] } };
  for (const field of ["visible", "on", "watch", "state", "repeat"]) {
    const sent = report({ t: { ...table, [field]: { $state: "/open" } } });
    const { section, fixed } = fixReported(sent, reported("row_mismatch", "body.elements.t.props.rows.0.cells"));
    assert.equal(fixed, false, field);
    assert.deepEqual(section, sent, `${field}: nothing changed`);
  }
  const group = report({ g: { type: "Group", props: {}, children: ["ghost"], visible: { $state: "/open" } } }, {}, ["g"]);
  assert.equal(fixReported(group, reported("missing_component", "body.elements.ghost")).fixed, false, "a container that holds a condition keeps its children");
  const unlinked = report({ a: md("A."), b: { ...md("B."), visible: { $state: "/open" } } }, {}, ["a"]);
  assert.equal(fixReported(unlinked, reported("unused_component", "body.elements"), report({ a: md("A.") }).body).fixed, false, "an edit never removes one");
  // The same fix applies without the field.
  assert.equal(fixReported(report({ t: table }), reported("row_mismatch", "body.elements.t.props.rows.0.cells")).fixed, true);
});

test("a markdown put is repaired as the body Core builds for it (YN-14 A3)", () => {
  const ask = { key: "q", kind: "ask", title: "Q", markdown: "Why: it costs a day.", ask: { question: "Run it?", reply: { options: ["Yes", "No"] } } };
  const { section, repairs } = acceptBriefSection(ask);
  assert.deepEqual(repairs.map((repair) => repair.code), ["reply_options"]);
  assert.deepEqual(section.ask.reply.options, [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }]);
  assert.equal(section.body.elements.text.props.text, "Why: it costs a day.");
  // A markdown with a body is refused as sent, never repaired into one of them.
  assert.throws(() => acceptBriefSection({ ...ask, body: section.body }), (error) => error instanceof BriefError && error.problems[0].path === "markdown");
  // Blank markdown or a wrong size is refused as sent, even when another slip could be repaired (#723 R1 P3).
  for (const wrong of [{ markdown: "  " }, { size: "huge" }])
    assert.throws(() => acceptBriefSection({ ...ask, ...wrong }), (error) => error instanceof BriefError
      && error.problems.some((found) => found.path === Object.keys(wrong)[0]), JSON.stringify(wrong));
});
