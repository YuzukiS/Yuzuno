// YN-16 S3: a Diagram's layout, by diagram-layout.ts with the real dagre
// (@dagrejs/dagre, as the renderer loads it). Pure: no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import * as dagre from "@dagrejs/dagre";
import { layoutDiagram, textWidth, wrapLabel } from "../src/home/brief/diagram-layout.ts";
import { BRIEF_EXAMPLES } from "../src/intelligent-ui/brief-contract.ts";

const box = (node) => ({ left: node.x - node.width / 2, right: node.x + node.width / 2, top: node.y - node.height / 2, bottom: node.y + node.height / 2 });
/** Every node inside the canvas, no two overlapping, every edge drawn from one node to the other. */
function sound(laid, edges) {
  for (const node of laid.nodes) {
    const b = box(node);
    assert.ok(b.left >= 0 && b.top >= 0 && b.right <= laid.width + 0.5 && b.bottom <= laid.height + 0.5, `${node.id} inside ${laid.width}×${laid.height}: ${JSON.stringify(b)}`);
  }
  for (const [i, a] of laid.nodes.entries())
    for (const c of laid.nodes.slice(i + 1)) {
      const p = box(a), q = box(c);
      assert.ok(p.right <= q.left || q.right <= p.left || p.bottom <= q.top || q.bottom <= p.top, `${a.id} and ${c.id} do not overlap`);
    }
  assert.equal(laid.edges.length, edges.length);
  for (const edge of laid.edges) {
    assert.ok(edge.points.length >= 2, `${edge.from}>${edge.to} has a path`);
    for (const point of edge.points) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
}

test("the flowchart example lays out left to right and top to bottom, sound and the same each time", () => {
  const flow = BRIEF_EXAMPLES.flowchart.body.elements.flow.props;
  for (const direction of ["right", "down"]) {
    const laid = layoutDiagram(dagre, flow, direction);
    sound(laid, flow.edges);
    assert.equal(laid.direction, direction);
    assert.deepEqual(layoutDiagram(dagre, flow, direction), laid, "deterministic");
    // The loop back from fix to ci is drawn, as an edge with bends; edge labels have a place.
    assert.ok(laid.edges.find((e) => e.from === "fix" && e.to === "ci").points.length >= 3);
    assert.deepEqual(laid.edges.filter((e) => e.label).map((e) => e.label.text).sort(), ["no", "yes"]);
  }
  const across = layoutDiagram(dagre, flow, "right");
  const down = layoutDiagram(dagre, flow, "down");
  assert.ok(across.width > across.height && down.height > down.width, "right is wide, down is tall");
  // A diamond is larger than the box its text needs.
  const green = across.nodes.find((n) => n.id === "green");
  assert.ok(green.width > textWidth("All green?") + 24 && green.height > 35);
});

test("40 nodes and 60 edges, a cycle included, lay out soundly within a second", () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: i % 3 ? `Step ${i}` : `A longer step number ${i} with more words`, shape: i % 7 === 0 ? "diamond" : undefined }));
  const edges = [];
  for (let i = 0; i < 39; i++) edges.push({ from: `n${i}`, to: `n${i + 1}`, label: i % 5 ? undefined : "next" });
  for (let i = 0; edges.length < 60; i += 2) edges.push({ from: `n${(i * 7) % 40}`, to: `n${(i * 7 + 13) % 40}` });
  edges.push({ from: "n39", to: "n0" });
  edges.splice(60);
  const started = performance.now();
  const laid = layoutDiagram(dagre, { nodes, edges }, "down");
  assert.ok(performance.now() - started < 1000, "within a second");
  sound(laid, edges);
});

test("a label is at most two lines that fit, by words or characters, with what is left cut to …", () => {
  assert.deepEqual(wrapLabel("Push"), ["Push"]);
  assert.deepEqual(wrapLabel("  Push   the  branch "), ["Push the branch"]);
  const long = wrapLabel("A rather long label that needs two lines and then some more words to cut");
  assert.equal(long.length, 2);
  assert.ok(long[1].endsWith("…"));
  for (const line of long) assert.ok(textWidth(line) <= 148, line);
  const chinese = wrapLabel("一个很长的中文标签需要换行而且还要截断后面的更多文字内容");
  assert.equal(chinese.length, 2);
  assert.ok(chinese[1].endsWith("…") && chinese.every((line) => textWidth(line) <= 148));
  // Without spaces, as Chinese is: broken by characters, two lines at most.
  const word = wrapLabel("Supercalifragilisticexpialidocious-and-even-longer-than-that-by-far");
  assert.equal(word.length, 2);
  assert.ok(word[1].endsWith("…") && word.every((line) => textWidth(line) <= 148));
  assert.ok(textWidth("宽") > textWidth("w") && textWidth("W") > textWidth("i"));
});
