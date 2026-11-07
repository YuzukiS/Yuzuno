// The conversation's head, with everything a Claude Agent puts in it
// (T-15, Dev 7's final d6 check, change 3).
//
// Dev 7 measured, at 951x669 by touch with an 84px inset and a Claude Agent:
// the right group's "Model & approvals" control lay over the reading index
// entry — "Where you are reading", 73x40 at x 551-624, took 0 of 9 hits, all
// landing on `.agent-settings-button`, and a press timed out so the index
// never opened. In the same row the Work activity pill broke onto two lines
// with its icon above its text, and the head showed no Agent name at all.
//
// My own earlier checks had the covered entry in front of them and filed it
// under "its middle lands on something else" as an exclusion instead of a
// defect, which is why they stayed green. The left group and the tools must
// never overlap; where they do not fit the head takes a second row.
//
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-head-fit.mjs
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
const iso = (ms) => new Date(now + ms).toISOString();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

// A Claude Agent, named as the real ones are, with the runtime and usage that
// put "Model & approvals" and its reasoning label in the head.
const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "working", harness: "claude",
  cwd: "/Users/yuzuki/yuzuno-public-worktrees/t15-layout", model: "claude-opus-5",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
  settings: { reasoningEffort: "high" },
};
const agents = [agent, { ...agent, id: "b", name: "Dev 3 · public" }];
const resources = { cpuMillis: 2000, memoryMiB: 2048 };
const job = (i, status) => ({
  id: `j${i}`, name: `web-check-${i} 跨设备布局量测`, status, reason: null, agentId: "a",
  agent: { name: agent.name }, taskRef: "T-15", cwd: "/work", machine: { name: "owl-mac" },
  resources, reservation: resources, exclusive: false, createdAt: iso(-600_000),
  startedAt: iso(-500_000), finishedAt: status === "running" ? null : iso(-100_000 + i * 1000),
  reserved: false, cursor: i, requestId: `r${i}`,
});
const jobs = [job(0, "running"), job(1, "failed"), job(2, "succeeded")];
const run = (i, status, conclusion) => ({
  id: `c${i}`, name: `CI · web (${i})`, repository: "YuzukiS/yuzuno-public", runId: `${1000 + i}`,
  attempt: "1", headSha: "f8b8a0b47f9fd0ec72a1794d1777dcd62a0bc05e", status, rawStatus: status,
  conclusion, url: "https://example.invalid/", createdAt: iso(-400_000), startedAt: iso(-390_000),
  updatedAt: iso(-10_000 + i * 1000), observedAt: iso(-5_000), cursor: i, runWatched: status === "running",
});
const ci = { runs: [run(0, "running", null), run(1, "completed", "failure")],
  subscriptions: [], hasMore: false, nextBefore: null };
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  // What makes the head's right group as wide as it really is.
  claudeRuntime: { permissionMode: "acceptEdits", model: "claude-opus-5", account: "yuzuki" },
  contextUsage: { usedTokens: 120_000, windowTokens: 1_000_000 },
  turns: Array.from({ length: 20 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：问题` }] },
      { id: `r${i}`, type: "agentMessage", text: `第 ${i + 1} 轮的回答。`.repeat(10) },
      ...(i >= 18
        ? [{ id: `sa${i}`, type: "claudeToolUse", name: "Task", status: "completed",
            subAgent: { taskId: `st${i}`, runId: `sr${i}`, type: "Explore",
              description: `中屏布局量测 ${i}`, prompt: "量测" } }]
        : []),
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

async function open({ width, height, inset }) {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([right, lang]) => {
    window.EventSource = class { close() {} };
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
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/[ab]$/.test(path)) return route.fulfill({ json: detail });
    if (/^\/api\/agents\/[ab]\/models$/.test(path))
      return route.fulfill({ json: { context: { requestedWindowTokens: null, settingsSubmitted: false, observedStale: false } } });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: ci });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(`${width}x${height}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return { context, page };
}

const look = () => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left),
      right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  };
  const overlap = (a, b) => {
    if (!a || !b) return 0;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? Math.round(w) : 0;
  };
  const hits = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { there: false };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { there: true, shown: false };
    const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + r.height / 2],
      [r.right - 2, r.top + r.height / 2], [r.left + r.width / 2, r.top + 2],
      [r.left + r.width / 2, r.bottom - 2]];
    let landed = 0, onto = new Set();
    for (const [x, y] of points) {
      const at = document.elementFromPoint(x, y);
      if (at === el || el.contains(at)) landed++;
      else onto.add(`${at?.tagName.toLowerCase()}.${(at?.className || "").toString().split(/\s+/)[0]}`);
    }
    return { there: true, shown: true, w: Math.round(r.width), h: Math.round(r.height),
      landed, of: points.length, onto: [...onto].join(",") };
  };
  const title = box(".conversation-header .conversation-title");
  const actions = box(".conversation-header .conversation-actions");
  // Each thing the left group draws, against the tools' box. Comparing the
  // title's box with the tools' box misses this entirely: the title's box
  // stays where it is and its children overflow out of it.
  const spill = [...document.querySelectorAll(".conversation-heading > *")]
    .map((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { what: el.tagName.toLowerCase() + "." + (el.className || "").toString().split(/\s+/)[0],
        left: Math.round(r.left), right: Math.round(r.right),
        pastTitle: title ? Math.round(Math.max(0, r.right - title.right)) : 0,
        ontoTools: actions ? Math.round(Math.max(0, Math.min(r.right, actions.right) - Math.max(r.left, actions.left))) : 0 };
    })
    .filter(Boolean);
  const pill = document.querySelector(".work-activity-entry");
  // Its height is no test: a touch target is 40px tall on purpose. Two lines
  // means the icon sits above the text, so their rows do not meet.
  const pillRows = (() => {
    if (!pill) return null;
    const icon = pill.querySelector("svg");
    const text = pill.querySelector(".work-activity-counts");
    if (!icon || !text) return { oneRow: null };
    const a = icon.getBoundingClientRect(), b = text.getBoundingClientRect();
    return { oneRow: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0,
      icon: `${Math.round(a.top)}-${Math.round(a.bottom)}`, text: `${Math.round(b.top)}-${Math.round(b.bottom)}` };
  })();
  const name = document.querySelector(".conversation-heading h1");
  const nameSpan = document.querySelector(".conversation-heading .conversation-name");
  return {
    header: box(".conversation-header"),
    title, actions,
    overlap: overlap(title, actions),
    index: hits(".conversation-index-entry"),
    work: hits(".work-activity-entry"),
    // One line or two: a pill whose icon sits above its text is taller than
    // its own line box by more than its padding.
    pill: pillRows,
    spill,
    name: name ? { w: Math.round(name.getBoundingClientRect().width),
      text: (nameSpan?.textContent || name.textContent || "").trim().slice(0, 28) } : null,
  };
};

