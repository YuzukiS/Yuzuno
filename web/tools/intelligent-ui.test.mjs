import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSpec,
  parseResultSpec,
  sourceTarget,
  MAX_SPEC_LENGTH,
} from "../src/intelligent-ui/spec.ts";
import { parseReply, parseResultMessage } from "../src/intelligent-ui/message.ts";
import {
  comparisonExample,
  reportExample,
  interactiveRequest,
  legacyInteractiveRequest,
} from "../src/intelligent-ui/examples.ts";

const copy = () => structuredClone(comparisonExample);
const fence = (value) =>
  `Before **Markdown**.\n\n\`\`\`yuzuno-ui\n${JSON.stringify(value)}\n\`\`\`\n\nAfter [file](notes.md:42).`;
test("both composable examples and generated request templates parse", () => {
  for (const example of [comparisonExample, reportExample])
    assert.equal(parseSpec(JSON.stringify(example)).root, "result");
  for (const kind of ["comparison", "report"])
    assert.ok(parseResultMessage(legacyInteractiveRequest(kind)).result);
});
test("the request button adds one line of intent, never the format", () => {
  for (const kind of ["comparison", "report"]) {
    const line = interactiveRequest(kind);
    assert.ok(line.length < 120 && !line.includes("\n"), line);
    assert.doesNotMatch(line, /yuzuno-ui|[{}]|root|elements|Result \{/);
  }
});
test("preserves surrounding Markdown and reference links", () => {
  const parsed = parseResultMessage(
    fence(comparisonExample) + "\n\n[ref]: https://example.com\n",
  );
  assert.ok(parsed.result);
  assert.match(parsed.result.before, /Before \*\*Markdown\*\*/);
  assert.match(parsed.result.after, /notes.md:42/);
  assert.match(parsed.result.before, /https:\/\/example.com/);
});
test("ordinary, nested and incomplete code retain the original path", () => {
  for (const value of [
    "Normal reply",
    "`yuzuno-ui`",
    "```json\n{}\n```",
    "```yuzuno-ui\n{}",
    "> ```yuzuno-ui\n> {}\n> ```",
  ])
    assert.deepEqual(parseResultMessage(value), {});
});
test("accepts closed tilde fences and CRLF without activating outer code", () => {
  assert.ok(
    parseResultMessage(
      fence(comparisonExample)
        .replaceAll("```", "~~~")
        .replaceAll("\n", "\r\n"),
    ).result,
  );
  assert.deepEqual(
    parseResultMessage("````text\n" + fence(comparisonExample) + "\n````"),
    {},
  );
});
test("malformed, unsupported and repeated specs explicitly fall back", () => {
  assert.ok(parseResultMessage("```yuzuno-ui\nnot json\n```").fallback);
  assert.ok(
    parseResultMessage(fence(comparisonExample) + "\n" + fence(reportExample))
      .fallback,
  );
  const spec = copy();
  spec.elements.options.type = "iframe";
  assert.ok(parseResultMessage(fence(spec)).fallback);
});
test("rejects automatic actions, bindings and all unrecognized fields", () => {
  for (const [field, value] of Object.entries({
    watch: { "/": { action: "send" } },
    on: { press: { action: "send" } },
    visible: true,
    repeat: {},
    slots: {},
  })) {
    const spec = copy();
    spec.elements.options[field] = value;
    assert.throws(() => parseSpec(JSON.stringify(spec)), field);
  }
  for (const field of ["state", "watch", "actions"]) {
    const spec = copy();
    spec[field] = {};
    assert.throws(() => parseSpec(JSON.stringify(spec)));
  }
  const spec = copy();
  spec.elements.result.props.title = { $state: "/token" };
  assert.throws(() => parseSpec(JSON.stringify(spec)));
});
test("checks tree shape, missing children, cycles, disconnected and shared nodes", () => {
  for (const children of [
    ["result"],
    ["missing"],
    ["options", "options", "sources", "continue"],
  ]) {
    const spec = copy();
    spec.elements.result.children = children;
    assert.throws(() => parseSpec(JSON.stringify(spec)));
  }
  const spec = copy();
  spec.elements.orphan = { type: "Text", props: { text: "unused" } };
  assert.throws(() => parseSpec(JSON.stringify(spec)));
});
test("bounds component counts, rows, payload size and nesting", () => {
  assert.throws(() => parseSpec(" ".repeat(MAX_SPEC_LENGTH + 1)));
  const spec = copy();
  spec.elements.options.props.rows = Array.from({ length: 101 }, (_, i) => ({
    id: `row${i}`,
    cells: { name: "n", strength: "s", tradeoff: "t" },
  }));
  assert.throws(() => parseSpec(JSON.stringify(spec)));
  const deep = {
    root: "root",
    elements: {
      root: {
        type: "Result",
        props: { title: "t", summary: "s" },
        children: ["s1"],
      },
    },
  };
  for (let i = 1; i <= 7; i++)
    deep.elements[`s${i}`] = {
      type: "Section",
      props: { title: "nested" },
      children: i < 7 ? [`s${i + 1}`] : [],
    };
  assert.throws(() => parseSpec(JSON.stringify(deep)));
});
test("checks unique row/column/group identities and exact cell shape", () => {
  for (const mutate of [
    (s) => s.elements.options.props.rows.push(s.elements.options.props.rows[0]),
    (s) =>
      s.elements.options.props.columns.push(
        s.elements.options.props.columns[0],
      ),
    (s) => delete s.elements.options.props.rows[0].cells.name,
    (s) => (s.elements.options.props.rows[0].cells.extra = "extra"),
  ]) {
    const spec = copy();
    mutate(spec);
    assert.throws(() => parseSpec(JSON.stringify(spec)));
  }
});
test("rejects missing sources, duplicate source identities, leaf children and multiple continuations", () => {
  for (const mutate of [
    (s) => (s.elements.sources.props.items = []),
    (s) =>
      s.elements.sources.props.items.push(s.elements.sources.props.items[0]),
    (s) => (s.elements.options.children = ["continue"]),
    (s) => {
      s.elements.again = s.elements.continue;
      s.elements.result.children.push("again");
    },
  ]) {
    const spec = copy();
    mutate(spec);
    assert.throws(() => parseSpec(JSON.stringify(spec)));
  }
});
test("sources permit explicit web links and existing local line references only", () => {
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,x",
    "//other.test/x",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "\u0000x",
    " https://example.com",
    "#fragment",
    "\\\\server\\share",
  ])
    assert.equal(sourceTarget(href), null, href);
  assert.deepEqual(sourceTarget("web/src/App.tsx:42"), {
    kind: "file",
    path: "web/src/App.tsx",
    line: 42,
  });
  assert.deepEqual(sourceTarget("App.tsx#L42"), {
    kind: "file",
    path: "App.tsx",
    line: 42,
  });
  assert.equal(sourceTarget("https://example.com/path").kind, "web");
});
test("prototype and dynamic keys never enter the registry", () => {
  const spec = copy();
  spec.elements.options.props.rows[0].cells = JSON.parse(
    '{"$state":"/secret"}',
  );
  assert.throws(() => parseSpec(JSON.stringify(spec)));
  assert.throws(() => parseSpec('{"root":"constructor","elements":{}}'));
  for (const key of ["toString", "hasOwnProperty", "valueOf"]) {
    const reserved = copy();
    reserved.elements.options.props.id = key;
    assert.throws(() => parseSpec(JSON.stringify(reserved)));
  }
});

