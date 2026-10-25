// T-193 slice 3: Settings → Draft storage. The list reads draft manifests only;
// one draft is opened only when chosen, shown whole and saved as a text file
// only when asked; nothing is written, and drafts of Agents this Workspace
// doesn't list are only counted. Synthetic drafts only.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(root, ".draft-export-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {DraftExport} from ${JSON.stringify(path.join(root, "src/DraftExport.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderDrafts = props => root.render(<DraftExport {...props}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "DraftExportTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally { await rm(temporary, { recursive: true, force: true }); }

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check, what = "Expected draft state") {
  for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail(`${what} did not appear`);
}
const image = { id: `${"a".repeat(64)}.png`, agentId: "a1", name: "screen.png", width: 10, height: 10, bytes: 100 };
const seed = {
  "yuzuno.composer.v1:a1": JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "text", text: "Hello there " }, { kind: "paste", id: "p1", number: 1, bodyId: "b1" }], images: [image] }),
  "yuzuno.paste.v1:a1:b1": "PASTED BODY line one\nline two",
  "yuzuno.drafts": JSON.stringify({ a2: "legacy words" }),
  "yuzuno.composer.v1:a3": "{damaged",
  "yuzuno.composer.v1:a4": JSON.stringify({ version: 1, nextNumber: 1, parts: [] }),
  "yuzuno.composer.v1:a5": JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "paste", id: "p9", number: 1, bodyId: "gone" }] }),
  "yuzuno.composer.v1:zz": JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "another Workspace's words" }] }),
};
const agents = [
  { id: "a1", name: "Cedar" },
  { id: "a2", name: "Pine", closedAt: "2026-10-01T00:00:00Z" },
  { id: "a3", name: "Maple" },
  { id: "a4", name: "Birch" },
  { id: "a5", name: "Rowan" },
];