for (const width of [951, 820]) {
  const { context, page } = await open({ width, height: 669, inset: 84 });
  const m = await page.evaluate(look);
  console.log(`\n--- ${width}x669 touch +84, Claude Agent ---`);
  console.log(`  head ${m.header?.w}x${m.header?.h}  title ${m.title?.left}-${m.title?.right}  tools ${m.actions?.left}-${m.actions?.right}  box overlap ${m.overlap}px`);
  for (const sp of m.spill)
    console.log(`    ${sp.what.padEnd(34)} ${sp.left}-${sp.right}${sp.pastTitle ? `  ${sp.pastTitle}px past the title` : ""}${sp.ontoTools ? `  ${sp.ontoTools}px onto the tools` : ""}`);
  console.log(`  index entry ${JSON.stringify(m.index)}`);
  console.log(`  work pill   ${JSON.stringify(m.work)}  box ${JSON.stringify(m.pill)}`);
  console.log(`  name ${JSON.stringify(m.name)}`);

  // 1. The left group and the tools must not overlap at all.
  const onTools = m.spill.filter((sp) => sp.ontoTools > 0);
  check(m.overlap === 0 && onTools.length === 0,
    onTools.length
      ? `nothing the left group draws reaches the tools, but ${onTools.map((sp) => `${sp.what} by ${sp.ontoTools}px`).join(", ")} (${width})`
      : `nothing the left group draws reaches the tools (${width})`);
  // 2. The reading index entry takes its own presses, at the middle and each edge.
  check(m.index.there && m.index.shown, `the reading index entry is shown (${width})`);
  check(m.index.landed === m.index.of,
    `and takes every press at its middle and edges (${m.index.landed}/${m.index.of}${m.index.onto ? `, losing them to ${m.index.onto}` : ""})`);
  // 3. The pill stays on one line.
  check(m.pill?.oneRow === true,
    `the Work activity pill keeps its icon beside its text, not above it (icon ${m.pill?.icon}, text ${m.pill?.text})`);
  // 4. The Agent's name is readable, or there is something to press to read it.
  check(!!m.name && m.name.w >= 40 && m.name.text.length > 0,
    `the Agent's name is in the head and wide enough to press (${m.name?.w}px, "${m.name?.text}")`);

  // 5. And the index actually opens.
  if (m.index.landed === m.index.of) {
    await page.click(".conversation-index-entry", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    const opened = await page.evaluate(() =>
      !!document.querySelector(".rail-turn-index, .turn-index, [data-turn-index]"));
    check(opened, `pressing it opens the index (${width})`);
  } else {
    check(false, `pressing it opens the index (not tried at ${width}: the press does not reach it)`);
  }
  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
