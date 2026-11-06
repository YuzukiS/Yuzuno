// The bottom bar on a workbench that has no room for it (T-15, V5).
//
// The bar holds things that are quiet most of the time — plan usage, the RAM
// jobs reserve, how the remote machines answered — and charges 27px of a
// 669px-tall screen for them. On a short or touched screen it becomes a
// panel under the toolbar instead, opened from the Core status entry. Folding
// it away must not fold away what it was saying: the entry carries the count
// of what needs a look while it is closed, and the panel has to open whole,
// inside the window, with rows a finger can hit. A screen with the room
// keeps the bar it had and shows no entry at all.
//
// The fixture is built to the user's screenshot (951x669 with an 84px system
// column); it is not a Duo, and the unreachable machine in it is a fixture
// too, there to give the entry something to count.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-status.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const machine = { id: "m1", name: "owl-linux", kind: "ssh", host: "owl.invalid", user: "yuzuki",
  lastCheck: { reachable: false, checkedAt: new Date(now - 120_000).toISOString() } };
// An Agent on that machine, because the bar only reads machines when one is in use.
const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const remoteAgent = { ...agent, id: "b", name: "Dev 3 · public", connectionState: "disconnected",
  remote: { machine: { id: "m1", name: "owl-linux" } } };
const agents = [agent, remoteAgent];
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(40) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

// Flipped by the test: the workspace read then fails, and with a snapshot
// already in hand that is what makes Core unhealthy (connection-status.ts
// `healthy: hasSnapshot && !error`).
let failWorkspace = false;

