import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText } from "./composer-driver.mjs";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// OpenCode's fork in the app itself (T-10 Fork, Lead 3528): "Fork" on a
// completed turn previews what is kept, forks once on an explicit confirm and
// opens the new Agent, sending nothing and copying no draft; one request per
// Workspace, Agent and turn, kept until Core says how it ended, so a lost
// answer, a reload or an unconfirmed fork goes on with that same attempt and
// is never asked anew; an answer after the Agent was left opens nothing.
// Against the built app (YUZUNO_UI_DIST, else web/dist), as ui.test.mjs.
const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const bundleScript = new vm.Script(await uiTestBundle(new URL(entry, distUrl)));
async function until(read, message) {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (read()) return;
    if (Date.now() >= deadline) assert.fail(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const reply = (status, body) => ({ ok: status < 300, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
const turn = (id, text, answer) => ({ id, status: "completed", items: [
  { id: `u-${id}`, type: "userMessage", content: [{ type: "text", text }] },
  { id: `m-${id}`, type: "agentMessage", text: answer },
] });
const agent = (id, name, harness) => ({ id, name, harness, cwd: "/w", model: "deepseek/deepseek-flash", color: "green", status: "idle",
  createdAt: "2026-11-04", updatedAt: "2026-11-04", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  settings: { reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "workspace-write" } });
const preview = { turnId: "t1", keptTurns: 1, laterTurns: 1, messages: 2, cwd: "/w", name: "Mori (fork)", model: "deepseek/deepseek-flash", variant: "high" };
const forked = agent("c", "Mori (fork)", "opencode");
const completed = { state: "completed", requestId: "", agent: forked, connected: true, warnings: [] };
const storageKey = "yuzuno.opencodeForkRequests";

/** The app with Mori (OpenCode, two turns) and Hana (Codex). `core.fork` answers the fork itself, `core.seen` its reads. */
async function mount(core, stored = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
  window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  window.EventSource = class { constructor() {} close() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  const agents = [agent("a", "Mori", "opencode"), agent("b", "Hana", "codex")];
  window.fetch = async (url, init = {}) => {
    const { pathname: path, searchParams } = new URL(String(url), window.location.href);
    const body = init.body && JSON.parse(init.body);
    core.calls.push({ path, method: init.method || "GET", requestId: searchParams.get("requestId"), turnId: searchParams.get("turnId"), body });
    if (path === "/api/workspace") return reply(200, { workspace: { id: "ws-1" }, agents, runtime: { connected: true }, defaultCwd: "/w" });
    if (path === "/api/agents/a") return reply(200, { agent: agents[0], pending: [], artifacts: [], messageReceipts: [],
      turns: [turn("t1", "Start", "Started."), turn("t2", "Next", "Done.")] });
    if (path === "/api/agents/b") return reply(200, { agent: agents[1], pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (path === "/api/agents/c") return reply(200, { agent: forked, pending: [], artifacts: [], messageReceipts: [],
      turns: [turn("t9", "Start", "Started.")] });
    if (path === "/api/agents/a/opencode/fork/preview") return reply(200, preview);
    if (path === "/api/agents/a/opencode/fork" && (init.method || "GET") === "GET")
      return reply(200, (await core.seen?.(searchParams)) ?? { state: "none" });
    if (path === "/api/agents/a/opencode/fork") {
      const answer = await core.fork(body);
      // As Core: a registered fork is one of the Workspace's Agents from then on.
      if (answer.state === "completed" && !agents.some((a) => a.id === answer.agent.id)) agents.push(answer.agent);
      return answer.status ? reply(answer.status, answer.body) : reply(200, answer);
    }
    if (/\/models(\?|$)/.test(path)) return reply(200, { models: [] });
    return reply(200, {});
  };
  bundleScript.runInContext(dom.getInternalVMContext());
  const d = window.document;
  const page = {
    window, d, errors, close: () => window.close(),
    text: () => d.body.textContent,
    open: (name) => [...d.querySelectorAll(".agent-row")].find((el) => el.textContent.includes(name)).querySelector(".agent-select").click(),
    shown: () => d.querySelector(".agent-row.selected")?.dataset.agentId,
    button: (text, within = d) => [...(within?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === text),
    dialog: () => d.querySelector('[role="dialog"]'),
    forks: () => core.calls.filter((c) => c.method === "POST" && c.path === "/api/agents/a/opencode/fork"),
    saved: () => JSON.parse(window.localStorage.getItem(storageKey) || "{}"),
    name: (value) => {
      const input = d.querySelector('[role="dialog"] input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
  };
  if (page.shown() !== "a") { await until(() => d.querySelector(".agent-row"), "the rail lists the Agents"); page.open("Mori"); }
  await until(() => d.querySelector('[data-turn-id="t1"]'), "Mori's conversation opens");
  return page;
}
const key = JSON.stringify(["ws-1", "a", "t1"]);

test("a fork from a completed turn previews what it keeps, forks once on confirm and opens the new Agent, sending nothing", async () => {
  const core = { calls: [], fork: (body) => ({ ...completed, requestId: body.requestId }) };
  const page = await mount(core);
  try {
    page.button("Fork", page.d.querySelector('[data-turn-id="t1"]')).click();
    await until(() => page.button("Fork", page.dialog()), "the preview offers the fork");
    const shown = page.dialog().textContent;
    assert.match(shown, /Keeps 1 turn, through this one/);
    assert.match(shown, /1 later turn stays only here/);
    assert.match(shown, /\/w/);
    assert.match(shown, /deepseek\/deepseek-flash · high/);
    assert.match(shown, /Files are not restored/);
    assert.match(shown, /draft and any running sub-agents are not copied, and nothing is sent/);
    assert.equal(page.forks().length, 0, "nothing asked before the confirm");
    page.name("Mori, the other way");
    page.button("Fork", page.dialog()).click();
    await until(() => page.shown() === "c", () => `the new Agent opens; asked ${JSON.stringify(core.calls.map((c) => `${c.method} ${c.path}`))}, `
      + `shown ${page.shown()}, dialog ${page.dialog()?.textContent}, errors ${JSON.stringify(page.errors)}`);
    const [asked] = page.forks();
    assert.deepEqual({ turnId: asked.body.turnId, name: asked.body.name }, { turnId: "t1", name: "Mori, the other way" });
    assert.match(asked.body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(page.forks().length, 1);
    assert.deepEqual(page.saved(), {}, "its request is gone once Core said how it ended");
    assert.ok(!core.calls.some((c) => c.method === "POST" && /\/agents\/c\//.test(c.path)), "nothing sent to the new Agent");
    assert.equal(composerText(page.d.querySelector('[data-composer-input]')), "", "no draft copied");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an unconfirmed fork is only checked again, after a reload too, and never asked anew", async () => {
  let id;
  const core = { calls: [], fork: (body) => { id = body.requestId; return { state: "uncertain", requestId: id, message: "fixture: no answer" }; },
    // Nothing before it is asked; then that attempt, unconfirmed.
    seen: (params) => id ? { state: "uncertain", requestId: params.get("requestId") ?? id, message: "still unconfirmed" } : { state: "none" } };
  let page = await mount(core);
  try {
    page.button("Fork", page.d.querySelector('[data-turn-id="t1"]')).click();
    await until(() => page.button("Fork", page.dialog()), "the preview offers the fork");
    page.button("Fork", page.dialog()).click();
    await until(() => page.button("Check again", page.dialog()), "the unconfirmed fork offers only a check");
    assert.match(page.dialog().textContent, /never asked again/);
    assert.equal(page.saved()[key], id, "its request kept");
    const stored = page.window.localStorage.getItem(storageKey);
    page.close();
    // A reload: the same attempt, read again; nothing previewed or asked.
    page = await mount(core, { [storageKey]: stored });
    page.button("Fork", page.d.querySelector('[data-turn-id="t1"]')).click();
    await until(() => page.button("Check again", page.dialog()), "the same attempt is shown again");
    page.button("Check again", page.dialog()).click();
    await until(() => core.calls.filter((c) => c.method === "GET" && c.requestId === id).length === 2, "checked again by its request");
    assert.equal(page.forks().length, 1, "asked once, before the reload, and never again");
    assert.equal(core.calls.filter((c) => c.path === "/api/agents/a/opencode/fork/preview").length, 1, "previewed only before it was asked");
    assert.ok(!page.button("Fork", page.dialog()), "no way to fork again from here");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a fork whose answer was lost goes on with the same request, never a new one", async () => {
  const asked = [];
  const core = { calls: [], fork: (body) => {
    asked.push(body.requestId);
    return asked.length === 1 ? { status: 502, body: { error: "fixture: the answer was lost" } } : { ...completed, requestId: body.requestId };
  } };
  const page = await mount(core);
  try {
    page.button("Fork", page.d.querySelector('[data-turn-id="t1"]')).click();
    await until(() => page.button("Fork", page.dialog()), "the preview offers the fork");
    page.button("Fork", page.dialog()).click();
    await until(() => page.button("Continue this fork", page.dialog()), "the same fork can go on");
    assert.equal(page.saved()[key], asked[0], "its request kept");
    page.button("Continue this fork", page.dialog()).click();
    await until(() => page.shown() === "c", "the new Agent opens");
    assert.deepEqual(asked, [asked[0], asked[0]], "the same request both times");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a fork that ends after its Agent was left opens nothing", async () => {
  let answer;
  const core = { calls: [], fork: (body) => new Promise((resolve) => { answer = () => resolve({ ...completed, requestId: body.requestId }); }) };
  const page = await mount(core);
  try {
    page.button("Fork", page.d.querySelector('[data-turn-id="t1"]')).click();
    await until(() => page.button("Fork", page.dialog()), "the preview offers the fork");
    page.button("Fork", page.dialog()).click();
    await until(() => answer, "the fork is asked");
    // Another Agent is shown while it is out.
    page.open("Hana");
    await until(() => page.shown() === "b", "Hana is shown");
    answer();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(page.shown(), "b", "nothing opened on its answer");
    assert.deepEqual(page.saved(), {}, "its outcome still kept as Core said");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
