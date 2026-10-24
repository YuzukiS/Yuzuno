import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";

// Which key sends from the conversation's composer, as this device's
// preference says (T-189, device-preferences.ts): `auto` as before (Return
// sends from a keyboard and makes a new line on a touch screen, T-170),
// `enter` (Return sends everywhere) and `modEnter` (Return makes a new line,
// Ctrl/Cmd+Return sends). Shift+Return always makes a new line, Ctrl/Cmd+
// Return always sends, and Return while an input method composes is the
// input method's in every mode. The composer alone, given the preference.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/send-key-ui-"));
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
window.show = (sendKey) => flushSync(() => root.render(<PastedTextComposer agentId="a1" label="Message" placeholder="Write" draft={draft}
  readOnly={false} slashCommands={false} sendKey={sendKey}
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
    build: { write: false, minify: false, lib: { entry, name: "SendKeyUiTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const TOUCH = "(hover: none) and (pointer: coarse)";

function page({ touch, sendKey }) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: touch && media === TOUCH, addEventListener() {}, removeEventListener() {} });
  w.Range.prototype.getClientRects = () => [];
  w.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  w.eval(bundle);
  w.show(sendKey);
  const content = () => w.document.querySelector(".cm-content");
  const view = () => EditorView.findFromDOM(content());
  return {
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

/** Return, then each modifier, from a draft "draft": what was sent and what is left. */
function presses(options) {
  const results = {};
  for (const [name, extra] of [["return", {}], ["shift", { shiftKey: true }], ["ctrl", { ctrlKey: true }], ["meta", { metaKey: true }]]) {
    const p = page(options);
    try {
      p.type("draft");
      p.key("Enter", extra);
      results[name] = { sent: p.submits(), text: p.text() };
    } finally {
      p.close();
    }
  }
  return results;
}
const sent = { sent: 1, text: "draft" };
const newLine = { sent: 0, text: "draft\n" };

test("unset or automatic, Return sends from a keyboard and makes a new line on a touch screen, as before", () => {
  for (const sendKey of [undefined, "auto"]) {
    assert.deepEqual(presses({ touch: false, sendKey }), { return: sent, shift: newLine, ctrl: sent, meta: sent }, `keyboard, ${sendKey}`);
    assert.deepEqual(presses({ touch: true, sendKey }), { return: newLine, shift: newLine, ctrl: sent, meta: sent }, `touch, ${sendKey}`);
  }
});

test("Return sends: on a touch screen too, chosen; Shift+Return still makes a new line", () => {
  for (const touch of [false, true])
    assert.deepEqual(presses({ touch, sendKey: "enter" }), { return: sent, shift: newLine, ctrl: sent, meta: sent }, `touch ${touch}`);
});

test("Ctrl or Cmd+Return sends: Return makes a new line, from a keyboard too", () => {
  for (const touch of [false, true])
    assert.deepEqual(presses({ touch, sendKey: "modEnter" }), { return: newLine, shift: newLine, ctrl: sent, meta: sent }, `touch ${touch}`);
});

test("while an input method composes, Return is the input method's in every mode", () => {
  for (const sendKey of ["auto", "enter", "modEnter"])
    for (const touch of [false, true]) {
      const p = page({ touch, sendKey });
      try {
        p.type("にほ");
        const event = p.key("Enter", { isComposing: true });
        assert.equal(p.submits(), 0, `${sendKey}, touch ${touch}: nothing sent`);
        assert.equal(p.text(), "にほ", `${sendKey}, touch ${touch}: no new line from the composer`);
        assert.equal(event.defaultPrevented, false, `${sendKey}, touch ${touch}: the input method keeps its Return`);
      } finally {
        p.close();
      }
    }
});