async function open({ width, height, coarse, inset, quiet }) {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: coarse, isMobile: coarse, reducedMotion: "reduce" });
  const page = await context.newPage();
  // The language is read inside the page, so it is passed in: process.env
  // there is the browser's, not this script's.
  await page.addInitScript(([right, lang]) => {
    // Enough of an EventSource for useWorkspaceEvents, and reachable from the
    // test so a workspace event can be delivered on purpose.
    window.EventSource = class {
      constructor(url) {
        this.url = url;
        this.onopen = this.onmessage = this.onerror = null;
        window.__sse = this;
      }
      close() {}
    };
    window.__event = (data) =>
      window.__sse?.onmessage?.({ data: JSON.stringify(data), lastEventId: "1" });
    if (right)
      addEventListener("DOMContentLoaded", () =>
        document.documentElement.style.setProperty("--safe-right", `${right}px`));
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang && lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, [inset || 0, process.env.T15_LANG || "en"]);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace") {
      if (failWorkspace) return route.fulfill({ status: 503, json: { error: "fixture: Core unreachable" } });
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {},
        agents: quiet ? [agent, { ...remoteAgent, connectionState: "connected" }] : agents,
        runtime: { connected: true }, defaultCwd: "/work" } });
    }
    if (/^\/api\/agents\/[ab]$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/machines")
      return route.fulfill({ json: { machines: [quiet ? { ...machine, lastCheck: { reachable: true, checkedAt: new Date(now - 120_000).toISOString() } } : machine] } });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs: [], liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: { runs: [], subscriptions: [], hasMore: false, nextBefore: null } });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (error) => errors.push(`${width}x${height}: ${error.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return { context, page };
}

// How the bar and its entry stand right now.
const look = () => ({
  entry: (() => {
    const el = document.querySelector(".core-status-entry");
    if (!el) return { there: false };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { there: true, shown: false };
    const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + r.height / 2],
      [r.right - 2, r.top + r.height / 2], [r.left + r.width / 2, r.top + 2],
      [r.left + r.width / 2, r.bottom - 2]];
    return { there: true, shown: true, w: Math.round(r.width), h: Math.round(r.height),
      min: Math.round(Math.min(r.width, r.height)),
      inToolbar: !!el.closest(".toolbar"),
      lands: hits.every(([x, y]) => { const at = document.elementFromPoint(x, y); return at === el || el.contains(at); }),
      // Everything in it, which includes the words kept for a reader only,
      // and separately what is actually on the screen.
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
      seen: (el.querySelector(".core-status-count")?.textContent || "").replace(/\s+/g, " ").trim(),
      state: (el.querySelector(".core-status-state")?.textContent || "").replace(/\s+/g, " ").trim(),
      dots: [...el.querySelectorAll(".core-status-mark")].filter((m) => {
        const mr = m.getBoundingClientRect();
        return mr.width > 0 && mr.height > 0;
      }).length,
      name: (() => {
        if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
        const walk = (node) => {
          if (node.nodeType === 3) return node.nodeValue || "";
          if (node.nodeType !== 1) return "";
          if (node.getAttribute("aria-hidden") === "true") return "";
          return [...node.childNodes].map(walk).join("");
        };
        return walk(el).replace(/\s+/g, " ").trim();
      })(),
      expanded: el.getAttribute("aria-expanded"),
      focused: document.activeElement === el };
  })(),
  bar: (() => {
    const el = document.querySelector(".statusbar");
    if (!el) return { there: false };
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return { there: true, h: Math.round(r.height), w: Math.round(r.width),
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
      position: st.position, display: st.display, open: el.hasAttribute("data-open"),
      text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 140),
      rows: [...el.querySelectorAll(".statusbar-item")].map((i) => {
        const ir = i.getBoundingClientRect();
        return { h: Math.round(ir.height), text: (i.textContent || "").trim().slice(0, 24) };
      }) };
  })(),
  // Core's own indicator in the toolbar: it stays the one that says how Core
  // is, and the entry beside it must not have grown a second dot.
  coreDot: (() => {
    const el = document.querySelector(".toolbar [data-core-status]");
    if (!el) return { there: false };
    const r = el.getBoundingClientRect();
    const label = el.querySelector(".connection-label");
    return { there: true, shown: r.width > 0 && r.height > 0,
      status: el.getAttribute("data-core-status"),
      words: label ? label.getBoundingClientRect().width > 0 : null,
      title: (el.getAttribute("title") || "").slice(0, 40) };
  })(),
  marks: document.querySelectorAll(".core-status-entry .core-status-mark").length,
  // Does everything in the toolbar still stand inside the app's content box?
  toolbar: (() => {
    const bar = document.querySelector(".toolbar");
    const app = document.querySelector(".app");
    if (!bar || !app) return { fits: false, spill: 0 };
    const st = getComputedStyle(app);
    const pad = (v) => parseFloat(v || "0") || 0;
    const ar = app.getBoundingClientRect();
    const left = ar.left + pad(st.paddingLeft);
    const right = ar.right - pad(st.paddingRight);
    let spill = 0;
    for (const el of bar.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      spill = Math.max(spill, Math.max(0, left - r.left) + Math.max(0, r.right - right));
    }
    return { fits: spill <= 1, spill: Math.round(spill) };
  })(),
  statusAttrs: document.querySelectorAll("[data-core-status]").length,
  // What the window allows, to see whether the panel opened whole inside it.
  view: { w: window.innerWidth, h: window.innerHeight },
  // What the conversation is left with.
  body: Math.round(document.querySelector(".conversation-body")?.getBoundingClientRect().height || 0),
  panelBottom: Math.round(document.querySelector(".main-panel")?.getBoundingClientRect().bottom || 0),
  appBottom: (() => {
    const el = document.querySelector(".app");
    if (!el) return 0;
    const st = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().bottom - parseFloat(st.paddingBottom || "0"));
  })(),
});

// --- the workbench: no room for a bar ---
{
  const { context, page } = await open({ width: 951, height: 669, coarse: true, inset: 84 });
  const shut = await page.evaluate(look);
  console.log("\n--- workbench 951x669 touch, panel closed ---");
  console.log(`  entry ${JSON.stringify(shut.entry)}`);
  console.log(`  bar height ${shut.bar.h} (${shut.bar.position}, ${shut.bar.display})   conversation ${shut.body}`);

  check(shut.entry.there && shut.entry.shown, "the toolbar carries the way into Core and the background work");
  check(shut.entry.inToolbar, "and it stands in the toolbar");
  check(shut.entry.min >= 40, `a finger can reach it (${shut.entry.w}x${shut.entry.h})`);
  check(shut.entry.lands, "a press in the middle or just inside an edge lands on it");
  // By the number, not by an English word: the same entry is read in Chinese.
  check(/\d/.test(shut.entry.seen), `it says how many need a look while it is shut, on the screen ("${shut.entry.seen}")`);
  check(/Core|后台/.test(shut.entry.name) && shut.entry.name.includes(shut.entry.seen),
    `and it is named by what it holds, including the count on the screen (${shut.entry.name})`);
  check(shut.bar.h === 0, `the bar itself costs the conversation nothing while it is shut (${shut.bar.h}px)`);
  // One Core indicator, not two. d6 keeps a single dot for Core, so on this
  // screen the entry carries it and the toolbar's own `.connection` is not
  // shown — it stays in the page because it is the one element carrying
  // data-core-status, which connection-ui.test.mjs counts.
  check(!shut.coreDot.shown, "the toolbar's own Core line gives way to the entry rather than sitting beside it");
  check(shut.coreDot.there && shut.statusAttrs === 1,
    `and it is still the one thing in the page saying how Core is (${shut.statusAttrs} with data-core-status)`);
  check(shut.entry.dots === 1, `the entry shows one dot, not a second one (${shut.entry.dots})`);
  // Connected, the dot alone says so: the recorded deviation.
  check(shut.entry.state === "",
    `connected, Core's state is the dot alone ("${shut.entry.state}")`);
  check(/Core|核心/.test(shut.entry.name) && /\d|nothing|没有/.test(shut.entry.name),
    `and the name carries Core's state and the count both (${shut.entry.name})`);
  check(Math.abs(shut.panelBottom - shut.appBottom) <= 1,
    `the conversation reaches the bottom of the window (${shut.panelBottom} vs ${shut.appBottom})`);

  // --- open it ---
  await page.click(".core-status-entry");
  await page.waitForTimeout(250);
  const up = await page.evaluate(look);
  console.log(`\n--- opened ---`);
  console.log(`  bar ${up.bar.w}x${up.bar.h} at ${up.bar.left},${up.bar.top} (${up.bar.position})  window ${up.view.w}x${up.view.h}`);
  console.log(`  rows: ${up.bar.rows.map((r) => `${r.text}=${r.h}`).join(" | ")}`);
  console.log(`  text: ${up.bar.text}`);

  check(up.bar.open && up.bar.h > 0, `pressing it opens the panel (${up.bar.h}px)`);
  check(up.entry.expanded === "true", "and the entry says so");
  check(up.bar.left >= 0 && up.bar.top >= 0 && up.bar.right <= up.view.w && up.bar.bottom <= up.view.h,
    `the panel opens whole, inside the window (${up.bar.left},${up.bar.top}-${up.bar.right},${up.bar.bottom})`);
  // What the bar held is in it: the machines that answered, and the RAM.
  check(/owl-linux|2 |机器|machines/i.test(up.bar.text) || up.bar.rows.length >= 2,
    `what the bar held is in the panel (${up.bar.rows.length} rows)`);
  check(/Core|核心/.test(up.bar.text), `and the panel says how Core is in words (${up.bar.rows[0]?.text || "-"})`);
  const squashed = up.bar.rows.filter((r) => r.h > 0 && r.h < 40);
  check(squashed.length === 0,
    squashed.length ? `every row is a 40px target, but ${squashed.map((r) => `${r.text}=${r.h}`).join(", ")}` : "every row in it is a 40px target");

  // --- Escape closes it and hands focus back ---
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const back = await page.evaluate(look);
  check(!back.bar.open && back.bar.h === 0, "Escape closes it");
  check(back.entry.focused, "and focus comes back to the entry it opened from");

  console.log(`\nnote (synthetic, from the screenshot — not a Duo): the conversation reads ${shut.body}px with`);
  console.log(`  the bar folded away, where the bar as a bar left it 427px and 27px went to the bar.`);
  await context.close();
}

