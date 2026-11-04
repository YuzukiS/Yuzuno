import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText, savedDraftText } from "./composer-driver.mjs";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// OpenCode's revert in the app itself (T-10, Lead 4128): held for the Agent,
// not for the turn it removes, so its result stays when Core's record drops
// that turn; an outcome not yet confirmed comes back from Core whenever the
// Agent is shown again (closed, another Agent, a reload) and is only checked,
// never confirmed again; the original text goes to the Agent's draft once.
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
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const reply = (status, body) => ({ ok: status < 300, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
const turn = (id, text, answer) => ({ id, status: "completed", items: [
  { id: `u-${id}`, type: "userMessage", content: [{ type: "text", text }] },
  { id: `m-${id}`, type: "agentMessage", text: answer },
] });
const preview = { previewId: "revert_1", available: true, removedTurns: 1, keptTurns: 1, draft: "Fix a.txt",
  files: [{ path: "/w/a.txt", current: { state: "file", size: 3, sha256: "b", executable: false }, expected: { state: "absent" } }] };
const unknown = { attemptId: "revert_1", status: "unknown", draft: "", message: "这次回退的结果无法确认" };

/**
 * The app with Mori (OpenCode, two turns) and Hana (Codex). `core.answers`
 * answers the revert routes; `core.turns` is Mori's record as Core holds it.
 */
async function mount(core, stored = {}, shownTurn = "t2", prepare = () => {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
  prepare(window);
  window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  const streams = [];
  window.EventSource = class { constructor(url) { this.url = url; streams.push(this); } close() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  const agent = (id, name, harness) => ({ id, name, harness, cwd: "/w", model: "", color: "green", status: "idle",
    createdAt: "2026-11-04", updatedAt: "2026-11-04", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 });
  const agents = [agent("a", "Mori", "opencode"), agent("b", "Hana", "codex")];
  window.fetch = async (url, init = {}) => {
    const { pathname: path, searchParams } = new URL(String(url), window.location.href);
    core.calls.push({ path, query: searchParams.get("id"), method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    if (path === "/api/workspace") return reply(200, { workspace: { id: "ws-1" }, agents, runtime: { connected: true }, defaultCwd: "/w" });
    if (path === "/api/agents/a") return reply(200, { agent: agents[0], pending: [], artifacts: [], messageReceipts: [], turns: core.turns });
    if (path === "/api/agents/b") return reply(200, { agent: agents[1], pending: [], artifacts: [], messageReceipts: [], turns: [] });
    const revert = path.match(/^\/api\/agents\/a\/rewind\/(\w+)$/)?.[1];
    if (revert) {
      const answer = core.answers[revert];
      const body = typeof answer === "function" ? answer(searchParams.get("id")) : answer;
      return reply(200, (await body) ?? {});
    }
    if (/\/models(\?|$)/.test(path)) return reply(200, { models: [] });
    return reply(200, {});
  };
  bundleScript.runInContext(dom.getInternalVMContext());
  const d = window.document;
  const page = {
    window, d, errors, close: () => window.close(),
    composer: () => d.querySelector('[data-composer-input][aria-label="Message Mori"]'),
    text: () => d.body.textContent,
    open: (name) => [...d.querySelectorAll(".agent-row")].find((el) => el.textContent.includes(name)).querySelector(".agent-select").click(),
    shown: () => d.querySelector(".agent-row.selected")?.dataset.agentId,
    button: (text, within = d) => [...(within?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === text),
    dialog: () => d.querySelector('[role="dialog"]'),
    changed: () => streams.at(-1)?.onmessage?.({ data: JSON.stringify({ type: "agent.changed", agentId: "a", lastSeq: 2 }), lastEventId: "e-1" }),
    sent: (route) => core.calls.filter((c) => c.method === "POST" && c.path === `/api/agents/a/rewind/${route}`),
  };
  if (page.shown() !== "a") { await until(() => d.querySelector(".agent-row"), "the rail lists the Agents"); page.open("Mori"); }
  await until(() => d.querySelector(`[data-turn-id="${shownTurn}"]`), "Mori's conversation opens");
  return page;
}
const occurrences = (text, part) => text.split(part).length - 1;

test("a revert's result stays readable once Core's record drops the turn it reverted", async () => {
  const core = { calls: [], turns: [turn("t1", "Start", "Started."), turn("t2", "Fix a.txt", "Fixed.")], answers: {
    preview,
    confirm: { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退，但有 2 个文件不是快照里的内容",
      files: [{ path: "/w/a.txt", outcome: "drifted", why: null }, { path: "/w/b.txt", outcome: "drifted", why: "Permission denied" }] },
  } };
  const page = await mount(core);
  try {
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    assert.match(page.text(), /\/w\/a\.txt: now 3 bytes, becomes no file/);
    page.button("Revert", page.dialog()).click();
    await until(() => /Reverted\./.test(page.text()), "the revert is kept");
    // Core's record drops the reverted turn, and says so.
    core.turns = [turn("t1", "Start", "Started.")];
    page.changed();
    await until(() => !page.d.querySelector('[data-turn-id="t2"]'), "the reverted turn leaves the conversation");
    const text = page.text();
    assert.match(text, /Reverted\. 已回退/, "the result stays");
    assert.match(text, /\/w\/a\.txt: neither as before nor as the snapshot holds it/);
    assert.match(text, /\/w\/b\.txt: could not be checked: Permission denied/, "a file that could not be read is not said to have changed");
    await until(() => occurrences(savedDraftText(page.window.localStorage, "a"), "Fix a.txt") === 1, "the text once, in Mori's draft");
    assert.equal(page.sent("confirm").length, 1);
    page.button("Close", page.dialog()).click();
    await until(() => !/Reverted\./.test(page.text()), "closed");
    assert.ok(!page.button("Check outcome"), "nothing left to check");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an outcome not yet confirmed is found again however the Agent is left, only checked, its text given once", async () => {
  let checks = 0;
  const core = { calls: [], turns: [turn("t1", "Start", "Started."), turn("t2", "Fix a.txt", "Fixed.")], answers: {
    // As Core answers it: not yet known, whether asked for by its ID or as the one pending.
    preview, confirm: unknown, attempt: () => ({ attempt: unknown }),
    check: () => (++checks < 2 ? { ...unknown, message: "第一次核对：仍无法确认" } : { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退", files: [] }),
  } };
  const page = await mount(core);
  let stored;
  try {
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    page.button("Revert", page.dialog()).click();
    await until(() => /The revert is not yet confirmed/.test(page.text()), "not yet confirmed");
    page.button("Close", page.dialog()).click();
    const dock = () => /OpenCode’s revert is not yet confirmed: new messages to Mori wait/.test(page.text());
    await until(dock, "closed, the Agent still shows it is held back, with its check");
    page.open("Hana");
    await until(() => page.shown() === "b" && !dock(), "Hana is shown");
    page.open("Mori");
    await until(() => page.shown() === "a" && dock(), "back on Mori, still there");
    assert.ok(!page.button("Keep current history"), "never kept by choice");
    assert.equal(page.sent("confirm").length, 1, "confirmed once");
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
  } finally { page.close(); }

  // Reloaded: what Core keeps brings the check back, and asking it is all that is done.
  core.calls.length = 0;
  const again = await mount(core, stored);
  try {
    const dock = () => /OpenCode’s revert is not yet confirmed: new messages to Mori wait/.test(again.text());
    await until(dock, "after a reload, the check is back");
    again.button("Check outcome").click();
    await until(() => again.button("Check outcome", again.dialog()), "its dialog opens on the outcome");
    assert.equal(again.sent("check").length, 0, "opening it asks nothing");
    again.button("Check outcome", again.dialog()).click();
    await until(() => /第一次核对：仍无法确认/.test(again.text()) && !again.button("Check outcome", again.dialog())?.disabled, "checked once, its answer shown");
    assert.equal(occurrences(savedDraftText(again.window.localStorage, "a"), "Fix a.txt"), 0, "no text while not confirmed");
    again.button("Check outcome", again.dialog()).click();
    await until(() => /Reverted\./.test(again.text()), "kept on the second check");
    await until(() => occurrences(savedDraftText(again.window.localStorage, "a"), "Fix a.txt") === 1, "the text once, in Mori's draft");
    assert.deepEqual(again.sent("check").map((c) => c.body), [{ attemptId: "revert_1" }, { attemptId: "revert_1" }]);
    assert.equal(again.sent("confirm").length + again.sent("preview").length + again.sent("resolve").length, 0, "only checked");
    stored = Object.fromEntries(Object.entries(again.window.localStorage));
  } finally { again.close(); }

  // Reloaded once more while Core still answers it as not known, then kept: its text is not given twice.
  checks = 1;
  const third = await mount(core, stored);
  try {
    await until(() => third.button("Check outcome"), "the check is back");
    third.button("Check outcome").click();
    await until(() => third.button("Check outcome", third.dialog()), "its dialog opens");
    third.button("Check outcome", third.dialog()).click();
    await until(() => /Reverted\./.test(third.text()), "kept");
    assert.equal(occurrences(savedDraftText(third.window.localStorage, "a"), "Fix a.txt"), 1, "the text is not given twice");
    assert.equal(third.sent("confirm").length, 0, "never confirmed again");
    assert.deepEqual(third.errors, []);
  } finally { third.close(); }
});

test("a revert that settled while the page was away is found again with its result, its text given once", async () => {
  const files = [{ path: "/w/a.txt", outcome: "verified" }];
  const core = { calls: [], turns: [turn("t1", "Start", "Started."), turn("t2", "Fix a.txt", "Fixed.")], answers: {
    preview,
    // The page goes before OpenCode answers.
    confirm: () => new Promise(() => {}),
    attempt: (id) => ({ attempt: id === "revert_1" ? { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退", files } : null }),
  } };
  const page = await mount(core);
  let stored;
  try {
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    page.button("Revert", page.dialog()).click();
    await until(() => page.sent("confirm").length === 1, "asked");
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
  } finally { page.close(); }

  // Meanwhile Core kept it, and dropped the turn. Reloaded: found by its ID, with its result and its text.
  core.turns = [turn("t1", "Start", "Started."), turn("t3", "Later", "Later.")];
  core.calls.length = 0;
  const again = await mount(core, stored, "t3");
  try {
    await until(() => /OpenCode’s revert has an outcome you have not seen yet/.test(again.text()), "an outcome to see");
    assert.deepEqual([...new Set(core.calls.filter((c) => c.path === "/api/agents/a/rewind/attempt").map((c) => c.query))].sort(), ["revert_1", null].sort(),
      "read as the one pending and by its own ID");
    await until(() => occurrences(savedDraftText(again.window.localStorage, "a"), "Fix a.txt") === 1, "its text, once, in Mori's draft");
    again.button("Show outcome").click();
    await until(() => /Reverted\. 已回退/.test(again.text()), "its result");
    assert.match(again.text(), /\/w\/a\.txt: as OpenCode’s snapshot holds it/);
    again.button("Close", again.dialog()).click();
    await until(() => !again.dialog(), "closed");
    assert.equal(again.sent("confirm").length + again.sent("check").length, 0, "only read");
    stored = Object.fromEntries(Object.entries(again.window.localStorage));
  } finally { again.close(); }

  // Seen through: not shown again, nor its text given again.
  core.calls.length = 0;
  const third = await mount(core, stored, "t3");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.doesNotMatch(third.text(), /OpenCode’s revert/, "nothing left to see");
    assert.deepEqual([...new Set(core.calls.filter((c) => c.path === "/api/agents/a/rewind/attempt").map((c) => c.query))], [null], "no longer asked for by its ID");
    assert.equal(occurrences(savedDraftText(third.window.localStorage, "a"), "Fix a.txt"), 1, "not given twice");
    assert.deepEqual(third.errors, []);
  } finally { third.close(); }
});

test("a saved draft that cannot be read is not overwritten, and the text is left to give", async () => {
  const damaged = "{not a draft";
  const key = `yuzuno.composer.v1:${JSON.stringify(["ws-1", "a"])}`;
  const core = { calls: [], turns: [turn("t1", "Start", "Started."), turn("t2", "Fix a.txt", "Fixed.")], answers: {
    preview, confirm: { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退", files: [] },
    attempt: { attempt: null },
  } };
  const page = await mount(core, { [key]: damaged });
  try {
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    page.button("Revert", page.dialog()).click();
    await until(() => /Reverted\./.test(page.text()), "kept");
    await until(() => /The original text could not be added to the draft/.test(page.text()), "said so");
    assert.ok(page.button("Add to draft", page.dialog()), "offered again");
    assert.equal(page.window.localStorage.getItem(key), damaged, "the damaged draft is left as it was");
    assert.doesNotMatch(page.window.localStorage.getItem("yuzuno.revert.given.v1") ?? "", /revert_1/, "not counted as given");
  } finally { page.close(); }
});

test("a draft that cannot be saved keeps the text once here, saves that one when it can, and never adds it twice", async () => {
  const kept = { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退", files: [] };
  const core = { calls: [], turns: [turn("t1", "Start", "Started."), turn("t2", "Fix a.txt", "Fixed.")], answers: {
    preview, confirm: kept, attempt: (id) => ({ attempt: id === "revert_1" ? kept : null }),
  } };
  // The page's own storage refuses writes as a full one does, to the draft or to what was given.
  const full = { draft: false, given: false };
  const refusing = (window) => {
    const write = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key, value) {
      if ((full.draft && key.startsWith("yuzuno.composer.v1:")) || (full.given && key === "yuzuno.revert.given.v1"))
        throw new window.DOMException("The quota has been exceeded.", "QuotaExceededError");
      return write.call(this, key, value);
    };
  };
  const page = await mount(core, {}, "t2", refusing);
  let stored;
  try {
    full.draft = true;
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    page.button("Revert", page.dialog()).click();
    await until(() => /The original text could not be added to the draft/.test(page.text()), "not saved, said so");
    assert.equal(savedDraftText(page.window.localStorage, "a"), "", "nothing saved");
    assert.equal(occurrences(composerText(page.composer()), "Fix a.txt"), 1, "kept once in this window");
    // The draft can be saved again; what was given cannot.
    full.draft = false; full.given = true;
    page.button("Add to draft", page.dialog()).click();
    await until(() => !/could not be added/.test(page.text()), "saved");
    assert.equal(occurrences(savedDraftText(page.window.localStorage, "a"), "Fix a.txt"), 1, "the one kept here is saved, not a second");
    assert.equal(occurrences(composerText(page.composer()), "Fix a.txt"), 1, "still once here");
    assert.doesNotMatch(page.window.localStorage.getItem("yuzuno.revert.given.v1") ?? "", /revert_1/, "what was given was not saved");
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
  } finally { page.close(); }

  // Reloaded before it was closed: found again by its ID, and its text, already in the saved draft, not added again.
  const again = await mount(core, stored);
  try {
    await until(() => core.calls.some((c) => c.path === "/api/agents/a/rewind/attempt" && c.query === "revert_1"), "read again by its ID");
    await until(() => (again.window.localStorage.getItem("yuzuno.revert.given.v1") ?? "").includes("revert_1"), "now counted as given");
    assert.equal(occurrences(savedDraftText(again.window.localStorage, "a"), "Fix a.txt"), 1, "never added twice");
    assert.deepEqual(again.errors, []);
  } finally { again.close(); }
});
