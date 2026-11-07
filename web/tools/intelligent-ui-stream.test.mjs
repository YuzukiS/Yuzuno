import assert from "node:assert/strict";
import test from "node:test";
import { BlockStream, PENDING } from "../src/intelligent-ui/stream.ts";
import { checkElement, checkSpec, DISPLAY_ONLY_REASON, MAX_SPEC_LENGTH, ResultError } from "../src/intelligent-ui/contract.ts";
import { clarificationExample } from "../src/intelligent-ui/clarification.ts";
import { parseReply } from "../src/intelligent-ui/message.ts";
import { comparisonExample, reportExample } from "../src/intelligent-ui/examples.ts";

// YN-15: a reply's yuzuno-ui block drawn as it is written. Only elements that
// have closed and pass the catalog are drawn; the rest are placeholders.

const table = {
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "Twenty runs", summary: "Synthetic sample." }, children: ["runs", "note"] },
    runs: {
      type: "Table",
      props: {
        id: "runs",
        title: "Runs",
        columns: [{ key: "name", label: "Run" }, { key: "ms", label: "Time (ms)" }],
        rows: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, cells: { name: `Run ${i + 1}`, ms: 100 + i } })),
      },
    },
    note: { type: "Text", props: { text: "Illustrative values only." } },
  },
};
const examples = { comparison: comparisonExample, report: reportExample, table };

/** Every view of `text` written one character at a time. */
function views(text) {
  const stream = new BlockStream();
  return Array.from({ length: text.length }, (_, i) => stream.update(text.slice(0, i + 1)).view());
}
const drawnKeys = (view) => (view ? Object.keys(view.elements).filter((key) => view.elements[key].type !== PENDING) : []);

test("a block written a character at a time draws only checked elements, each as it ends", () => {
  for (const [name, spec] of Object.entries(examples)) {
    const { spec: final } = checkSpec(structuredClone(spec));
    for (const text of [JSON.stringify(spec), JSON.stringify(spec, null, 2)]) {
      let drawn = [];
      for (const view of views(text)) {
        if (!view) {
          assert.equal(drawn.length, 0, `${name}: once drawn, a part stays drawn`);
          continue;
        }
        const keys = drawnKeys(view);
        assert.ok(drawn.every((key) => keys.includes(key)), `${name}: drawn parts only grow`);
        drawn = keys;
        for (const key of keys) {
          const { children: _shown, ...element } = view.elements[key];
          const { children: _all, ...whole } = final.elements[key];
          assert.deepEqual(element, whole, `${name}: ${key} is drawn as the whole block has it`);
          // A parent lists only what is placed, in order: drawn parts and placeholders.
          for (const child of view.elements[key].children ?? []) assert.ok(view.elements[child], `${name}: ${child} is placed`);
        }
        for (const [key, element] of Object.entries(view.elements))
          if (element.type === PENDING) assert.ok(!keys.includes(key));
        assert.equal(view.root, "result");
      }
      const last = views(text).at(-1);
      // Everything is drawn once written.
      for (const [key, element] of Object.entries(final.elements))
        assert.equal(last.elements[key].type, element.type, `${name}: ${key} at the end`);
    }
  }
});

test("written root first and in display order, the first part comes long before the block ends", () => {
  for (const [name, spec] of Object.entries(examples)) {
    const text = JSON.stringify(spec, null, 2);
    const all = views(text);
    const root = all.findIndex(Boolean);
    const part = all.findIndex((view) => drawnKeys(view).length > 1);
    assert.ok(root > 0 && root < text.length * 0.25, `${name}: the root at ${root} of ${text.length}`);
    // A part is drawn whole: one that is most of the block (a table) comes near its end.
    const by = name === "report" ? text.length * 0.8 : text.length - 1;
    assert.ok(part > root && part < by, `${name}: the first part at ${part} of ${text.length}`);
  }
});

