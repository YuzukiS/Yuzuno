// YN-221 S2: Home reads its history as an index (`X-Yuzuno-History: index`,
// S1) and an entry whole only where it is shown: History opened, a pinned
// report kept there; an older Core, which sends every entry whole, is read as
// before. The open Asks' count away from Home reads Needs you alone
// (`/api/home/needs`), and Home where Core has no such read. The built app
// against an in-memory Core; synthetic data only.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const bundle = await uiTestBundle(new URL(index.match(/src="\/(assets\/[^" ]+\.js)"/)[1], distUrl));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, seconds = 6) {
  const deadline = Date.now() + seconds * 1000;
  while (!predicate() && Date.now() < deadline) await pause(25);
  assert.ok(predicate(), message);
}

const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const body = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const mori = { agentId: "a", name: "Mori", state: "active" };
const section = (id, key, kind, title, version, extra = {}) => ({
  id, key, kind, title, version, owner: mori, updatedAt: at(5), updatedTurnId: "t1",
  body: body(`${title} body`), attachments: [], refs: {}, seen: null, history: false, ...extra,
});
// History as Core keeps it: a report the user marked seen and an Ask answered and resolved.
const seenReport = section(11, "old", "report", "Last week", 1, { history: true, historyReason: "seen", currentSource: true, seen: { version: 1, at: at(900) } });
const resolvedAsk = section(12, "migrate", "ask", "Migrate the data?", 2, {
  history: true, historyReason: "resolved", currentSource: true, body: body("Migrated 12 tables"),
  ask: { question: "Run the migration now?", state: "resolved", replyText: "Run it tonight", reply: { freeText: true } },
});
const whole = [seenReport, resolvedAsk];
// The same entries as S1's index has them: no body, attachments or refs.
const indexRow = (s) => {
  const { body: _b, attachments: _a, refs: _r, ...rest } = s;
  return { ...rest, bodyOmitted: true, attachmentCount: 0 };
};
function homeOf(history, indexed) {
  return {
    generatedAt: at(0), order: ["p-app"], needsYou: [{ kind: "ask", projectId: "p-app", agentId: "a", agentName: "Mori", sectionKey: "release", title: "Ship today?", since: at(30) }],
    projects: [{
      project: { id: "p-app", name: "App" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
      errors: [], pending: [], jobs: [], unseen: 1, missing: [],
      brief: {
        version: 7, sections: [section(1, "release", "ask", "Ship today?", 3, { ask: { question: "Ship the release today?", state: "open", reply: { freeText: true } } })],
        history: indexed ? history.map(indexRow) : history, ...(indexed ? { historyIndex: true } : {}),
      },
    }],
  };
}
const agents = [{ id: "a", name: "Mori", cwd: "/w/app", projectId: "p-app", model: "m", color: "sage", status: "idle", createdAt: "", updatedAt: "", goal: "",
  pendingCount: 0, unreadCount: 0, lastSeq: 1, reviewedSeq: 1 }];
const projects = [{ id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }];

/**
 * indexed: Core has S1 (index rows, the entries read, Needs you alone); not, an older Core: whole rows, and both
 * reads answered as its page answers an address it does not have (404). entries(url): the entries read's answer,
 * [status, body], else each asked for whole.
 */
async function mount({ indexed = true, storage = {}, entries = null, pressHome = true } = {}) {
  const calls = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  const streams = [];
  w.EventSource = class { constructor() { streams.push(this); } addEventListener() {} close() {} };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  const respond = (value, status = 200) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  };
  const notHere = () => respond("<!doctype html><title>Yuzuno</title>", 404);
  w.fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ path, method: init.method || "GET", history: headers["x-yuzuno-history"] ?? null });
    if (path === "/api/workspace") return respond({ workspace: { id: "ws-history" }, projects, agents, runtime: { connected: true }, defaultCwd: "/w" });
    if (path === "/api/home") return respond(homeOf(whole, indexed));
    if (path === "/api/home/needs") return indexed ? respond({ generatedAt: at(0), needsYou: homeOf(whole, true).needsYou }) : notHere();
    const read = path.match(/^\/api\/projects\/p-app\/brief\/history\?entries=(.*)$/);
    if (read) {
      if (!indexed) return notHere();
      const answer = await entries?.(path);
      if (answer) return respond(answer[1], answer[0]);
      const wanted = read[1].split(",").map((pair) => pair.split(":").map(Number));
      return respond({ entries: whole.filter((s) => wanted.some(([id, v]) => s.id === id && s.version === v)), missing: [] });
    }
    if (path === "/api/machine-load") return respond({ at: at(0), cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: null, otherPct: null },
      memory: { totalMiB: 4096, usedMiB: 0, availableMiB: 4096, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] });
    if (path === "/api/machine-live") return respond({ machines: [] });
    if (/^\/api\/projects\/[^/]+\/requests$/.test(path)) return respond({ requests: [], hasMore: false });
    if (/^\/api\/projects\/[^/]+\/front-desk$/.test(path)) return respond({ version: 1, agentId: "a", effectiveAgentId: "a" });
    if (path === "/api/collaboration/github_repositories") return respond({ repositories: [], links: [] });
    if (/^\/api\/agents\/a$/.test(path)) return respond({ agent: agents[0], pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (path === "/api/machines") return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  const button = (text, root = doc) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
  w.eval(bundle);
  await waitFor(() => button("Home") && /Mori/.test(doc.querySelector(".agent-list")?.textContent || ""), "the workspace is read");
  if (pressHome) {
    button("Home").click();
    await waitFor(() => doc.querySelector("[data-glance-project]"), "Home read its projects");
  }
  const reads = () => calls.filter((c) => c.path.startsWith("/api/projects/p-app/brief/history"));
  return {
    w, doc, calls, errors, button, reads,
    event: (value) => streams.at(-1)?.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }),
    close: () => w.close(),
  };
}

