// T-34 S3b: a lead's handover proposal on Home. The card shows the lead's
// reason and the changed lines; the user approves or rejects it against the
// version read, with a note; a stale proposal can't be approved. Fixture
// HTTP only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "handover-proposal-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {HandoverProposal} from ${src("home/HandoverProposal.tsx")};
const root=createRoot(document.getElementById('root'));
window.changed=0;
window.renderCard=(proposal,readOnly=false)=>root.render(<HandoverProposal projectId="p1" proposal={proposal} readOnly={readOnly} onChanged={()=>{window.changed+=1;}}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "HandoverProposalUI", formats: ["iife"] } },
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
// As Core answers (handover_proposals.rs summary and detail).
const summary = { id: "h1", projectId: "p1", proposer: { id: "lead", name: "Mori" }, baseVersion: 1, reason: "Say how to test",
  bytes: 40, at: "2026-11-05T08:00:00Z", state: "pending" };
const detail = (current = 1) => ({
  proposal: { ...summary, markdown: "# Lab\nBuild with make; test with make check.\nKeep the fixtures." },
  base: { version: 1, markdown: "# Lab\nBuild with make.\nKeep the fixtures." },
  currentVersion: current,
  stale: current !== 1,
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
const posts = (page) => page.calls.filter((c) => c.method === "POST");
const reads = (page) => page.calls.filter((c) => c.method === "GET").length;
const card = (page) => page.document.querySelector("#home-handover-h1");

test("a lead's proposal shows its reason and changed lines, and is approved against the version read with a note", async () => {
  const page = mount((url, method) => method === "POST"
    ? [200, { proposal: { ...summary, state: "approved", version: 2 }, handover: { version: 2 } }]
    : [200, detail()]);
  page.window.renderCard(summary);
  await until(() => card(page)?.querySelector(".changes-lines"), "the changed lines");
  assert.match(card(page).textContent, /by Mori/);
  assert.match(card(page).textContent, /Say how to test/);
  const lines = [...card(page).querySelectorAll(".changes-lines [data-line]")].map((l) => [l.dataset.line, l.textContent.trim()]);
  assert.deepEqual(lines.filter(([kind]) => kind !== "meta"), [["del", "- Build with make."], ["add", "+ Build with make; test with make check."]],
    "the removed line, then the line that replaces it");
  await type(page, "Note for Mori", "Thanks, merged");
  button(page, "Approve").click();
  await until(() => page.window.changed === 1, "Home read again");
  const sent = posts(page)[0];
  assert.match(sent.url, /\/projects\/p1\/handover\/proposals\/h1\/decision$/);
  assert.equal(typeof sent.body.requestId, "string");
  assert.deepEqual({ ...sent.body, requestId: "" }, { requestId: "", action: "approve", expectedVersion: 1, note: "Thanks, merged" },
    "a decision names the version it was read at, with the note");
  assert.deepEqual(page.errors, []);
});

test("a stale proposal can't be approved and is rejected; a refusal is shown, the proposal read again, and a retry is the same request", async () => {
  let refuse = true;
  const page = mount((url, method) => {
    if (method === "POST") return refuse
      ? [400, { error: "version_conflict: this Project's handover changed after you read the proposal; reload it before deciding" }]
      : [200, { proposal: { ...summary, state: "rejected" }, handover: { version: 2 } }];
    return [200, detail(2)];
  });
  page.window.renderCard(summary);
  await until(() => card(page)?.querySelector('[role="alert"]'), "the stale note");
  assert.match(card(page).textContent, /it is at version 2 now, not 1/);
  assert.equal(button(page, "Approve").disabled, true, "a stale proposal can't be approved");
  assert.equal(button(page, "Reject").disabled, false);
  await type(page, "Note for Mori", "x".repeat(1001));
  assert.match(card(page).textContent, /1001 of 1000 bytes\./);
  assert.match(card(page).textContent, /At most 1000 bytes\./);
  assert.equal(button(page, "Reject").disabled, true, "a note over its limit is not sent");
  await type(page, "Note for Mori", "Merge yours with mine");
  const before = reads(page);
  button(page, "Reject").click();
  await until(() => [...card(page).querySelectorAll('[role="alert"]')].some((a) => /version_conflict/.test(a.textContent)), "the refusal");
  await until(() => reads(page) > before, "the proposal read again");
  assert.equal(page.window.changed, 0, "a refused decision changes nothing on Home");
  refuse = false;
  button(page, "Reject").click();
  await until(() => page.window.changed === 1, "Home read again");
  const [first, second] = posts(page);
  assert.equal(second.body.requestId, first.body.requestId, "the same decision tried again is the same request");
  assert.deepEqual({ ...second.body, requestId: "" }, { requestId: "", action: "reject", expectedVersion: 2, note: "Merge yours with mine" });
  assert.deepEqual(page.errors, []);
});

// #612 R1 6658e4c4: a save in the Project's settings while a proposal waits.
test("when Home says the document moved, the card reads the proposal again and shows it stale before any click", async () => {
  let current = 1;
  const page = mount(() => [200, detail(current)]);
  page.window.renderCard({ ...summary, currentVersion: 1 });
  await until(() => card(page)?.querySelector(".changes-lines"), "the changed lines");
  assert.equal(button(page, "Approve").disabled, false, "a proposal on the current version can be approved");
  const before = reads(page);
  current = 2;
  page.window.renderCard({ ...summary, currentVersion: 2 });
  await until(() => /it is at version 2 now, not 1/.test(card(page).textContent), "the stale note", 3000);
  assert.ok(reads(page) > before, "the proposal is read again");
  assert.equal(button(page, "Approve").disabled, true, "the card shows stale before any click");
  assert.equal(posts(page).length, 0, "nothing was sent");
  assert.deepEqual(page.errors, []);
});

test("on a read-only Home the proposal is shown and can't be decided", async () => {
  const page = mount(() => [200, detail()]);
  page.window.renderCard(summary, true);
  await until(() => card(page)?.querySelector(".changes-lines"), "the changed lines");
  assert.equal(button(page, "Approve").disabled, true);
  assert.equal(button(page, "Reject").disabled, true);
  assert.deepEqual(page.errors, []);
});
