// YN-234: a reply being written is drawn block by block (src/prose-blocks.ts).
// At every step of a stream, however its text is cut into appends, what the
// reader sees is what Prose shows for that whole text (src/prose-html.ts),
// node for node once the fading words' spans are taken away; blocks that can
// no longer change keep their nodes; raw HTML, link reference definitions and
// carriage returns are read whole, as before.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
// DOMPurify's default instance reads `window` as it loads.
globalThis.window = window;
const { document } = window;
const { ProseBlocks, canSettleAt } = await import("../src/prose-blocks.ts");
const { proseHtml } = await import("../src/prose-html.ts");
const { corpus, every, para, random, randomDocument } = await import("./prose-blocks-corpus.mjs");

// What Prose shows for the whole text. Its HTML reads back as it is, so the
// string is compared with the root's: every parse in JSDOM keeps memory
// (some 100 bytes per byte of HTML), which bounds how many steps fit here.
// acceptance/stream-prose/differential.mjs runs many more in Chromium.
const reference = (text) => proseHtml(text);
/** The root's HTML without the spans of fading words. */
const plain = (root) => {
  const copy = root.cloneNode(true);
  for (const span of copy.querySelectorAll(".stream-word")) span.replaceWith(...span.childNodes);
  copy.normalize();
  return copy.innerHTML;
};
const fresh = () => {
  const root = document.createElement("div");
  root.className = "prose";
  document.body.append(root);
  return { root, blocks: new ProseBlocks(root) };
};
/** Show `text` cut into appends at `cuts`, checking every step. */
function stream(text, cuts, label) {
  const { root, blocks } = fresh();
  let now = 1000;
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    if (cut <= at) continue;
    const shown = text.slice(0, cut);
    blocks.show(shown, false, (now += 100));
    assert.equal(plain(root), reference(shown), `${label}: after ${JSON.stringify(shown.slice(-40))} (${cut} of ${text.length})`);
    at = cut;
  }
  const before = [...root.childNodes];
  blocks.show(text, true, (now += 100));
  assert.equal(plain(root), reference(text), `${label}: whole`);
  root.remove();
  return { root, before };
}
test("a cut is only where nothing after it can change what comes before", () => {
  assert.equal(canSettleAt("a\n\nb", 3), true);
  assert.equal(canSettleAt("a\nb", 2), false, "no empty line before");
  assert.equal(canSettleAt("a\n\n b", 3), false, "indented");
  assert.equal(canSettleAt("a\n\n\tb", 3), false, "a tab");
  for (const marker of ["-", "*", "+", "1", "9"]) assert.equal(canSettleAt(`- a\n\n${marker}`, 5), false, marker);
  assert.equal(canSettleAt("a\n\n　b", 3), false, "any white space");
  assert.equal(canSettleAt("a\n\n", 3), false, "nothing after it yet");
});

test("at every character of every sample, the stream shows what the whole text shows", () => {
  for (const [name, text] of Object.entries(corpus)) stream(text, every(text, 1), `${name} by 1`);
});

test("cut into appends of any size, it shows the same", () => {
  for (const [name, text] of Object.entries(corpus))
    for (const size of [2, 3, 7, 16, 61]) stream(text, every(text, size), `${name} by ${size}`);
  const next = random(234);
  for (const [name, text] of Object.entries(corpus))
    for (let run = 0; run < 4; run++) {
      const cuts = [];
      for (let at = 0; at < text.length; ) cuts.push((at += 1 + Math.floor(next() * 40)));
      stream(text, cuts, `${name}, run ${run}`);
    }
});

test("documents made of random blocks show the same at every step", () => {
  const next = random(46);
  for (let doc = 0; doc < 150; doc++) {
    const text = randomDocument(next);
    const cuts = next() < 0.5 ? every(text, 1) : every(text, 1 + Math.floor(next() * 9));
    stream(text, cuts, `random ${doc}: ${JSON.stringify(text)}`);
  }
});

