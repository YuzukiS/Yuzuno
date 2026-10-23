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
window.events = {changes: 0, submits: 0, last: null, skills: []};
const root = createRoot(document.getElementById('root'));
let props = {agentId: 'a1', draft: textDraft(''), slash: 'claude', readOnly: false};
window.show = (next) => { props = {...props, ...next}; flushSync(() => root.render(<PastedTextComposer agentId={props.agentId} label="Message" placeholder="Write" draft={props.draft}
  readOnly={props.readOnly} slashCommands={props.slash}
  onChange={(d) => { window.events.changes++; window.events.last = d; props = {...props, draft: d}; }}
  onSkill={(s) => { window.events.skills.push(s); }}
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
    const found = /\/api\/agents\/([^/]+)\/(claude\/commands|codex\/skills)$/.exec(new URL(url, "http://isolated.test").pathname);
    // A Codex Agent's skills are answered as `codex:<agent>`.
    const answer = found && answers[`${found[2] === "codex/skills" ? "codex:" : ""}${decodeURIComponent(found[1])}`];
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
      hint: o.querySelector(".slash-menu-hint").textContent,
    })),
    notes: () => [...w.document.querySelectorAll(".slash-menu-note")].map((n) => n.textContent),
  };
}

test("typing / lists this Agent's commands; arrows choose, Enter fills in the name only, and arguments follow", async () => {
  const p = page({ a1: ready(catalog) });
  try {
    p.type("/");
    await until(() => p.options().length === 9, "the Agent's commands");
    assert.deepEqual(p.calls, ["/api/agents/a1/claude/commands"]);
    assert.deepEqual(p.options().map((o) => [o.name, o.source]), [
      ["/compact", "Claude Code"], ["/context", "Claude Code"], ["/usage", "Claude Code"], ["/yuzuno", "Skill"], ["/expo:expo-router", "Command"],
      ["/model", "Yuzuno control"], ["/permissions", "Yuzuno control"], ["/new", "Yuzuno control"], ["/resume", "Yuzuno control"],
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
    await until(() => p.options().length === 5, "first list");
    p.key("Escape");
    answers.a1 = ready([...catalog.slice(0, 1), command("archify", "skill")], { source: "folder", skillsKnown: false });
    p.backspace();
    p.type("/");
    await until(() => p.options().length === 6, "the new list");
    assert.deepEqual(p.options().map((o) => o.source), ["Claude Code", "Skill", ...Array(4).fill("Yuzuno control")]);
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
    await until(() => p.options().length === 5, "a2's own list");
    assert.deepEqual(p.options().map((o) => o.name), ["/only-a2", "/model", "/permissions", "/new", "/resume"]);
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

// T-29: a Codex Agent's skills, as its own Codex lists them for its folder
// (`/agents/{id}/codex/skills`), beside Yuzuno's controls.
const REPO = "/w/.codex/skills/deploy/SKILL.md";
const USER = "C:\\Users\\me\\.codex\\skills\\deploy\\SKILL.md";
const skill = (name, path, scope, description = `${name} skill`) => ({ name, description, argumentHint: "", aliases: [], source: "skill", path, scope });
// What the composer handed to the draft, as plain values of this realm.
const chosen = (p) => Array.from(p.w.events.skills, (s) => [s.name, s.path, s.scope]);
const skills = ready([skill("deploy", REPO, "repo"), skill("deploy", USER, "user"), skill("review", "/w/.codex/skills/review/SKILL.md", "repo")],
  { disabled: 1, errors: 0 });

test("a Codex Agent lists Yuzuno's controls and the skills its Codex lists; choosing a skill writes $name and adds it to the draft", async () => {
  const p = page({ "codex:a1": skills });
  try {
    p.w.show({ slash: "codex" });
    p.type("/");
    await until(() => p.options().length === 19, "controls and skills");
    assert.deepEqual(p.calls, ["/api/agents/a1/codex/skills"], "read from this Agent's own Codex");
    assert.deepEqual(p.options().map((o) => [o.name, o.source, o.hint]), [
      ["/compact", "Yuzuno control", ""], ["/review", "Yuzuno control", "[instructions]"], ["/goal", "Yuzuno control", "[objective]"],
      ["/plan", "Yuzuno control", ""], ["/model", "Yuzuno control", "<model>"],
      ["/permissions", "Yuzuno control", ""], ["/fork", "Yuzuno control", ""], ["/new", "Yuzuno control", ""], ["/resume", "Yuzuno control", ""], ["/status", "Yuzuno control", ""],
      ["/usage", "Yuzuno control", ""], ["/mcp", "Yuzuno control", ""], ["/changes", "Yuzuno control", ""], ["/diff", "Yuzuno control", ""],
      ["/ps", "Yuzuno control", ""], ["/stop", "Yuzuno control", ""],
      ["$deploy", "Codex skill", "repo · skills/deploy"], ["$deploy", "Codex skill", "user · skills/deploy"], ["$review", "Codex skill", "repo · skills/review"],
    ], "two skills of one name show where each is");
    assert.equal(p.w.document.querySelector(".slash-menu [role=listbox]").getAttribute("aria-label"), "Codex controls and skills");
    p.type("dep");
    await until(() => p.options().length === 2, "filtered");
    p.key("ArrowDown");
    p.key("Enter");
    assert.equal(p.text(), "$deploy ");
    assert.deepEqual(chosen(p), [["deploy", USER, "user"]], "the one chosen, by its own path");
    assert.equal(p.w.events.submits, 0, "choosing sends nothing");
    // A control is filled in as before, and is no skill.
    p.view().dispatch({ changes: { from: 0, to: p.text().length, insert: "" } });
    p.type("/comp");
    await until(() => p.options().length === 1, "the control");
    p.key("Enter");
    assert.equal(p.text(), "/compact ");
    assert.equal(p.w.events.skills.length, 1);
  } finally {
    p.close();
  }
});

test("$ at the start of a word lists only skills; text alone, $ inside a word or an IME composition chooses none", async () => {
  const p = page({ "codex:a1": skills });
  try {
    p.w.show({ slash: "codex" });
    p.type("Ship it ");
    p.type("$");
    await until(() => p.options().length === 3, "skills only");
    assert.ok(p.options().every((o) => o.name.startsWith("$") && o.source === "Codex skill"));
    p.type("rev");
    await until(() => p.options().length === 1, "filtered");
    p.key("Enter");
    assert.equal(p.text(), "Ship it $review ");
    assert.deepEqual(chosen(p).map(([name]) => name), ["review"]);
    // A word with "$" in it is no skill.
    p.type("cost a$b");
    assert.equal(p.menu(), null);
    // "$HOME" matches no skill: Enter sends the text as typed, choosing none.
    p.type(" $HOME");
    await until(() => /No skill matches/.test(p.notes().join(" ")), "no match");
    p.key("Enter");
    assert.equal(p.w.events.submits, 1);
    assert.equal(p.w.events.skills.length, 1, "text alone invokes no skill");
    // An IME composition never chooses.
    p.type(" $de");
    await until(() => p.options().length === 2, "listed");
    const composing = p.key("Enter", { isComposing: true });
    assert.equal(composing.defaultPrevented, false);
    assert.equal(p.w.events.skills.length, 1);
  } finally {
    p.close();
  }
});

test("when a Codex Agent's skills cannot be listed, its controls stay and the list says why; a Claude composer's $ is text", async () => {
  for (const [answer, why] of [[{ state: "unavailable", reason: "not_connected" }, /once this Agent is connected/],
                               [{ state: "unsupported", reason: "old_protocol" }, /does not list skills/],
                               ["fail", /Could not read this Agent's Codex skills/]]) {
    const p = page({ "codex:a1": answer });
    try {
      p.w.show({ slash: "codex" });
      p.type("/");
      await until(() => p.options().length === 16 && why.test(p.notes().join(" ")), `controls and ${why}`);
      assert.deepEqual(p.options().map((o) => o.name), ["/compact", "/review", "/goal", "/plan", "/model", "/permissions", "/fork", "/new", "/resume", "/status", "/usage", "/mcp", "/changes", "/diff", "/ps", "/stop"]);
    } finally {
      p.close();
    }
  }
  const p = page({ a1: ready(catalog) });
  try {
    p.type("Cost is ");
    p.type("$5");
    assert.equal(p.menu(), null, "no skills list for Claude here");
    assert.deepEqual(p.calls, []);
  } finally {
    p.close();
  }
});

test("Claude Code's own /model, /permissions, /new and /resume become Yuzuno's controls, each listed once", async () => {
  const p = page({ a1: ready([command("compact"), command("model"), command("context"), command("resume"), command("permissions")]) });
  try {
    p.type("/");
    await until(() => p.options().length === 6, "the list");
    assert.deepEqual(p.options().map((o) => [o.name, o.source]), [["/compact", "Claude Code"], ["/context", "Claude Code"], ["/model", "Yuzuno control"], ["/permissions", "Yuzuno control"], ["/new", "Yuzuno control"], ["/resume", "Yuzuno control"]]);
  } finally {
    p.close();
  }
});

test("only a draft that is exactly a control for its harness runs it", async () => {
  const p = page({});
  try {
    // Copied out of the page's realm so plain objects compare.
    const c = (text, harness = "codex") => JSON.parse(JSON.stringify(p.w.nativeControl(text, harness)));
    assert.deepEqual(c("/compact"), { command: "compact", args: "" });
    assert.deepEqual(c("  /compact  "), { command: "compact", args: "" });
    assert.deepEqual(c("/compact keep notes"), { command: "compact", args: "keep notes" });
    assert.equal(c("/compact", "claude"), null, "Claude Code runs its own /compact as a message");
    // /review is Codex's own review; what follows is its instructions.
    assert.deepEqual(c("/review"), { command: "review", args: "" });
    assert.deepEqual(c("/review  the error paths\n in parse.rs "), { command: "review", args: "the error paths\n in parse.rs" });
    assert.equal(c("/review", "claude"), null, "Claude Code runs its own /review as a message");
    assert.equal(c("/review", "opencode"), null);
    // /goal is Codex's own goal of this conversation.
    assert.deepEqual(c("/goal Ship the parser"), { command: "goal", args: "Ship the parser" });
    assert.equal(c("/goal", "claude"), null);
    assert.equal(c("/goals"), null);
    // /plan shows a Codex conversation's own mode; Claude Code keeps its own /plan.
    assert.deepEqual(c("/plan"), { command: "plan", args: "" });
    assert.deepEqual(c("/plan the parser"), { command: "plan", args: "the parser" }, "App refuses what follows; the parser reports it");
    assert.equal(c("/plan", "claude"), null, "Claude Code's own /plan, sent as a message");
    assert.equal(c("/plan", "opencode"), null);
    assert.equal(c("/planning"), null);
    // /changes is Yuzuno's record of a Codex turn's file edits, not a command of any harness.
    assert.deepEqual(c("/changes"), { command: "changes", args: "" });
    assert.deepEqual(c("/changes all"), { command: "changes", args: "all" }, "App refuses what follows; the parser reports it");
    assert.equal(c("/changes", "claude"), null, "a Claude Agent's /changes is a message, as before");
    assert.equal(c("/changes", "opencode"), null);
    assert.equal(c("/change"), null);
    // /diff reads Git's diff of a Codex Agent's folder through its Codex; Claude Code has its own.
    assert.deepEqual(c("/diff"), { command: "diff", args: "" });
    assert.deepEqual(c("/diff --cached"), { command: "diff", args: "--cached" }, "App refuses what follows; the parser reports it");
    assert.equal(c("/diff", "claude"), null, "a Claude Agent's /diff is Claude Code's own, sent as a message");
    assert.equal(c("/diff", "opencode"), null);
    assert.equal(c("/diffs"), null);
    // /ps and /stop are a Codex conversation's background terminals; /clean is Codex's alias of /stop.
    assert.deepEqual(c("/ps"), { command: "ps", args: "" });
    assert.deepEqual(c("/stop"), { command: "stop", args: "" });
    assert.deepEqual(c("/clean"), { command: "stop", args: "" });
    assert.deepEqual(c("/stop all"), { command: "stop", args: "all" }, "App refuses what follows; the parser reports it");
    assert.equal(c("/stop", "claude"), null, "a Claude Agent's /stop is a message, as before");
    assert.equal(c("/clean", "claude"), null);
    assert.equal(c("/ps", "opencode"), null);
    assert.equal(c("/cleanup"), null);
    // /mcp shows what a Codex Agent's servers reported; Claude Code has its own.
    assert.deepEqual(c("/mcp"), { command: "mcp", args: "" });
    assert.equal(c("/mcp", "claude"), null);
    assert.deepEqual(c("/model"), { command: "model", args: "" });
    assert.deepEqual(c("/model gpt-x", "claude"), { command: "model", args: "gpt-x" });
    // OpenCode's model is its own configuration; its drafts are messages.
    assert.equal(c("/model gpt-x", "opencode"), null);
    assert.equal(c("/compact", "opencode"), null);
    // What opens a part of Yuzuno (T-29): for Codex all of them; for Claude
    // those Claude Code has no better command for; none for OpenCode.
    for (const name of ["permissions", "fork", "new", "resume", "status", "usage"]) {
      assert.deepEqual(c(`/${name}`), { command: name, args: "" }, name);
      assert.equal(c(`/${name}`, "opencode"), null, name);
    }
    assert.deepEqual(c("/fork later"), { command: "fork", args: "later" }, "App refuses what follows; the parser reports it");
    for (const name of ["permissions", "new", "resume"]) assert.deepEqual(c(`/${name}`, "claude"), { command: name, args: "" }, name);
    for (const name of ["fork", "status", "usage"]) assert.equal(c(`/${name}`, "claude"), null, `Claude Code's own /${name}, or none`);
    for (const text of ["/modelx", "/compacting", "see /model", "use /compact later", "```\n/compact\n```", "//compact", "/ compact", "/constructor", "/toString"]) {
      assert.equal(c(text), null, text);
    }
  } finally {
    p.close();
  }
});