// --- the same workbench with Core no longer answering, at three widths ---
// Spelling the state out makes the entry much wider, and a toolbar that
// cannot hold it would push a control out of the window: the same fault the
// Work activity entry had at 248px.
for (const width of [951, 820, 669]) {
  const { context, page } = await open({ width, height: 669, coarse: true, inset: 84 });
  const before = await page.evaluate(look);
  check(before.entry.state === "", "with Core answering, the entry shows no state text");
  // The read fails from here, and an Agent event asks for a fresh one
  // (App.tsx: agent.changed -> workspaceRefresh.soon(250)).
  failWorkspace = true;
  await page.evaluate(() => window.__event({ type: "agent.changed", agentId: "a" }));
  await page.waitForTimeout(1500);
  const bad = await page.evaluate(look);
  console.log(`\n--- workbench ${width}x669 touch, Core not answering ---`);
  console.log(`  entry ${bad.entry.w}x${bad.entry.h} state "${bad.entry.state}" named "${bad.entry.name}"`);
  check(bad.entry.state !== "",
    `not connected, the state is written out beside the dot rather than left to a colour ("${bad.entry.state}")`);
  check(bad.entry.min >= 40, `and it is still one 40px target (${bad.entry.w}x${bad.entry.h})`);
  check(bad.entry.dots === 1, `still one dot (${bad.entry.dots})`);
  check(/\d|nothing|没有/.test(bad.entry.name) && bad.entry.name.includes(bad.entry.state),
    `and the name still carries both Core's state and the count (${bad.entry.name})`);
  // Once, not twice: the words beside the dot and the words read aloud are
  // the same words, and a reader should hear them one time.
  const said = bad.entry.name.split(bad.entry.state).length - 1;
  check(said === 1, `and says Core's state once, not twice (${said}x in "${bad.entry.name}")`);
  // A 253px entry has to fit the toolbar it stands in: a control pushed out
  // of the window is worse than a shorter word.
  check(bad.toolbar.fits,
    `the toolbar still holds everything with the state spelled out (entry ${bad.entry.w}px, ${bad.toolbar.spill}px past its edge)`);
  // And the panel says it in words as well.
  await page.click(".core-status-entry");
  await page.waitForTimeout(250);
  const open2 = await page.evaluate(look);
  check(/Core|核心/.test(open2.bar.text),
    `the panel says how Core is in words too (${open2.bar.rows[0]?.text || "-"})`);
  failWorkspace = false;
  await context.close();
}

