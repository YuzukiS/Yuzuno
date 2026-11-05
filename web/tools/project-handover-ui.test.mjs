// T-34 S3a: a project's handover document on its settings page. A save is a
// new version against the version read; a conflict says so and offers a
// reload; past versions stay readable. Fixture HTTP only; no Core.
import "./jsdom-guard.mjs";
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
const fixture = await mkdtemp(path.join(cache, "project-handover-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectHandover} from ${src("ProjectHandover.tsx")};
const root=createRoot(document.getElementById('root'));
window.renderHandover=(id,disabled=false)=>root.render(<ProjectHandover projectId={id} disabled={disabled}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "ProjectHandoverUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
// As Core answers (handover::read_in).
const answer = (versions) => ({
  projectId: "p1",
  version: versions.length,
  markdown: versions.at(-1)?.markdown ?? "",
  history: [...versions].reverse().map(({ markdown, ...v }) => ({ ...v, bytes: markdown.length })),
  limit: 64,
});

function mount(route) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    const body = init.body && JSON.parse(init.body);
    const method = init.method || "GET";
    calls.push({ url, method, body });
    const [status, value] = route(url, method, body);
    return { ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors };
}
const field = (page, label) => page.document.querySelector(`[aria-label="${label}"]`);
async function type(page, label, value) {
  const node = field(page, label);
  const proto = node.tagName === "TEXTAREA" ? page.window.HTMLTextAreaElement.prototype
    : node.tagName === "SELECT" ? page.window.HTMLSelectElement.prototype : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
  node.dispatchEvent(new page.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await tick();
}
const button = (page, text) => [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const puts = (page) => page.calls.filter((c) => c.method === "PUT");

test("a project's handover is saved as a new version against the version read, and its past versions stay readable", async () => {
  const versions = [];
  let conflict = false;
  const page = mount((url, method, body) => {
    if (url.includes("version=")) {
      const n = Number(url.split("version=")[1]);
      return [200, { projectId: "p1", past: { ...versions[n - 1], bytes: versions[n - 1].markdown.length } }];
    }
    if (method === "PUT") {
      if (conflict || body.expectedVersion !== versions.length) return [400, { error: "version_conflict: this Project's handover changed; reload before saving" }];
      versions.push({ version: versions.length + 1, markdown: body.markdown, writtenBy: { id: "user", name: "You" }, reason: body.reason ?? null, at: "2026-11-05T08:00:00Z" });
    }
    return [200, answer(versions)];
  });
  page.window.renderHandover("p1");
  const section = () => page.document.querySelector("#project-settings-handover");
  await until(() => /No version yet\./.test(section()?.textContent ?? ""), "the empty document");
  assert.equal(button(page, "Save handover").disabled, true, "nothing to save after loading");

  await type(page, "Handover document", "# Lab\nBuild with make.");
  await type(page, "Why this change", "First notes");
  assert.match(section().textContent, /22 of 64 bytes/);
  assert.match(section().textContent, /Unsaved changes/);
  button(page, "Save handover").click();
  await until(() => /Saved\./.test(section().textContent), "the saved version");
  assert.deepEqual(puts(page)[0].body, { expectedVersion: 0, markdown: "# Lab\nBuild with make.", reason: "First notes" },
    "a save names the version it was read at");
  assert.match(section().textContent, /Version 1/);
  assert.match(section().textContent, /First notes/);
  assert.equal(field(page, "Why this change").value, "", "the reason goes with the version saved");

  await type(page, "Handover document", "# Lab\nBuild with make; test with make check.");
  button(page, "Save handover").click();
  await until(() => /Version 2/.test(section().textContent), "the second version");
  assert.equal(puts(page)[1].body.expectedVersion, 1);
  assert.equal("reason" in puts(page)[1].body, false, "no reason, none sent");
  button(page, "Show version 1").click();
  await until(() => page.document.querySelector(".project-handover-past"), "the past version");
  assert.equal(page.document.querySelector(".project-handover-past").textContent, "# Lab\nBuild with make.", "a past version stays readable");

  conflict = true;
  await type(page, "Handover document", "Overwritten");
  button(page, "Save handover").click();
  await until(() => page.document.querySelector('[role="alert"]'), "the refusal");
  assert.match(page.document.querySelector('[role="alert"]').textContent, /version_conflict: this Project/);
  assert.equal(field(page, "Handover document").value, "Overwritten", "a refused save keeps what was typed");
  conflict = false;
  button(page, "Reload the saved handover").click();
  await until(() => field(page, "Handover document")?.value === "# Lab\nBuild with make; test with make check.", "the saved document again");

  await type(page, "Handover document", "x".repeat(65));
  assert.match(section().textContent, /At most 64 bytes\./);
  assert.equal(button(page, "Save handover").disabled, true, "a document over its limit is not sent");
  assert.deepEqual(page.errors, []);
});

test("an archived project's handover is shown but can't change", async () => {
  const page = mount(() => [200, answer([{ version: 1, markdown: "Kept", writtenBy: { id: "user", name: "You" }, reason: null, at: "2026-11-05T08:00:00Z" }])]);
  page.window.renderHandover("p1", true);
  await until(() => page.document.querySelector('[aria-label="Handover document"]')?.value === "Kept", "the document");
  assert.equal(field(page, "Handover document").disabled, true, "an archived project's document can't change");
  assert.equal(button(page, "Save handover").disabled, true);
  assert.deepEqual(page.errors, []);
});

// #605 R2 fc8c3d78: Core counts the trimmed reason in UTF-8 bytes, so the field does too.
test("a reason is counted in bytes, as Core counts it: one over the limit is not sent, one at 999 bytes is", async () => {
  const versions = [];
  const page = mount((url, method, body) => {
    if (method === "PUT") versions.push({ version: versions.length + 1, markdown: body.markdown, writtenBy: { id: "user", name: "You" },
      reason: body.reason ?? null, at: "2026-11-05T08:00:00Z" });
    return [200, answer(versions)];
  });
  page.window.renderHandover("p1");
  const section = () => page.document.querySelector("#project-settings-handover");
  await until(() => /No version yet\./.test(section()?.textContent ?? ""), "the empty document");
  await type(page, "Handover document", "# Lab");
  // 400 characters, 1,200 bytes: under a 1,000-character limit, over Core's 1,000 bytes.
  await type(page, "Why this change", "说".repeat(400));
  assert.match(section().textContent, /1200 of 1000 bytes\./, "the reason's size is shown in bytes");
  assert.match(section().textContent, /At most 1000 bytes\./);
  assert.equal(button(page, "Save handover").disabled, true, "a reason over its limit in bytes is not sent");
  await type(page, "Why this change", "a".repeat(999));
  assert.match(section().textContent, /999 of 1000 bytes\./);
  button(page, "Save handover").click();
  await until(() => /Saved\./.test(section().textContent), "the saved version");
  assert.equal(puts(page).length, 1);
  assert.equal(puts(page)[0].body.reason, "a".repeat(999), "a reason within the limit is sent whole");
  assert.deepEqual(page.errors, []);
});
