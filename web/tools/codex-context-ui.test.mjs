import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "node_modules/.cache/context-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react'; import {createRoot} from 'react-dom/client';
import {CodexContextSettings, tokenSetting} from ${JSON.stringify(path.join(root, "src/CodexContextSettings.tsx"))};
window.tokenSetting = tokenSetting; const root = createRoot(document.getElementById('root'));
window.renderContext = props => root.render(<CodexContextSettings {...props}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "ContextUI", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find(o => o.type === "chunk").code;
} finally { await rm(fixture, { recursive: true, force: true }); }
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function mount() {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(bundle); return dom;
}
test("integer boundaries and automatic defaults remain unambiguous", () => {
  const dom = mount(), parse = dom.window.tokenSetting;
  assert.equal(parse(""), null); assert.equal(parse("872000"), 872000);
  for (const bad of ["0", "-1", "1.5", "1e6", "NaN", "9007199254740992"]) assert.throws(() => parse(bad));
  dom.window.close();
});
test("requested window never becomes the native reported denominator", async () => {
  const dom = mount(); let applied = 0;
  const props = { context: { supported: true, settingsSubmitted: false, canApply: false, observedWindowTokens: 258400, observedStale: true }, window: "872000", compact: "", disabled: false, onWindow() {}, onCompact() {}, onApply() { applied++; } };
  dom.window.renderContext(props); await tick();
  const body = dom.window.document.body;
  const figure = () => body.querySelector(".codex-context-figure").textContent;
  const status = () => body.querySelector('[role="status"]').textContent;
  const apply = () => [...body.querySelectorAll("button")].find((b) => b.textContent === "Apply now");
  // The reported window, marked as last known; never the requested 872,000.
  assert.equal(figure(), "258,400 tokenslast known");
  assert.equal(body.querySelector(".codex-context-stale").textContent, "last known");
  assert.match(status(), /not been submitted for reload/);
  assert.match(status(), /Save first/);
  assert.equal(apply().disabled, true);
  dom.window.renderContext({ ...props, context: { ...props.context, canApply: true } }); await tick();
  apply().click(); assert.equal(applied, 1);
  dom.window.renderContext({ ...props, context: { supported: true, settingsSubmitted: true, canApply: true, observedWindowTokens: null, observedStale: false } }); await tick();
  assert.equal(figure(), "Unknown");
  assert.match(body.textContent, /Codex has not reported it yet/);
  assert.match(status(), /only known from its native usage report/);
  dom.window.renderContext({ ...props, context: { ...props.context, settingsSubmitted: true, requestedWindowTokens: 872000, observedWindowTokens: 828400, observedStale: false } }); await tick();
  assert.equal(figure(), "828,400 tokens");
  assert.equal(body.querySelector(".codex-context-stale"), null);
  assert.match(body.querySelector(".codex-context-differs").textContent, /Differs from the saved request \(872,000 tokens\)/);
  dom.window.renderContext({ ...props, context: { ...props.context, needsFirstTurn: true } }); await tick();
  assert.match(status(), /must finish its first turn/);
  assert.equal(apply().disabled, true);
  dom.window.renderContext({ ...props, context: { ...props.context, needsReconnect: true } }); await tick();
  assert.match(status(), /save corrected settings after a rejection, then reconnect/);
  assert.equal(apply().disabled, true);
  assert.equal(body.querySelector("input").disabled, false);
  dom.window.close();
});
test("the last action's note stands in for a routine state, never for one that blocks applying", async () => {
  const dom = mount(); let refreshed = 0, reset = 0;
  const props = { context: { supported: true, settingsSubmitted: false, canApply: true, observedWindowTokens: 258400, observedStale: false }, window: "", compact: "", disabled: false, note: "Saved. Apply them when this conversation is idle.", onWindow() {}, onCompact() {}, onApply() {}, onRefresh() { refreshed++; } };
  dom.window.renderContext(props); await tick();
  const body = dom.window.document.body;
  const status = () => body.querySelector('[role="status"]').textContent;
  assert.equal(status(), "Saved. Apply them when this conversation is idle.");
  assert.equal(body.querySelector(".codex-context-note"), null);
  // Without saved overrides there is nothing to reset.
  assert.equal([...body.querySelectorAll("button")].some((b) => b.textContent === "Reset to automatic"), false);
  body.querySelector('[aria-label="Refresh context status"]').click();
  assert.equal(refreshed, 1);
  dom.window.renderContext({ ...props, onReset() { reset++; }, context: { ...props.context, needsReconnect: true } }); await tick();
  assert.match(status(), /Reload has not finished/);
  assert.equal(body.querySelector(".codex-context-note").textContent, props.note);
  [...body.querySelectorAll("button")].find((b) => b.textContent === "Reset to automatic").click();
  assert.equal(reset, 1);
  // Blank fields say what they fall back to, with the native value when known.
  dom.window.renderContext({ ...props, context: { ...props.context, inheritedContextWindow: 400000, inheritedAutoCompactTokenLimit: 300000 } }); await tick();
  assert.deepEqual([...body.querySelectorAll(".codex-context-fields small")].map((n) => n.textContent),
    ["Blank uses Codex’s configuration (400,000).", "Blank uses Codex’s configuration (300,000)."]);
  dom.window.renderContext({ ...props, window: "872000" }); await tick();
  assert.equal(body.querySelectorAll(".codex-context-fields small")[1].textContent, "Blank uses 90% of the window.");
  dom.window.close();
});
test("an unsupported execution machine cannot submit context overrides", async () => {
  const dom = mount();
  dom.window.renderContext({ context: { supported: false }, window: "", compact: "", disabled: false, onWindow() {}, onCompact() {}, onApply() {} }); await tick();
  assert.ok([...dom.window.document.querySelectorAll("input,button")].every(node => node.disabled));
  assert.match(dom.window.document.body.textContent, /execution machine has not reported support/);
  dom.window.close();
});
