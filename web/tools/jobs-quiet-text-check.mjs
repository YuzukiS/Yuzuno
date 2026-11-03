// T-19: the Jobs dialog's quiet text on its cards (Dev 7): a card's heading and its
// note, a detail's terms, the footnotes and the empty states must read at 4.5:1 or
// more over what is under them, in every palette, light and dark. In Chromium on a
// production build with a synthetic Jobs fixture, never written to. Each colour is
// composited as the browser paints it: the backgrounds from the text up to the first
// opaque one, over white, then the text's own colour, each drawn on a 1x1 canvas and
// read back, so any CSS colour (rgb(), color(srgb …) from color-mix(), alpha) counts
// as painted. What --text-quiet, --text-secondary and --ink would give there is
// recorded too, and every other quiet text in the dialog is measured for the record,
// unjudged. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/jobs-quiet-text-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/jobs-quiet-text");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], notShown: [], rows: [], others: [] };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const base = { agentId: "a", agent: { name: "Mori" }, machine: { name: "lab-host" }, resources: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 },
  reservation: { cpuMillis: 2100, memoryMiB: 2112, swapMiB: 0 }, cwd: "/w/web", env: {}, argv: ["/bin/sh", "-c", "npm run check"],
  requestId: "r", usage: null, outputs: [], guardGit: true, timeoutSeconds: 900, taskRef: "T-19" };
const jobs = [
  { ...base, id: "fail-1", name: "browser check", status: "failed", reserved: false, reason: "The command exited with status 1",
    createdAt: ago(3_700_000), startedAt: ago(3_650_000), finishedAt: ago(3_400_000), cursor: 39,
    snapshot: { scope: "Frozen argv/env/resources; untracked data is not frozen." },
    result: { reason: "exit-code", evidence: { systemd: { Result: "exit-code" } } } },
  { ...base, id: "run-1", name: "ui tests", status: "running", reserved: true, reason: "Running within its reservation",
    createdAt: ago(200_000), startedAt: ago(125_000), finishedAt: null, cursor: 40 },
];
// The log of a job whose oldest output was rotated away: its footnote shows.
const log = { text: "[00] check step 1 passed\n[01] check step 2 failed", offset: 400, nextOffset: 480, oldestOffset: 400, totalBytes: 480, truncated: false };
let listEmpty = false;
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (path === "/api/jobs") return route.fulfill({ json: { jobs: listEmpty ? [] : jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    const job = path.match(/^\/api\/jobs\/([^/]+)(\/logs)?$/);
    if (job && !["budget", "live"].includes(job[1])) return route.fulfill({ json: job[2] ? log : jobs.find((j) => j.id === job[1]) ?? {} });
    return route.fulfill({ json: gets[path] ?? {} });
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  const at = resolve(dist, file);
  assert.ok(at.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(at), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page: a text's contrast over what is under it, as painted. */
function pageHelpers() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const pixel = () => [...ctx.getImageData(0, 0, 1, 1).data];
  /** Alpha (0–1) of a CSS colour, as the canvas paints it on nothing. */
  const alpha = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return pixel()[3] / 255;
  };
  const luminance = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  window.__contrast = (el, color = getComputedStyle(el).color) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const background = getComputedStyle(n).backgroundColor;
      if (alpha(background) > 0) layers.push(background);
      if (alpha(background) >= 1) break;
    }
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 1, 1);
    for (const background of layers.reverse()) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 1, 1);
    }
    const under = pixel().slice(0, 3);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const text = pixel().slice(0, 3);
    const [hi, lo] = [luminance(text), luminance(under)].sort((p, q) => q - p);
    return { ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, color, text: `rgb(${text})`, under: `rgb(${under})`, layers: layers.length };
  };
  /** What a token would give the same text, over the same backgrounds. */
  window.__tokenContrast = (el, token) => {
    const was = el.style.color;
    el.style.color = `var(${token})`;
    const result = window.__contrast(el);
    el.style.color = was;
    return result;
  };
}

