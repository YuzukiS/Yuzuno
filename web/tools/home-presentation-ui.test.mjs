import "./jsdom-guard.mjs";
// T-175: Settings → Home. The user's presentation preference for this
// Workspace: what Core keeps is shown with exactly what Agents receive; a
// change is sent only when saved; Restore default clears it. Core is a fetch
// stub here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "home-presentation-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {HomePresentationSettings} from ${JSON.stringify(path.join(root, "src/HomePresentationSettings.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderSettings = props => root.render(<HomePresentationSettings {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "HomePresentationUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

function mount(handler) {
  const calls = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  dom.window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || "GET", body });
    const result = await handler(url, body);
    return { ok: true, status: 200, json: async () => structuredClone(result), text: async () => JSON.stringify(result) };
  };
  dom.window.eval(bundle);
  return { window: dom.window, doc: dom.window.document, calls, errors, close: () => dom.window.close() };
}
const button = (p, text) => [...p.doc.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
async function waitFor(f) {
  for (let i = 0; i < 100; i++) {
    if (f()) return;
    await tick();
  }
  assert.fail("Expected UI state did not appear");
}
function type(p, element, value) {
  const proto = element.tagName === "TEXTAREA" ? p.window.HTMLTextAreaElement.prototype : p.window.HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new p.window.Event(element.tagName === "TEXTAREA" ? "input" : "change", { bubbles: true }));
}

/** Core's answer for what it keeps, with the text it gives Agents. */
function core(style, note) {
  if (style === "default" && !note) return { style, note: "", updatedAt: null, scope: "workspace", agentText: null };
  const visual = style === "visual" ? " lead with a visual summary." : "";
  return {
    style, note, updatedAt: "2026-10-22T17:00:00Z", scope: "workspace",
    agentText: `The user's Home presentation preference:${visual}${note ? ` In the user's words: "${note}"` : ""} It shapes presentation only.`,
  };
}

test("the saved preference shows with what Agents receive, and only a saved change is sent", async () => {
  let kept = core("default", "");
  const p = mount((url, body) => {
    assert.equal(url, "/api/home/presentation");
    if (body) kept = core(body.style, body.note.trim().split(/\s+/).join(" "));
    return kept;
  });
  try {
    p.window.renderSettings({ active: true });
    await waitFor(() => p.doc.querySelector('[aria-label="Home presentation"]'));
    const text = () => p.doc.body.textContent;
    assert.ok(text().includes("Saved in this Workspace, so every device that opens it uses the same choice."));
    assert.ok(text().includes("Nothing: Agents follow the general rule."));
    assert.equal(button(p, "Restore default"), undefined, "nothing to restore");
    assert.equal(button(p, "Save Home preference"), undefined, "nothing changed");

    type(p, p.doc.querySelector('[aria-label="Home presentation"]'), "visual");
    type(p, p.doc.querySelector('[aria-label="Your note for Agents"]'), "  Charts   first ");
    await waitFor(() => button(p, "Save Home preference"));
    assert.ok(text().includes("Nothing: Agents follow the general rule."), "not sent yet");
    assert.equal(p.calls.filter((c) => c.method === "PUT").length, 0);
    button(p, "Save Home preference").click();
    await waitFor(() => text().includes('In the user\'s words: "Charts first"'));
    assert.deepEqual(p.calls.filter((c) => c.method === "PUT").map((c) => c.body), [{ style: "visual", note: "  Charts   first " }]);
    assert.ok(p.doc.querySelector(".settings-current").textContent.includes("Visual first · with your note"));
    assert.equal(button(p, "Save Home preference"), undefined, "saved: nothing left to save");

    button(p, "Restore default").click();
    await waitFor(() => text().includes("Nothing: Agents follow the general rule."));
    assert.deepEqual(p.calls.filter((c) => c.method === "PUT").at(-1).body, { style: "default", note: "" });
    assert.equal(p.doc.querySelector('[aria-label="Home presentation"]').value, "default");
    assert.equal(p.doc.querySelector('[aria-label="Your note for Agents"]').value, "");
    assert.equal(button(p, "Restore default"), undefined);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a refused save keeps the draft and says why", async () => {
  const p = mount(() => core("default", ""));
  const refusal = JSON.stringify({ error: "invalid_input: the note has 301 characters; the limit is 300" });
  p.window.fetch = ((orig) => async (url, init = {}) =>
    init.method === "PUT" ? { ok: false, status: 400, text: async () => refusal } : orig(url, init))(p.window.fetch);
  try {
    p.window.renderSettings({ active: true });
    await waitFor(() => p.doc.querySelector('[aria-label="Home presentation"]'));
    type(p, p.doc.querySelector('[aria-label="Home presentation"]'), "visual");
    await waitFor(() => button(p, "Save Home preference"));
    button(p, "Save Home preference").click();
    await waitFor(() => p.doc.querySelector('[role="alert"]'));
    assert.match(p.doc.querySelector('[role="alert"]').textContent, /the limit is 300/);
    assert.equal(p.doc.querySelector('[aria-label="Home presentation"]').value, "visual", "the draft stays");
    assert.ok(p.doc.body.textContent.includes("Nothing: Agents follow the general rule."), "nothing changed for Agents");
  } finally {
    p.close();
  }
});