test("blocks that can no longer change keep their nodes; only the last ones are drawn again", () => {
  const { root, blocks } = fresh();
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${String.fromCharCode(65 + (i % 26))} says **${i}**.`);
  let text = "";
  blocks.show(text, false);
  const first = new Map();
  let replaced = 0;
  const watch = new window.MutationObserver((records) => {
    for (const record of records) if (record.target === root) replaced += record.removedNodes.length;
  });
  watch.observe(root, { childList: true });
  for (const [i, paragraph] of paragraphs.entries()) {
    for (const word of paragraph.split(/(?<= )/)) {
      text += word;
      blocks.show(text, false);
    }
    text += "\n\n";
    blocks.show(text, false);
    if (i) first.set(i - 1, root.children[i - 1]);
  }
  watch.takeRecords();
  watch.disconnect();
  for (const [i, element] of first) assert.equal(root.children[i], element, `paragraph ${i} kept its node`);
  // Each append draws the paragraph being written again, with its line break.
  const appends = paragraphs.reduce((sum, p) => sum + p.split(/(?<= )/).length + 1, 0);
  assert.ok(replaced <= appends * 2, `${replaced} nodes replaced over ${appends} appends`);
  assert.equal(plain(root), reference(text));
});

test("a selection in what was written before stays as more is written", () => {
  const { root, blocks } = fresh();
  const selection = document.getSelection();
  try {
    let text = `${para}\n\n第二段。\n\n`;
    blocks.show(text, false);
    const strong = root.querySelector("p strong");
    const range = document.createRange();
    range.selectNodeContents(strong);
    selection.removeAllRanges();
    selection.addRange(range);
    for (const word of ["第三段", "继续写", "下去。", "\n\n- 列表", "\n- 第二项"]) blocks.show((text += word), false);
    assert.equal(selection.rangeCount, 1);
    assert.equal(selection.toString(), "请求卡");
    assert.equal(selection.getRangeAt(0).startContainer, strong);
    assert.ok(root.contains(strong));
    assert.equal(plain(root), reference(text));
  } finally {
    selection.removeAllRanges();
    root.remove();
  }
});

test("new words fade in; a settled word's span is plain text again once its fade is over", () => {
  const { root, blocks } = fresh();
  const words = () => [...root.querySelectorAll(".stream-word")].map((w) => w.textContent.trim());
  blocks.show("First words", false, 1000);
  assert.deepEqual(words(), [], "the first text is shown as is");
  blocks.show("First words and more\n\nNext", false, 1100);
  assert.deepEqual(words(), ["and", "more", "Next"]);
  blocks.show("First words and more\n\nNext paragraph", false, 1200);
  assert.deepEqual(words(), ["and", "more", "Next", "paragraph"], "fading words keep fading where they are");
  blocks.show("First words and more\n\nNext paragraph goes on", false, 2000);
  assert.deepEqual(words(), ["goes", "on"], "finished fades are plain text");
  assert.equal(root.textContent, "First words and more\nNext paragraph goes on\n");
  blocks.show("Rewritten", false, 2100);
  assert.deepEqual(words(), [], "an edit is not animated");
  assert.equal(plain(root), reference("Rewritten"));
  root.remove();
});

test("raw HTML and link definitions are read whole, as before; once whole, nothing is drawn again", () => {
  for (const text of [corpus.html, corpus.references]) {
    const { before, root } = stream(text, every(text, 5), "whole");
    assert.deepEqual([...root.childNodes], before, "the last text is already what Prose shows");
  }
  const { before, root } = stream(corpus.lists, every(corpus.lists, 4), "lists");
  assert.deepEqual([...root.childNodes], before, "finishing a reply drawn block by block changes nothing");
});

test.after(() => {
  const { heapUsed, rss } = process.memoryUsage();
  console.log(`# memory: heap ${Math.round(heapUsed / 2 ** 20)} MiB, rss ${Math.round(rss / 2 ** 20)} MiB`);
});
