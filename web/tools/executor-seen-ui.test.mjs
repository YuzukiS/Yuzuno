import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { readTip } from "./tip-dom.mjs";

// YN-232 (R-44, the user: they talk with the lead, not with each executor):
// an executor's row, ring, pill, card, screen-reader text and place in the
// list say what Core says it is at, never whether its conversation has been
// opened. Fixed for the whole test: Core reports one background shell for
// an executor at rest whose last Turn finished; nothing of it was read. Its
// row says "Awaits a shell" before it is opened, after it has been shown
// past the read dwell (AUTO_READ_DWELL_MS, 1.2 s) and after switching away
// and back. Beside it: one at rest with nothing running, one whose last Turn
// failed, and a lead, whose unseen Turn end and updates unread still show.
// The built app against a fixture Core, as executor-rail-ui.test.mjs.
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
  assert.ok(predicate(), message);
}
/** Past the read dwell (useAutoRead.ts AUTO_READ_DWELL_MS = 1200 ms), with room. */
const DWELL_PAST_MS = 1500;
const PHONE = "(max-width: 520px), (max-height: 500px) and (hover: none) and (pointer: coarse)";

const WS = "ws-seen";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
const ended = (outcome = "finished", seq = 9) => ({ seq, outcome, at: at(2) });
const agent = (id, extra = {}) => ({
  id, name: `Agent ${id}`, goal: "", cwd: "/synthetic/work", model: "m", color: "sage", status: "idle", harness: "codex",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 9, reviewedSeq: 1, projectId: "p", ...extra,
});
const executor = (id, extra = {}) => agent(id, {
  name: `YN-${id} · Small fix`,
  kind: "executor",
  executor: { state: "running", agentId: id, dispatcher: { kind: "agent", id: "l", name: "Dev Lead" },
    task: { id: `YN-${id}`, title: `Work ${id}` }, template: { id: "small-fix", label: "Small fix" }, dispatchedAt: at(65), since: at(5) },
  lastTurnEnd: ended(),
  ...extra,
});
const agents = () => [
  // A lead, its last Turn ended and not shown here, with updates unread.
  agent("l", { name: "Dev Lead", kind: "lead", unreadCount: 2, lastTurnEnd: ended("finished", 5), lastSeq: 5 }),
  // At rest, its last Turn finished, one background shell still running (Core's /api/waits/live).
  executor("sh"),
  // At rest, nothing running; with updates unread, which are no executor's to show.
  executor("qt", { unreadCount: 3 }),
  // At rest, its last Turn failed: a fault, read or not.
  executor("bad", { lastTurnEnd: ended("failed") }),
  // A Turn running.
  executor("k", { status: "working" }),
];
const waitsLive = { agents: { sh: { shells: 1 } } };

