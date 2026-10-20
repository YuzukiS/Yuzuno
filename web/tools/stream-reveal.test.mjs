import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { FADE, SPREAD, revealSegments } from "../src/stream-reveal.ts";

const words = (root) =>
  [...root.querySelectorAll(".stream-word")].map((w) => [
    w.textContent,
    Number.parseInt(w.style.animationDelay, 10),
  ]);

test("only the appended words fade, each a little after the one before", () => {
  const { document } = new JSDOM("<div><p>Hello world</p><p>New words here</p></div>").window;
  const root = document.querySelector("div");
  revealSegments(root, [{ start: 11, end: 25, at: 1000 }], 1100);
  const step = SPREAD / 14;
  assert.deepEqual(words(root), [
    ["New ", Math.round(1000 - 1100)],
    ["words ", Math.round(1000 + 4 * step - 1100)],
    ["here", Math.round(1000 + 10 * step - 1100)],
  ]);
  assert.equal(root.querySelector("p").innerHTML, "Hello world", "earlier text is untouched");
  assert.equal(root.textContent, "Hello worldNew words here", "text is unchanged");
});

test("a text node straddling the boundary is split; whitespace and markup stay", () => {
  const { document } = new JSDOM("<div><p>Old text <strong>and new</strong> tail</p></div>").window;
  const root = document.querySelector("div");
  revealSegments(root, [{ start: 9, end: 21, at: 0 }], 0);
  assert.deepEqual(words(root).map(([w]) => w), ["and ", "new", "tail"]);
  assert.equal(root.querySelector("strong").textContent, "and new");
  assert.equal(root.textContent, "Old text and new tail");
});

test("later segments start later; a word continues from where it had got to", () => {
  const { document } = new JSDOM("<div><p>one two three four</p></div>").window;
  const root = document.querySelector("div");
  revealSegments(root, [{ start: 0, end: 8, at: 0 }, { start: 8, end: 18, at: 100 }], 200);
  const delays = words(root).map(([, delay]) => delay);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]), JSON.stringify(delays));
  assert.ok(delays.every((d) => d > -(SPREAD + FADE)), "none is already finished");
});