test("placeholders keep the room of their kind once their type is read", () => {
  const text = JSON.stringify(table);
  const stream = new BlockStream();
  const at = (marker) => stream.update(text.slice(0, text.indexOf(marker) + marker.length)).view();
  assert.deepEqual(at('"children":["runs","note"]}').elements.runs, { type: PENDING, props: { kind: "line" } });
  assert.deepEqual(at('"type":"Table"').elements.runs, { type: PENDING, props: { kind: "table" } });
  assert.deepEqual(at('"type":"Table"').elements.note, { type: PENDING, props: { kind: "line" } });
  assert.equal(at('"type":"Text"').elements.runs.type, "Table");
});

test("nothing is drawn before the root closes, nor when it is written last", () => {
  const { root, elements } = table;
  const last = JSON.stringify({ elements, root });
  const all = views(last);
  const read = last.length - 2; // the root's closing quote
  assert.ok(all.slice(0, read).every((view) => view === null), "no root yet, nothing to place");
  assert.ok(all[read] && all.at(-1), "drawn once the root is read");
  // The root's own props are read only whole: a root still being written is not drawn.
  const text = JSON.stringify(table);
  const stream = new BlockStream();
  assert.equal(stream.update(text.slice(0, text.indexOf('"Synthetic'))).view(), null);
  // A root that is not a Result is never drawn.
  assert.equal(new BlockStream().update(JSON.stringify({ root: "note", elements })).view(), null);
});

test("braces, quotes and escapes inside strings are text", () => {
  const tricky = 'A } ] { [ " \\ ☃ \\u0041 "elements": {"x": 1}';
  const spec = {
    root: "result",
    elements: {
      result: { type: "Result", props: { title: "T } {", summary: tricky }, children: ["text"] },
      text: { type: "Text", props: { text: tricky } },
    },
  };
  const text = JSON.stringify(spec);
  for (const view of views(text))
    for (const key of drawnKeys(view)) assert.deepEqual(view.elements[key].props, spec.elements[key].props);
  assert.deepEqual(drawnKeys(views(text).at(-1)), ["result", "text"]);
});

test("text that cannot be JSON stops the drawing for good", () => {
  const text = JSON.stringify(table);
  const head = text.slice(0, text.indexOf('"runs":{') );
  for (const broken of [
    `// comment\n${text}`,
    `${head}"runs" "x"`,
    `${head}"runs":{"type"}`,
    `${head},,`,
    `${head}"runs":{"type":"Table"]`,
    `${head}"runs":{"type":"Table",}`,
    `${text}{}`,
    `${text} trailing`,
    `${head}"runs":{"type":"Table","props":{"bad\\q":1}}`,
  ]) {
    const stream = new BlockStream();
    assert.ok(stream.update(head).view(), "drawn before");
    assert.equal(stream.update(broken).view(), null, broken.slice(-30));
    assert.equal(stream.update(`${broken}${text}`).view(), null, "and after more is written");
  }
  // More than a block may hold.
  const big = new BlockStream();
  assert.ok(big.update(head).view());
  assert.equal(big.update(head + " ".repeat(MAX_SPEC_LENGTH)).view(), null);
});

// YN-14 A5: a reply's block only displays. A part that acts is refused once
// the block closes, so nothing of the block is drawn while it is written.
const acts = {
  Continue: { label: "Go on", instruction: "Explore the selected run." },
  Clarification: clarificationExample,
  TaskStatus: { taskId: "T-1", status: "review", reason: "Synthetic proposal." },
};
const withAct = (type) => ({
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "Twenty runs", summary: "Synthetic sample." }, children: ["note", "act"] },
    note: { type: "Text", props: { text: "Illustrative values only." } },
    act: { type, props: acts[type] },
  },
});

