import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// ExitPlanMode as Claude Code 2.1.280 sends it through canUseTool: the plan
// as Markdown in input.plan and the file it saved in input.planFilePath,
// with no permission suggestions (acceptance/t24/probe, 2026-10-17).
// Bundle the components in memory, without replacing the running UI's dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "claude-plan-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ClaudePermission, ClaudeRuntimeFacts, ClaudeTool} from ${JSON.stringify(path.join(root, "src/ClaudeControls.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderPermission=(props)=>root.render(<ClaudePermission {...props}/>);
window.renderTool=(props)=>root.render(<ClaudeTool {...props}/>);
window.renderFacts=(props)=>root.render(<dl><ClaudeRuntimeFacts {...props}/></dl>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "PlanUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
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
    const reply = (await handler?.(url, init)) ?? {};
    // A handler may answer { status, body } to fail a request.
    const status = typeof reply.status === "number" && "body" in reply ? reply.status : 200;
    const body = status === 200 ? reply : reply.body;
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors, close: () => window.close() };
}
const button = (page, text) => [...page.document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
async function type(page, label, text) {
  const node = [...page.document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(label))?.querySelector("input");
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, text);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}

const PLAN = "# Add subtract() to calc.py\n\n## Steps\n\n1. Add `subtract(a, b)` below `add`.\n2. Run `python3 -c \"import calc\"`.\n\n```python\ndef subtract(a, b):\n    return a - b\n```\n";
const PLAN_FILE = "/home/u/.claude/plans/calc-py-zany-thunder.md";
const planRequest = (input = { plan: PLAN, planFilePath: PLAN_FILE }, extra = {}) => ({
  id: "plan-request", agentId: "agent", method: "claude/canUseTool", createdAt: "now",
  params: { toolName: "ExitPlanMode", input, toolUseId: "toolu_plan", requestId: "native-1", sessionPermissions: [], ...extra },
});

