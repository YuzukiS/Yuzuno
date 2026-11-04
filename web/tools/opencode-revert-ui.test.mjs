import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText, savedDraftText, setComposerText } from "./composer-driver.mjs";
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
    core.calls.push({ path, query: searchParams.get("id"), turnId: searchParams.get("turnId"), method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    if (path === "/api/workspace") return reply(200, { workspace: { id: "ws-1" }, agents, runtime: { connected: true }, defaultCwd: "/w" });
    if (path === "/api/agents/a") return reply(200, { agent: agents[0], pending: [], artifacts: [], messageReceipts: [], turns: core.turns,
      ...(core.window ? { conversation: windowOf(core.turns) } : {}) });
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
/** Mori's conversation as one window, with its metadata, as Core sends it: what the reader's window is held at. */
const windowOf = (turns) => ({
  index: turns.map((t, i) => ({ ...t, number: i + 1, itemCount: t.items.length, items: [t.items[0]] })),
  questions: [], nativeClientIds: [],
  start: JSON.stringify([turns[0].id, turns[0].items[0].id]),
  end: JSON.stringify([turns.at(-1).id, turns.at(-1).items.at(-1).id]),
  hasBefore: false, hasAfter: false, totalItems: turns.reduce((n, t) => n + t.items.length, 0),
});

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
  let confirmed = false;
  const core = { calls: [], turns: [turn("t1", "Start", "Started."), turn("t2", "Fix a.txt", "Fixed.")], answers: {
    // As Core answers it: none before it is confirmed; then not yet known, whether asked for by its ID or as the one pending.
    preview, confirm: () => { confirmed = true; return unknown; }, attempt: () => ({ attempt: confirmed ? unknown : null }),
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

/** Storage that refuses writes as a full one does, to the draft or to what was given, while `full` says so. */
function refusing(full) {
  return (window) => {
    const write = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key, value) {
      if ((full.draft && key.startsWith("yuzuno.composer.v1:")) || (full.given && key === "yuzuno.revert.given.v1"))
        throw new window.DOMException("The quota has been exceeded.", "QuotaExceededError");
      return write.call(this, key, value);
    };
  };
}
const keptRevert = { attemptId: "revert_1", status: "completed", draft: "Fix a.txt", message: "已回退", files: [] };
const keptCore = () => ({ calls: [], turns: [turn("t1", "Start", "Started."), turn("t2", "Fix a.txt", "Fixed.")], answers: {
  preview, confirm: keptRevert, attempt: (id) => ({ attempt: id === "revert_1" ? keptRevert : null }),
} });
const settleTyping = () => new Promise((resolve) => setTimeout(resolve, 60));

test("text typed after a revert's text, before it could be saved, is kept; the revert's text is saved once", async () => {
  const core = keptCore();
  const full = { draft: true, given: false };
  const page = await mount(core, {}, "t2", refusing(full));
  let stored;
  try {
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    page.button("Revert", page.dialog()).click();
    await until(() => /The original text could not be added to the draft/.test(page.text()), "not saved, said so");
    // Ordinary input, through the editor, while it is not saved.
    setComposerText(page.composer(), `${composerText(page.composer())}\n\nand more`);
    await settleTyping();
    full.draft = false;
    page.button("Add to draft", page.dialog()).click();
    await until(() => !/could not be added/.test(page.text()), "saved");
    const saved = savedDraftText(page.window.localStorage, "a");
    assert.equal(occurrences(saved, "Fix a.txt"), 1, "the revert's text saved once");
    assert.match(saved, /and more/, "what was typed after it is kept");
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
  } finally { page.close(); }
  const again = await mount(core, stored);
  try {
    await until(() => core.calls.some((c) => c.query === "revert_1"), "read again by its ID");
    await settleTyping();
    const saved = savedDraftText(again.window.localStorage, "a");
    assert.equal(occurrences(saved, "Fix a.txt"), 1, "not added again after a reload");
    assert.match(saved, /and more/);
    assert.deepEqual(again.errors, []);
  } finally { again.close(); }
});

test("a draft cleared after a revert's text was saved stays cleared, even when what was given could not be saved", async () => {
  const core = keptCore();
  const full = { draft: false, given: true };
  const page = await mount(core, {}, "t2", refusing(full));
  let stored;
  try {
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    page.button("Revert", page.dialog()).click();
    await until(() => occurrences(savedDraftText(page.window.localStorage, "a"), "Fix a.txt") === 1, "saved once");
    assert.doesNotMatch(page.window.localStorage.getItem("yuzuno.revert.given.v1") ?? "", /revert_1/, "what was given was not saved");
    // The user clears the draft.
    setComposerText(page.composer(), "");
    await settleTyping();
    assert.equal(savedDraftText(page.window.localStorage, "a"), "", "cleared");
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
  } finally { page.close(); }
  // Reloaded before the result was closed: read again by its ID, and the cleared draft not refilled.
  const again = await mount(core, stored);
  try {
    await until(() => core.calls.some((c) => c.query === "revert_1"), "read again by its ID");
    await until(() => (again.window.localStorage.getItem("yuzuno.revert.given.v1") ?? "").includes("revert_1"), "now counted as given");
    assert.equal(savedDraftText(again.window.localStorage, "a"), "", "a cleared draft is not refilled");
    assert.equal(composerText(again.composer()), "", "nor shown as holding text");
    assert.deepEqual(again.errors, []);
  } finally { again.close(); }
});

test("a revert dialog's disclosure is not the conversation's: opening its original input does not take over from following", async () => {
  const withTool = turn("t2", "Fix a.txt", "Fixed.");
  withTool.items.splice(1, 0, { id: "prt_1", type: "opencodeTool", name: "bash", callId: "call_1", input: { command: "ls" }, output: "a.txt", status: "completed" });
  // A long original input, which scrolls inside the dialog.
  const long = { ...preview, draft: Array.from({ length: 60 }, (_, i) => `line ${i + 1} of what was asked`).join("\n") };
  const core = { calls: [], window: true, turns: [turn("t1", "Start", "Started."), withTool], answers: { preview: long, attempt: { attempt: null } } };
  const page = await mount(core);
  const w = page.window;
  const reads = () => core.calls.filter((c) => c.path === "/api/agents/a" && c.method === "GET");
  const readAgain = async () => {
    const before = reads().length;
    page.changed();
    await until(() => reads().length > before, "Mori's conversation read again");
    return reads().at(-1);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
    page.button("Rewind", page.d.querySelector('[data-turn-id="t2"]')).click();
    await until(() => page.button("Revert", page.dialog()), "the preview offers the revert");
    const before = reads().length;
    // In the dialog: its original input opened, scrolled by wheel, keys and touch, as a reader of it would.
    const input = [...page.dialog().querySelectorAll("summary")].find((el) => el.textContent.trim() === "Original input");
    assert.ok(input, "the dialog's original input");
    input.click();
    const text = page.dialog().querySelector(".rewind-input");
    assert.ok(text, "its long text");
    for (const deltaY of [-120, 120]) text.dispatchEvent(new w.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
    for (const key of ["Home", "PageUp", "ArrowUp", "End", "PageDown", "ArrowDown", " "])
      text.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    text.dispatchEvent(new w.Event("touchstart", { bubbles: true }));
    text.dispatchEvent(new w.Event("pointercancel", { bubbles: true }));
    text.dispatchEvent(new w.Event("touchend", { bubbles: true }));
    text.dispatchEvent(new w.Event("touchcancel", { bubbles: true }));
    await settle();
    assert.equal(reads().length, before, "nothing in the dialog sends the conversation to its end or anywhere else");
    page.button("Close", page.dialog()).click();
    await until(() => !page.dialog(), "closed");
    assert.equal((await readAgain()).turnId, null, "a dialog's disclosure is not the conversation's: it still follows the latest");
    // The conversation's own: a wheel up in it, and its own disclosure, do take over from following.
    page.d.querySelector('[data-turn-id="t1"]').dispatchEvent(new w.WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
    assert.equal((await readAgain()).turnId, "t1", "its own wheel holds the reader's window");
    const own = page.d.querySelector('[data-turn-id="t2"] summary');
    assert.ok(own, "the tool row's own disclosure");
    own.click();
    assert.equal((await readAgain()).turnId, "t1", "its own disclosure holds the reader's window");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
