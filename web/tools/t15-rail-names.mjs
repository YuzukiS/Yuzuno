// What the Agent list spends its width on (T-15). Every row reserved space
// for a "…" it was not showing, and the names paid for it: a name had 23px of
// a 129px row and showed a quarter of itself. The button now stands where the
// reader is, and is still reachable by keyboard from anywhere.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-rail-names.mjs
// The Turn dock reads, it does not take the scroll away (T-15). A finger
// landing on the thin bars between the numbers used to press a button, so the
// conversation stayed put under it. The bars show where the Turns are; the
// numbers are what a finger presses. A mouse keeps the bars clickable.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-dock-touch.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const agent = { id:"a", name:"Dev 8 · Mac / iOS", status:"idle", harness:"claude", cwd:"/w", model:"m", color:"sage",
  createdAt:"", updatedAt:"", unreadCount:0, pendingCount:0, lastSeq:9, reviewedSeq:9, connectionState:"connected", goal:"", projectId:null };
const turns = Array.from({length:40},(_,i)=>({id:`t${i}`,status:"completed",startedAt:Math.floor(now/1000)-3000+i*60,
  items:[{id:`u${i}`,type:"userMessage",content:[{type:"text",text:`第 ${i+1} 轮`}]},{id:`r${i}`,type:"agentMessage",text:"回复。".repeat(30)}]}));
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".woff2":"font/woff2",".webmanifest":"application/manifest+json"};
const b = await launchBrowser();
const c = await b.newContext({ viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
const page = await c.newPage();
// T15_LANG=zh-Hans reads the same rows in Chinese, where the status words
// are a different length.
const LANG = process.env.T15_LANG || "en";
await page.addInitScript((lang) => {
  window.EventSource = class { close() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
}, LANG);
const summary = { text: "正在量测中屏工作台两侧轴占用的宽度与高度，并记录每个状态下的实际像素", kind: "progress", source: "agent" };
const agents = [agent,
  { ...agent, id: "b", name: "Dev 3 · public", status: "working", workSummary: summary },
  { ...agent, id: "c", name: "Dev Lead", status: "offline", workSummary: summary }];
await page.route("**/*", async (r) => {
  const p = new URL(r.request().url()).pathname;
  if (r.request().method() !== "GET") return r.fulfill({ json: { ok: true } });
  if (p === "/api/workspace") return r.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/w" } });
  if (/^\/api\/agents\/[abc]$/.test(p)) return r.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns } });
  if (p === "/api/updates") return r.fulfill({ json: unmanagedUpdates });
  if (p === "/api/jobs") return r.fulfill({ json: noJobs });
  if (p === "/api/jobs/live") return r.fulfill({ json: noLiveJobs });
  if (p === "/api/jobs/budget") return r.fulfill({ json: idleJobsBudget });
  if (p === "/api/ci") return r.fulfill({ json: noCiRuns });
  if (p === "/api/reviews") return r.fulfill({ json: noReviews });
  if (p === "/api/catchup") return r.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
  if (p.startsWith("/api/")) return r.fulfill({ json: {} });
  const f = resolve(dist, `.${p === "/" ? "/index.html" : p}`);
  try { return r.fulfill({ body: await readFile(f), contentType: types[extname(f)] }); }
  catch { return r.fulfill({ status: 404, body: "" }); }
});
await page.goto("https://t15.test/");
await page.locator(".app").waitFor({ timeout: 10_000 });
await page.waitForTimeout(700);

const rows = () => page.evaluate(() => {
  const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
  return [...document.querySelectorAll(".agent-row")].map((row) => {
    const name = row.querySelector(".agent-name");
    const menu = row.querySelector(".agent-row-menu");
    const status = row.querySelector(".agent-runtime");
    const activity = row.querySelector(".agent-work-summary");
    const box = menu?.getBoundingClientRect();
    return { selected: row.classList.contains("selected"), name: w(name),
      text: name?.textContent, shows: name ? Math.round((name.clientWidth / name.scrollWidth) * 100) : null,
      menuShown: menu ? getComputedStyle(menu).opacity !== "0" : null,
      status: status?.textContent?.trim() ?? null,
      statusWhole: status ? status.scrollWidth <= status.clientWidth + 1 : null,
      activityClipped: activity ? activity.scrollWidth > activity.clientWidth + 1 : null,
      height: Math.round(row.getBoundingClientRect().height),
      menuHit: box ? Math.round(Math.min(box.width, box.height)) : null };
  });
});

console.log(`language: ${LANG}`);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const before = await rows();
for (const r of before) console.log(JSON.stringify(r));

const unselected = before.filter((r) => !r.selected);
check(unselected.every((r) => r.name >= 55), `an unselected name gets at least 55px (${unselected.map((r) => r.name).join(", ")})`);
// The acceptance is a name a reader can tell apart, not a round number: the
// shortest name here still ends 2px short of its box at this rail width, which
// is reported rather than rounded away.
check(unselected.some((r) => r.shows >= 90), `a short name is nearly whole (${unselected.map((r) => r.shows + "%").join(", ")})`);
check(unselected.every((r) => r.shows >= 55), "every name shows more than half of itself");
check(before.every((r) => r.selected === r.menuShown || !r.menuShown),
  "the \u2026 shows on the selected row and not on the others");

// Hidden is not unreachable: tabbing to it brings it back.
const reached = await page.evaluate(async () => {
  const menu = document.querySelector(".agent-row:not(.selected) .agent-row-menu");
  if (!menu) return { ok: false, why: "no menu on an unselected row" };
  menu.focus();
  await new Promise((r) => requestAnimationFrame(r));
  return { ok: document.activeElement === menu, opacity: getComputedStyle(menu).opacity,
    events: getComputedStyle(menu).pointerEvents };
});
check(reached.ok, `the \u2026 on an unselected row still takes focus (${reached.why ?? "focused"})`);
check(reached.opacity === "1" && reached.events === "auto",
  `and shows itself once focused (opacity ${reached.opacity}, pointer-events ${reached.events})`);
// Line two: the status word keeps its whole self, the activity after it gives way.
check(before.every((r) => r.statusWhole), `every status word is shown whole (${before.map((r) => r.status).join(", ")})`);
check(before.filter((r) => r.activityClipped !== null).every((r) => r.activityClipped),
  "the activity after it is what runs out of room");
check(before.every((r) => r.height >= 44), `a row is still at least 44px tall (${before.map((r) => r.height).join(", ")})`);
check(before.every((r) => r.menuHit >= 36), `the \u2026 keeps a touch target of at least 36px (${before[0].menuHit})`);

await b.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
