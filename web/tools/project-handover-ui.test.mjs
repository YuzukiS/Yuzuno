// T-34 S3a, YN-2 S3: a project's handover document on its settings page. A
// save is checked against the revision read, with an optional note; a
// conflict says so and offers a reload; the page says who changed it last and
// shows no history. Fixture HTTP only; no Core.
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
// As Core answers (handover::read_in): the latest save's text, its revision, and who made it.
const answer = (saves) => {
  const last = saves.at(-1);
  return {
    projectId: "p1",
    version: saves.length,
    markdown: last?.markdown ?? "",
    lastModified: last ? { by: last.by, at: last.at, note: last.note ?? null } : null,
    limit: 64,
  };
};
const you = { id: "user", name: "You" };

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

test("a project's handover is saved against the revision read, with an optional note, and says who changed it last", async () => {
  const saves = [];
  let conflict = false;
  const page = mount((url, method, body) => {
    if (method === "PUT") {
      if (conflict || body.expectedVersion !== saves.length) return [400, { error: "version_conflict: this Project's handover changed; reload before saving" }];
      saves.push({ markdown: body.markdown, by: you, note: body.note ?? null, at: "2026-11-05T08:00:00Z" });
    }
    return [200, answer(saves)];
  });
  page.window.renderHandover("p1");
  const section = () => page.document.querySelector("#project-settings-handover");
  await until(() => field(page, "Handover document"), "the document");
  assert.match(section().textContent, /Not written yet\./, "a document never saved says so, with no version");
  assert.equal(button(page, "Save handover").disabled, true, "nothing to save after loading");

  await type(page, "Handover document", "# Lab\nBuild with make.");
  await type(page, "Note", "First notes");
  assert.match(section().textContent, /22 of 64 bytes/);
  assert.match(section().textContent, /Unsaved changes/);
  button(page, "Save handover").click();
  await until(() => /Saved\./.test(section().textContent), "the save");
  assert.deepEqual(puts(page)[0].body, { expectedVersion: 0, markdown: "# Lab\nBuild with make.", note: "First notes" },
    "a save names the revision it was read at");
  assert.match(section().textContent, /Last changed by you, .* · First notes/, "who changed it last, and the note");
  assert.equal(field(page, "Note").value, "", "the note goes with the save");

  await type(page, "Handover document", "# Lab\nBuild with make; test with make check.");
  button(page, "Save handover").click();
  await until(() => puts(page).length === 2 && /Saved\./.test(section().textContent), "the second save");
  assert.equal(puts(page)[1].body.expectedVersion, 1);
  assert.equal("note" in puts(page)[1].body, false, "no note, none sent");
  assert.doesNotMatch(section().textContent, /Version \d|Show version|Restore/, "no history is shown");

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
  const page = mount(() => [200, answer([{ markdown: "Kept", by: you, note: null, at: "2026-11-05T08:00:00Z" }])]);
  page.window.renderHandover("p1", true);
  await until(() => page.document.querySelector('[aria-label="Handover document"]')?.value === "Kept", "the document");
  assert.equal(field(page, "Handover document").disabled, true, "an archived project's document can't change");
  assert.equal(button(page, "Save handover").disabled, true);
  assert.deepEqual(page.errors, []);
});

// As Core counts it (handover::MAX_NOTE): the trimmed note, in characters.
test("a note is counted in characters, as Core counts it: one over 200 is not sent, one at 200 is", async () => {
  const saves = [];
  const page = mount((url, method, body) => {
    if (method === "PUT") saves.push({ markdown: body.markdown, by: you, note: body.note ?? null, at: "2026-11-05T08:00:00Z" });
    return [200, answer(saves)];
  });
  page.window.renderHandover("p1");
  const section = () => page.document.querySelector("#project-settings-handover");
  await until(() => field(page, "Handover document"), "the document");
  assert.ok(field(page, "Note"), "a save takes an optional note");
  await type(page, "Handover document", "# Lab");
  await type(page, "Note", "说".repeat(201));
  assert.match(section().textContent, /201 of 200 characters\./, "the note's size is shown in characters");
  assert.match(section().textContent, /At most 200 characters\./);
  assert.equal(button(page, "Save handover").disabled, true, "a note over its limit is not sent");
  await type(page, "Note", "说".repeat(200));
  assert.match(section().textContent, /200 of 200 characters\./);
  button(page, "Save handover").click();
  await until(() => /Saved\./.test(section().textContent), "the save");
  assert.equal(puts(page)[0].body.note, "说".repeat(200), "a note within the limit is sent whole");
  assert.deepEqual(page.errors, []);
});

test("the settings page shows who changed the handover last after a lead's handover_update (YN-2 S3)", async () => {
  // As Core answers once a lead wrote with handover_update: the lead's name, when, and its note.
  const saves = [
    { markdown: "# Lab", by: you, note: null, at: "2026-11-05T08:00:00Z" },
    { markdown: "# Lab\nTest with make check.", by: { id: "lead", name: "Dev Lead" }, note: "Say how to test", at: "2026-11-05T09:00:00Z" },
  ];
  const page = mount(() => [200, answer(saves)]);
  page.window.renderHandover("p1");
  const section = () => page.document.querySelector("#project-settings-handover");
  await until(() => field(page, "Handover document")?.value === "# Lab\nTest with make check.", "the lead's document");
  assert.match(section().textContent, /Last changed by Dev Lead, .* · Say how to test/, "the lead, when, and its note");
  assert.match(section().textContent, /The project's leads write it; you can change it here too\./);
  assert.doesNotMatch(section().textContent, /Version \d|Show version|Restore/, "no history and no restore");
  assert.deepEqual(page.errors, []);
});
