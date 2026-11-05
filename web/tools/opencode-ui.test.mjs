import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// OpenCode Agents (T-110): offered only when Core says it creates them, and
// answered in OpenCode's own terms. Bundled in memory, without the running UI's dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "opencode-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${JSON.stringify(path.join(root, "src/RemoteCreateAgent.tsx"))};
import {PendingCard, Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {AgentSettings} from ${JSON.stringify(path.join(root, "src/AgentSettings.tsx"))};
import {OpenCodeRevertHost} from ${JSON.stringify(path.join(root, "src/Rewind.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderSettings=(props)=>root.render(<AgentSettings {...props}/>);
window.renderCreate=(props)=>root.render(<RemoteCreateAgent {...props}/>);
window.renderPending=(props)=>root.render(<PendingCard onViewChanges={()=>{}} {...props}/>);
// An OpenCode turn as the app shows it: inside its Agent's revert host.
window.renderTurn=(props)=>root.render(props.agent.harness==='opencode'
  ? <OpenCodeRevertHost workspaceId={props.workspaceId ?? 'ws-1'} agent={props.agent} onDraft={props.onRewindDraft}><Turn {...props}/></OpenCodeRevertHost>
  : <Turn {...props}/>);
window.unmount=()=>root.render(null);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "OpenCodeUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
/** `ready()`'s first truthy value, checked every 10 ms for at most 3 s: a wait for the state a step needs, where a
 * count of ticks is only a guess at how long rendering takes (#548's CI 41920749507 rendered later than two). */
async function until(ready, what) {
  for (let tries = 0; tries < 300; tries++) {
    const value = ready();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** The revert host's effects have run `times` times: each run sets the Workspace shown, then reads what Core keeps
 * (`/rewind/attempt` without `?id=`). A Rewind clicked before them asks for a preview of a Workspace not yet shown,
 * which the host drops when it comes, so the preview never opens. */
const hostShown = (page, times = 1) =>
  until(() => page.calls.filter((call) => call.url.endsWith("/rewind/attempt")).length >= times, "the revert host to be shown");
const local = { id: "local", name: "Core host", kind: "local", defaultCwd: "/workspace" };
const remote = { id: "mini", name: "Mac mini", kind: "ssh", target: "mac-mini", defaultCwd: "/Users/test/projects" };

function mount(handler) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    const body = (await handler?.(url, init)) ?? (url.endsWith("/machines")
      ? { machines: [local, remote] }
      : /\/models(\?|$)/.test(url) ? { models: [{ id: "m", model: "m", displayName: "Codex model" }] } : {});
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors, close: () => window.close() };
}
const button = (page, text) => [...page.document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
const group = (page, label) => page.document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
const choice = (page, label, value) => group(page, label)?.querySelector(`input[value="${value}"]`);
async function value(page, node, text) {
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, text);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}
async function create(page, opencode) {
  page.window.renderCreate({ open: true, close() {}, defaultCwd: "/workspace", disabled: false, onCreated() {}, opencode });
  await tick(); await tick();
}

test("OpenCode is offered only when Core creates it, on the Core host, with OpenCode's own model", async () => {
  const off = mount();
  try {
    await create(off, false);
    assert.ok(choice(off, "Harness", "claude"));
    assert.equal(choice(off, "Harness", "opencode"), null, "a Core without the switch offers no OpenCode");
  } finally { off.close(); }

  // Codex's list never answers: choosing OpenCode leaves no wait for it.
  const page = mount((url, init) => url.endsWith("/agents") ? { id: "new", ...JSON.parse(init.body) }
    : /\/models(\?|$)/.test(url) ? new Promise(() => {}) : undefined);
  try {
    await create(page, true);
    assert.match(page.document.body.textContent, /Loading Codex models/);
    choice(page, "Where to work", "mini").click(); await tick();
    choice(page, "Harness", "opencode").click(); await tick();
    assert.equal(group(page, "Where to work").querySelector("input:checked").value, "local", "an SSH machine is left");
    assert.equal(choice(page, "Where to work", "mini").disabled, true);
    assert.equal(button(page, "Add SSH machine").disabled, true, "no SSH machine to add for OpenCode");
    assert.equal(group(page, "Model"), null, "no model choice");
    assert.doesNotMatch(page.document.body.textContent, /Loading|Couldn’t load models/);
    assert.match(page.document.body.textContent, /OpenCode’s own default model, login and permission rules/);
    assert.match(page.document.body.textContent, /OpenCode may download or update its own\s+dependencies when it starts/);
    assert.equal(page.calls.some((call) => /harness=opencode/.test(call.url)), false, "no model list is asked for");
    await value(page, [...page.document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith("Name")).querySelector("input"), "Ocean");
    page.document.querySelector("form").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    const sent = page.calls.find((call) => call.url.endsWith("/agents")).body;
    assert.deepEqual(sent, { name: "Ocean", cwd: "/workspace", machineId: "local", harness: "opencode" });
    // The switch turned off while the dialog is open: back to Codex.
    await create(page, false);
    assert.equal(group(page, "Harness").querySelector("input:checked").value, "codex");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a machine added while OpenCode is chosen is kept, and the Core host stays selected", async () => {
  const page = mount((url, init) => url.endsWith("/machines") && init.method === "POST"
    ? { id: "mini-new", kind: "ssh", ...JSON.parse(init.body) } : undefined);
  const field = (label) => [...page.document.querySelectorAll("label")]
    .find((node) => node.textContent.trim().startsWith(label))?.querySelector("input");
  try {
    await create(page, true);
    // The form was opened for Codex, then OpenCode was chosen.
    button(page, "Add SSH machine").click(); await tick();
    choice(page, "Harness", "opencode").click(); await tick();
    await value(page, field("Machine name"), "Garden mini");
    await value(page, field("SSH destination"), "mini-alias");
    await value(page, field("Default working folder"), "/Users/fixture/work");
    button(page, "Save machine").click(); await tick();
    assert.equal(page.calls.filter((call) => call.init.method === "POST" && call.url.endsWith("/machines")).length, 1);
    assert.equal(group(page, "Where to work").querySelector("input:checked").value, "local");
    assert.equal(choice(page, "Where to work", "mini-new").disabled, true);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

const permission = { id: "req-1", agentId: "oc", method: "opencode/permission", createdAt: "now",
  params: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls -la"], metadata: {}, always: ["ls *"],
    _runtimeGeneration: 1, _opencodeSession: "ses_1", _responseSent: false } };

test("a permission is allowed once or rejected, and nothing lasting is offered", async () => {
  for (const [label, decision] of [["Allow once", "once"], ["Reject", "reject"]]) {
    const page = mount();
    try {
      page.window.renderPending({ request: permission, refresh() {}, disabled: false }); await tick();
      assert.match(page.document.body.textContent, /OpenCode asks to use bash for:\s*ls -la/);
      assert.deepEqual([...page.document.querySelectorAll("button")].map((b) => b.textContent.trim()), ["Allow once", "Reject"]);
      button(page, label).click(); button(page, label).click(); await tick();
      assert.equal(page.calls.length, 1, "two clicks answer once");
      assert.match(page.calls[0].url, /requests\/req-1\/respond$/);
      assert.deepEqual(page.calls[0].body, { response: { decision } });
    } finally { page.close(); }
  }
  const stale = mount();
  try {
    stale.window.renderPending({ request: { ...permission, stale: true }, refresh() {}, disabled: false }); await tick();
    assert.equal(button(stale, "Allow once").disabled, true);
    assert.match(stale.document.body.textContent, /closed connection/);
  } finally { stale.close(); }
});

test("a sub-agent's request names the sub-agent that asks, and is answered as any other (T-10)", async () => {
  const child = { ...permission, id: "req-2", params: { ...permission.params, id: "per_2", sessionID: "ses_child",
    _opencodeSession: "ses_child", _opencodeChild: { title: "Find the files (@explore subagent)", agent: "explore" } } };
  const page = mount();
  try {
    page.window.renderPending({ request: child, refresh() {}, disabled: false }); await tick();
    const line = page.document.querySelector(".pending-source");
    assert.ok(line !== null, "the card names the sub-agent that asks");
    assert.equal(line.textContent, "From sub-agent Find the files (@explore subagent). Your answer goes only to this sub-agent.");
    button(page, "Allow once").click(); await tick();
    assert.match(page.calls[0].url, /requests\/req-2\/respond$/);
    assert.deepEqual(page.calls[0].body, { response: { decision: "once" } });
  } finally { page.close(); }
  // Without a title, its agent; the Agent's own requests name none.
  const untitled = mount();
  try {
    untitled.window.renderPending({ request: { ...child, params: { ...child.params, _opencodeChild: { agent: "explore" } } }, refresh() {}, disabled: false }); await tick();
    const name = untitled.document.querySelector(".pending-source strong");
    assert.ok(name !== null, "an untitled sub-agent is named too");
    assert.equal(name.textContent, "@explore");
  } finally { untitled.close(); }
  const own = mount();
  try {
    own.window.renderPending({ request: permission, refresh() {}, disabled: false }); await tick();
    assert.ok(own.document.querySelector(".pending-source") === null, "the Agent's own request names no sub-agent");
  } finally { own.close(); }
});

test("an OpenCode Agent's settings choose only its model and that model's variant, from what its OpenCode lists (T-10)", async () => {
  const listed = [
    { id: "deepseek/deepseek-flash", model: "deepseek/deepseek-flash", displayName: "DeepSeek · DeepSeek Flash", description: null, variants: ["high", "max"] },
    { id: "openrouter/anthropic/claude-x", model: "openrouter/anthropic/claude-x", displayName: "OpenRouter · Claude X", description: "beta", variants: [] },
  ];
  const agent = { id: "oc", name: "Ocean", harness: "opencode", model: "", settings: null, status: "idle", connectionState: "connected" };
  const page = mount((url, init) => url.endsWith("/agents/oc/models") ? { models: listed, opencode: { version: "2.2.5", verified: "2.2.5" } }
    : url.endsWith("/agents/oc/settings") ? { ...agent, model: JSON.parse(init.body).model } : undefined);
  const save = async () => {
    page.document.querySelector(".agent-settings-form").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick(); await tick();
  };
  const saved = () => page.calls.filter((call) => call.url.endsWith("/agents/oc/settings")).map((call) => call.body);
  try {
    page.window.renderSettings({ agent, onSaved() {} }); await tick();
    const opener = page.document.querySelector(".agent-settings-button");
    assert.ok(opener !== null, "OpenCode has the settings button");
    assert.equal(opener.title, "OpenCode model and variant");
    assert.equal(opener.textContent.trim(), "Model & variant");
    opener.click(); await tick(); await tick();
    const dialog = page.document.querySelector('[role="dialog"]');
    assert.ok(dialog !== null, "the dialog opens");
    assert.match(dialog.textContent, /Permissions stay OpenCode’s own configuration/);
    assert.ok(page.calls.some((call) => call.url.endsWith("/agents/oc/models")), "its own OpenCode's models are read");
    const offered = (label) => [...(group(page, label)?.querySelectorAll("input") || [])].map((input) => input.value);
    assert.deepEqual(offered("Model"), ["", "deepseek/deepseek-flash", "openrouter/anthropic/claude-x"], "OpenCode's default, then its list");
    assert.ok(group(page, "Reasoning effort") === null, "no effort");
    assert.ok(group(page, "Approvals") === null, "no approvals");
    assert.ok(page.document.querySelector(".codex-context-settings") === null, "no context settings");
    assert.ok(group(page, "Variant") === null, "OpenCode's default model offers no variant");

    // A model with variants: OpenCode's default, then its variants; one chosen goes with the model.
    choice(page, "Model", "deepseek/deepseek-flash").click(); await tick();
    assert.deepEqual(offered("Variant"), ["", "high", "max"]);
    choice(page, "Variant", "max").click(); await tick();
    await save();
    assert.deepEqual(saved().at(-1), { model: "deepseek/deepseek-flash", effort: "max" });

    // A model without it drops the variant back to the default, and says so.
    // Saving closed the dialog; it opens again on the Agent as saved.
    page.window.renderSettings({ agent: { ...agent, model: "deepseek/deepseek-flash", settings: { reasoningEffort: "max" } }, onSaved() {} }); await tick();
    page.document.querySelector(".agent-settings-button").click(); await tick(); await tick();
    assert.ok(choice(page, "Variant", "max")?.checked, "the saved variant is shown");
    choice(page, "Model", "openrouter/anthropic/claude-x").click(); await tick();
    assert.ok(group(page, "Variant") === null, "Claude X lists no variant");
    assert.match(page.document.body.textContent, /OpenRouter · Claude X does not list variant max; it is back to the default/);
    await save();
    assert.deepEqual(saved().at(-1), { model: "openrouter/anthropic/claude-x", effort: null }, "the model, and OpenCode's own variant");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

// T-32 (Lead 4669): a running OpenCode newer than the verified release is noted, never refused.
test("an OpenCode Agent's settings say when its OpenCode is newer than the verified one, and nothing for that one", async () => {
  const agent = { id: "oc", name: "Ocean", harness: "opencode", model: "", settings: null, status: "idle", connectionState: "connected" };
  for (const [native, said] of [
    [{ version: "2.9.1", verified: "2.2.5", note: "newer than the verified 2.2.5" }, "OpenCode 2.9.1 is newer than the verified 2.2.5."],
    [{ version: "2.2.5", verified: "2.2.5" }, null],
  ]) {
    const page = mount((url) => url.endsWith("/agents/oc/models") ? { models: [], opencode: native } : undefined);
    try {
      page.window.renderSettings({ agent, onSaved() {} }); await tick();
      page.document.querySelector(".agent-settings-button").click();
      await until(() => page.calls.some((call) => call.url.endsWith("/agents/oc/models")) && page.document.querySelector('[role="dialog"]'),
        "the dialog reads the Agent's models");
      await tick();
      const note = page.document.querySelector(".opencode-version-note");
      if (said) assert.equal(note?.textContent, said);
      else assert.ok(!note, "nothing said of the verified release");
      assert.deepEqual(page.errors, []);
    } finally { page.close(); }
  }
});

test("questions are answered with one list of labels per question, in order", async () => {
  const request = { id: "req-2", agentId: "oc", method: "opencode/question", createdAt: "now",
    params: { id: "que_1", sessionID: "ses_1", _runtimeGeneration: 1, _opencodeSession: "ses_1", questions: [
      { question: "Which fruit?", header: "Fruit", options: [{ label: "Yuzu", description: "citrus" }, { label: "Peach", description: "" }] },
      { question: "Which colours?", header: "Colours", multiple: true, custom: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] },
    ] } };
  const page = mount();
  try {
    page.window.renderPending({ request, refresh() {}, disabled: false }); await tick();
    assert.equal(button(page, "Send answer").disabled, true);
    assert.equal(page.document.querySelectorAll('input[aria-label^="Your answer"]').length, 1, "custom text only where OpenCode allows it");
    await value(page, page.document.querySelector('input[aria-label="Your answer: Which fruit?"]'), "  Kumquat  ");
    for (const box of page.document.querySelectorAll("input[type=checkbox]")) box.click();
    await tick();
    button(page, "Send answer").click(); await tick();
    assert.deepEqual(page.calls[0].body, { response: { answers: [["Kumquat"], ["Red", "Blue"]] } });
  } finally { page.close(); }
  const declined = mount();
  try {
    declined.window.renderPending({ request, refresh() {}, disabled: false }); await tick();
    button(declined, "Decline").click(); await tick();
    assert.deepEqual(declined.calls[0].body, { response: { decision: "reject" } });
  } finally { declined.close(); }
});

test("an unsent answer survives a reload, within bounds, and says so when it cannot be kept (T-170)", async () => {
  const request = (id, native = "que_1") => ({ id, agentId: "oc", method: "opencode/question", createdAt: "now",
    params: { id: native, sessionID: "ses_1", _runtimeGeneration: 1, _opencodeSession: "ses_1", questions: [
      { question: "Which fruit?", header: "Fruit", options: [{ label: "Yuzu", description: "citrus" }, { label: "Peach", description: "" }] },
    ] } });
  const field = (page) => page.document.querySelector('input[aria-label="Your answer: Which fruit?"]');
  const KEY = 'yuzuno.request-drafts.v1:["ws-1"]';
  // Thirty older drafts of another Agent: the oldest goes first.
  const older = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [JSON.stringify(["other", "opencode", "ses_0", `que_old_${i}`]), { answers: { answers: {}, free: { 0: "old" } }, at: i + 1 }]));
  const page = mount();
  try {
    page.window.localStorage.setItem(KEY, JSON.stringify({ version: 1, entries: older }));
    page.window.renderPending({ request: request("req-1"), refresh() {}, disabled: false, draftScope: "ws-1" }); await tick();
    await value(page, field(page), "Kumquat");
    const entries = JSON.parse(page.window.localStorage.getItem(KEY)).entries;
    assert.equal(Object.keys(entries).length, 30);
    assert.deepEqual(entries[JSON.stringify(["oc", "opencode", "ses_1", "que_1"])].answers, { answers: { 0: [] }, free: { 0: "Kumquat" } });
    assert.equal(entries[JSON.stringify(["other", "opencode", "ses_0", "que_old_0"])], undefined, "the oldest went first");
    assert.doesNotMatch(page.document.body.textContent, /kept in this window only/);
    // Too large to keep: the card says so, and the last saved answer stays.
    await value(page, field(page), "x".repeat(200_001));
    assert.match(page.document.body.textContent, /This answer is kept in this window only; it could not be saved in this browser/);
    assert.doesNotMatch(page.window.localStorage.getItem(KEY), /x{1000}/);
  } finally { page.close(); }
  // A reload of the same native request under a new id; another request starts empty.
  for (const [id, native, restored] of [["req-2", "que_1", "Kumquat"], ["req-3", "que_2", ""]]) {
    const again = mount();
    try {
      again.window.localStorage.setItem(KEY, JSON.stringify({ version: 1, entries: {
        [JSON.stringify(["oc", "opencode", "ses_1", "que_1"])]: { answers: { answers: { 0: [] }, free: { 0: "Kumquat" } }, at: 1 } } }));
      again.window.renderPending({ request: request(id, native), refresh() {}, disabled: false, draftScope: "ws-1" }); await tick();
      assert.equal(field(again).value, restored);
      assert.equal(again.calls.length, 0);
    } finally { again.close(); }
  }
  // Saved data this version cannot read is left as it is.
  const damaged = mount();
  try {
    damaged.window.localStorage.setItem(KEY, "{not json");
    damaged.window.renderPending({ request: request("req-4"), refresh() {}, disabled: false, draftScope: "ws-1" }); await tick();
    await value(damaged, field(damaged), "Kumquat");
    assert.equal(damaged.window.localStorage.getItem(KEY), "{not json");
    assert.match(damaged.document.body.textContent, /kept in this window only/);
  } finally { damaged.close(); }
});

test("an OpenCode turn names OpenCode, shows its tool calls and offers its own revert", async () => {
  const turn = { id: "msg_1", status: "completed", items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "List the files" }] },
    { id: "prt_1", type: "opencodeTool", name: "bash", callId: "call_1", input: { command: "ls" }, output: "a.txt\nb.txt", status: "completed" },
    { id: "prt_2", type: "agentMessage", text: "Two files." },
  ] };
  const shown = (harness) => {
    const page = mount();
    page.window.renderTurn({ turn, index: 0, agent: { id: "a", name: "Ocean", status: "idle", color: "sage", harness }, onFile() {}, onRewindDraft() {} });
    return page;
  };
  const codex = shown("codex");
  const page = shown("opencode");
  try {
    await tick(); await tick();
    assert.ok(button(codex, "Rewind"), "the same turn of a Codex Agent offers a rewind");
    assert.match(button(page, "Rewind")?.title ?? "", /reverting to before this turn, with its files/);
    const text = page.document.body.textContent;
    assert.match(text, /OpenCode/);
    assert.doesNotMatch(text, /Codex/);
    for (const tools of page.document.querySelectorAll("details")) tools.open = true;
    await tick();
    const tool = page.document.querySelector(".opencode-tool");
    assert.ok(tool, "rendered as an OpenCode tool");
    assert.match(tool.querySelector("summary").textContent, /bash · ls/);
    assert.match(tool.textContent, /a\.txt\s*b\.txt/);
    assert.deepEqual(page.errors, []);
  } finally { codex.close(); page.close(); }
});

// OpenCode's revert (T-10): previewed with its files, asked once, the
// original text given back only once OpenCode keeps the revert; an outcome
// not confirmed is only checked, never kept by choice or asked again.
test("OpenCode's revert previews its files, asks once and gives the text back only once it is kept", async () => {
  const turn = { id: "msg_2", status: "completed", items: [
    { id: "u2", type: "userMessage", content: [{ type: "text", text: "Fix a.txt" }] },
    { id: "prt_3", type: "agentMessage", text: "Fixed." },
  ] };
  const preview = { previewId: "revert_1", available: true, removedTurns: 2, keptTurns: 1, draft: "Fix a.txt",
    files: [{ path: "/work/a.txt", current: { state: "file", size: 3, sha256: "b", executable: false }, expected: { state: "absent" } }] };
  const open = async (answers) => {
    const drafts = [];
    const page = mount((url) => {
      for (const [end, body] of Object.entries(answers)) if (url.endsWith(end)) return typeof body === "function" ? body() : body;
      return undefined;
    });
    page.window.renderTurn({ turn, index: 0, agent: { id: "a", name: "Ocean", status: "idle", color: "sage", harness: "opencode" },
      onFile() {}, onRewindDraft(agent, text) { drafts.push([agent, text]); return true; } });
    await hostShown(page);
    button(page, "Rewind").click(); await until(() => button(page, "Revert"), "the preview");
    return { page, drafts };
  };
  const sent = (page, end) => page.calls.filter((call) => call.url.endsWith(end)).map((call) => call.body);

  // Kept, every file as the snapshot holds it: the text comes back once, and the dialog closes.
  const kept = await open({ "/rewind/preview": preview,
    "/rewind/confirm": { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退", files: [{ path: "/work/a.txt", outcome: "verified" }] } });
  try {
    const text = kept.page.document.body.textContent;
    assert.match(text, /This turn and 1 later turns leave the conversation; 1 earlier turns stay/);
    assert.match(text, /\/work\/a\.txt: now 3 bytes, becomes no file/);
    assert.match(text, /Any change made since, by you or another Agent, is overwritten; Core keeps a copy of each first/);
    assert.ok(!button(kept.page, "Keep current history"), "no way to keep the current history");
    assert.ok(!button(kept.page, "Preview file restore…"), "no Claude file restore");
    assert.deepEqual(kept.drafts, [], "nothing given back before the revert is confirmed");
    button(kept.page, "Revert").click(); await tick(); await tick();
    assert.deepEqual(sent(kept.page, "/rewind/confirm"), [{ previewId: "revert_1" }], "asked once, for that preview");
    assert.deepEqual(kept.drafts, [["a", "Fix a.txt"]]);
    assert.match(kept.page.document.body.textContent, /Reverted\. 已回退/);
    assert.match(kept.page.document.body.textContent, /\/work\/a\.txt: as OpenCode’s snapshot holds it/);
    button(kept.page, "Close").click(); await tick();
    assert.doesNotMatch(kept.page.document.body.textContent, /in OpenCode’s conversation and in the files/, "closed");
    assert.deepEqual(kept.page.errors, []);
  } finally { kept.page.close(); }

  // Not confirmed: only checked, held back meanwhile; kept on check with a file that drifted: the text once, the file named.
  let checks = 0;
  const unsure = await open({ "/rewind/preview": preview,
    "/rewind/confirm": { attemptId: "revert_1", status: "unknown", draft: "", message: "这次回退的结果无法确认" },
    "/rewind/check": () => (++checks === 1
      ? { attemptId: "revert_1", status: "unknown", draft: "", message: "这次回退的结果无法确认" }
      : { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退，但有 1 个文件不是快照里的内容",
        files: [{ path: "/work/a.txt", outcome: "drifted", why: null }] }) });
  try {
    button(unsure.page, "Revert").click(); await tick(); await tick();
    let text = unsure.page.document.body.textContent;
    assert.match(text, /The revert is not yet confirmed/);
    assert.match(text, /New messages to this Agent wait until the outcome is confirmed\. The revert is never asked for again/);
    assert.ok(!button(unsure.page, "Keep current history"), "an unknown outcome is never kept by choice");
    assert.deepEqual(unsure.drafts, [], "no text back while not confirmed");
    button(unsure.page, "Check outcome").click(); await tick(); await tick();
    assert.deepEqual(unsure.drafts, []);
    button(unsure.page, "Check outcome").click(); await tick(); await tick();
    assert.deepEqual(sent(unsure.page, "/rewind/check"), [{ attemptId: "revert_1" }, { attemptId: "revert_1" }]);
    assert.deepEqual(sent(unsure.page, "/rewind/confirm").length, 1, "never asked again");
    assert.deepEqual(unsure.drafts, [["a", "Fix a.txt"]], "the text once, when kept");
    text = unsure.page.document.body.textContent;
    assert.match(text, /Reverted\./);
    assert.match(text, /\/work\/a\.txt: neither as before nor as the snapshot holds it/, "a file that drifted is named, the dialog left open");
    assert.deepEqual(unsure.page.errors, []);
  } finally { unsure.page.close(); }

  // Ended with nothing kept: no text back, even were one given.
  const none = await open({ "/rewind/preview": preview,
    "/rewind/confirm": { attemptId: "revert_1", status: "unchanged", draft: "Fix a.txt", message: "没有保留回退的结果" } });
  try {
    button(none.page, "Revert").click(); await tick(); await tick();
    assert.match(none.page.document.body.textContent, /Not reverted\. 没有保留回退的结果/);
    assert.deepEqual(none.drafts, [], "nothing kept, no text back");
  } finally { none.page.close(); }
});

// Bound to its Workspace and Agent, given only once taken, never undone by an
// older read (Lead 4133): what OpenCode's revert does when the page moves on.
const later = () => { let settle; const promise = new Promise((resolve) => { settle = resolve; }); return { promise, settle }; };
const fixTurn = { id: "msg_2", status: "completed", items: [
  { id: "u2", type: "userMessage", content: [{ type: "text", text: "Fix a.txt" }] },
  { id: "prt_3", type: "agentMessage", text: "Fixed." },
] };
const shownPreview = { previewId: "revert_1", available: true, removedTurns: 1, keptTurns: 1, draft: "Fix a.txt", files: [] };
const kept = { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退", files: [] };
const ocAgent = { id: "a", name: "Ocean", status: "idle", color: "sage", harness: "opencode" };
function revertPage(answer) {
  const page = mount((url) => {
    const { pathname, search } = new URL(url, "http://isolated.test/");
    const route = pathname.match(/\/rewind\/(\w+)$/)?.[1];
    return route ? answer(route, new URLSearchParams(search)) : undefined;
  });
  // Every show in these tests mounts the host anew or changes its Workspace, so each one reads once.
  let shows = 0;
  const show = (workspaceId, onRewindDraft) => {
    shows++;
    page.window.renderTurn({ turn: fixTurn, index: 0, agent: ocAgent, workspaceId, onFile() {}, onRewindDraft });
  };
  return { page, show, ready: () => hostShown(page, shows) };
}

test("a late answer is given to its own Workspace's draft, once that Workspace is shown again, never to another's", async () => {
  const confirm = later();
  const { page, show, ready } = revertPage((route, query) => route === "preview" ? shownPreview : route === "confirm" ? confirm.promise
    : route === "attempt" ? { attempt: query.get("id") === "revert_1" ? kept : null } : undefined);
  const first = [], second = [];
  try {
    show("ws-1", (agent, text) => { first.push([agent, text]); return true; }); await tick();
    await ready(); button(page, "Rewind").click(); await until(() => button(page, "Revert"), "the preview");
    button(page, "Revert").click(); await tick();
    // Another Workspace, with an Agent of the same ID, is shown while the answer is on its way.
    show("ws-2", (agent, text) => { second.push([agent, text]); return true; }); await tick();
    confirm.settle(kept); await tick(); await tick();
    assert.deepEqual(second, [], "never into another Workspace's draft");
    assert.deepEqual(first, [], "nor into its own while it is not shown");
    show("ws-1", (agent, text) => { first.push([agent, text]); return true; }); await tick(); await tick();
    assert.deepEqual(first, [["a", "Fix a.txt"]], "given to its own, once it is shown again");
    assert.deepEqual(second, []);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a text the draft did not take is not counted as given: it is offered again, then given once", async () => {
  const { page, show, ready } = revertPage((route, query) => route === "preview" ? shownPreview : route === "confirm" ? kept
    : route === "attempt" ? { attempt: query.get("id") === "revert_1" ? kept : null } : undefined);
  const tries = [];
  let takes = false;
  const draft = (agent, text) => { tries.push([agent, text]); return takes; };
  try {
    show("ws-1", draft); await tick();
    await ready(); button(page, "Rewind").click(); await until(() => button(page, "Revert"), "the preview");
    button(page, "Revert").click(); await tick(); await tick();
    assert.equal(tries.length, 1);
    assert.match(page.document.body.textContent, /The original text could not be added to the draft/, "said, not counted as given");
    takes = true;
    button(page, "Add to draft").click(); await tick();
    assert.equal(tries.length, 2, "offered again");
    assert.doesNotMatch(page.document.body.textContent, /could not be added/);
    button(page, "Close").click(); await tick();
    // Shown again from nothing: found again by Core, not given twice.
    page.window.unmount(); await tick();
    show("ws-1", draft); await tick(); await tick();
    assert.equal(tries.length, 2, "given once");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a read begun before the Agent's revert was opened does not undo it", async () => {
  const pending = later();
  const { page, show, ready } = revertPage((route) => route === "preview" ? shownPreview : route === "attempt" ? pending.promise : undefined);
  try {
    show("ws-1", () => true); await tick();
    await ready(); button(page, "Rewind").click(); await until(() => button(page, "Revert"), "the preview");
    assert.ok(button(page, "Revert"), "the preview is shown");
    pending.settle({ attempt: { attemptId: "revert_0", status: "unknown", draft: "", message: "old" } }); await tick(); await tick();
    assert.ok(button(page, "Revert"), "an older read does not take the preview's place");
    assert.doesNotMatch(page.document.body.textContent, /not yet confirmed/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a preview left for another Workspace leaves nothing waiting when its own is shown again", async () => {
  const first = later();
  let previews = 0;
  const { page, show, ready } = revertPage((route) => route === "preview" ? (++previews === 1 ? first.promise : shownPreview)
    : route === "attempt" ? { attempt: null } : undefined);
  try {
    show("ws-1", () => true); await tick();
    await ready(); button(page, "Rewind").click(); await tick();
    show("ws-2", () => true); await tick();
    first.settle(shownPreview); await tick(); await tick();
    show("ws-1", () => true); await tick(); await tick();
    assert.doesNotMatch(page.document.body.textContent, /Reading OpenCode’s session/, "nothing left waiting");
    await ready(); button(page, "Rewind").click(); await until(() => button(page, "Revert"), "the preview");
    assert.ok(button(page, "Revert"), "a new preview is shown");
    assert.equal(previews, 2);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an answer taken is not undone by a read begun before it", async () => {
  const confirm = later();
  const read = later();
  let reads = 0;
  const { page, show, ready } = revertPage((route) => route === "preview" ? shownPreview : route === "confirm" ? confirm.promise
    : route === "attempt" ? (++reads === 1 ? { attempt: null } : read.promise) : undefined);
  try {
    show("ws-1", () => true); await tick();
    await ready(); button(page, "Rewind").click(); await until(() => button(page, "Revert"), "the preview");
    button(page, "Revert").click(); await tick();
    // Shown again while the confirm is on its way: a read of what Core keeps begins.
    page.window.unmount(); await tick();
    show("ws-1", () => true); await tick();
    confirm.settle(kept); await tick(); await tick();
    assert.match(page.document.body.textContent, /Reverted\./);
    read.settle({ attempt: { attemptId: "revert_1", status: "sending", draft: "", message: "" } }); await tick(); await tick();
    assert.match(page.document.body.textContent, /Reverted\./, "the answer taken stays");
    assert.doesNotMatch(page.document.body.textContent, /not yet confirmed/, "not undone by the older read");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
