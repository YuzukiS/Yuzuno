// The whole name is readable without a pointer (T-15). A long name does not
// fit the header, and the rail may have had to cut it too, so the header name
// opens when it is pressed. Sizes here are the synthetic 951x669 fixture
// derived from the screenshot and the other widths beside it, not a device.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-header-name.mjs
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
const c = await b.newContext({ viewport: { width: Number(process.env.T15_W || 951), height: Number(process.env.T15_H || 669) }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
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
// The names this Workspace actually has: several share a shape, which is the
// case a rail has to survive -- telling them apart is the acceptance, not a
// percentage.
const NAMES = [process.env.T15_NAME || "Dev 8 · Mac / iOS", "Dev 3 · public", "Dev 5 · public", "Dev 2 · public",
  "Dev 9 CI", "Dev Lead", "Dev 7", "elasticLM"];
const agents = NAMES.map((name, i) => ({ ...agent, id: i === 0 ? "a" : `a${i}`, name,
  status: ["idle", "working", "offline"][i % 3], ...(i ? { workSummary: summary } : {}) }));
await page.route("**/*", async (r) => {
  const p = new URL(r.request().url()).pathname;
  if (r.request().method() !== "GET") return r.fulfill({ json: { ok: true } });
  if (p === "/api/workspace") return r.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/w" } });
  if (/^\/api\/agents\/a\d*$/.test(p)) return r.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns } });
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

const read = () => page.evaluate(() => {
  const h1 = document.querySelector(".conversation-heading h1");
  if (!h1) return { missing: true };
  const r = document.createRange();
  r.selectNodeContents(h1);
  const target = h1.querySelector(".conversation-name") ?? h1;
  return { text: h1.textContent, textWidth: Math.ceil(r.getBoundingClientRect().width),
    shown: Math.round(h1.getBoundingClientRect().width),
    height: Math.round(h1.getBoundingClientRect().height),
    whole: target.scrollWidth <= target.clientWidth + 1,
    pressable: !!h1.querySelector(".conversation-name"),
    expanded: h1.getAttribute("data-open") !== null };
});

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const SIZES = [[951, 669, "220px rail beside the conversation"], [400, 844, "phone"], [1400, 900, "rail expanded"]];
for (const [w, h, what] of SIZES) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
  // A phone shows one thing at a time: open the conversation to see its head.
  const heading = page.locator(".conversation-heading h1");
  if (!(await heading.isVisible().catch(() => false))) {
    await page.locator(".agent-row .agent-select").first().click();
    await heading.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(500);
  }
  const shut = await read();
  let open = null;
  if (shut.pressable) {
    await page.locator(".conversation-heading h1 .conversation-name").click();
    await page.waitForTimeout(300);
    open = await read();
  }
  console.log(`\n${w}x${h} (${what})`);
  console.log(`   closed: text ${shut.textWidth}px in ${shut.shown}px, whole=${shut.whole}, pressable=${shut.pressable}`);
  if (open) console.log(`   opened: ${open.height}px tall, whole=${open.whole}, expanded=${open.expanded}`);
  check(shut.whole || shut.pressable, `${what}: a name the header cannot fit can be pressed`);
  check(shut.whole || (open && open.whole), `${what}: and pressing it shows the whole name`);
  if (open) {
    await page.locator(".conversation-heading h1 .conversation-name").click();
    await page.waitForTimeout(250);
    const again = await read();
    check(!again.expanded, `${what}: pressing again puts it back`);
  }
}
await b.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
