// What each kind of study keeps apart, and a claim's revision scope (T-17
// slice 5), in a browser: a theory proof checked by enumeration, a systems
// method's levels, an ML claim's baseline, selection and budget, robot
// episode counts that overlap, and a claim narrowed by its next version.
// Desktop light and dark, and a 390 px phone.
// - Each part shows as its author gave it, with what it cannot show (a finite
//   enumeration is no proof; iterations are not independent runs; episode
//   counts overlap). Nothing is reconciled, judged or called verified.
// - The narrowing version says it narrows; the earlier version, opened, says
//   how it was revised and still shows its own scope.
// - Words are readable (contrast at least 4.5:1); nothing scrolls sideways.
// - Reads only, and every read is one this fixture answers on purpose.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent. Screenshots and report.json go to
// YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/research-fields");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-research-fields.test";
const report = { checks: [], failures: [], errors: [], unexpected: [], writes: [], reads: [], shots: [] };
let page;
async function step(name, run) {
  try {
    const extra = (await run()) || {};
    report.checks.push({ name, ...extra });
    console.log(`PASS ${name}`);
  } catch (error) {
    const file = `fail-${report.failures.length + 1}.png`;
    report.failures.push({ name, error: error.stack || String(error), screenshot: file });
    console.log(`FAIL ${name}: ${String(error.message).split("\n")[0]}`);
    await page?.screenshot({ path: resolve(output, file) }).catch(() => {});
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

// ---------------------------------------------------------------- fixture
const at = "2026-11-02T09:00:00Z";
const mina = { kind: "agent", id: "mina", name: "Mina" };
const base = { schema: "research/1", text: "As written." };
const theory = { ...base, type: "claim", id: "bound", title: "The bound holds for every n", field: "theory", status: "supported",
  details: { result: "proof", checked: "enumeration", bound: "n ≤ 12", obligations: ["Base case", "Induction step"] } };
const systems = { ...base, type: "method", id: "timing", title: "Timing protocol", field: "systems",
  details: { machines: 1, builds: 2, processes: 10, iterations: 5, warmup: "One discarded process" } };
const ml = { ...base, type: "claim", id: "gain", title: "A gain on task A", field: "ml", status: "conditional",
  details: { baseline: "Tuned baseline, same code base", selection: "Best validation loss", budget: "20 trials each", seeds: 5, split: "Fixed 80/10/10" } };
const robot = { ...base, type: "observation", id: "episodes", title: "Real-arm episodes", field: "robotics",
  details: { planned: 20, executed: 18, completed: 12, intervened: 3, stopped: 6, excluded: 2, protocol: "Grasp protocol v1" } };
const first = { ...base, type: "claim", id: "faster", title: "Layout B is faster", field: "systems", status: "conditional", conditions: ["Machine A", "Machine B"] };
const narrowed = { ...first, title: "Layout B is faster on machine A", conditions: ["Machine A"],
  revises: { activitySeq: 8, scope: "narrows", reason: "Machine B reverses it." } };
const task = { id: "T-1", title: "Layouts and bounds (synthetic)", description: "Records of four kinds of study.",
  status: "doing", version: 3, projectId: "p1", progress: "", blocker: "", github: [], assigneeAgentId: "mina", assignee: mina,
  createdAt: at, updatedAt: at, createdBy: mina, updatedBy: mina, result: null };
const activities = [
  { seq: 1, taskId: "T-1", kind: "created", actor: mina, at },
  ...[[3, theory], [4, systems], [5, ml], [6, robot], [8, first], [9, narrowed]].map(([seq, research]) =>
    ({ seq, taskId: "T-1", kind: "comment", body: "Recorded.", actor: mina, at, research })),
];
const view = (seq) => {
  const record = activities.find((a) => a.seq === seq).research;
  return { taskId: "T-1", activitySeq: seq, version: seq === 9 ? 2 : 1, revisedBy: seq === 8 ? 9 : null, latestActivitySeq: seq === 8 ? 9 : seq,
    research: record, method: null, ...(seq === 8 ? { revision: { activitySeq: 9, scope: "narrows", reason: "Machine B reverses it." } } : {}) };
};
const agents = [mina].map((a) => ({ ...a, projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: at, updatedAt: at, status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null }));
const projects = [{ id: "p1", name: "Layouts (synthetic)", defaultDirs: {}, archivedAt: null, createdAt: at, updatedAt: at }];
const home = () => ({
  generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [],
  projects: [{ project: { id: "p1", name: "Layouts (synthetic)" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }],
});
const READS = ["task_get", "task_list", "task_research_get", "github_links", "github_refresh", "github_repositories", "delivery_get", "peers_list"];

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  if (path.startsWith("/api/collaboration/")) {
    const operation = path.split("/").at(-1);
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    if (!READS.includes(operation)) report.writes.push(`${request.method()} ${path}`);
    report.reads.push(operation);
    const answer = {
      task_list: () => ({ tasks: [task], hasMore: false, counts: { doing: 1 } }),
      task_get: () => ({ task, activities, executions: [], hasMore: false }),
      peers_list: () => ({ peers: [] }),
      delivery_get: () => ({ flow: null, settings: { harness: "codex", model: "test" } }),
      github_links: () => ({ links: [], repositories: [], refreshing: false }),
      github_refresh: () => ({ links: [], repositories: [], refreshing: false }),
      github_repositories: () => ({ links: [], repositories: [], refreshing: false }),
      task_research_get: () => view(body.activitySeq),
    }[operation];
    if (!answer) report.unexpected.push(path);
    return route.fulfill({ json: answer ? answer() : {} });
  }
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 1 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/machine-load": () => ({ at, cpu: { cores: 8, totalPct: 5, jobsPct: 0, agentsPct: null, otherPct: null },
      memory: { totalMiB: 16000, usedMiB: 4000, availableMiB: 12000, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] }),
    "/api/projects/p1/repo-activity": () => ({ observedAt: at, repositories: [] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => ({ jobs: [], liveJobs: [], hasMore: false, nextBefore: null }),
    "/api/jobs/live": () => noLiveJobs,
    "/api/jobs/runs": () => ({ runs: [], hasMore: false, nextBefore: null }),
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: at, agents: {} }),
    "/api/tasks/T-1/workspaces": () => ({ taskId: "T-1", repositories: [], workspaces: [] }),
    "/api/pr-reviews": () => ({ reviews: [], hasMore: false, nextBefore: null }),
    "/api/pr-operations": () => ({ operations: [], repositories: [], hasMore: false, nextBefore: null }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/agents/")) return route.fulfill({ json: path.endsWith("/reading") ? { handoff: null } : { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream",
  });
}