function mount({ refuse = false } = {}) {
  const vc = new VirtualConsole();
  const errors = [], reads = [], writes = [], saves = { blobs: [], links: [], fail: null };
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, doc = w.document;
  for (const [key, value] of Object.entries(seed)) w.localStorage.setItem(key, value);
  const proto = w.Storage.prototype, get = proto.getItem;
  proto.getItem = function (key) { reads.push(key); return get.call(this, key); };
  proto.setItem = function (key) { writes.push(`set ${key}`); };
  proto.removeItem = function (key) { writes.push(`remove ${key}`); };
  if (refuse) Object.defineProperty(w, "localStorage", { configurable: true, get() { throw new w.DOMException("The operation is insecure.", "SecurityError"); } });
  w.URL.createObjectURL = (blob) => { if (saves.fail) throw new w.Error(saves.fail); saves.blobs.push(blob); return "blob:http://isolated.test/fixture"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { saves.links.push(this.getAttribute("download")); };
  w.eval(bundle);
  const section = () => doc.querySelector("#settings-drafts");
  const row = (id) => doc.querySelector(`[data-agent="${id}"]`);
  const shown = () => doc.querySelector("#settings-drafts textarea")?.value;
  const blobText = (blob) => new Promise((resolve) => { const r = new w.FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });
  return { w, doc, errors, reads, writes, saves, section, row, shown, blobText, close: () => w.close() };
}

test("the list reads manifests only, shows this Workspace's drafts as they are, and counts the others", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: false, agents });
  await tick(); await tick();
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.")), [], "hidden, it reads nothing");
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a1"), "the list");
  assert.match(p.row("a1").textContent, /^Cedar12 characters of text, 1 pasted text, 1 image \(referenced; not saved in the file\) Show$/);
  assert.match(p.row("a2").textContent, /^Pine \(closed\)Saved by an earlier version: 12 characters of text Show$/);
  assert.match(p.row("a3").textContent, /^MapleCan't be read \(.+\); left as it is\.$/, "a damaged draft is said, and offers nothing");
  assert.equal(p.row("a4") === null, true, "an empty saved draft is no draft");
  assert.equal(p.row("zz") === null, true, "another Workspace's draft is not listed");
  assert.match(p.section().textContent, /1 saved draft is for Agent IDs this Workspace doesn't list, so it is not shown here\./);
  assert.match(p.section().textContent, /which Workspace it was written in is not recorded, so a matching Agent doesn't prove it/);
  assert.ok(!p.section().textContent.includes("another Workspace's words"));
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.paste.v1:")), [], "no pasted text is read for the list");
  assert.deepEqual(p.writes, [], "nothing is written");
  assert.deepEqual(p.errors, []);
});

test("a chosen draft is shown whole, pasted text included, and saved as a text file only when asked", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a1"));
  p.row("a1").querySelector("button").click();
  const text = await until(() => p.shown(), "the chosen draft");
  assert.match(text, /^Yuzuno draft for Cedar\nExported \S+ from the copy saved in this browser for this site\. Text typed since it was last saved is not included\.\nSaved under the Agent's ID only: the Workspace it was written in is not recorded\.\n/);
  assert.match(text, /^Images in the draft: 1 \(references only; the images themselves are not in this file\)$/m);
  assert.match(text, /Hello there \n\[Pasted text #1, 2 lines\]\nPASTED BODY line one\nline two\n\[End of pasted text #1\]\n$/);
  assert.deepEqual(p.reads.filter((key) => key.startsWith("yuzuno.paste.v1:")), ["yuzuno.paste.v1:a1:b1"], "only the chosen draft's pasted text is read");
  assert.deepEqual([p.saves.blobs.length, p.saves.links.length], [0, 0], "showing saves nothing");
  assert.match(p.section().textContent, /The whole saved draft for Cedar\. Nothing has been saved, copied or sent\./);
  [...p.section().querySelectorAll("button")].find((b) => b.textContent.trim() === "Download .txt").click();
  await until(() => p.saves.links.length === 1, "a download is asked for");
  assert.match(p.saves.links[0], /^yuzuno-draft-Cedar-[\dTZ-]+\.txt$/);
  assert.equal(await p.blobText(p.saves.blobs[0]), text, "the file holds the shown text");
  assert.match(p.section().textContent, /Your browser was asked to save yuzuno-draft-Cedar-[\dTZ-]+\.txt\./);
  // An older version's draft is shown the same way.
  p.row("a2").querySelector("button").click();
  await until(() => /legacy words$/.test(p.shown() || ""), "the older version's draft");
  // Another Agent joins the Workspace: the list is read again and the open draft stays.
  p.w.renderDrafts({ active: true, agents: [...agents, { id: "a6", name: "Elm" }] });
  await tick(); await tick();
  assert.match(p.shown() || "", /legacy words$/, "the open draft stays while its Agent is listed");
  // Its Agent is no longer listed: the open draft is put away.
  p.w.renderDrafts({ active: true, agents: agents.filter((agent) => agent.id !== "a2") });
  await until(() => p.shown() === undefined, "the draft of an Agent no longer listed is put away");
  assert.deepEqual(p.writes, [], "nothing is written");
});

test("a draft that can't be opened, or a download that can't start, is said and claims nothing", async (t) => {
  const p = mount(); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.row("a5"));
  p.row("a5").querySelector("button").click();
  await until(() => p.section().querySelector('[role="alert"]'), "the unreadable draft is said");
  assert.match(p.section().querySelector('[role="alert"]').textContent, /^The draft for Rowan can't be read \(Saved pasted text is missing\)\. It is left as it is\.$/);
  assert.equal(p.shown(), undefined);
  p.row("a1").querySelector("button").click();
  await until(() => p.shown());
  p.saves.fail = "Blob URLs are blocked here";
  [...p.section().querySelectorAll("button")].find((b) => b.textContent.trim() === "Download .txt").click();
  await until(() => /could not start/.test(p.section().textContent), "the failed download is said");
  assert.match(p.section().textContent, /The download could not start \(Blob URLs are blocked here\)\. Select the text below and copy it\./);
  assert.doesNotMatch(p.section().textContent, /asked to save/);
  assert.deepEqual(p.writes, []);
});

test("storage the browser refuses is said, and nothing is listed", async (t) => {
  const p = mount({ refuse: true }); t.after(p.close);
  p.w.renderDrafts({ active: true, agents });
  await until(() => p.section()?.querySelector('[role="alert"]'), "the refusal");
  assert.equal(p.section().querySelector('[role="alert"]').textContent, "Drafts can't be read: this browser gives Yuzuno no storage here.");
  assert.equal(p.doc.querySelectorAll("[data-agent]").length, 0);
});
