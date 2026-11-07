// Can a finger hit the things on a middle-sized workbench (T-15, V3)?
//
// An element's box is not its target. Several of these are extended by an
// ::after that takes the press, so a 14px bar can be a 44px target, and a
// 44px row that something lies over is not a target at all. So nothing here
// is read from a bounding box: every candidate is probed outwards from its
// middle with elementFromPoint until the press stops landing on it, and the
// region that comes back is what a finger actually has.
//
// Only what can be pressed is counted. A disabled button, one with
// pointer-events: none, one of zero size, and a decoration that happens to
// carry a role are all left out, and each exclusion is printed with its
// reason rather than quietly dropped.
//
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-touch.mjs
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
// What a finger needs. d6 asks for 40; 44 is the figure Apple publishes, and
// both are printed so the gap between them is visible rather than argued.
const WANT = Number(process.env.T15_TOUCH || 40);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "working", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent, { ...agent, id: "b", name: "Dev 3 · public" }, { ...agent, id: "c", name: "Dev Lead" }];
const resources = { cpuMillis: 2000, memoryMiB: 2048 };
const job = (i, status) => ({
  id: `j${i}`, name: `web-check-${i} 跨设备布局量测`, status, reason: null, agentId: "a",
  agent: { name: agent.name }, taskRef: "T-15", cwd: "/work", machine: { name: "owl-mac" },
  resources, reservation: resources, exclusive: false, createdAt: iso(-600_000),
  startedAt: iso(-500_000), finishedAt: status === "running" ? null : iso(-100_000 + i * 1000),
  reserved: false, cursor: i, requestId: `r${i}`,
});
const jobs = [job(0, "running"), job(1, "running"), job(2, "succeeded"), job(3, "failed"),
  job(4, "succeeded"), job(5, "succeeded"), job(6, "cancelled")];
