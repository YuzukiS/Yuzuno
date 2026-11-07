// The interactive-result contract (T-37): one source for the format, the
// checks, and what Agents are told. Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkResultSpec, describeContract, describeFenceGuide, parseResultSpec, ResultError, COMPONENT_DESCRIPTIONS, componentProps,
  FENCE_COMPONENTS, FENCE_NOTICE, MAX_DESCRIPTION_LENGTH,
  DISPLAY_DEFAULTS, MAX_PROBLEMS, MAX_SPEC_BYTES, MAX_SPEC_LENGTH, RESULT_LIMITS, SCHEMA_VERSION,
} from "../src/intelligent-ui/contract.ts";
import { catalog } from "../src/intelligent-ui/spec.ts";
import { comparisonExample, reportExample } from "../src/intelligent-ui/examples.ts";
import { RESERVE_CAP, RESERVE_HEIGHT, reserveFor } from "../src/intelligent-ui/result-reserve.ts";

const problems = (value) => {
  try {
    checkResultSpec(value);
  } catch (error) {
    assert.ok(error instanceof ResultError);
    return error.problems;
  }
  assert.fail("expected a ResultError");
};

test("a value and its JSON text are checked identically", () => {
  for (const example of [comparisonExample, reportExample]) {
    assert.deepEqual(checkResultSpec(example), parseResultSpec(JSON.stringify(example)));
  }
  const untitled = structuredClone(comparisonExample);
  const table = Object.keys(untitled.elements).find((key) => untitled.elements[key].type === "Table");
  delete untitled.elements[table].props.title;
  const { spec, defaults } = checkResultSpec(untitled);
  assert.equal(spec.elements[table].props.title, DISPLAY_DEFAULTS.Table.title);
  assert.deepEqual(defaults, [`elements.${table}.props.title`]);
  assert.equal(untitled.elements[table].props.title, undefined, "the given value is not changed");
});

test("schema problems are reported together, first one first, at most a few", () => {
  const broken = structuredClone(comparisonExample);
  broken.elements.result.props.summary = 7;
  broken.elements.result.props.color = "red";
  const found = problems(broken);
  assert.ok(found.length >= 2 && found.length <= MAX_PROBLEMS);
  assert.deepEqual(new Set(found.map((p) => p.code)), new Set(["invalid_field", "unknown_field"]));
  assert.ok(found.every((p) => p.path?.startsWith("elements.result.props")));
  const many = { root: "result", elements: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`x${i}`, { type: "Text", props: { text: 1 } }])) };
  assert.equal(problems(many).length, MAX_PROBLEMS);
  // A whole-result check stops at its first problem.
  const unused = structuredClone(comparisonExample);
  unused.elements.extra = { type: "Text", props: { text: "never shown" } };
  assert.deepEqual(problems(unused), [{ code: "unused_component", reason: "Result contains unused components.", path: "elements" }]);
  assert.equal(problems({ root: "r", elements: { r: { type: "Result", props: { title: "t", summary: "x".repeat(70_000) } } } })[0].code, "too_large");
});

test("a submitted result is measured in UTF-8 bytes, a reply's block in characters as before", () => {
  // Valid apart from its size: 700 rows of 3-byte characters.
  const sized = (length) => ({
    root: "r",
    elements: {
      r: { type: "Result", props: { title: "t", summary: "s" }, children: ["t"] },
      t: {
        type: "Table",
        props: {
          id: "t", columns: [{ key: "c", label: "C" }],
          rows: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, cells: { c: "表".repeat(length) } })),
        },
      },
    },
  });
  const value = sized(250);
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text).length;
  assert.ok(text.length <= MAX_SPEC_LENGTH && bytes > MAX_SPEC_BYTES, `${text.length} chars, ${bytes} bytes`);
  assert.equal(parseResultSpec(text).spec.elements.t.props.rows.length, 100, "a block of that text is unchanged");
  assert.equal(problems(value)[0].code, "too_large");
  assert.match(problems(value)[0].reason, /bytes/);
  assert.ok(checkResultSpec(sized(200)));
});

