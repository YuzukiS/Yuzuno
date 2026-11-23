import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-221 S2: an entry of Home's history index read whole and put in place of
// its index row (history-bodies.ts): what comes from Home's newer read and
// what only the entry has. Synthetic data; Core answered here.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "history-bodies-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.ts");
  await writeFile(entry, `import {wantBody, withBodies, wholeSection} from ${JSON.stringify(path.join(root, "src/home/history-bodies.ts"))};
window.bodies = {wantBody, withBodies, wholeSection};`);
  const result = await build({
    root, configFile: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "HistoryBodies", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(answer) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://bodies.test/", runScripts: "outside-only", virtualConsole });
  const reads = [];
  window.fetch = async (url) => {
    reads.push(String(url));
    const body = answer(String(url));
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, bodies: window.bodies, reads, errors };
}

const owner = { agentId: "a", name: "Mori", state: "active" };
const askBody = { root: "b", elements: { b: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text: "Migrated 12 tables" } } } };
// The entry whole, as GET …/brief/history?entries= has it: with a part of its Ask only a whole read carries.
const full = { id: 12, key: "migrate", kind: "ask", title: "Migrate the data?", version: 2, owner, updatedAt: "2026-11-20T10:00:00Z", updatedTurnId: null,
  body: askBody, attachments: [], refs: {}, seen: null, history: true, historyReason: "resolved", currentSource: true,
  ask: { question: "Run the migration now?", state: "replied", replyText: "Run it tonight", reply: { options: [{ id: "now", label: "Now" }], freeText: true },
    replySnapshot: { question: "Run the migration now?", options: [{ id: "now", label: "Now" }] } } };
// Its index row in Home's newer read: no body, and its Ask as Home has it now (resolved since), without the snapshot.
const indexRow = { ...full, body: null, attachments: [], refs: {}, bodyOmitted: true, attachmentCount: 0, currentSource: false,
  ask: { question: "Run the migration now?", state: "resolved", replyText: "Run it tonight", reply: { options: [{ id: "now", label: "Now" }], freeText: true } } };
const home = (row) => ({ generatedAt: "", order: ["p1"], needsYou: [], projects: [{ project: { id: "p1", name: "atlas" },
  agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
  brief: { version: 1, sections: [], history: [row], historyIndex: true } }] });

test("an entry read whole keeps what only it has of its Ask, under the state Home read last (YN-221 S2)", async () => {
  const p = mount(() => ({ entries: [full], missing: [] }));
  const data = home(indexRow);
  p.bodies.wantBody("p1", 12, 2);
  await tick();
  assert.deepEqual(p.reads, ["/api/projects/p1/brief/history?entries=12:2"]);
  const shown = p.bodies.withBodies(data).projects[0].brief.history[0];
  assert.equal(shown.bodyOmitted, undefined, "whole now");
  assert.deepEqual(shown.body, askBody);
  assert.equal(shown.ask.state, "resolved", "the Ask's state as Home read it last");
  assert.equal(shown.currentSource, false, "Home's newer facts");
  assert.deepEqual(shown.ask.replySnapshot, full.ask.replySnapshot, "what only the whole entry has of its Ask is kept");
  assert.deepEqual(shown.ask.reply, full.ask.reply);
  // The same object for the same row, so a later read that keeps the row keeps it.
  assert.equal(p.bodies.withBodies(data).projects[0].brief.history[0], shown);
  assert.equal(p.bodies.wholeSection("p1", indexRow), shown);
  assert.deepEqual(p.errors, []);
});

test("an entry asked for twice, or with others in the same moment, is read once (YN-221 S2)", async () => {
  const p = mount((url) => ({ entries: url.includes("13:1") ? [full, { ...full, id: 13, version: 1, key: "other" }] : [full], missing: [] }));
  p.bodies.wantBody("p1", 12, 2);
  p.bodies.wantBody("p1", 12, 2);
  p.bodies.wantBody("p1", 13, 1);
  await tick();
  assert.deepEqual(p.reads, ["/api/projects/p1/brief/history?entries=12:2,13:1"]);
  p.bodies.wantBody("p1", 12, 2);
  await tick();
  assert.equal(p.reads.length, 1, "kept once read");
});
