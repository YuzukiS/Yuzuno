import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";

// The composer on a touch screen (T-170): a phone's on-screen keyboard has no
// Shift for Return, so there Return makes a new line and the Send button (or
// Ctrl/Cmd+Return from an attached keyboard) sends. With a mouse or trackpad,
// Return sends and Shift+Return makes a new line, as before. Which one applies
// is read from the (hover: none) and (pointer: coarse) media query.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/touch-input-ui-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {flushSync} from 'react-dom';import {createRoot} from 'react-dom/client';
import {PastedTextComposer} from ${JSON.stringify(path.join(root, "src/PastedTextComposer.tsx"))};
import {textDraft} from ${JSON.stringify(path.join(root, "src/composer-draft.ts"))};
window.events = {submits: 0};
const root = createRoot(document.getElementById('root'));
let draft = textDraft('');
window.show = () => flushSync(() => root.render(<PastedTextComposer agentId="a1" label="Message" placeholder="Write" draft={draft}
  readOnly={false} slashCommands={false}
  onChange={(d) => { draft = d; }}
  onSubmit={() => { window.events.submits++; }}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, lib: { entry, name: "TouchInputUiTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const TOUCH = "(hover: none) and (pointer: coarse)";

function page({ touch }) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: touch && media === TOUCH, addEventListener() {}, removeEventListener() {} });
  w.Range.prototype.getClientRects = () => [];
  w.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  w.eval(bundle);
  w.show();
  const content = () => w.document.querySelector(".cm-content");
  // The bundle's own EditorView, found through the DOM (composer-driver.mjs).
  const view = () => EditorView.findFromDOM(content());
  return {
    w,
    close: () => w.close(),
    text: () => view().state.doc.toString(),
    submits: () => w.events.submits,
    type(text) {
      const v = view();
      const at = v.state.selection.main.head;
      v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
    },
    key(key, extra = {}) {
      const event = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
      content().dispatchEvent(event);
      return event;
    },
  };
}

test("with a mouse or trackpad, Return sends and Shift+Return makes a new line", () => {
  const p = page({ touch: false });
  try {
    p.type("hello");
    p.key("Enter", { shiftKey: true });
    assert.equal(p.text(), "hello\n");
    assert.equal(p.submits(), 0);
    assert.equal(p.key("Enter").defaultPrevented, true);
    assert.equal(p.submits(), 1);
    assert.equal(p.text(), "hello\n", "sending does not add a line");
  } finally {
    p.close();
  }
});

test("on a touch screen, Return makes a new line and Ctrl or Cmd+Return sends", () => {
  const p = page({ touch: true });
  try {
    p.type("first");
    assert.equal(p.key("Enter").defaultPrevented, true);
    p.type("second");
    assert.equal(p.text(), "first\nsecond");
    assert.equal(p.submits(), 0, "Return never sends there");
    p.key("Enter", { shiftKey: true });
    assert.equal(p.text(), "first\nsecond\n", "Shift+Return is a new line too");
    p.key("Enter", { ctrlKey: true });
    p.key("Enter", { metaKey: true });
    assert.equal(p.submits(), 2, "an attached keyboard's Ctrl/Cmd+Return sends");
    assert.equal(p.text(), "first\nsecond\n");
    // Return that confirms an IME candidate belongs to the IME.
    const composing = p.key("Enter", { isComposing: true });
    assert.equal(composing.defaultPrevented, false);
    assert.equal(p.text(), "first\nsecond\n");
    assert.equal(p.submits(), 2);
  } finally {
    p.close();
  }
});
