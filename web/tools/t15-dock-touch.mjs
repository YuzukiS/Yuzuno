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
const agent = { id:"a", name:"Dev 8", status:"idle", harness:"claude", cwd:"/w", model:"m", color:"sage",
  createdAt:"", updatedAt:"", unreadCount:0, pendingCount:0, lastSeq:9, reviewedSeq:9, connectionState:"connected", goal:"", projectId:null };
const turns = Array.from({length:40},(_,i)=>({id:`t${i}`,status:"completed",startedAt:Math.floor(now/1000)-3000+i*60,
  items:[{id:`u${i}`,type:"userMessage",content:[{type:"text",text:`第 ${i+1} 轮`}]},{id:`r${i}`,type:"agentMessage",text:"回复。".repeat(30)}]}));
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".woff2":"font/woff2",".webmanifest":"application/manifest+json"};
const results = [];
for (const pointer of ["coarse", "fine"]) {
  const touch = pointer === "coarse";
  const b = await launchBrowser();
  const c = await b.newContext({ viewport: { width: 951, height: 669 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await c.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  await page.route("**/*", async (r) => {
    const p = new URL(r.request().url()).pathname;
    if (r.request().method() !== "GET") return r.fulfill({ json: { ok: true } });
    if (p === "/api/workspace") return r.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/w" } });
    if (/^\/api\/agents\/a$/.test(p)) return r.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns } });
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
  results.push({ pointer, ...(await page.evaluate(() => {
    const named = (el) => (el ? `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}` : null);
    const at = (el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };
    const stops = [...document.querySelectorAll(".turn-dock-stop")];
    const bar = stops.find((s) => !s.querySelector(".turn-dock-chip"));
    const number = stops.find((s) => s.querySelector(".turn-dock-chip"));
    const reaches = (el) => { for (let p = el; p; p = p.parentElement) if (p.classList?.contains("conversation-scroll")) return true; return false; };
    const inDock = (el) => { for (let p = el; p; p = p.parentElement) if (p.classList?.contains("turn-dock")) return true; return false; };
    return {
      barHit: named(at(bar)), barReachesConversation: reaches(at(bar)),
      numberHit: named(at(number)), numberInDock: inDock(at(number)),
      numberSize: number ? Math.round(Math.min(number.getBoundingClientRect().width, number.getBoundingClientRect().height)) : null,
    };
  })) });
  await b.close();
}

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const coarse = results.find((r) => r.pointer === "coarse");
const fine = results.find((r) => r.pointer === "fine");
for (const r of results) console.log(r.pointer.padEnd(7), JSON.stringify(r));
check(coarse.barReachesConversation, `a finger on a bar reaches the conversation, not the dock (${coarse.barHit})`);
check(coarse.numberInDock, `a finger on a numbered Turn still reaches it (${coarse.numberHit})`);
check(coarse.numberSize === 44, `and that Turn is still a 44px target (${coarse.numberSize})`);
check(!fine.barReachesConversation && fine.barHit?.includes("turn-dock"),
  `a mouse keeps the bars clickable (${fine.barHit})`);
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