test("a block with Continue, Clarification or TaskStatus is refused: they go to a Home Ask", () => {
  for (const type of Object.keys(acts)) {
    const spec = withAct(type);
    // Valid as a stored result, which still renders and answers it.
    assert.equal(checkSpec(structuredClone(spec)).spec.elements.act.type, type);
    const segments = parseReply(`One sentence first.\n\n\`\`\`yuzuno-ui\n${JSON.stringify(spec)}\n\`\`\``, true);
    assert.deepEqual(segments.map((segment) => segment.kind), ["text", "invalid"], type);
    assert.deepEqual(segments[1].problem, { code: "display_only", reason: DISPLAY_ONLY_REASON, path: "elements.act.type" }, type);
  }
  assert.equal(DISPLAY_ONLY_REASON, "Forms, choices and status changes go to a Home Ask; a reply block only displays.");
  // Refused first, even when the part's own props are wrong.
  const wrong = withAct("TaskStatus");
  wrong.elements.act.props = {};
  assert.equal(parseReply(`\`\`\`yuzuno-ui\n${JSON.stringify(wrong)}\n\`\`\``, true)[0].problem.code, "display_only");
});

test("while a block with a part that acts is written, nothing of it is drawn and no room is kept for the part", () => {
  for (const type of Object.keys(acts)) {
    const text = JSON.stringify(withAct(type), null, 2);
    const typed = text.indexOf(`"${type}"`) + type.length + 2;
    const all = views(text);
    assert.ok(all.slice(0, typed).some(Boolean), `${type}: the root and its text are drawn before the part's type is read`);
    for (const [at, view] of all.entries()) {
      if (at >= typed - 1) assert.equal(view, null, `${type}: nothing drawn from its type on, at ${at}`);
      for (const element of Object.values(view?.elements ?? {}))
        assert.ok(element.type !== type && !["form", "task"].includes(element.props?.kind), `${type}: no skeleton for it`);
    }
  }
});

test("an element outside the catalog, or missing a prop, is a placeholder and never drawn", () => {
  const spec = structuredClone(table);
  spec.elements.result.children = ["runs", "note", "script", "fake"];
  delete spec.elements.runs.props.columns;
  spec.elements.script = { type: "Script", props: { src: "x.js" } };
  // An Agent writing the placeholder's own type gets a placeholder, not its props.
  spec.elements.fake = { type: PENDING, props: { kind: "table", html: "<b>x</b>" } };
  spec.elements.note.props.html = "<i>no</i>";
  const view = new BlockStream().update(JSON.stringify(spec)).view();
  assert.deepEqual(view.elements.runs, { type: PENDING, props: { kind: "table" } });
  assert.deepEqual(view.elements.note, { type: PENDING, props: { kind: "line" } });
  assert.deepEqual(view.elements.script, { type: PENDING, props: { kind: "line" } });
  assert.deepEqual(view.elements.fake, { type: PENDING, props: { kind: "line" } });
  assert.deepEqual(drawnKeys(view), ["result"]);
});

test("a cycle, a repeated child, or more than the bounds is left out", () => {
  const section = (children) => ({ type: "Section", props: { title: "S" }, children });
  const cycle = {
    root: "result",
    elements: {
      result: { type: "Result", props: { title: "T", summary: "" }, children: ["a", "a", "b"] },
      a: section(["result", "a", "b"]),
      b: section(["a"]),
    },
  };
  const view = new BlockStream().update(JSON.stringify(cycle)).view();
  assert.deepEqual(view.elements.result.children, ["a", "b"]);
  assert.deepEqual(view.elements.a.children, []);
  assert.deepEqual(view.elements.b.children, []);
  // Six levels at most.
  const deep = { root: "result", elements: { result: { type: "Result", props: { title: "T", summary: "" }, children: ["s2"] } } };
  for (let level = 2; level <= 8; level++) deep.elements[`s${level}`] = section(level < 8 ? [`s${level + 1}`] : []);
  const levels = new BlockStream().update(JSON.stringify(deep)).view();
  assert.deepEqual(Object.keys(levels.elements), ["result", "s2", "s3", "s4", "s5", "s6"]);
  assert.deepEqual(levels.elements.s6.children, []);
  // 32 components at most.
  const wide = { root: "result", elements: { result: { type: "Result", props: { title: "T", summary: "" }, children: ["s1", "s2"] } } };
  for (const s of ["s1", "s2"]) {
    wide.elements[s] = section([]);
    for (let i = 0; i < 20; i++) {
      wide.elements[s].children.push(`${s}t${i}`);
      wide.elements[`${s}t${i}`] = { type: "Text", props: { text: `${i}` } };
    }
  }
  const capped = new BlockStream().update(JSON.stringify(wide)).view();
  assert.equal(Object.keys(capped.elements).length, 32);
  assert.equal(capped.elements.s1.children.length, 20);
  assert.equal(capped.elements.s2.children.length, 9);
});

