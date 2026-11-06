// Does the shell meet acceptance item 6 as it stands? (T-15)
//
// Item 6 asks that the theme reach the real html/body/background and meet the
// system bars, that the safe areas be kept, and that theme-color agree with
// what the user chose — without inventing a new manifest scheme. None of that
// was this task's work, so this reads the head as it is and says plainly what
// holds and what does not, rather than claiming item 6 either way.
//
// What is read, in light, dark and a palette the user picked:
//  - the one <meta name="theme-color">, which appearance.ts rewrites from the
//    live --cream. A pair of media-based metas would be the other way to do
//    it, and would ignore an in-app override; this one cannot.
//  - color-scheme on the root, which is what makes the browser's own
//    furniture (scrollbars, form controls) match the theme.
//  - what is actually painted outside `.app`: html and body carry no
//    background of their own, so anything not covered by `.app` shows the
//    browser's default. `.app` is 100dvh and holds the safe areas as its own
//    padding, so normally nothing is uncovered -- except while the keyboard
//    is up, when the shell is shorter than the layout viewport on purpose.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-theme.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const note = (what) => console.log(`NOTE ${what}`);

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent];
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 6 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 600 + i * 60,
    items: [{ id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(20) }],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

async function read({ theme, palette, inset }) {
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([look, right]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify(look));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    if (right)
      addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.setProperty("--safe-right", `${right}px`);
        document.documentElement.style.setProperty("--safe-bottom", "34px");
      });
  }, [{ theme, fontSize: 16, palette }, inset || 0]);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/a$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: noJobs });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(`${theme}/${palette}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  const out = await page.evaluate(() => {
    const root = document.documentElement;
    const rs = getComputedStyle(root);
    const bs = getComputedStyle(document.body);
    const app = document.querySelector(".app");
    const as = getComputedStyle(app);
    const metas = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({
      content: (m.getAttribute("content") || "").trim(),
      media: m.getAttribute("media") || null,
    }));
    const px = (v) => Math.round(parseFloat(v || "0") || 0);
    const ar = app.getBoundingClientRect();
    return {
      dataTheme: root.getAttribute("data-theme"),
      dataPalette: root.getAttribute("data-palette"),
      colorScheme: rs.colorScheme,
      cream: rs.getPropertyValue("--cream").trim(),
      paper: rs.getPropertyValue("--paper").trim(),
      metas,
      htmlBg: rs.backgroundColor,
      bodyBg: bs.backgroundColor,
      appBg: as.backgroundColor,
      // The safe areas, and whether anything above `.app` counts them again.
      safe: { top: rs.getPropertyValue("--safe-top").trim(), right: rs.getPropertyValue("--safe-right").trim(),
        bottom: rs.getPropertyValue("--safe-bottom").trim(), left: rs.getPropertyValue("--safe-left").trim() },
      appPad: { top: px(as.paddingTop), right: px(as.paddingRight), bottom: px(as.paddingBottom), left: px(as.paddingLeft) },
      bodyPad: { top: px(bs.paddingTop), right: px(bs.paddingRight), bottom: px(bs.paddingBottom), left: px(bs.paddingLeft) },
      bodyMargin: px(bs.marginTop) + px(bs.marginRight) + px(bs.marginBottom) + px(bs.marginLeft),
      // Does the shell cover the window it is in?
      covers: { h: Math.round(ar.height), w: Math.round(ar.width), vh: window.innerHeight, vw: window.innerWidth },
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href") || null,
    };
  });
  await context.close();
  return out;
}

const looks = [
  { name: "light · garden (default)", theme: "light", palette: "garden" },
  { name: "dark · garden", theme: "dark", palette: "garden" },
  { name: "light · sunroom (a palette the user picked)", theme: "light", palette: "sunroom" },
  { name: "dark · pine (both overridden)", theme: "dark", palette: "pine" },
];
const seen = [];
for (const look of looks) {
  const m = await read({ ...look, inset: 84 });
  seen.push({ ...look, ...m });
  console.log(`\n--- ${look.name} ---`);
  console.log(`  data-theme=${m.dataTheme} data-palette=${m.dataPalette} color-scheme=${m.colorScheme}`);
  console.log(`  --cream ${m.cream}  --paper ${m.paper}`);
  console.log(`  theme-color metas: ${JSON.stringify(m.metas)}`);
  console.log(`  background: html ${m.htmlBg} · body ${m.bodyBg} · .app ${m.appBg}`);
  console.log(`  safe ${JSON.stringify(m.safe)} -> .app padding ${JSON.stringify(m.appPad)}, body padding ${JSON.stringify(m.bodyPad)} margin ${m.bodyMargin}`);
  console.log(`  .app ${m.covers.w}x${m.covers.h} in ${m.covers.vw}x${m.covers.vh}   manifest ${m.manifest}`);
}
console.log("");

// 1. theme-color follows the live theme AND the user's palette, which is what
//    "多theme-color与用户覆盖一致" is about: one meta that tracks the choice,
//    rather than a pair keyed to prefers-color-scheme that cannot see it.
check(seen.every((s) => s.metas.length === 1),
  `one theme-color meta, not a set keyed to the system's scheme (${[...new Set(seen.map((s) => s.metas.length))].join("/")})`);
check(seen.every((s) => s.metas[0]?.content && s.metas[0].content === s.cream),
  `and it carries the live --cream in every look (${seen.map((s) => s.metas[0]?.content).join(", ")})`);
const contents = new Set(seen.map((s) => s.metas[0]?.content));
check(contents.size > 1, `so a user's own theme and palette change it (${contents.size} distinct values over ${seen.length} looks)`);
check(seen.every((s) => !s.metas[0]?.media), "and none of them is gated on a media query the app cannot override");

// 2. color-scheme tells the browser which furniture to draw.
check(seen.every((s) => s.colorScheme === (s.theme === "dark" ? "dark" : "light")),
  `color-scheme follows the theme (${seen.map((s) => `${s.theme}=${s.colorScheme}`).join(", ")})`);

// 3. The safe areas are held once, by `.app`, and not again above it.
check(seen.every((s) => s.appPad.right === 84 && s.appPad.bottom === 34),
  `the safe areas reach the shell as its own padding (right ${seen[0].appPad.right}, bottom ${seen[0].appPad.bottom})`);
check(seen.every((s) => Object.values(s.bodyPad).every((v) => v === 0) && s.bodyMargin === 0),
  "and nothing above it counts them a second time");

// 4. What is painted where the shell does not reach.
const uncovered = seen.filter((s) => s.covers.h < s.covers.vh || s.covers.w < s.covers.vw);
check(uncovered.length === 0,
  uncovered.length ? `the shell covers the window, but ${uncovered.length} look(s) leave a gap` : "the shell covers the whole window, so its own background is what shows");
note(`body carries no background of its own (${seen[0].bodyBg}); the root's does the painting.`);

// --- what does not hold: the root's background is a fixed light colour ---
// This is reported, not enforced: closing it is not this task's call (the
// Lead decides), and a red check would stop the evidence Job over something
// that is not a regression from this branch.
const sameAsTheme = seen.filter((s) => {
  const hex = s.cream.replace("#", "").toLowerCase();
  const rgb = s.htmlBg.match(/\d+/g)?.map(Number) ?? [];
  const asHex = rgb.slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("");
  return hex.length === 6 && asHex === hex;
});
console.log(`\n--- item 6: what does NOT hold at this head ---`);
if (sameAsTheme.length === seen.length) {
  console.log("  (nothing: the root's background follows the theme in every look)");
} else {
  console.log(`  GAP: the root's background is a fixed light colour and does not follow the theme.`);
  console.log(`       styles.css:10 \`:root { background: #f7f7f2 }\`, while --cream and --paper are`);
  console.log(`       redefined per theme and palette (appearance.css, palettes.css). Measured:`);
  for (const s of seen)
    console.log(`         ${s.name.padEnd(42)} html ${s.htmlBg.padEnd(22)} --cream ${s.cream}`);
  console.log(`       It is invisible while the shell covers the window, which it does at every size`);
  console.log(`       read here. It is not invisible where the shell does not reach: an overscroll or`);
  console.log(`       rubber-band area, and the strip left while the on-screen keyboard shortens the`);
  console.log(`       shell on purpose (:root[data-keyboard]) — a light flash under a dark theme.`);
  console.log(`       Not a regression from this branch: the line predates it.`);
  console.log(`       One-line candidate: background: var(--cream) at styles.css:10, which the theme`);
  console.log(`       and palette overrides then follow. NOT applied here — the Lead's decision.`);
  console.log(`       A real device is the only way to see the overscroll case; this Mac cannot.`);
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