test("an identical fence in a quoted code example does not steal the result location", () => {
  const block = `\`\`\`yuzuno-ui\n${JSON.stringify(comparisonExample)}\n\`\`\`\n`;
  const prefix = `\`\`\`\`text\n${block}\`\`\`\`\n\nThe actual result follows.\n\n`;
  const parsed = parseResultMessage(prefix + block);
  assert.ok(parsed.result);
  assert.ok(parsed.result.before.startsWith(prefix));
});

// T-36: a reply as segments; results that are still coming or cannot be
// shown keep the rest of the reply readable.
const kinds = (segments) => segments?.map((segment) => segment.kind) ?? null;
const block = (body, fence = "```") => `${fence}yuzuno-ui\n${body}\n${fence}`;
/** As real replies on 2026-10-14 sent it: a Table without its title. */
const untitledTable = {
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "输入内容块", summary: "已登记，尚未开工" }, children: ["items"] },
    items: {
      type: "Table",
      props: {
        id: "input-todos",
        columns: [{ key: "task", label: "任务" }, { key: "experience", label: "交互" }],
        rows: [{ id: "t33", cells: { task: "T-33 · 长文本粘贴", experience: "紧凑块显示编号与行数" } }],
      },
    },
  },
};

test("only an explicit top-level yuzuno-ui fence is a result; everything else stays Markdown", () => {
  for (const value of [
    "Normal reply",
    "`yuzuno-ui`",
    "```json\n{}\n```",
    "> ```yuzuno-ui\n> {}\n> ```",
    "````markdown\n" + block(JSON.stringify(comparisonExample)) + "\n````",
    "- item\n\n    ```yuzuno-ui\n    {}\n    ```",
  ])
    assert.equal(parseReply(value, true), null, value);
});

test("Markdown before and after a result, and reference links, are kept in order", () => {
  const segments = parseReply(
    `Before **bold**.\n\n${block(JSON.stringify(comparisonExample))}\n\nAfter [ref][r].\n\n[r]: https://example.com`,
    true,
  );
  assert.deepEqual(kinds(segments), ["text", "result", "text"]);
  assert.match(segments[0].text, /Before \*\*bold\*\*/);
  assert.match(segments[2].text, /After \[ref\]\[r\]/);
  assert.match(segments[0].text, /\[r\]: <https:\/\/example.com>/, "definitions reach the text before the result too");
});

