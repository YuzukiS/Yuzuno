// The interactive-result contract (T-37): one source for the format, the
// checks, and what Agents are told. Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkResultSpec, describeContract, describeGuide, parseResultSpec, ResultError, COMPONENT_DESCRIPTIONS, componentProps,
  GUIDE_TOOL, MAX_DESCRIPTION_LENGTH,
  DISPLAY_DEFAULTS, MAX_PROBLEMS, MAX_SPEC_BYTES, MAX_SPEC_LENGTH, RESULT_LIMITS, RESULT_TOOL, SCHEMA_VERSION,
} from "../src/intelligent-ui/contract.ts";
import { catalog } from "../src/intelligent-ui/spec.ts";
import { comparisonExample, reportExample } from "../src/intelligent-ui/examples.ts";

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

test("the tool is described from the contract alone", () => {
  const first = describeContract();
  assert.deepEqual(describeContract(), first, "deterministic");
  assert.equal(first.name, RESULT_TOOL);
  assert.equal(first.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(first.limits, RESULT_LIMITS);
  // The full guide has every component's props and purpose, and the rules.
  for (const [type, description] of Object.entries(COMPONENT_DESCRIPTIONS))
    assert.ok(first.guide.text.includes(`- ${type} {`) && first.guide.text.includes(description), type);
  assert.match(first.guide.text, /title defaults to "Table"/);
  assert.match(first.guide.text, /at most one Continue, Clarification or TaskStatus/);
  assert.match(first.guide.text, /Publishing a form does not authorize any action or permission request/);
  assert.match(first.guide.text, /rows and bars cite them by id in sourceIds/);
  // Every limit the validator enforces is stated: string lengths, item
  // counts, ids, and which Clarification field type has which props.
  for (const limit of ["unit≤30", "href≤2000", "title≤160", "summary≤2000", "string≤500|number|boolean|null",
    "rows[≤100]", "data[1-24]", "items[≤30]", "fields[1-8]", "options[2-12]", 'type="single"', "1-64 characters"])
    assert.ok(first.guide.text.includes(limit), limit);
  // The entry and the guide both say how to publish.
  for (const text of [first.description, first.guide.text]) {
    assert.match(text, /plain text/);
    assert.match(text, new RegExp(`after ${RESULT_LIMITS.rejectedPerTurn} rejections in a Turn, answer in text`));
    assert.match(text, new RegExp(`At most ${RESULT_LIMITS.chainsPerTurn} results per Turn`));
    assert.match(text, new RegExp(`at most ${RESULT_LIMITS.versionsPerChain} versions`));
    assert.match(text, /yuzuno\.activeTurnId/);
    assert.match(text, /at the end of this Turn, below your reply: do not repeat it, its JSON or a yuzuno-ui block/);
  }
  for (const type of Object.keys(componentProps)) assert.ok(first.description.includes(type), type);
  assert.deepEqual(RESULT_LIMITS, { chainsPerTurn: 3, versionsPerChain: 5, rejectedPerTurn: 3 });
  // The once-per-session notice: short, optional, and never the format.
  assert.ok(first.capability.length < 500, first.capability.length);
  assert.match(first.capability, new RegExp(`yuzuno ${RESULT_TOOL} tool`));
  assert.match(first.capability, new RegExp(GUIDE_TOOL));
  assert.match(first.capability, /plain text/);
  assert.match(first.capability, /text only/);
  assert.match(first.capability, /do not repeat an accepted result/);
  assert.doesNotMatch(first.capability, /root|elements|\{|yuzuno-ui/);
  assert.deepEqual(first.inputSchema.required, ["requestId", "expectedTurnId", "spec"]);
  assert.equal(first.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(first.inputSchema.properties), ["requestId", "expectedTurnId", "spec", "revisesResultId"]);
  assert.ok(!/agentId|turnId/.test(JSON.stringify(first.inputSchema)), "identity is never an argument");
});

test("every description Agents are given fits the shortest supported client, and the entry names the guide early", () => {
  const contract = describeContract();
  assert.equal(MAX_DESCRIPTION_LENGTH, 2048, "Claude Code 2.1.280 keeps 2048 UTF-16 code units");
  assert.equal(contract.maxDescriptionLength, MAX_DESCRIPTION_LENGTH);
  // String length is UTF-16 code units, as the client counts them.
  for (const [name, text] of [["entry", contract.description], ["guide tool", contract.guideTool.description], ["notice", contract.capability]])
    assert.ok(text.length <= MAX_DESCRIPTION_LENGTH, `${name}: ${text.length}`);
  // A client that cuts harder still keeps where to read the rest.
  assert.ok(contract.description.indexOf(GUIDE_TOOL) < 256, contract.description.indexOf(GUIDE_TOOL));
  // The full guide does not fit: it is a tool answer, never a description.
  assert.ok(contract.guide.text.length > MAX_DESCRIPTION_LENGTH, contract.guide.text.length);
  for (const property of Object.values(contract.guideTool.inputSchema.properties))
    assert.ok(property.description.length <= MAX_DESCRIPTION_LENGTH);
});

test("the guide is one text in parts, whole or for some components, in catalog order", () => {
  const { guide, guideTool } = describeContract();
  assert.equal(guideTool.name, GUIDE_TOOL);
  assert.deepEqual(guideTool.inputSchema.properties.components.items.enum, Object.keys(componentProps));
  assert.equal(guideTool.inputSchema.additionalProperties, false);
  assert.deepEqual(guide.components.map((part) => part.type), Object.keys(componentProps));
  assert.equal(describeGuide(), guide.text);
  assert.equal(guide.text, [guide.header, guide.usage, "Components:", ...guide.components.map((part) => part.text), "Rules:", guide.rules].join("\n"));
  const some = describeGuide(["Continue", "Table"]);
  assert.ok(some.indexOf("- Table {") < some.indexOf("- Continue {"), "catalog order, not request order");
  assert.ok(!some.includes("- BarChart {") && some.includes(guide.rules) && some.includes(guide.usage));
  assert.throws(() => describeGuide(["Chart"]), /Unknown component: Chart/);
  // A prop's allowed values come from its schema (T-131), and the header says how to read them.
  const status = guide.components.find((part) => part.type === "TaskStatus").text;
  assert.match(status, /^- TaskStatus \{taskId, status="todo"\|"doing"\|"blocked"\|"review"\|"done"\|"cancelled", reason≤\d+\}: /);
  assert.match(guide.header, /="a"\|"b" the only values a prop takes/);
});

test("the renderer's catalog describes the same components", () => {
  assert.deepEqual(Object.keys(componentProps).sort(), Object.keys(COMPONENT_DESCRIPTIONS).sort());
  const prompt = catalog.prompt();
  for (const description of Object.values(COMPONENT_DESCRIPTIONS)) assert.ok(prompt.includes(description));
});