// --- the same workbench with nothing to report ---
{
  const { context, page } = await open({ width: 951, height: 669, coarse: true, inset: 84, quiet: true });
  const calm = await page.evaluate(look);
  console.log(`\n--- workbench 951x669 touch, nothing needs a look ---`);
  console.log(`  entry ${calm.entry.w}x${calm.entry.h} on screen "${calm.entry.seen}" named "${calm.entry.name}"`);
  check(calm.entry.shown && calm.entry.min >= 40,
    `the entry is still there to press when all is quiet (${calm.entry.w}x${calm.entry.h})`);
  check(calm.entry.lands, "and a press still lands on it");
  check(calm.entry.seen === "", `it puts no count on the screen when there is nothing to count ("${calm.entry.seen}")`);
  check(/quiet|nothing|没有/.test(calm.entry.name), `and says so when read aloud (${calm.entry.name})`);
  await page.click(".core-status-entry");
  await page.waitForTimeout(250);
  const up = await page.evaluate(look);
  check(up.bar.open && up.bar.h > 0, `and it still opens what the bar held (${up.bar.h}px)`);
  await context.close();
}

// --- a screen with the room keeps its bar ---
{
  const { context, page } = await open({ width: 1400, height: 900, coarse: false, inset: 0 });
  const desk = await page.evaluate(look);
  console.log(`\n--- desktop 1400x900 mouse ---`);
  console.log(`  bar ${desk.bar.w}x${desk.bar.h} (${desk.bar.position})  entry ${JSON.stringify(desk.entry)}`);
  check(desk.bar.h > 0 && desk.bar.position === "static", `the bar is still a bar (${desk.bar.h}px, ${desk.bar.position})`);
  check(desk.bar.w > 1000, `and still lies across the window (${desk.bar.w}px)`);
  check(!desk.entry.shown, "and the toolbar shows no entry, because there is nothing to open");
  check(desk.coreDot.words === true, "and Core keeps the words beside its dot");
  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
