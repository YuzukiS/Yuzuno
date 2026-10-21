import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";

// The Claude composer's slash list (T-29): typing "/" at the very start of a
// draft lists the commands this Agent's Claude Code lists, read each time
// the list opens. Choosing one only fills in its name, keeping the rest of
// the draft; nothing is sent or run. A slash elsewhere, a path, an IME
// composition or an answer meant for another Agent never acts.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/slash-commands-ui-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {flushSync} from 'react-dom';import {createRoot} from 'react-dom/client';
import {PastedTextComposer} from ${JSON.stringify(path.join(root, "src/PastedTextComposer.tsx"))};
import {pastedText, textDraft} from ${JSON.stringify(path.join(root, "src/composer-draft.ts"))};
import {nativeControl} from ${JSON.stringify(path.join(root, "src/slash-commands.ts"))};
window.pastedText = pastedText; window.textDraft = textDraft; window.nativeControl = nativeControl;
window.events = {changes: 0, submits: 0, last: null};
const root = createRoot(document.getElementById('root'));
let props = {agentId: 'a1', draft: textDraft(''), slash: 'claude', readOnly: false};
window.show = (next) => { props = {...props, ...next}; flushSync(() => root.render(<PastedTextComposer agentId={props.agentId} label="Message" placeholder="Write" draft={props.draft}
  readOnly={props.readOnly} slashCommands={props.slash}
  onChange={(d) => { window.events.changes++; window.events.last = d; props = {...props, draft: d}; }}
  onSubmit={() => { window.events.submits++; }}/>)); };`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, lib: { entry, name: "SlashCommandsUiTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 2000) {
  for (let i = 0; i < ms / 10; i++) {
    if (f()) return;
    await sleep(10);
  }
  assert.fail(`Expected: ${what}`);
}
const command = (name, source = "builtin", extra = {}) => ({ name, description: `${name} does a thing`, argumentHint: "", aliases: [], source, ...extra });
const ready = (commands, extra = {}) => ({ state: "ready", reason: "listed", source: "session", sessionId: "s1", commands, total: commands.length, truncated: false, skillsKnown: true, ...extra });
const catalog = [
  command("compact", "builtin", { argumentHint: "<instructions>", description: "Clear history but keep a summary" }),
  command("context"),
  command("usage", "builtin", { aliases: ["cost", "stats"] }),
  command("yuzuno", "skill"),
  command("expo:expo-router", "custom"),
];

// A page with the composer. `answers[agent]`: what Core says, or a function
// returning a promise (held answers).
function page(answers) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  // JSDOM does no layout: CodeMirror's tooltip measures text ranges, which
  // get empty rects here (where the list sits is checked in Chromium,
  // acceptance/t29-commands/browser.mjs).
  w.Range.prototype.getClientRects = () => [];
  w.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const calls = [];
  w.fetch = async (url) => {
    calls.push(url);
    const agent = /\/api\/agents\/([^/]+)\/claude\/commands$/.exec(new URL(url, "http://isolated.test").pathname)?.[1];
    const answer = agent && answers[decodeURIComponent(agent)];
    if (!answer) return { ok: false, status: 404, json: async () => ({ error: "not in fixture" }), text: async () => "{}" };
    const value = typeof answer === "function" ? await answer() : answer;
    if (value === "fail") return { ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => "boom" };
    return { ok: true, status: 200, json: async () => structuredClone(value) };
  };
  w.eval(bundle);
  w.show({});
  const content = () => w.document.querySelector(".cm-content");
  const view = () => {
    // The bundle's own EditorView, found through the DOM (composer-driver.mjs).
    const found = content() && EditorView.findFromDOM(content());
    assert.ok(found, "composer mounted");
    return found;
  };
  return {
    w,
    calls,
    close: () => dom.window.close(),
    text: () => view().state.doc.toString(),
    view,
    type(text) {
      const v = view();
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
    },
    backspace() {
      const v = view();
      const at = v.state.selection.main.head;
      v.dispatch({ changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: "delete.backward" });
    },
    key(key, extra = {}) {
      const event = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
      content().dispatchEvent(event);
      return event;
    },
    menu: () => w.document.querySelector(".slash-menu"),
    options: () => [...w.document.querySelectorAll(".slash-menu [role=option]")].map((o) => ({
      name: o.querySelector(".slash-menu-name").textContent,
      selected: o.getAttribute("aria-selected") === "true",
      source: o.querySelector(".slash-menu-source").textContent,
    })),
    notes: () => [...w.document.querySelectorAll(".slash-menu-note")].map((n) => n.textContent),
  };
}

test("typing / lists this Agent's commands; arrows choose, Enter fills in the name only, and arguments follow", async () => {
  const p = page({ a1: ready(catalog) });
  try {
    p.type("/");
    await until(() => p.options().length === 6, "the Agent's commands");
    assert.deepEqual(p.calls, ["/api/agents/a1/claude/commands"]);
    assert.deepEqual(p.options().map((o) => [o.name, o.source]), [
      ["/compact", "Claude Code"], ["/context", "Claude Code"], ["/usage", "Claude Code"], ["/yuzuno", "Skill"], ["/expo:expo-router", "Command"],
      ["/model", "Yuzuno control"],
    ]);
    assert.equal(p.view().contentDOM.getAttribute("aria-expanded"), "true");
    p.type("co");
    await until(() => p.options().length === 3, "filtered by what was typed");
    // Names first, then an alias match (/usage is also /cost).
    assert.deepEqual(p.options().map((o) => [o.name, o.selected]), [["/compact", true], ["/context", false], ["/usage", false]]);
    const changes = p.w.events.changes;
    assert.equal(p.key("ArrowDown").defaultPrevented, true);
    assert.deepEqual(p.options().map((o) => o.selected), [false, true, false]);
    p.key("ArrowUp");
    p.key("ArrowUp");
    assert.deepEqual(p.options().map((o) => o.selected), [false, false, true], "wraps around");
    p.key("ArrowDown");
    assert.deepEqual(p.options().map((o) => o.selected), [true, false, false]);
    assert.equal(p.w.events.changes, changes, "moving in the list changes no draft");
    const enter = p.key("Enter");
    assert.equal(enter.defaultPrevented, true);
    assert.equal(p.text(), "/compact ");
    assert.equal(p.w.events.submits, 0, "choosing sends nothing");
    assert.equal(p.menu(), null, "the list closes");
    p.type("keep the plan");
    assert.equal(p.menu(), null, "arguments open no list");
    p.key("Enter");
    assert.equal(p.w.events.submits, 1, "Enter now sends the draft");
    assert.equal(p.text(), "/compact keep the plan");
  } finally {
    p.close();
  }
});

test("a name typed in full is sent as typed; Tab fills in, Escape closes the list only, and typing opens it again", async () => {
  const p = page({ a1: ready(catalog) });
  try {
    p.type("/usage");
    await until(() => p.options().length === 1, "one match");
    p.key("Enter");
    assert.equal(p.w.events.submits, 1, "the exact name is sent as typed");
    assert.equal(p.text(), "/usage");
    p.view().dispatch({ changes: { from: 0, to: p.text().length, insert: "" } });
    p.type("/cos");
    await until(() => p.options()[0]?.name === "/usage", "an alias finds its command");
    p.key("Tab");
    assert.equal(p.text(), "/usage ");
    p.view().dispatch({ changes: { from: 0, to: p.text().length, insert: "" } });
    p.type("/y");
    await until(() => p.options().length === 1, "listed");
    const escape = p.key("Escape");
    assert.equal(escape.defaultPrevented, true, "a handled Escape: App does not interrupt the turn");
    assert.equal(p.menu(), null);
    p.key("Enter");
    assert.equal(p.w.events.submits, 2, "with the list closed Enter sends as typed");
    assert.equal(p.text(), "/y");
    p.type("u");
    await until(() => p.options().length === 1, "typing opens it again");
    assert.equal(p.calls.length, 4, "each opening reads the list again");
  } finally {
    p.close();
  }
});

test("a slash after other text, a path, a // or an IME composition never opens or acts", async () => {
  const p = page({ a1: ready(catalog) });
  try {
    for (const text of ["see /usr/bin", "/usr/", "//host/path", "路径 /tmp"]) {
      p.view().dispatch({ changes: { from: 0, to: p.text().length, insert: "" } });
      p.type(text);
      await sleep(30);
      assert.equal(p.menu(), null, text);
    }
    assert.deepEqual(p.calls, [], "nothing was read");
    p.view().dispatch({ changes: { from: 0, to: p.text().length, insert: "" } });
    p.type("/co");
    await until(() => p.options().length === 3, "listed");
    // Enter that confirms an IME candidate is the IME's, not the list's.
    const composing = p.key("Enter", { isComposing: true });
    assert.equal(composing.defaultPrevented, false);
    assert.equal(p.text(), "/co");
    assert.equal(p.w.events.submits, 0);
    p.key("ArrowDown", { isComposing: true });
    assert.deepEqual(p.options().map((o) => o.selected), [true, false, false]);
  } finally {
    p.close();
  }
});

test("choosing keeps what follows the command: arguments, a pasted block and images", async () => {
  const p = page({ a1: ready(catalog) });
  try {
    const paste = p.w.pastedText(Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n"), 1);
    const images = [{ id: `${"a".repeat(64)}.png`, agentId: "a1", name: "shot.png", width: 10, height: 10, bytes: 100 }];
    p.w.show({ draft: { version: 1, nextNumber: 2, parts: [{ kind: "text", text: "/comp the plan " }, paste], images } });
    const v = p.view();
    v.dispatch({ selection: { anchor: 5 } });
    p.backspace();
    p.type("p");
    await until(() => p.options()[0]?.name === "/compact", "listed with the cursor in the command");
    p.key("Enter");
    // Copied out of the page's realm: deepEqual compares prototypes.
    const last = JSON.parse(JSON.stringify(p.w.events.last));
    assert.deepEqual(last.parts.map((part) => part.kind === "text" ? part.text : `[paste ${part.number}]`), ["/compact the plan ", "[paste 1]"]);
    assert.equal(last.parts[1].text, paste.text, "the pasted body is unchanged");
    assert.deepEqual(last.images, images);
    assert.equal(p.view().state.selection.main.head, "/compact ".length);
  } finally {
    p.close();
  }
});

test("what Claude Code lists now shows on each opening; failures say so and leave Enter to send", async () => {
  const answers = { a1: ready(catalog.slice(0, 1)) };
  const p = page(answers);
  try {
    p.type("/");
    await until(() => p.options().length === 2, "first list");
    p.key("Escape");
    answers.a1 = ready([...catalog.slice(0, 1), command("archify", "skill")], { source: "folder", skillsKnown: false });
    p.backspace();
    p.type("/");
    await until(() => p.options().length === 3, "the new list");
    assert.deepEqual(p.options().map((o) => o.source), ["Claude Code", "Skill", "Yuzuno control"]);
    assert.match(p.notes().join(" "), /for this folder/);
    p.key("Escape");
    answers.a1 = { state: "unavailable", reason: "initializing" };
    p.backspace();
    p.type("/");
    await until(() => /starting/.test(p.notes().join(" ")), "Claude is starting");
    assert.deepEqual(p.options(), []);
    p.key("Enter");
    assert.equal(p.w.events.submits, 1, "no list item: Enter sends");
    p.view().dispatch({ changes: { from: 0, to: p.text().length, insert: "" } });
    answers.a1 = "fail";
    p.type("/");
    await until(() => /Could not read/.test(p.notes().join(" ")), "a failed read says so");
  } finally {
    p.close();
  }
});

test("an answer for another Agent never shows in this one's list", async () => {
  let release;
  const answers = {
    a1: () => new Promise((resolve) => { release = () => resolve(ready(catalog)); }),
    a2: ready([command("only-a2", "custom")]),
  };
  const p = page(answers);
  try {
    p.type("/");
    await until(() => !!release, "a1's read is in flight");
    p.w.show({ agentId: "a2", draft: p.w.textDraft("") });
    release();
    await sleep(50);
    assert.equal(p.menu(), null, "a1's answer does not open a2's list");
    p.type("/");
    await until(() => p.options().length === 2, "a2's own list");
    assert.deepEqual(p.options().map((o) => o.name), ["/only-a2", "/model"]);
    // Back to a1: its draft starts with "/", but nothing opens until typed.
    p.w.show({ agentId: "a1", draft: p.w.textDraft("/") });
    await sleep(30);
    assert.equal(p.menu(), null);
  } finally {
    p.close();
  }
});

test("without the list (another Harness) or read-only, / is plain text", async () => {
  const p = page({ a1: ready(catalog) });
  try {
    p.w.show({ slash: false });
    p.type("/");
    await sleep(30);
    assert.equal(p.menu(), null);
    p.w.show({ slash: "claude", readOnly: true });
    p.type("c");
    await sleep(30);
    assert.equal(p.menu(), null);
    assert.deepEqual(p.calls, []);
  } finally {
    p.close();
  }
});

test("a Codex Agent lists only the controls Yuzuno runs itself, read from nowhere", async () => {
  const p = page({});
  try {
    p.w.show({ slash: "codex" });
    p.type("/");
    await until(() => p.options().length === 2, "Codex's controls");
    assert.deepEqual(p.options().map((o) => [o.name, o.source]), [["/compact", "Yuzuno control"], ["/model", "Yuzuno control"]]);
    assert.deepEqual(p.calls, [], "Codex lists no commands, so nothing is read");
    assert.match(p.notes().join(" "), /Codex lists no commands here.*never as a prompt/);
    assert.equal(p.w.document.querySelector(".slash-menu [role=listbox]").getAttribute("aria-label"), "Codex controls");
    p.key("Enter");
    assert.equal(p.text(), "/compact ");
    assert.equal(p.w.events.submits, 0, "choosing only fills it in; Send runs it");
  } finally {
    p.close();
  }
});

test("Claude Code's own /model becomes the settings control, listed once", async () => {
  const p = page({ a1: ready([command("compact"), command("model"), command("context")]) });
  try {
    p.type("/");
    await until(() => p.options().length === 3, "the list");
    assert.deepEqual(p.options().map((o) => [o.name, o.source]), [["/compact", "Claude Code"], ["/context", "Claude Code"], ["/model", "Yuzuno control"]]);
  } finally {
    p.close();
  }
});

test("only a draft that is exactly a control runs it: /model for Codex and Claude, /compact for Codex", async () => {
  const p = page({});
  try {
    // Copied out of the page's realm so plain objects compare.
    const c = (text, harness = "codex") => JSON.parse(JSON.stringify(p.w.nativeControl(text, harness)));
    assert.deepEqual(c("/compact"), { command: "compact", args: "" });
    assert.deepEqual(c("  /compact  "), { command: "compact", args: "" });
    assert.deepEqual(c("/compact keep notes"), { command: "compact", args: "keep notes" });
    assert.equal(c("/compact", "claude"), null, "Claude Code runs its own /compact as a message");
    assert.deepEqual(c("/model"), { command: "model", args: "" });
    assert.deepEqual(c("/model gpt-x", "claude"), { command: "model", args: "gpt-x" });
    // OpenCode's model is its own configuration; its drafts are messages.
    assert.equal(c("/model gpt-x", "opencode"), null);
    assert.equal(c("/compact", "opencode"), null);
    for (const text of ["/modelx", "/compacting", "see /model", "use /compact later", "```\n/compact\n```", "//compact", "/ compact"]) {
      assert.equal(c(text), null, text);
    }
  } finally {
    p.close();
  }
});