async function openProject(p) {
  p.doc.querySelector('[data-glance-project="p-app"] .project-glance-open').click();
  await waitFor(() => p.doc.querySelector('[data-project-home="p-app"] .home-history'), "the project's page and its History");
  const history = p.doc.querySelector('[data-project-home="p-app"] .home-history');
  history.open = true;
  return history;
}
const entry = (history, title) => [...history.querySelectorAll("li details")].find((d) => d.querySelector("summary").textContent.includes(title));
async function toggle(p, details, open) {
  details.open = open;
  details.dispatchEvent(new p.w.Event("toggle"));
  await pause();
}

test("Home asks for its history as an index and reads an entry whole once, as it is opened; a seen report keeps its Reply (YN-221 S2)", async () => {
  const p = await mount();
  try {
    const homeReads = p.calls.filter((c) => c.path === "/api/home");
    assert.ok(homeReads.length >= 1 && homeReads.every((c) => c.history === "index"), `Home asks for the index: ${JSON.stringify(homeReads)}`);
    const history = await openProject(p);
    await pause(200);
    assert.equal(p.reads().length, 0, "nothing is read whole while History is closed");
    const last = entry(history, "Last week");
    await toggle(p, last, true);
    await waitFor(() => /Last week body/.test(last.textContent), "the entry opened is read whole");
    assert.deepEqual(p.reads().map((c) => c.path), ["/api/projects/p-app/brief/history?entries=11:1"]);
    // A report the user marked seen takes a reply where History shows it, as before.
    assert.ok(p.button("Reply", last), "the seen report keeps its Reply");
    await toggle(p, last, false);
    await toggle(p, last, true);
    await pause(200);
    assert.match(last.textContent, /Last week body/);
    assert.equal(p.reads().length, 1, "read once");
    // A resolved Ask: its question and answer from the index, its body read as it opens.
    const ask = entry(history, "Migrate the data?");
    await toggle(p, ask, true);
    await waitFor(() => /Migrated 12 tables/.test(ask.textContent), "the resolved Ask's body");
    assert.match(ask.querySelector(".home-history-reply").textContent, /Run it tonight/);
    assert.deepEqual(p.reads().map((c) => c.path).slice(1), ["/api/projects/p-app/brief/history?entries=12:2"]);
    // Home read again keeps what was read: nothing is read again.
    p.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => p.calls.filter((c) => c.path === "/api/home").length > homeReads.length, "Home read again");
    await pause(300);
    assert.match(last.textContent, /Last week body/);
    assert.equal(p.reads().length, 2);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an entry that could not be read says so and is read again on asking; one History no longer keeps says that (YN-221 S2)", async () => {
  let answers = [[503, { error: "busy" }]];
  const p = await mount({ entries: () => answers.shift() });
  try {
    const history = await openProject(p);
    const last = entry(history, "Last week");
    await toggle(p, last, true);
    await waitFor(() => last.querySelector('[data-history-body="failed"]'), "the failed read is said");
    assert.ok(!/Last week body/.test(last.textContent));
    p.button("Try again", last).click();
    await waitFor(() => /Last week body/.test(last.textContent), "read again, whole");
    assert.equal(p.reads().length, 2);
    answers = [[200, { entries: [], missing: [{ id: 12, version: 2 }] }]];
    const ask = entry(history, "Migrate the data?");
    await toggle(p, ask, true);
    await waitFor(() => ask.querySelector('[data-history-body="missing"]'), "an entry no longer kept says so");
    assert.match(ask.textContent, /History no longer keeps this entry/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a pinned report the user marked seen is read whole for its widget, once (YN-221 S2)", async () => {
  const pins = { order: [], hidden: [], pins: [{ projectId: "p-app", key: "old", id: 11, title: "Last week", projectName: "App" }] };
  const p = await mount({ storage: { "yuzuno.homeWidgets.ws-history": JSON.stringify(pins) } });
  try {
    const pinned = () => p.doc.querySelector(".home-widget-column .home-pinned");
    await waitFor(() => /Last week body/.test(pinned()?.textContent ?? ""), "the pinned report's body");
    assert.equal(pinned().dataset.pinState, "shown");
    assert.match(pinned().textContent, /Marked seen/);
    assert.deepEqual(p.reads().map((c) => c.path), ["/api/projects/p-app/brief/history?entries=11:1"]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // Read whole after Home listed it, History no longer has it: said so, never as removed or as another's.
  const gone = await mount({ storage: { "yuzuno.homeWidgets.ws-history": JSON.stringify(pins) }, entries: () => [200, { entries: [], missing: [{ id: 11, version: 1 }] }] });
  try {
    const pinned = () => gone.doc.querySelector(".home-widget-column .home-pinned");
    await waitFor(() => pinned()?.querySelector('[data-history-body="missing"]'), "the pin says History no longer keeps it");
    assert.equal(pinned().dataset.pinState, "shown");
    assert.deepEqual(gone.errors, []);
  } finally {
    gone.close();
  }
});

test("an older Core's history, each entry whole, is shown as before with nothing read for it (YN-221 S2)", async () => {
  const p = await mount({ indexed: false });
  try {
    const history = await openProject(p);
    const last = entry(history, "Last week");
    await toggle(p, last, true);
    await waitFor(() => /Last week body/.test(last.textContent), "the entry, whole from Home's read");
    assert.equal(p.reads().length, 0);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("away from Home the open Asks are read from Needs you alone, and from Home where Core has no such read (YN-221 S2)", async () => {
  const p = await mount({ pressHome: false });
  try {
    await waitFor(() => p.calls.some((c) => c.path === "/api/home/needs"), "Needs you read alone");
    assert.equal(p.calls.filter((c) => c.path === "/api/home").length, 0, "Home is not read for it");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  const older = await mount({ indexed: false, pressHome: false });
  try {
    await waitFor(() => older.calls.some((c) => c.path === "/api/home"), "Home read where Core has no Needs you read");
    const before = older.calls.length;
    older.event({ type: "workspace.changed", scope: "brief" });
    await waitFor(() => older.calls.slice(before).some((c) => c.path === "/api/home"), "read again on a Brief's change");
    assert.equal(older.calls.filter((c) => c.path === "/api/home/needs").length, 1, "asked once, then not again for this Workspace");
    assert.deepEqual(older.errors, []);
  } finally {
    older.close();
  }
});
