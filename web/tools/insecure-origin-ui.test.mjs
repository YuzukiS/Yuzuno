import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { composerText, setComposerText } from "./composer-driver.mjs";
import { hoverTip } from "./tip-dom.mjs";

// YN-36: the built app opened over plain http on a LAN or tailnet address
// (here 192.0.2.10, a documentation address). Such a page is not a secure
// context: the browser gives it no crypto.randomUUID and no Clipboard API,
// while crypto.getRandomValues is still there. Every action on Home works
// there, or says why it can't; nothing fails without a word. Core is
// answered here; no request leaves the page.
const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const bundle = await uiTestBundle(new URL(entry, distUrl));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, seconds = 6) {
  const deadline = Date.now() + seconds * 1000;
  while (!predicate() && Date.now() < deadline) await pause(25);
  assert.ok(predicate(), typeof message === "function" ? message() : message);
}

const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const body = (text) => ({
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: ["text"] },
    text: { type: "Markdown", props: { text } },
  },
});
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const section = (key, kind, title, version, by, extra = {}) => ({
  key, kind, title, version, owner: by, updatedAt: at(5), updatedTurnId: "t1",
  body: body(`${title} body`), attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const base = { model: "m", color: "sage", status: "idle", createdAt: "", updatedAt: "", goal: "", pendingCount: 0, lastSeq: 12, reviewedSeq: 12, unreadCount: 0 };
const agents = [
  { ...base, id: "a", name: "Mori", harness: "codex", cwd: "/w/app", projectId: "p-app" },
  { ...base, id: "b", name: "Hana", harness: "codex", cwd: "/w/app", projectId: "p-app", pendingCount: 1 },
];
const projects = [{ id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const form = {
  id: "scope", title: "Which part ships first?",
  fields: [{ id: "part", type: "single", label: "First part", required: false,
    options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }] }],
};
function homeFixture() {
  return {
    generatedAt: at(0),
    order: ["p-app"],
    needsYou: [
      { kind: "ask", projectId: "p-app", agentId: "a", agentName: "Mori", sectionKey: "release", title: "Ship today?", since: at(30) },
      { kind: "approval", projectId: "p-app", agentId: "b", agentName: "Hana", requestId: "r-1", title: "Run the test suite", since: at(10) },
    ],
    projects: [{
      project: { id: "p-app", name: "App" },
      agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
      errors: [],
      pending: [{ id: "r-1", agentId: "b", agentName: "Hana", method: "item/commandExecution/requestApproval",
        params: { command: "npm test", reason: "Run the test suite" }, createdAt: at(10) }],
      jobs: [],
      unseen: 1,
      missing: [],
      brief: {
        version: 5,
        history: [],
        sections: [
          section("release", "ask", "Ship today?", 3, owner("a", "Mori"), {
            ask: { question: "Ship the release today?", state: "open",
              reply: { options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait" }], freeText: true } },
          }),
          section("budget", "ask", "Which plan?", 1, owner("b", "Hana"), {
            ask: { question: "Plan A or B?", state: "open",
              reply: { choice: { a: { id: "plan-a", label: "Plan A" }, b: { id: "plan-b", label: "Plan B" } } } },
          }),
          section("scope", "ask", "Which part first?", 1, owner("a", "Mori"), {
            ask: { question: "Which part ships first?", state: "open", reply: { form } },
          }),
          section("notes", "report", "Notes", 2, owner("a", "Mori")),
        ],
      },
    }],
  };
}

const ORIGIN = "http://192.0.2.10:4317";
async function mount({ copies = null } = {}) {
  const calls = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `${ORIGIN}/`, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  // What a browser gives a page that is not a secure context: JSDOM itself
  // offers randomUUID everywhere and has no isSecureContext.
  Object.defineProperty(w, "isSecureContext", { configurable: true, value: false });
  delete Object.getPrototypeOf(w.crypto).randomUUID;
  Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: undefined });
  assert.equal(typeof w.crypto.randomUUID, "undefined");
  assert.equal(typeof w.crypto.getRandomValues, "function");
  // The browser's copy command, which works without a secure context: it
  // copies the selection of the focused field. Absent unless a test gives it.
  if (copies)
    w.document.execCommand = (command) => {
      if (command !== "copy") return false;
      const field = w.document.activeElement;
      copies.push(field?.value?.slice(field.selectionStart, field.selectionEnd) ?? "");
      return true;
    };
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  w.EventSource = class {
    addEventListener() {}
    close() {}
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  w.structuredClone = structuredClone;
  const home = homeFixture();
  const respond = (value, status = 200) => {
    const text = JSON.stringify(value);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  w.fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(request);
    if (!request.url.startsWith(`${ORIGIN}/api/`) && !request.url.startsWith("/api/")) return respond({ error: "unexpected" }, 404);
    const path = request.url.replace(ORIGIN, "");
    if (path === "/api/workspace")
      return respond({ workspace: { id: "ws-lan" }, projects, agents, runtime: { connected: true }, defaultCwd: "/w" });
    if (path === "/api/home") return respond(home);
    if (path === "/api/machine-load") return respond({ at: at(0), cpu: null, memory: null, gpus: null, jobs: [] });
    if (path === "/api/machine-live") return respond({ machines: [] });
    if (/^\/api\/projects\/[^/]+\/brief\/seen$/.test(path)) return respond({ ok: true });
    if (/^\/api\/projects\/[^/]+\/brief\/reply$/.test(path))
      return respond({ input: { ...request.body, expectedTurnId: null, question: null }, status: "accepted", turnId: "t10", error: null });
    if (/^\/api\/requests\/[^/]+\/respond$/.test(path)) return respond({ ok: true });
    if (/^\/api\/agents\/\w\/(messages|turns)$/.test(path))
      return respond({ input: request.body, status: "queued", turnId: "t1", error: null });
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return respond({ agent: agents.find((a) => a.id === detail[1]), pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (path === "/api/collaboration/github_repositories") return respond({ repositories: [], links: [] });
    if (path === "/api/machines") return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  const button = (text, root = doc) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text) || (!b.textContent.trim() && (b.title ?? "").startsWith(text)));
  try {
    w.eval(bundle);
    await waitFor(() => button("Home") && /Mori/.test(doc.querySelector(".agent-list")?.textContent || ""), "the workspace is read");
    button("Home").click();
    await waitFor(() => doc.querySelector('[data-glance-project="p-app"]'), "Home read its projects");
    // The project's page, where its cards, its approval and its reply are (YN-86).
    doc.querySelector('[data-glance-project="p-app"] .project-glance-open').click();
    await waitFor(() => doc.querySelector('[data-project-home="p-app"]'), "App's page");
  } catch (error) {
    w.close();
    throw error;
  }
  const card = (key) => doc.getElementById(`home-section-p-app-${key}`);
  /** What the page says went wrong, if anything: each alert's words. */
  const alerts = (root = doc) => [...root.querySelectorAll('[role="alert"]')].map((e) => e.textContent.trim()).filter(Boolean);
  return {
    w, doc, calls, errors, button, card, alerts,
    posts: (pattern) => calls.filter((c) => c.method === "POST" && pattern.test(c.url)),
    close: () => w.close(),
  };
}
async function type(p, element, value) {
  // A Home reply's field is the conversation's composer (YN-91).
  if (element.matches("[data-composer-input]")) {
    setComposerText(element, value);
    await pause();
    return;
  }
  const proto = element.tagName === "TEXTAREA" ? p.w.HTMLTextAreaElement.prototype : p.w.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  await pause();
}
async function choose(p, select, value) {
  Object.getOwnPropertyDescriptor(p.w.HTMLSelectElement.prototype, "value").set.call(select, value);
  select.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  await pause();
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const replies = (p) => p.posts(/\/brief\/reply$/);

test("YN-36 over plain http on a LAN address, a written reply to an Ask is sent and shown as replied", async () => {
  const p = await mount();
  try {
    const release = p.card("release");
    await type(p, release.querySelector(".home-text-reply [data-composer-input]"), "Ship it after the docs fix");
    p.button("Send", release).click();
    await waitFor(() => replies(p).length === 1,
      () => `the reply was sent; the page says: ${JSON.stringify(p.alerts(p.card("release")))}`);
    const [sent] = replies(p);
    assert.equal(sent.body.key, "release");
    assert.equal(sent.body.agentId, "a");
    assert.equal(sent.body.text, "Ship it after the docs fix");
    assert.match(sent.body.clientMessageId, uuid, "a version 4 UUID, made without crypto.randomUUID");
    await waitFor(() => /Replied · waiting for Mori/.test(p.card("release").textContent), "shown as replied");
    assert.deepEqual(p.alerts(), [], "nothing went wrong");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-36 over plain http, an option, a choice, a form and a reply to the project are sent too, each with its own id", async () => {
  const p = await mount();
  try {
    p.button("Ship today", p.card("release")).click();
    await waitFor(() => replies(p).length === 1, () => `the option was sent; the page says: ${JSON.stringify(p.alerts())}`);
    assert.equal(replies(p)[0].body.choice, "ship");
    p.button("Choose B", p.card("budget")).click();
    await waitFor(() => replies(p).length === 2, () => `the choice was sent; the page says: ${JSON.stringify(p.alerts())}`);
    assert.equal(replies(p)[1].body.choice, "plan-b");
    p.card("scope").querySelector(".clarification footer .primary-button").click();
    await waitFor(() => replies(p).length === 3, () => `the form was sent; the page says: ${JSON.stringify(p.alerts())}`);
    assert.equal(replies(p)[2].body.form?.formId, "scope");
    const panel = p.doc.querySelector('[data-project-home="p-app"]');
    p.button("Reply to the project", panel).click();
    await pause();
    const reply = panel.querySelector(".home-project-reply");
    await choose(p, reply.querySelector("select"), "b");
    await type(p, reply.querySelector(".home-text-reply [data-composer-input]"), "Please tidy the notes");
    p.button("Send", reply).click();
    await waitFor(() => replies(p).length === 4, () => `the project reply was sent; the page says: ${JSON.stringify(p.alerts())}`);
    assert.equal(replies(p)[3].body.text, "Please tidy the notes");
    const ids = replies(p).map((r) => r.body.clientMessageId);
    for (const id of ids) assert.match(id, uuid);
    assert.equal(new Set(ids).size, 4, "a new id for each reply");
    assert.deepEqual(p.alerts(), []);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-36 over plain http, an approval on Home is answered", async () => {
  const p = await mount();
  try {
    const panel = p.doc.querySelector('[data-project-home="p-app"]');
    p.button("Allow once", panel).click();
    await waitFor(() => p.posts(/\/api\/requests\/r-1\/respond$/).length === 1, "the approval was sent");
    assert.deepEqual(p.posts(/\/respond$/)[0].body, { response: { decision: "accept" } });
    assert.deepEqual(p.alerts(), []);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("YN-36 over plain http, a report still copies, through the browser's copy command; without one it says the clipboard is unavailable", async () => {
  const copies = [];
  const p = await mount({ copies });
  try {
    const notes = p.card("notes");
    const copy = p.button("Copy report", notes);
    copy.focus();
    copy.click();
    // Within the click, as the copy command needs.
    assert.equal(copies.length, 1, "copied in the click");
    assert.match(copies[0], /Notes body/);
    await waitFor(() => p.button("Copied", notes), "said copied");
    assert.ok(p.doc.activeElement === copy, "focus back on the button");
    assert.equal(p.doc.querySelectorAll("textarea[data-copy-fallback]").length, 0, "nothing left on the page");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // A browser whose copy command does nothing: said, never shown as copied.
  const q = await mount();
  try {
    const notes = q.card("notes");
    q.button("Copy report", notes).click();
    await waitFor(() => q.button("Copy unavailable", notes), "the missing clipboard is said");
    assert.deepEqual(await hoverTip(q.w, q.button("Copy unavailable", notes)), ["Clipboard unavailable. Select the text to copy."]);
    assert.equal(q.doc.querySelectorAll("textarea[data-copy-fallback]").length, 0, "nothing left on the page");
  } finally {
    q.close();
  }
});

test("YN-36 over plain http, a message from the conversation's composer is sent", async () => {
  const p = await mount();
  try {
    p.doc.querySelector('.agent-row[data-agent-id="a"] .agent-select').click();
    await waitFor(() => p.doc.querySelector("[data-composer-input]"), "Mori's conversation is open");
    const field = p.doc.querySelector("[data-composer-input]");
    setComposerText(field, "Run the linter too.");
    await pause();
    p.doc.querySelector('[aria-label="Send message"]').click();
    await waitFor(() => p.posts(/\/api\/agents\/a\/(messages|turns)$/).length === 1,
      () => `the message was sent; the page says: ${JSON.stringify(p.alerts())}`);
    const [sent] = p.posts(/\/api\/agents\/a\/(messages|turns)$/);
    assert.equal(sent.body.text, "Run the linter too.");
    assert.match(sent.body.clientMessageId, uuid);
    await waitFor(() => composerText(field) === "", "the composer is cleared once sent");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