async function open(width, height, theme) {
  page = await browser.newPage({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce", hasTouch: width < 600 });
  await page.addInitScript((theme) => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 50); }
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
  }, theme);
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
}
/** Each piece of text inside `selector`, with its contrast against what is behind it. */
const contrast = (selector) =>
  page.evaluate((selector) => {
    // Any CSS colour (rgb, color(srgb …) from color-mix, oklch …) as 0–255
    // RGB and 0–1 alpha, read back from a 1×1 canvas.
    const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgb = (css) => {
      pixel.clearRect(0, 0, 1, 1);
      pixel.fillStyle = "rgba(0, 0, 0, 0)";
      pixel.fillStyle = css;
      pixel.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const behind = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color[3] > 0.95) return color;
      }
      return [255, 255, 255];
    };
    const rows = [];
    const all = selector.split(",").flatMap((part) => [part.trim(), `${part.trim()} *`]).join(", ");
    for (const el of document.querySelectorAll(all)) {
      if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) continue;
      // Text with alpha is seen blended over what is behind it.
      const under = behind(el), [r, g, b, a] = rgb(getComputedStyle(el).color);
      const fg = lum([r, g, b].map((v, i) => v * a + under[i] * (1 - a))), bg = lum(under);
      rows.push({ what: el.className || el.tagName, text: el.textContent.trim().slice(0, 40), ratio: Math.round(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) * 100) / 100 });
    }
    return rows;
  }, selector);
/** Elements inside `selector` that run past its right edge, and page-wide sideways scroll. */
const sideways = (selector) =>
  page.evaluate((selector) => {
    const scroller = document.scrollingElement;
    const boxes = [...document.querySelectorAll(selector)];
    return { page: scroller.scrollWidth > scroller.clientWidth + 1,
      inside: boxes.flatMap((box) => [...box.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > box.getBoundingClientRect().right + 1).map((el) => el.className)).slice(0, 5) };
  }, selector);