const run = (i, status, conclusion) => ({
  id: `c${i}`, name: `CI · web (${i})`, repository: "YuzukiS/yuzuno-public", runId: `${1000 + i}`,
  attempt: "1", headSha: "f8b8a0b47f9fd0ec72a1794d1777dcd62a0bc05e", status, rawStatus: status,
  conclusion, url: "https://example.invalid/", createdAt: iso(-400_000), startedAt: iso(-390_000),
  updatedAt: iso(-10_000 + i * 1000), observedAt: iso(-5_000), cursor: i, runWatched: status === "running",
});
const ci = { runs: [run(0, "running", null), run(1, "completed", "success"), run(2, "completed", "failure")],
  subscriptions: [], hasMore: false, nextBefore: null };
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：展开态阅读区还剩多少。` }] },
      { id: `sh${i}`, type: "commandExecution", command: "npm test", status: "completed", exitCode: 0 },
      { id: `r${i}`, type: "agentMessage", text: "这一段用来占据正文宽度。".repeat(3) },
      ...(i >= 34
        ? [{ id: `sa${i}`, type: "claudeToolUse", name: "Task", status: i === 39 ? "inProgress" : "completed",
            subAgent: { taskId: `st${i}`, runId: `sr${i}`, type: "Explore",
              description: `中屏布局量测 ${i}`, prompt: "量测两侧轴占用" } }]
        : []),
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];
// 951x669 is the fixture this task is about; T15_HEIGHT shortens it, which is
// how the "row below the list's fold" branch below is exercised on a machine
// where every row happens to fit.
const context = await browser.newContext({
  viewport: { width: 951, height: Number(process.env.T15_HEIGHT || 669) },
  hasTouch: true, isMobile: true, reducedMotion: "reduce" });
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
}, [Number(process.env.T15_INSET_RIGHT || 84), process.env.T15_LANG || "en"]);
await page.route("**/*", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
  if (path === "/api/workspace")
    return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
  if (/^\/api\/agents\/[abc]$/.test(path)) return route.fulfill({ json: detail });
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
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("https://t15.test/");
await page.locator(".app").waitFor({ timeout: 10_000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);

const sweep = (want) => {
  const SELECTOR = "button, a[href], [role=button], [role=tab], [role=switch], input, select, summary, [tabindex]:not([tabindex='-1'])";
  const lands = (el, x, y) => {
    const at = document.elementFromPoint(x, y);
    return !!at && (at === el || el.contains(at));
  };
  // How far the press keeps landing on it, out from the middle. This is what
  // an ::after that takes the press adds, and what something lying over it
  // takes away.
  const reach = (el, cx, cy, dx, dy, limit) => {
    let far = 0, stopped = null;
    for (let step = 1; step <= limit; step++) {
      if (!lands(el, cx + dx * step, cy + dy * step)) {
        stopped = document.elementFromPoint(cx + dx * step, cy + dy * step);
        break;
      }
      far = step;
    }
    return { far, stopped };
  };
  const named = (el) => {
    const cls = el.className?.toString?.().trim().split(/\s+/).slice(0, 2).join(".") || "";
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  };
  // Which part of the workbench it belongs to, so a report can be acted on.
  const place = (el) => {
    const where = [[".toolbar", "toolbar"], [".rail", "rail (agent list)"],
      [".conversation-header", "conversation head"], [".composer-area", "input area"],
      [".turn-dock", "turn dock"], [".work-dock", "work dock"], [".statusbar", "bottom bar"],
      [".conversation-scroll", "conversation"], [".jump-latest", "back to latest"]];
    for (const [sel, name] of where) if (el.closest(sel)) return name;
    return "elsewhere";
  };

  const skipped = [];
  const covered = [];
  const targets = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const why =
      r.width === 0 || r.height === 0 ? "no size"
      : el.disabled ? "disabled"
      : el.getAttribute("aria-hidden") === "true" ? "hidden from everyone"
      : st.visibility === "hidden" || st.display === "none" ? "not shown"
      : Number(st.opacity) === 0 ? "transparent"
      : st.pointerEvents === "none" ? "pointer-events: none"
      : r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth ? "outside the window"
      : null;
    if (why) { skipped.push({ what: named(el), where: place(el), why }); continue; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (!lands(el, cx, cy)) {
      // Its middle belongs to something else: either something lies over it,
      // or it is a container whose own middle is a gap.
      //
      // This was a plain exclusion once, and it swallowed a real defect: at
      // 951x669 by touch with a Claude Agent the reading index entry was
      // listed here, 77px of it lying over "Model & approvals", taking none
      // of its own presses — and the check stayed green because being
      // unreachable was the reason for leaving it out. Dev 7 found it by
      // hand. A thing this task placed and cannot be pressed is the defect
      // the check is for, so it is counted now.
      const at = document.elementFromPoint(cx, cy);
      covered.push({ what: named(el), where: place(el),
        box: `${Math.round(r.width)}x${Math.round(r.height)}`,
        under: at ? named(at) : "nothing" });
      continue;
    }
    const limit = 40;
    const L = reach(el, cx, cy, -1, 0, Math.ceil(r.width / 2) + limit);
    const R = reach(el, cx, cy, 1, 0, Math.ceil(r.width / 2) + limit);
    const U = reach(el, cx, cy, 0, -1, Math.ceil(r.height / 2) + limit);
    const D = reach(el, cx, cy, 0, 1, Math.ceil(r.height / 2) + limit);
    const left = L.far, right = R.far, up = U.far, down = D.far;
    // Who stops it short of its own box, if anyone does.
    const inside = (side, far) => Math.round(far) + 1 < Math.ceil(side / 2);
    const thieves = [
      inside(r.width, left) && L.stopped ? `left: ${named(L.stopped)}` : null,
      inside(r.width, right) && R.stopped ? `right: ${named(R.stopped)}` : null,
      inside(r.height, up) && U.stopped ? `above: ${named(U.stopped)}` : null,
      inside(r.height, down) && D.stopped ? `below: ${named(D.stopped)}` : null,
    ].filter(Boolean);
    targets.push({
      what: named(el), where: place(el),
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      // The region the press actually has, through the middle.
      hit: { w: left + right + 1, h: up + down + 1,
        left: Math.round(cx - left), right: Math.round(cx + right),
        top: Math.round(cy - up), bottom: Math.round(cy + down) },
      text: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28),
      thieves,
      // What its nearest scrolling ancestor keeps out of sight. A probe stops
      // at the edge of that box, so a row scrolled half out measures short
      // without being small: it is a row to scroll to, not a target to fix.
      cut: (() => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowY;
          if (o === "visible") continue;
          const pr = p.getBoundingClientRect();
          return Math.round(Math.max(0, pr.top - r.top) + Math.max(0, r.bottom - pr.bottom));
        }
        return 0;
      })(),
    });
  }
  // Do two targets' regions take each other's presses? Neighbours that
  // overlap mean a finger aimed at one can land on the other.
  const overlaps = [];
  for (let i = 0; i < targets.length; i++)
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i].hit, b = targets[j].hit;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 1 && h > 1) overlaps.push({ a: targets[i].what, b: targets[j].what,
        where: targets[i].where, by: `${Math.round(w)}x${Math.round(h)}` });
    }
  const list = document.querySelector(".work-activity-column-list");
  const scrolls = !!list && list.scrollHeight > list.clientHeight + 1;
  return { targets, skipped, covered, overlaps, want, scrolls };
};
const audit = await page.evaluate(sweep, WANT);

const small = audit.targets.filter((t) => Math.min(t.hit.w, t.hit.h) < WANT);
// What this task answers for: the shell it placed, the Agent navigation it
// rebuilt, and the input area the acceptance names by hand ("Send, Interrupt
// and the attachment reachable by touch").
const mine = ["conversation head", "toolbar", "turn dock", "work dock", "bottom bar",
  "back to latest", "rail (agent list)", "input area"];
// Left out by name, each for a reason that is not "it is too small":
//  - a panel's resize handle is dragged, not tapped, and 40px of it would lie
//    over the rows beside it;
//  - the "…" in an Agent row is reached by holding the row on a touch screen
//    (agent-actions.css), which is why it is transparent until a pointer or
//    focus is on the row.
const DRAGGED = /panel-resize-handle/;
const minesmall = small.filter((t) => mine.includes(t.where) && !DRAGGED.test(t.what));

const byPlace = {};
for (const t of small) (byPlace[t.where] ||= []).push(t);

console.log(`\n=== every pressable thing on the workbench, 951x669 touch (synthetic fixture, not a Duo) ===`);
console.log(`counted ${audit.targets.length} pressable, left out ${audit.skipped.length}`);
console.log(`\n--- under ${WANT}px by hit test, by where it is ---`);
if (!small.length) console.log("  (none)");
for (const [where, list] of Object.entries(byPlace)) {
  console.log(`\n  ${where} — ${list.length}`);
  for (const t of list)
    console.log(`    ${t.what}  box ${t.box.w}x${t.box.h}  hit ${t.hit.w}x${t.hit.h}  "${t.text}"${t.thieves.length ? `  <- ${t.thieves.join(", ")}` : ""}`);
}
console.log(`\n--- the box understates the target (an ::after takes the press) ---`);
const grown = audit.targets.filter((t) => t.hit.w > t.box.w + 2 || t.hit.h > t.box.h + 2);
for (const t of grown.slice(0, 12))
  console.log(`  ${t.what} (${t.where})  box ${t.box.w}x${t.box.h} -> hit ${t.hit.w}x${t.hit.h}`);
console.log(`  ${grown.length} of ${audit.targets.length} reach past their own box`);
console.log(`\n--- left out, with the reason ---`);
const why = {};
for (const s of audit.skipped) (why[s.why] ||= []).push(`${s.what} (${s.where})`);
for (const [reason, list] of Object.entries(why))
  console.log(`  ${reason} — ${list.length}: ${list.slice(0, 6).join(", ")}${list.length > 6 ? ` …+${list.length - 6}` : ""}`);
console.log(`\n--- pressable, but something lies over the middle ---`);
if (!audit.covered.length) console.log("  (none)");
for (const c of audit.covered)
  console.log(`  ${c.what} (${c.where}) ${c.box} — the press lands on ${c.under}`);
{
  const ours = audit.covered.filter((c) => mine.includes(c.where));
  check(ours.length === 0,
    ours.length
      ? `nothing this task placed is covered, but ${ours.map((c) => `${c.what} under ${c.under} (${c.where})`).join(", ")}`
      : "nothing this task placed has something lying over it");
}

console.log(`\n--- under ${WANT}px but set aside, by name and reason ---`);
const aside = small.filter((t) => DRAGGED.test(t.what));
if (!aside.length) console.log("  (none)");
for (const t of aside)
  console.log(`  ${t.what} (${t.where}) hit ${t.hit.w}x${t.hit.h} — dragged, not tapped; 40px of it would lie over the rows beside it`);
console.log(`\n--- neighbours whose targets take each other's presses ---`);
if (!audit.overlaps.length) console.log("  (none)");
for (const o of audit.overlaps.slice(0, 10)) console.log(`  ${o.a} / ${o.b} (${o.where}) by ${o.by}`);