test("a later element with the same key wins, as in JSON.parse", () => {
  const text = JSON.stringify(table).replace(
    '"note":{',
    '"note":{"type":"Text","props":{"text":"first"}},"note":{',
  );
  assert.equal(JSON.parse(text).elements.note.props.text, "Illustrative values only.");
  assert.deepEqual(new BlockStream().update(text).view().elements.note.props, { text: "Illustrative values only." });
});

test("the same view while nothing drawn changes, and drawn elements keep their identity", () => {
  const text = JSON.stringify(table);
  const stream = new BlockStream();
  const start = text.indexOf('"type":"Table"');
  const a = stream.update(text.slice(0, start + 20)).view();
  const b = stream.update(text.slice(0, start + 40)).view();
  assert.equal(a, b);
  const whole = stream.update(text).view();
  assert.notEqual(whole, a);
  assert.equal(whole.elements.runs, stream.update(text).view().elements.runs);
  // A text that does not extend the last one is read again from the start.
  const other = structuredClone(table);
  other.elements.note.props.text = "Replaced.";
  assert.equal(stream.update(JSON.stringify(other)).view().elements.note.props.text, "Replaced.");
  assert.equal(stream.update(text.slice(0, start)).view().elements.runs.type, PENDING);
});

test("checkElement checks one element as checkSpec does, display defaults included", () => {
  const { runs } = structuredClone(table.elements);
  delete runs.props.title;
  assert.equal(checkElement("runs", runs).props.title, "Table");
  const fails = (key, element, code, path) =>
    assert.throws(() => checkElement(key, element), (error) => error instanceof ResultError && error.code === code && error.path === path);
  const mismatch = structuredClone(table.elements.runs);
  mismatch.props.rows[3].cells = { name: "x" };
  fails("runs", mismatch, "row_mismatch", "elements.runs.props.rows");
  const twice = structuredClone(table.elements.runs);
  twice.props.rows[1].id = "r0";
  fails("runs", twice, "duplicate_id", "elements.runs.props");
  fails("runs", { type: "Table", props: {} }, "invalid_field", "elements.runs.props.id");
  fails("x", { type: "Iframe", props: {} }, "unknown_component", "elements.x.type");
  fails("x", { type: "Sources", props: { items: [{ id: "s", label: "S", href: "javascript:alert(1)" }] } }, "invalid_source", "elements.x.props.items");
  for (const key of ["__proto__", "constructor", "1bad"]) assert.throws(() => checkElement(key, table.elements.note), ResultError, key);
  // Nor is such a root drawn.
  const raw = `{"root":"__proto__","elements":{"__proto__":${JSON.stringify(table.elements.result)}}}`;
  assert.equal(new BlockStream().update(raw).view(), null);
});

test("only the first block is drawn as it is written", () => {
  const block = (body, close = true) => "```yuzuno-ui\n" + body + (close ? "\n```" : "");
  const text = JSON.stringify(table);
  const first = parseReply(`Lead.\n\n${block(text.slice(0, 200), false)}`, false);
  assert.deepEqual(first.map((s) => [s.kind, s.extra]), [["text", undefined], ["pending", undefined]]);
  const second = parseReply(`Lead.\n\n${block(text)}\n\nMore.\n\n${block(text.slice(0, 200), false)}`, false);
  assert.deepEqual(second.map((s) => [s.kind, s.extra]), [["text", undefined], ["result", undefined], ["text", undefined], ["pending", true]]);
  // After a block that could not be shown, the next one still can be.
  const afterInvalid = parseReply(`${block("{")}\n\n${block(text.slice(0, 200), false)}`, false);
  assert.deepEqual(afterInvalid.map((s) => [s.kind, s.extra]), [["invalid", undefined], ["pending", undefined]]);
});