async function readable(selector) {
  const rows = await contrast(selector);
  assert.ok(rows.length > 0, `${selector} has text`);
  assert.deepEqual(rows.filter((row) => row.ratio < 4.5), [], `every word of ${selector} is readable`);
  const wide = await sideways(selector);
  assert.ok(!wide.page && wide.inside.length === 0, JSON.stringify(wide));
  return { lowestContrast: Math.min(...rows.map((row) => row.ratio)), measured: rows.length };
}

const card = (title) => page.locator(".task-research").filter({ hasText: title }).first();
for (const [width, height, theme, name] of [[1440, 960, "light", "desktop-light"], [1440, 960, "dark", "desktop-dark"], [390, 844, "light", "phone"]]) {
  await step(`${name}: each kind of study shows what it keeps apart, as given, with what it cannot show`, async () => {
    report.reads.length = 0;
    await open(width, height, theme);
    await page.getByRole("button", { name: "Tasks & messages", exact: true }).first().click();
    await page.locator('button[data-task-id="T-1"]').first().click();
    await page.locator(".task-research-details").first().waitFor();
    for (const [title, expected] of [
      ["The bound holds for every n", ["Proof · checked by enumeration up to n ≤ 12", "A finite enumeration is no general proof.", "Proof obligations", "Induction step"]],
      ["Timing protocol", ["Levels: 1 machine · 2 builds · 10 processes · 5 iterations", "Warm-up: One discarded process", "Iterations within one process are not independent runs."]],
      ["A gain on task A", ["Baseline", "Tuned baseline, same code base", "Selection", "Best validation loss", "Budget", "20 trials each", "Seeds", "Split"]],
      ["Real-arm episodes", ["Episodes: 20 planned · 18 executed · 12 completed · 3 intervened · 6 stopped · 2 excluded", "Protocol: Grasp protocol v1",
        "These counts overlap: an intervened episode may also be completed, and the denominator is the protocol's."]],
    ]) {
      const text = await card(title).locator(".task-research-details").innerText();
      for (const part of expected) assert.ok(text.includes(part), `${title}: ${part} in ${text}`);
    }
    assert.ok(!/verified/i.test(await page.locator(".collab-activity").innerText()));
    assert.ok(!report.reads.includes("task_research_get"), "nothing is read to show what was written");
    const measured = await readable(".task-research-details");
    await card("Real-arm episodes").scrollIntoViewIfNeeded();
    await card("Real-arm episodes").screenshot({ path: resolve(output, `${name}-robotics.png`) });
    await card("The bound holds for every n").screenshot({ path: resolve(output, `${name}-theory.png`) });
    report.shots.push(`${name}-robotics.png`, `${name}-theory.png`);
    return measured;
  });
  await step(`${name}: a narrowing version says so, and the earlier one keeps its own scope and says how it was revised`, async () => {
    const newer = card("Layout B is faster on machine A");
    assert.equal(await newer.locator(".task-research-revises").getAttribute("data-scope"), "narrows");
    assert.ok((await newer.locator(".task-research-revises").innerText()).includes("Narrows activity 8"));
    const earlier = page.locator(".task-research").filter({ hasText: "Machine B" }).filter({ hasNotText: "on machine A" }).first();
    assert.ok((await earlier.innerText()).includes("Machine B"), "the earlier scope as written");
    const toggle = earlier.locator(".task-research-toggle");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await until("how it was revised", async () => (await earlier.locator(".task-research-revised").count()) > 0);
    assert.ok((await earlier.locator(".task-research-revised").innerText()).includes("Activity 9 narrows this scope: Machine B reverses it."));
    const measured = await readable(".task-research-revises, .task-research-revised");
    await earlier.scrollIntoViewIfNeeded();
    await earlier.screenshot({ path: resolve(output, `${name}-revised.png`) });
    report.shots.push(`${name}-revised.png`);
    return measured;
  });
  await page.close();
}

await browser.close();
await step("reads only: nothing is written, no other host is asked, and every read is one the fixture answers", async () => {
  assert.deepEqual(report.writes, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
});
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(report.failures.length ? `FAILED ${report.failures.length}` : `PASSED ${report.checks.length}`);
process.exit(report.failures.length ? 1 : 0);