console.log("");
check(audit.overlaps.length === 0,
  audit.overlaps.length ? `no two targets take each other's presses, but ${audit.overlaps.length} pairs do` : "no two targets take each other's presses");
check(minesmall.length === 0,
  minesmall.length
    ? `everything this task placed is at least ${WANT}px, but ${minesmall.map((t) => `${t.what} ${t.hit.w}x${t.hit.h} (${t.where})`).join(", ")}`
    : `everything this task placed is at least ${WANT}px by hit test`);
// The dock hands its presses over to the Work activity column by touch, so
// that column has to be reachable itself — otherwise the work in the dock
// has no way in at all on this screen.
const entry = await page.$(".work-activity-entry");
check(!!entry, "the Work activity entry is there to open the column with");
if (entry) {
  await entry.click();
  await page.waitForTimeout(350);
  const open = await page.evaluate(sweep, WANT);
  const rows = open.targets.filter((t) => /work-activity-(row|column)/.test(t.what));
  const shortRows = rows.filter((t) => Math.min(t.hit.w, t.hit.h) < WANT);
  console.log(`\n--- with this Agent's work open in the rail ---`);
  console.log(`  ${rows.length} rows and controls in the column`);
  for (const t of rows.slice(0, 6))
    console.log(`    ${t.what}  box ${t.box.w}x${t.box.h}  hit ${t.hit.w}x${t.hit.h}  "${t.text}"`);
  check(rows.length > 0, `the column opens with the work in it (${rows.length} rows)`);
  const whole = rows.filter((t) => !t.cut);
  const below = rows.filter((t) => t.cut);
  const tooSmall = whole.filter((t) => Math.min(t.hit.w, t.hit.h) < WANT);
  check(whole.length > 0, `and some of them are wholly in view to judge (${whole.length} of ${rows.length})`);
  check(tooSmall.length === 0,
    tooSmall.length
      ? `every row wholly in view is at least ${WANT}px, but ${tooSmall.map((t) => `${t.what} ${t.hit.w}x${t.hit.h}`).join(", ")}`
      : `every row wholly in view is at least ${WANT}px by hit test, which is the way in the dock gave up`);
  if (below.length) {
    console.log(`  ${below.length} row(s) reach past the list's edge: ${below.map((t) => `${t.what} box ${t.box.h}px, ${t.cut}px out of view`).join(", ")}`);
    // Short only because the list ends there, so the list has to scroll.
    check(open.scrolls, `and the rest are reached by scrolling the list (${below.length} below the fold, list scrolls: ${open.scrolls})`);
    // And they are drawn full size, or being below the fold would excuse a
    // row that is genuinely too small once it is scrolled to.
    const drawnSmall = below.filter((t) => Math.min(t.box.w, t.box.h) < WANT);
    check(drawnSmall.length === 0,
      drawnSmall.length
        ? `each is still drawn at least ${WANT}px, but ${drawnSmall.map((t) => `${t.what} box ${t.box.w}x${t.box.h}`).join(", ")}`
        : `and each is drawn at least ${WANT}px (${below.map((t) => `${t.box.h}px`).join(", ")}), so scrolling to it gives a full target`);
  }
  check(open.overlaps.length === 0,
    open.overlaps.length ? `and no two of them take each other's presses, but ${open.overlaps.length} pairs do` : "and no two of them take each other's presses");
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);

await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
