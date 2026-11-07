// YN-16 S6: what a page in its sandboxed frame may send Home, and the theme
// Home gives it. Pure: no DOM, no model.
import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_HEIGHT, readFrameMessage, SEND_CHARS, themeMessage, THEME_VARS } from "../src/intelligent-ui/page-bridge.ts";
import { briefGuide } from "../src/intelligent-ui/brief-contract.ts";

test("a page's height is a finite number, kept within 120-1600 px and rounded; anything else is not a height", () => {
  assert.deepEqual([FRAME_HEIGHT.min, FRAME_HEIGHT.max], [120, 1600]);
  const px = (value) => readFrameMessage({ type: "yuzuno:height", px: value });
  assert.deepEqual([px(300), px(300.5), px(40), px(-5), px(5000)].map((m) => m.px), [300, 301, 120, 120, 1600]);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "300", null, undefined]) assert.equal(px(value), null, String(value));
});

test("a page's message is one text, trimmed, of 1-2000 characters; a longer one is not cut but ignored", () => {
  assert.equal(SEND_CHARS, 2000);
  const send = (text) => readFrameMessage({ type: "yuzuno:send", text });
  assert.deepEqual(send("  Ring size 7  "), { kind: "send", text: "Ring size 7" });
  assert.equal(send("x".repeat(2000)).text.length, 2000);
  assert.equal(send("x".repeat(2001)), null);
  // Characters, not UTF-16 units: 2000 emoji are 4000 units and still one message.
  assert.equal([...send("🚲".repeat(2000)).text].length, 2000);
  assert.equal(send("🚲".repeat(2001)), null);
  for (const text of ["", "   ", 42, null, ["a"], { text: "a" }]) assert.equal(send(text), null, JSON.stringify(text));
});

test("only the bridge's two messages are taken; any other shape or type is nothing", () => {
  for (const data of [null, undefined, "yuzuno:send", 1, [], [{ type: "yuzuno:send", text: "a" }], {}, { type: "yuzuno:theme", vars: {} },
    { type: "yuzuno:navigate", url: "https://example.test" }, { type: "YUZUNO:SEND", text: "a" }])
    assert.equal(readFrameMessage(data), null, JSON.stringify(data) ?? String(data));
});

test("the theme names its five colours and the font, as the window around the page has them, and the scheme", () => {
  const root = { dataset: { theme: "dark" } };
  const computed = { "--paper": " #181a17", "--ink": "#eef0ea ", "--line": "#3a3e37", "--accent-ink": "#9fd3a8", "--green": "#5fa86d" };
  globalThis.getComputedStyle = (element) => {
    assert.equal(element, root);
    return { getPropertyValue: (name) => computed[name] ?? "", fontFamily: ' Inter, "Noto Sans SC", sans-serif ' };
  };
  try {
    assert.deepEqual(THEME_VARS, ["--paper", "--ink", "--line", "--accent-ink", "--green"]);
    assert.deepEqual(themeMessage(root), {
      type: "yuzuno:theme",
      vars: { "--paper": "#181a17", "--ink": "#eef0ea", "--line": "#3a3e37", "--accent-ink": "#9fd3a8", "--green": "#5fa86d", "--font": 'Inter, "Noto Sans SC", sans-serif' },
      scheme: "dark",
    });
    root.dataset.theme = "light";
    assert.equal(themeMessage(root).scheme, "light");
  } finally {
    delete globalThis.getComputedStyle;
  }
});

test("brief_guide attachments tells an Agent the three messages, their limits and that nothing is sent without Send", () => {
  const part = briefGuide("attachments");
  for (const phrase of [
    /An HTML page \(one self-contained \.html or \.htm file\) shows working on its card and in its Preview, in a sandbox/,
    /"type": "yuzuno:theme", "vars": \{"--paper", "--ink", "--line", "--accent-ink", "--green", "--font"\}, "scheme": "light" or "dark"\}/,
    /parent\.postMessage\(\{type: "yuzuno:height", px\}, "\*"\) sets the height of its card's frame \(120-1600 px\)/,
    /at most 2000 characters; a longer one is ignored, a newer one replaces it/,
    /sends it as the reader's reply from Home only if they press Send\. Nothing else the page does reaches you\./,
    /<script>addEventListener\("message"/,
  ])
    assert.match(part, phrase);
});