async function mount({ storage = {}, phone = false } = {}) {
  const errors = [];
  const calls = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  w.matchMedia = (media) => ({ media, matches: phone && media === PHONE, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.EventSource = class { addEventListener() {} close() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const respond = (value, status = 200) => {
    const text = JSON.stringify(value);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  const listed = agents();
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url.endsWith("/api/workspace")) return respond({ workspace: { id: WS }, projects: [project], agents: listed, runtime: { connected: true }, defaultCwd: "/w" });
    if (url.endsWith("/api/home")) return respond({ generatedAt: at(0), order: ["p"], needsYou: [], projects: [] });
    if (url.endsWith("/api/waits/live")) return respond(waitsLive);
    if (url.endsWith("/task_list")) return respond({ tasks: [], counts: {}, hasMore: false });
    const detail = url.match(/\/api\/agents\/(\w+)$/);
    if (detail) return respond({ agent: listed.find((a) => a.id === detail[1]), pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  w.eval(bundle);
  await waitFor(() => doc.querySelector('.agent-list article[data-agent-id="qt"]'), "the sidebar lists the Agents");
  const row = (id) => doc.querySelector(`.agent-list article[data-agent-id="${id}"]`);
  const island = (id) => row(id)?.querySelector(":scope > .agent-island") ?? null;
  const reads = (id) => calls.filter((c) => c.url.endsWith(`/api/agents/${id}`)).length;
  return {
    w, doc, calls, errors, row, island,
    /** What the row says, as one value: its ring, the pill that stays, the wait in the ring, the pill's words,
     * line two, the screen reader's text, its dot. */
    shown: (id) => {
      const i = island(id);
      return {
        ring: i?.dataset.state ?? null,
        stay: i?.dataset.stay ?? null,
        form: row(id)?.dataset.form ?? null,
        wait: row(id)?.querySelector(".island-ringbox")?.getAttribute("data-wait") ?? null,
        pill: i?.querySelector(".island-pill")?.textContent ?? null,
        meta: row(id)?.querySelector(":scope > .agent-row-meta")?.textContent ?? null,
        said: row(id)?.querySelector(".agent-select")?.getAttribute("aria-description") ?? null,
        dot: i?.dataset.dot === "true",
      };
    },
    order: () => [...doc.querySelectorAll(".agent-list article[data-agent-id]")].map((el) => el.dataset.agentId),
    /** The rows drawn and Core's live waits read and shown: what the row says then is what it says unopened. */
    ready: async () => {
      await waitFor(() => calls.some((c) => c.url.endsWith("/api/waits/live")) && island("qt")?.querySelector(".island-pill"), "the rows and Core's live waits");
      await pause(300);
    },
    seen: () => JSON.parse(w.localStorage.getItem(`yuzuno.turnSeen.${WS}`) || "{}"),
    card: (id) => readTip(w, row(id).querySelector(".agent-select")),
    /** Opens its conversation from its row, as a click does, and waits for its read. */
    open: async (id) => {
      const before = reads(id);
      row(id).querySelector(".agent-select").click();
      await waitFor(() => reads(id) > before && row(id)?.classList.contains("selected"), `${id}'s conversation opens`);
    },
    close: () => w.close(),
  };
}

const SHELL = {
  ring: "idle", stay: "waits", form: "pill", wait: "shell", pill: "Awaits a shell", meta: "1h5m",
  said: "Executor · Waiting on a background shell, on Core host", dot: false,
};
const BETWEEN = {
  ring: "idle", stay: "between", form: "pill", wait: null, pill: "Between turns", meta: "1h5m",
  said: "Executor · Between turns, on Core host", dot: false,
};

test("fixed: one shell, its last Turn finished, at rest; unopened, opened past the read dwell, and away and back say the same", async () => {
  const p = await mount();
  try {
    await p.ready();
    const before = { sh: p.shown("sh"), qt: p.shown("qt"), bad: p.shown("bad") };
    assert.deepEqual(before.sh, SHELL, "unopened: the shell Core reports, not \"Between turns\"");
    assert.deepEqual(before.qt, BETWEEN, "unopened, nothing running: between Turns, and no unread");
    assert.deepEqual([before.bad.ring, before.bad.form, before.bad.meta], ["failed", "row", "Its Turn failed · 5m ago"], "unopened: its failed Turn");
    assert.match(before.bad.said, /^Executor · Failed · Its Turn failed, on Core host$/);
    const card = await p.card("sh");
    assert.equal(card[1], "Waiting on a background shell on its task for 1h5m", card.join(" | "));
    assert.ok(card.includes("Its Turn has ended: not working, only waiting for what it started"), card.join(" | "));
    assert.doesNotMatch([...card, before.sh.said, before.qt.said].join("\n"), /unseen|unread|未看|未读/i);

    // Opened, shown past the read dwell: its end is marked seen on this device, and the row is as it was.
    await p.open("sh");
    await pause(DWELL_PAST_MS);
    await waitFor(() => p.seen().sh === 9, "sh's Turn end marked seen after the dwell");
    assert.deepEqual({ ...p.shown("sh") }, SHELL, "opened past the dwell: the same");
    // Away to another executor and back.
    await p.open("qt");
    await pause(DWELL_PAST_MS);
    assert.deepEqual(p.shown("sh"), SHELL, "switched away: the same");
    assert.deepEqual(p.shown("qt"), BETWEEN, "qt opened past the dwell: the same as unopened");
    await p.open("sh");
    assert.deepEqual(p.shown("sh"), SHELL, "back again: the same");
    // A failed Turn stays failed once read.
    await p.open("bad");
    await pause(DWELL_PAST_MS);
    await waitFor(() => p.seen().bad === 9, "bad's end marked seen");
    assert.deepEqual(p.shown("bad"), before.bad, "its failed Turn, read: still failed");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a lead still shows its Turn end unseen here and its updates unread; an executor never does", async () => {
  const p = await mount();
  try {
    await waitFor(() => p.island("l")?.dataset.dot === "true", "the lead's dot");
    assert.deepEqual([p.shown("l").ring, p.shown("l").dot], ["done", true], "the lead: ✓ for its unseen end, and its dot");
    for (const id of ["sh", "qt", "bad", "k"]) assert.equal(p.shown(id).dot, false, `${id}: no dot`);
    assert.equal(p.doc.querySelectorAll(".agent-list .island-notch").length, 0, "no count anywhere");
    await p.open("l");
    await pause(DWELL_PAST_MS);
    await waitFor(() => p.shown("l").ring === "idle", "the lead's end, shown, is seen");
    assert.equal(p.shown("l").dot, true, "its updates unread are Core's to clear");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in attention order an executor's place is the same before and after it is read; a failed Turn goes first", async () => {
  const p = await mount({ storage: { "yuzuno.appearance": JSON.stringify({ agentOrder: "attention" }) } });
  try {
    await p.ready();
    const before = p.order();
    assert.deepEqual(before.filter((id) => id !== "l"), ["bad", "k", "sh", "qt"], before.join(","));
    for (const id of ["sh", "qt", "bad"]) {
      await p.open(id);
      await pause(DWELL_PAST_MS);
    }
    await waitFor(() => p.seen().sh === 9 && p.seen().qt === 9 && p.seen().bad === 9, "all three marked seen");
    assert.deepEqual(p.order().filter((id) => id !== "l"), before.filter((id) => id !== "l"), "read: the same order");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese, and on a phone's list, the row says the same before and after", async () => {
  const zh = await mount({ storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    await zh.ready();
    const before = { sh: zh.shown("sh"), qt: zh.shown("qt"), bad: zh.shown("bad") };
    assert.deepEqual([before.sh.pill, before.qt.pill, before.bad.ring, before.bad.meta], ["在等 shell", "等下一轮", "failed", "Turn 出错 · 5分前"]);
    assert.match(before.sh.said, /^执行者 · 在等后台 shell，位于 Core 主机$/);
    for (const id of ["sh", "bad"]) {
      await zh.open(id);
      await pause(DWELL_PAST_MS);
    }
    await waitFor(() => zh.seen().sh === 9 && zh.seen().bad === 9, "marked seen");
    assert.deepEqual({ sh: zh.shown("sh"), qt: zh.shown("qt"), bad: zh.shown("bad") }, before);
    assert.deepEqual(zh.errors, []);
  } finally {
    zh.close();
  }
  const phone = await mount({ phone: true });
  try {
    await phone.ready();
    assert.deepEqual(phone.shown("sh"), SHELL);
    await phone.open("sh");
    await pause(DWELL_PAST_MS);
    await waitFor(() => phone.seen().sh === 9, "marked seen on the phone");
    // Back to the list: the same row.
    phone.doc.querySelector(".phone-back").click();
    await waitFor(() => phone.doc.querySelector(".app.phone-list"), "the phone's list again");
    assert.deepEqual(phone.shown("sh"), SHELL, "on the phone's list, after its conversation");
    assert.deepEqual(phone.errors, []);
  } finally {
    phone.close();
  }
});