test("an ExitPlanMode request shows the plan as Markdown with the mode Claude reports, never its raw input", async () => {
  const p = mount();
  p.window.renderPermission({ request: planRequest(), refresh() {}, disabled: false, permissionMode: "plan" }); await tick();
  const card = p.document.querySelector(".claude-plan");
  assert.ok(card, "the plan card");
  assert.match(card.querySelector(".pending-heading").textContent, /Claude has a plan for you to review/);
  assert.equal(card.querySelector(".claude-plan-body h1").textContent, "Add subtract() to calc.py");
  assert.deepEqual([...card.querySelectorAll(".claude-plan-body ol li")].map((li) => li.textContent), ["Add subtract(a, b) below add.", "Run python3 -c \"import calc\"."]);
  assert.match(card.querySelector(".claude-plan-body pre code").textContent, /def subtract/);
  assert.match(card.querySelector(".claude-plan-mode").textContent, /Claude reports Plan mode for this session/);
  assert.match(card.querySelector(".claude-plan-file").textContent, /calc-py-zany-thunder\.md/);
  assert.doesNotMatch(card.textContent, /"planFilePath"|\{"plan"/, "no JSON input");
  assert.ok(button(p, "Approve plan") && button(p, "Keep planning"));
  assert.equal(button(p, "Approve for this session"), undefined, "Claude offered no session permission");
  assert.equal(card.querySelector(".claude-plan-toggle"), null, "a short plan is shown whole");
  assert.deepEqual(p.errors, []);
  p.close();
});

test("approving answers exactly this request and changes nothing else", async () => {
  const p = mount();
  p.window.renderPermission({ request: planRequest(), refresh() {}, disabled: false, permissionMode: "plan" }); await tick();
  button(p, "Approve plan").click(); button(p, "Approve plan").click(); await tick();
  assert.equal(p.calls.length, 1, "one decision, however often it is clicked");
  assert.match(p.calls[0].url, /\/requests\/plan-request\/respond$/);
  assert.deepEqual(p.calls[0].body, { response: { decision: "allow" } }, "no updated input, scope or permission");
  p.close();
});

test("every Claude approval card sends one decision for a double click, can retry a failed one, and stays answered", async () => {
  const bash = { ...planRequest(), id: "bash-request", params: { toolName: "Bash", input: { command: "ls" }, sessionPermissions: [] } };
  const p = mount();
  p.window.renderPermission({ request: bash, refresh() {}, disabled: false }); await tick();
  button(p, "Allow once").click(); button(p, "Allow once").click(); await tick();
  assert.equal(p.calls.length, 1);
  assert.equal(button(p, "Allow once").disabled, true, "answered, before Core's next read says so");
  button(p, "Deny").click(); await tick();
  assert.equal(p.calls.length, 1);
  p.close();
  let fail = true;
  const q = mount(() => (fail ? ((fail = false), { status: 503, body: { error: "Core is restarting" } }) : {}));
  q.window.renderPermission({ request: planRequest(), refresh() {}, disabled: false }); await tick();
  button(q, "Approve plan").click(); await tick();
  assert.match(q.document.querySelector("[role=alert]").textContent, /Core is restarting/);
  assert.equal(button(q, "Approve plan").disabled, false, "a failed answer can be sent again");
  button(q, "Approve plan").click(); await tick();
  assert.equal(q.calls.length, 2);
  assert.deepEqual(q.calls[1].body, { response: { decision: "allow" } });
  q.close();
});

test("keep planning sends the feedback as the reason; without feedback a plain denial", async () => {
  const p = mount();
  p.window.renderPermission({ request: planRequest(), refresh() {}, disabled: false }); await tick();
  await type(p, "Feedback for Claude", "  Also add a docstring  ");
  button(p, "Keep planning with feedback").click(); await tick();
  assert.deepEqual(p.calls[0].body, { response: { decision: "deny", message: "Also add a docstring" } });
  p.close();
  const q = mount();
  q.window.renderPermission({ request: planRequest(), refresh() {}, disabled: false }); await tick();
  button(q, "Keep planning").click(); await tick();
  assert.deepEqual(q.calls[0].body, { response: { decision: "deny" } });
  assert.equal(q.document.querySelector(".claude-plan-mode"), null, "no mode line when Claude has reported none");
  q.close();
});

test("feedback over 2000 bytes cannot be sent; approving never sends it", async () => {
  const p = mount();
  p.window.renderPermission({ request: planRequest(), refresh() {}, disabled: false }); await tick();
  await type(p, "Feedback for Claude", "界".repeat(700));
  assert.equal(button(p, "Keep planning with feedback").disabled, true);
  assert.match(p.document.querySelector("[role=alert]").textContent, /under 2000 bytes/);
  button(p, "Approve plan").click(); await tick();
  assert.deepEqual(p.calls[0].body, { response: { decision: "allow" } });
  p.close();
});

test("a long plan opens on request; an empty plan says so and can still be answered", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Step ${i + 1}`).join("\n");
  const p = mount();
  p.window.renderPermission({ request: planRequest({ plan: long }), refresh() {}, disabled: false }); await tick();
  const body = p.document.querySelector(".claude-plan-body");
  const toggle = p.document.querySelector(".claude-plan-toggle");
  assert.equal(body.dataset.collapsed, "true");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), body.id);
  assert.equal(body.querySelectorAll("li").length, 40, "the whole plan is in the page, only cut to a height");
  toggle.click(); await tick();
  assert.equal(body.dataset.collapsed, undefined);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "Show less");
  p.close();
  for (const input of [{}, { plan: "   " }]) {
    const e = mount();
    e.window.renderPermission({ request: planRequest(input), refresh() {}, disabled: false }); await tick();
    assert.match(e.document.querySelector(".claude-plan-empty").textContent, /Claude sent no plan text/);
    button(e, "Keep planning").click(); await tick();
    assert.deepEqual(e.calls[0].body, { response: { decision: "deny" } });
    e.close();
  }
});

test("a stale or answered request cannot be answered again", async () => {
  for (const [extra, text] of [[{ stale: true }, /closed connection/], [{ params: { ...planRequest().params, _responseSent: true } }, /Response sent/]]) {
    const p = mount();
    p.window.renderPermission({ request: { ...planRequest(), ...extra }, refresh() {}, disabled: false }); await tick();
    assert.match(p.document.body.textContent, text);
    for (const label of ["Approve plan", "Keep planning"]) {
      assert.equal(button(p, label).disabled, true, label);
      button(p, label).click();
    }
    await tick();
    assert.equal(p.calls.length, 0);
    p.close();
  }
});

test("a session offer from the bridge is named on the card; raw suggestions offer nothing", async () => {
  const offer = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];
  const p = mount();
  p.window.renderPermission({ request: planRequest(undefined, { suggestions: offer }), refresh() {}, disabled: false }); await tick();
  assert.equal(button(p, "Approve and allow edits for this session"), undefined);
  p.close();
  const q = mount();
  q.window.renderPermission({ request: planRequest(undefined, { sessionPermissions: offer }), refresh() {}, disabled: false }); await tick();
  assert.match(q.document.body.textContent, /also allows all file edits \(switches to acceptEdits mode\) until this Claude session restarts/);
  button(q, "Approve and allow edits for this session").click(); await tick();
  assert.deepEqual(q.calls[0].body, { response: { decision: "allow", scope: "session" } });
  q.close();
});

test("the plan's Markdown is sanitized like any reply", async () => {
  const p = mount();
  const plan = "# Plan\n\n<img src=x onerror=\"window.hit=1\"><script>window.hit=2</script>\n\n[docs](javascript:alert(1)) and [site](https://example.com)";
  p.window.renderPermission({ request: planRequest({ plan }), refresh() {}, disabled: false }); await tick();
  const body = p.document.querySelector(".claude-plan-body");
  assert.equal(body.querySelector("img, script"), null);
  assert.equal(p.window.hit, undefined);
  const hrefs = [...body.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("https://example.com"), JSON.stringify(hrefs));
  assert.ok(!hrefs.some((href) => /^javascript:/i.test(href || "")), JSON.stringify(hrefs));
  p.close();
});

test("the ExitPlanMode call in the conversation shows its plan and the outcome Claude Code reported", async () => {
  const item = (status, output) => ({ id: "toolu_plan", type: "claudeToolUse", name: "ExitPlanMode", status, input: { plan: PLAN, planFilePath: PLAN_FILE }, output });
  const p = mount();
  p.window.renderTool({ item: item("completed", "User has approved your plan. You can now start coding."), unconfirmed: false, opened: true }); await tick();
  const summary = p.document.querySelector(".claude-tool summary").textContent;
  assert.match(summary, /ExitPlanMode · Add subtract\(\) to calc\.py/);
  assert.match(summary, /Approved$/);
  assert.equal(p.document.querySelector(".claude-tool .claude-plan-body h1").textContent, "Add subtract() to calc.py");
  assert.doesNotMatch(p.document.querySelector(".claude-tool .tool-content").textContent, /"planFilePath"/);
  p.window.renderTool({ item: item("failed", "The user declined this action: Also add a docstring"), unconfirmed: false, opened: true }); await tick();
  assert.match(p.document.querySelector(".claude-tool summary").textContent, /Not approved$/);
  assert.match(p.document.querySelector(".claude-tool .tool-content").textContent, /declined this action: Also add a docstring/);
  p.window.renderTool({ item: item("inProgress", null), unconfirmed: false, opened: true }); await tick();
  assert.match(p.document.querySelector(".claude-tool summary").textContent, /Waiting for your review$/);
  // Another tool keeps its input as before.
  p.window.renderTool({ item: { id: "t2", type: "claudeToolUse", name: "Bash", status: "completed", input: { command: "ls" }, output: "a" }, unconfirmed: false, opened: true }); await tick();
  assert.match(p.document.querySelector(".claude-tool .tool-content").textContent, /INPUT\{\s*"command": "ls"\s*\}/);
  p.close();
});

test("the inspector shows the mode Claude reports, plan included", async () => {
  const p = mount();
  p.window.renderFacts({ runtime: { permissionMode: "plan" } }); await tick();
  const mode = [...p.document.querySelectorAll("dt")].find((dt) => dt.textContent === "Mode")?.nextElementSibling;
  assert.equal(mode?.textContent, "Plan · reported");
  p.window.renderFacts({ runtime: { permissionMode: "default" } }); await tick();
  assert.equal([...p.document.querySelectorAll("dt")].find((dt) => dt.textContent === "Mode")?.nextElementSibling.textContent, "Default · reported");
  p.window.renderFacts({ runtime: {} }); await tick();
  assert.equal([...p.document.querySelectorAll("dt")].find((dt) => dt.textContent === "Mode"), undefined, "unknown is not shown as a mode");
  p.close();
});