test("an unclosed block is generating while the reply streams and unfinished once it ends", () => {
  const streaming = `Here it comes.\n\n\`\`\`yuzuno-ui\n{"root":"result","elements":{`;
  assert.deepEqual(kinds(parseReply(streaming, false)), ["text", "pending"]);
  assert.deepEqual(kinds(parseReply("```yuzuno-ui", false)), ["pending"]);
  const ended = parseReply(streaming, true);
  assert.deepEqual(kinds(ended), ["text", "invalid"]);
  assert.equal(ended[1].problem.code, "unfinished");
  // Once closed it is judged at once, finished or not.
  const closed = `${block(JSON.stringify(comparisonExample))}\n\nMore text still streaming`;
  assert.deepEqual(kinds(parseReply(closed, false)), ["result", "text"]);
});

test("invalid results say what and where, and only the first valid block is shown", () => {
  const reason = (body) => parseReply(block(body), true)[0].problem;
  assert.equal(reason("not json").code, "invalid_json");
  const unknown = structuredClone(comparisonExample);
  unknown.elements.options.type = "iframe";
  assert.deepEqual(
    [reason(JSON.stringify(unknown)).code, reason(JSON.stringify(unknown)).path],
    ["unknown_component", "elements.options.type"],
  );
  const extra = structuredClone(comparisonExample);
  extra.elements.result.props.color = "red";
  assert.deepEqual([reason(JSON.stringify(extra)).code, reason(JSON.stringify(extra)).path], ["unknown_field", "elements.result.props"]);
  assert.match(reason(JSON.stringify(extra)).reason, /color/);
  const missing = structuredClone(comparisonExample);
  delete missing.elements.result.props.summary;
  assert.deepEqual([reason(JSON.stringify(missing)).code, reason(JSON.stringify(missing)).path], ["invalid_field", "elements.result.props.summary"]);
  const twice = parseReply(`${block(JSON.stringify(comparisonExample))}\n\n${block(JSON.stringify(reportExample))}`, true);
  assert.deepEqual(kinds(twice), ["result", "invalid"]);
  assert.equal(twice[1].problem.code, "multiple_results");
});

test("only whitelisted display titles get a default; data, IDs and actions never do", () => {
  const { spec, defaults } = parseResultSpec(JSON.stringify(untitledTable));
  assert.equal(spec.elements.items.props.title, "Table");
  assert.deepEqual(defaults, ["elements.items.props.title"]);
  const segments = parseReply(`已加入 TODO。\n\n${block(JSON.stringify(untitledTable))}\n\n后续建议。`, true);
  assert.deepEqual(kinds(segments), ["text", "result", "text"]);
  assert.equal(segments[1].raw, JSON.stringify(untitledTable), "the raw block is kept as sent");
  const chart = structuredClone(reportExample);
  const chartKey = Object.keys(chart.elements).find((key) => chart.elements[key].type === "BarChart");
  if (chartKey) {
    delete chart.elements[chartKey].props.title;
    assert.equal(parseResultSpec(JSON.stringify(chart)).spec.elements[chartKey].props.title, "Chart");
  }
  for (const change of [
    (s) => { s.elements.items.props.title = ""; },
    (s) => { delete s.elements.items.props.id; },
    (s) => { delete s.elements.items.props.columns; },
    (s) => { delete s.elements.result.props.title; },
    (s) => { s.elements.items.type = "Section"; s.elements.items.props = {}; },
  ]) {
    const spec = structuredClone(untitledTable);
    change(spec);
    assert.throws(() => parseResultSpec(JSON.stringify(spec)), undefined, JSON.stringify(spec.elements.items));
  }
});

test("a fence may put spaces or a tab before yuzuno-ui, exactly as marked reads it", () => {
  // R1: marked read these as yuzuno-ui fences but they were judged unclosed.
  const body = JSON.stringify(comparisonExample);
  const tick = "`".repeat(3);
  for (const open of [`${tick} yuzuno-ui`, `${tick}\tyuzuno-ui`, `${tick}  yuzuno-ui`, "~~~ yuzuno-ui", `   ${tick} yuzuno-ui`]) {
    const close = open.trimStart().startsWith("~") ? "~~~" : tick;
    assert.deepEqual(kinds(parseReply(`${open}\n${body}\n${close}`, true)), ["result"], JSON.stringify(open));
    assert.deepEqual(kinds(parseReply(`${open}\n${body}\n${close}  `, true)), ["result"], `${JSON.stringify(open)} closed with spaces`);
    // marked does not close a fence followed by a tab, so neither does this.
    assert.equal(parseReply(`${open}\n${body}\n${close}\t`, true)[0].problem.code, "unfinished", `${JSON.stringify(open)} closed with a tab`);
    assert.deepEqual(kinds(parseReply(`${open}\n${body.slice(0, 40)}`, false)), ["pending"]);
    assert.equal(parseReply(`${open}\n${body.slice(0, 40)}`, true)[0].problem.code, "unfinished");
  }
  // The info string itself stays exact.
  for (const open of [`${tick}yuzuno-ui extra`, `${tick} yuzuno-uix`, `${tick} json yuzuno-ui`])
    assert.equal(parseReply(`${open}\n${body}\n${tick}`, true), null, open);
});
