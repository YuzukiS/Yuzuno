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

// The OpenCode composer's slash list (T-10): typing "/" at the very start of
// a draft lists the commands this Agent's OpenCode lists
// (`/agents/{id}/opencode/commands`, read each time the list opens), in the
// menu the Claude and Codex composers have. Choosing one only fills in its
// name; Send posts the message as any other, and Core runs a listed
// "/name …" as that command. Yuzuno's own controls are not listed: an
// OpenCode Agent has none.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/opencode-commands-ui-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {flushSync} from 'react-dom';import {createRoot} from 'react-dom/client';
import {PastedTextComposer} from ${JSON.stringify(path.join(root, "src/PastedTextComposer.tsx"))};
import {textDraft} from ${JSON.stringify(path.join(root, "src/composer-draft.ts"))};
import {nativeControl} from ${JSON.stringify(path.join(root, "src/slash-commands.ts"))};
window.textDraft = textDraft; window.nativeControl = nativeControl;
window.events = {changes: 0, submits: 0};
const root = createRoot(document.getElementById('root'));
let props = {agentId: 'o1', draft: textDraft(''), slash: 'opencode', readOnly: false};
window.show = (next) => { props = {...props, ...next}; flushSync(() => root.render(<PastedTextComposer agentId={props.agentId} label="Message" placeholder="Write" draft={props.draft}
  readOnly={props.readOnly} slashCommands={props.slash}
  onChange={(d) => { window.events.changes++; props = {...props, draft: d}; }}
  onSubmit={() => { window.events.submits++; }}/>)); };`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, lib: { entry, name: "OpencodeCommandsUiTests", formats: ["iife"] } },
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
// What Core answers (T-10, Dev 3's interface): a name, a description, an
// argument hint and whether it runs as a sub-agent; nothing of the template.
const command = (name, extra = {}) => ({ name, description: `${name} does a thing`, argumentHint: "", aliases: [], source: "custom", subtask: false, ...extra });
const ready = (commands, extra = {}) => ({ state: "ready", reason: "listed", source: "session", sessionId: "ses_1", observedAt: "2026-10-29T21:05:00.123456789+00:00",
  commands, total: commands.length, truncated: false, skillsKnown: true, ...extra });
// Not listed: the same shape, with nothing in it (as Claude's `View::not`).
const not = (state, reason) => ({ state, reason, source: null, sessionId: null, observedAt: null, commands: [], total: 0, truncated: false, skillsKnown: false });
const catalog = [
  command("review", { argumentHint: "<arguments>", description: "Review the diff against main" }),
  command("plan-it", { subtask: true }),
  command("deploy"),
];

// A page with an OpenCode Agent's composer. `answers[agent]`: what Core says,
// a function returning a promise (held answers), "fail" (HTTP 500) or
// nothing (HTTP 404, as a Core without the route answers).
function page(answers) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  // JSDOM does no layout: CodeMirror's tooltip measures text ranges.
  w.Range.prototype.getClientRects = () => [];
  w.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const calls = [];
  w.fetch = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const found = /\/api\/agents\/([^/]+)\/opencode\/commands$/.exec(new URL(url, "http://isolated.test").pathname);
    const answer = found && answers[decodeURIComponent(found[1])];
    if (!answer) return { ok: false, status: 404, json: async () => ({ error: "not found" }), text: async () => "{}" };
    const value = typeof answer === "function" ? await answer() : answer;
    if (value === "fail") return { ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => "boom" };
    return { ok: true, status: 200, json: async () => structuredClone(value) };
  };
  w.eval(bundle);
  w.show({});
  const content = () => w.document.querySelector(".cm-content");
  const view = () => {
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
    clear() {
      view().dispatch({ changes: { from: 0, to: this.text().length, insert: "" } });
    },
    key(key, extra = {}) {
      const event = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
      content().dispatchEvent(event);
      return event;
    },
    menu: () => w.document.querySelector(".slash-menu"),
    list: () => w.document.querySelector(".slash-menu [role=listbox]"),
    options: () => [...w.document.querySelectorAll(".slash-menu [role=option]")].map((o) => ({
      name: o.querySelector(".slash-menu-name").textContent,
      selected: o.getAttribute("aria-selected") === "true",
      source: o.querySelector(".slash-menu-source").textContent,
      hint: o.querySelector(".slash-menu-hint").textContent,
      title: o.title,
    })),
    notes: () => [...w.document.querySelectorAll(".slash-menu-note")].map((n) => n.textContent),
  };
}

test("typing / lists this Agent's OpenCode commands; choosing fills in the name only, and Send sends the text", async () => {
  const p = page({ o1: ready(catalog) });
  try {
    p.type("/");
    await until(() => p.options().length === 3, "the Agent's commands");
    assert.deepEqual(p.calls, ["GET /api/agents/o1/opencode/commands"]);
    assert.deepEqual(p.options().map((o) => [o.name, o.source, o.hint]), [
      ["/review", "Command", "<arguments>"], ["/plan-it", "Command", ""], ["/deploy", "Command", ""],
    ], "OpenCode's own, and none of Yuzuno's controls");
    assert.equal(p.list().getAttribute("aria-label"), "OpenCode commands");
    assert.match(p.options()[1].title, /Runs as a sub-agent/);
    assert.doesNotMatch(p.options()[0].title, /sub-agent/);
    assert.match(p.notes().join(" "), /^Listed by this Agent's OpenCode\. Choosing one only fills it in; Send runs it as that command\./);
    p.type("re");
    await until(() => p.options().length === 1, "filtered by what was typed");
    assert.equal(p.key("Enter").defaultPrevented, true);
    assert.equal(p.text(), "/review ");
    assert.equal(p.w.events.submits, 0, "choosing sends nothing");
    assert.equal(p.menu(), null, "the list closes");
    p.type("the diff");
    p.key("Enter");
    assert.equal(p.w.events.submits, 1, "Enter sends the draft as it is");
    assert.equal(p.text(), "/review the diff");
    assert.deepEqual(p.calls, ["GET /api/agents/o1/opencode/commands"], "the list is only read");
  } finally {
    p.close();
  }
});

test("why OpenCode's commands are not listed is said; a failed read or a Core without the list says so; Enter still sends", async () => {
  const answers = {};
  const p = page(answers);
  try {
    for (const [answer, said] of [
      [not("unavailable", "disconnected"), "OpenCode isn't connected; reconnect it, then type / again."],
      [not("unavailable", "closed"), "This Agent is closed."],
      [not("unavailable", "changed"), "OpenCode's connection changed; type / again."],
      [not("failed", "read_failed"), "Could not read OpenCode's commands."],
      ["fail", "Could not read OpenCode's commands."],
      [undefined, "Could not read OpenCode's commands."],
    ]) {
      answers.o1 = answer;
      p.clear();
      const asked = p.calls.length;
      p.type("/");
      // Read again each time: the earlier answer's note is not this one's.
      await until(() => p.calls.length === asked + 1, "read again");
      await sleep(30);
      assert.deepEqual(p.notes(), [said], JSON.stringify(answer));
      assert.deepEqual(p.options(), []);
      assert.doesNotMatch(p.notes().join(" "), /Claude/, "nothing of Claude's wording");
      const sent = p.w.events.submits;
      p.key("Enter");
      assert.equal(p.w.events.submits, sent + 1, "no list item: Enter sends");
    }
  } finally {
    p.close();
  }
});

test("an OpenCode that lists no commands says so; a long list says how many there are", async () => {
  const answers = { o1: ready([]) };
  const p = page(answers);
  try {
    p.type("/");
    await until(() => p.notes().length > 0 && !/^Reading/.test(p.notes()[0]), "the answer");
    assert.deepEqual(p.notes(), ["This Agent's OpenCode lists no commands. Enter sends the text as it is."]);
    p.key("Enter");
    assert.equal(p.w.events.submits, 1);
    answers.o1 = ready(catalog.slice(0, 2), { total: 600, truncated: true });
    p.clear();
    p.type("/");
    await until(() => p.options().length === 2, "the first ones");
    assert.match(p.notes().join(" "), /Listed by this Agent's OpenCode; 600 in all, the first 2 shown\./);
  } finally {
    p.close();
  }
});

test("an answer for another OpenCode Agent never shows in this one's list", async () => {
  let release;
  const answers = {
    o1: () => new Promise((resolve) => { release = () => resolve(ready(catalog)); }),
    o2: ready([command("only-o2")]),
  };
  const p = page(answers);
  try {
    p.type("/");
    await until(() => !!release, "o1's read is in flight");
    p.w.show({ agentId: "o2", draft: p.w.textDraft("") });
    release();
    await sleep(50);
    assert.equal(p.menu(), null, "o1's answer does not open o2's list");
    p.type("/");
    await until(() => p.options().length === 1, "o2's own list");
    assert.deepEqual(p.options().map((o) => o.name), ["/only-o2"]);
  } finally {
    p.close();
  }
});

test("read-only, the list is not read; no draft is one of Yuzuno's controls for OpenCode", async () => {
  const p = page({ o1: ready(catalog) });
  try {
    p.w.show({ readOnly: true });
    p.type("/");
    await sleep(30);
    assert.equal(p.menu(), null);
    assert.deepEqual(p.calls, []);
    for (const text of ["/model", "/review the diff", "/compact", "/new", "/status"])
      assert.equal(p.w.nativeControl(text, "opencode"), null, `${text} is sent to OpenCode, not run by Yuzuno`);
  } finally {
    p.close();
  }
});