// The texts this change is for, by the rule that colours them (jobs.css).
const judged = [
  { name: "a card's heading", selector: ".job-detail .job-card-heading strong" },
  { name: "a card's heading note", selector: ".job-detail .job-card-heading small" },
  { name: "a detail's term", selector: ".job-detail dt" },
  { name: "a footnote", selector: ".job-detail .job-footnote" },
  { name: "the detail's empty state", selector: ".job-detail .jobs-empty" },
];
const palettes = ["garden", "graphite", "pine", "sunroom", "yuzu"];
const browser = await launchBrowser();
report.browser = browser.version();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.on("pageerror", (e) => report.errors.push(String(e).slice(0, 300)));
await page.route("**/*", serve);
await page.addInitScript(pageHelpers);
await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
await page.goto("http://yuzuno-jobs-quiet.test/");
await page.locator(".agent-row").first().waitFor();
const theme = (palette, mode) => page.evaluate(([p, t]) => { document.documentElement.dataset.palette = p; document.documentElement.dataset.theme = t; }, [palette, mode]);
const measure = (selector) => page.evaluate((s) => {
  const el = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length);
  return el && { actual: window.__contrast(el), quiet: window.__tokenContrast(el, "--text-quiet"),
    secondary: window.__tokenContrast(el, "--text-secondary"), ink: window.__tokenContrast(el, "--ink") };
}, selector);

const judge = (palette, mode, row) =>
  ok(`${palette}/${mode}: ${row.name} reads at ${row.actual.ratio}:1 (≥ 4.5; quiet would be ${row.quiet.ratio}, secondary ${row.secondary.ratio})`,
    row.actual.ratio >= 4.5, row.actual);
// A job chosen: its cards' headings and notes, its terms and its footnotes.
await page.locator(".jobs-nav").first().click();
await page.locator(".modal.jobs-dialog").waitFor();
await page.locator(".job-row", { hasText: "browser check" }).first().click();
await page.locator(".job-detail .job-footnote").first().waitFor({ timeout: 5000 });
for (const palette of palettes) {
  for (const mode of ["light", "dark"]) {
    await theme(palette, mode);
    await page.waitForTimeout(80);
    for (const kind of judged.slice(0, 4)) {
      const read = await measure(kind.selector);
      if (!read) {
        report.notShown.push(`${palette}/${mode}: ${kind.name}`);
        continue;
      }
      const row = { palette, mode, ...kind, ...read };
      report.rows.push(row);
      judge(palette, mode, row);
    }
    // Every other quiet text in the dialog, for the record.
    const others = await page.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--text-quiet)";
      document.querySelector(".modal.jobs-dialog").append(probe);
      const quiet = getComputedStyle(probe).color;
      probe.remove();
      const seen = new Set();
      return [...document.querySelectorAll(".modal.jobs-dialog *")]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).color === quiet && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        .map((el) => ({ what: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`, ratio: window.__contrast(el).ratio }))
        .filter((r) => !seen.has(r.what) && seen.add(r.what));
    });
    report.others.push({ palette, mode, others });
    if (palette === "garden" || palette === "graphite") await page.screenshot({ path: join(output, `${palette}-${mode}-job.png`) });
  }
}
// No job at all: the list's empty state and the detail's.
await page.keyboard.press("Escape");
await page.locator(".modal.jobs-dialog").waitFor({ state: "detached" });
listEmpty = true;
await page.locator(".jobs-nav").first().click();
await page.locator(".jobs-browser .jobs-empty").first().waitFor({ timeout: 5000 });
for (const palette of palettes) {
  for (const mode of ["light", "dark"]) {
    await theme(palette, mode);
    await page.waitForTimeout(60);
    for (const kind of [{ name: "the list's empty state", selector: ".jobs-browser .jobs-empty" }, judged[4]]) {
      const read = await measure(kind.selector);
      if (!read) {
        report.notShown.push(`${palette}/${mode}: ${kind.name}`);
        continue;
      }
      const row = { palette, mode, ...kind, ...read };
      report.rows.push(row);
      judge(palette, mode, row);
    }
    if (palette === "garden" && mode === "light") await page.screenshot({ path: join(output, "garden-light-empty.png") });
  }
}
await browser.close();
ok("every text was found in every palette and theme", report.notShown.length === 0, report.notShown);
ok("nothing was written", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "jobs-quiet-text-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors, notShown: report.notShown }));
process.exit(report.passed ? 0 : 1);