test("what Core is told about results comes from the contract alone: the notice and the fence guide (YN-14 A5)", () => {
  const first = describeContract();
  assert.deepEqual(describeContract(), first, "deterministic");
  assert.deepEqual(Object.keys(first), ["schemaVersion", "limits", "capability", "fenceGuide", "maxDescriptionLength"], "no tool, input schema or tool guide");
  assert.equal(first.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(first.limits, RESULT_LIMITS);
  assert.deepEqual(RESULT_LIMITS, { chainsPerTurn: 3, versionsPerChain: 5, rejectedPerTurn: 3 });
  // The once-per-session notice: how to show a result in a reply, short.
  assert.equal(first.capability, FENCE_NOTICE);
  assert.ok(first.capability.length < 700, first.capability.length);
  assert.match(first.capability, /one yuzuno-ui fenced block in your reply: one sentence of plain text first/);
  assert.match(first.capability, /"root" first, then the elements in the order they are shown/);
  assert.match(first.capability, /At most one block per reply; it only displays\. A form, a choice or a status change goes to a Home Ask instead\./);
  assert.match(first.capability, /yuzuno_guide topic results/);
  assert.doesNotMatch(first.capability, /result_publish|result_guide/);
  // The fence guide: every display component with its props and purpose, none that acts.
  for (const type of FENCE_COMPONENTS) {
    assert.ok(first.fenceGuide.includes(`- ${type} {`), type);
    assert.ok(first.fenceGuide.includes(COMPONENT_DESCRIPTIONS[type]), type);
  }
  for (const type of ["Clarification", "TaskStatus", "Continue"]) assert.ok(!first.fenceGuide.includes(`- ${type} {`), type);
  assert.match(first.fenceGuide, /title defaults to "Table"/);
  assert.match(first.fenceGuide, /root names a Result/);
  assert.match(first.fenceGuide, /rows and bars cite them by id in sourceIds/);
  assert.match(first.fenceGuide, /="a"\|"b" the only values a prop takes/);
  assert.doesNotMatch(first.fenceGuide, /result_publish|result_guide/);
  for (const limit of ["unit≤30", "href≤2000", "title≤160", "summary≤2000", "rows[≤100]", "data[1-24]", "1-64 characters"])
    assert.ok(first.fenceGuide.includes(limit), limit);
});

test("the notice fits the shortest supported client; the fence guide is read from yuzuno_guide", () => {
  const contract = describeContract();
  assert.equal(MAX_DESCRIPTION_LENGTH, 2048, "Claude Code 2.1.280 keeps 2048 UTF-16 code units");
  assert.equal(contract.maxDescriptionLength, MAX_DESCRIPTION_LENGTH);
  assert.ok(contract.capability.length <= MAX_DESCRIPTION_LENGTH, contract.capability.length);
  assert.equal(describeFenceGuide(), contract.fenceGuide);
});

test("the renderer's catalog describes the same components", () => {
  assert.deepEqual(Object.keys(componentProps).sort(), Object.keys(COMPONENT_DESCRIPTIONS).sort());
  const prompt = catalog.prompt();
  for (const description of Object.values(COMPONENT_DESCRIPTIONS)) assert.ok(prompt.includes(description));
});

test("a result's placeholder keeps room for the kinds of block its spec holds, at most the cap; text alone keeps none (T-19 HM:I5)", () => {
  const result = (children, elements) => ({ root: "result", elements: {
    result: { type: "Result", props: { title: "T", summary: "S" }, children }, ...elements } });
  const text = { type: "Text", props: { text: "Hello" } };
  assert.equal(reserveFor(checkResultSpec(result(["body"], { body: text })).spec), null);
  const table = checkResultSpec(comparisonExample).spec;
  assert.deepEqual(reserveFor(table), { kinds: ["table"], height: RESERVE_HEIGHT.table });
  // Inside a Section, and more than one kind: the sum, at most the cap.
  const chart = { type: "BarChart", props: { id: "c", title: "Chart", unit: "ms", data: [{ id: "a", label: "A", value: 1 }] } };
  const grid = { type: "Table", props: { id: "t", title: "Table", columns: [{ key: "k", label: "K" }], rows: [{ id: "r", cells: { k: "v" } }] } };
  const both = checkResultSpec(result(["part"], { part: { type: "Section", props: { title: "Part" }, children: ["grid", "chart"] }, grid, chart })).spec;
  assert.deepEqual(reserveFor(both), { kinds: ["table", "chart"], height: Math.min(RESERVE_CAP, RESERVE_HEIGHT.table + RESERVE_HEIGHT.chart) });
  assert.equal(reserveFor(both).height, RESERVE_CAP);
  // Only what the tree reaches counts.
  assert.equal(reserveFor({ root: "result", elements: { result: { type: "Result", props: {}, children: [] }, stray: grid } }), null);
});

test("T-56 a TaskStatus proposal names its task by T-n or a Project task key, in canonical capitals only", () => {
  const proposal = (taskId) => ({ root: "r", elements: {
    r: { type: "Result", props: { title: "Status", summary: "Ready for review." }, children: ["p"] },
    p: { type: "TaskStatus", props: { taskId, status: "review", reason: "PR open, CI green" } },
  } });
  // What the contract makes of a taskId: the id taken, or where the first problem is.
  const read = (taskId) => {
    try {
      return checkResultSpec(proposal(taskId)).spec.elements.p.props.taskId;
    } catch (error) {
      assert.ok(error instanceof ResultError);
      return `refused at ${error.problems[0].path}`;
    }
  };
  for (const taskId of ["T-1", "YN-3", "ATL2-10", "ABCDEFGHIJ-9"])
    assert.equal(read(taskId), taskId, `${taskId} names a task`);
  for (const taskId of ["yn-3", "Yn-3", "Y-3", "ABCDEFGHIJK-1", "YN-0", "YN-", "YN3", "3-1"])
    assert.equal(read(taskId), "refused at elements.p.props.taskId", `${taskId} is not a task key`);
});
