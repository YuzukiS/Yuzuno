// T-115: Home's card folds in Chromium, on a production build with every API
// answered here (no Core, no GitHub). A wide window and a phone: each card's
// fold is visible and works by keyboard, the project's Repositories fold on
// their own, Seen and the fold do not set each other off. Screenshots for
// review.
//   YUZUNO_UI_DIST=<isolated build> node tools/home-fold-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/home-fold");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const section = (key, kind, title, text, extra = {}) => ({ key, kind, title, version: 1, owner: { agentId: "a", name: "Mori", state: "active" },
  updatedAt: ago(5), updatedTurnId: "t1", body: markdown(text), attachments: [], refs: {}, seen: null, history: false, ...extra });
const home = {
  generatedAt: ago(0),
  order: ["p1"],
  needsYou: [{ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "ship", title: "Ship today?", since: ago(20) }],
  projects: [{
    project: { id: "p1", name: "Yuzuno" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: 2, missing: [],
    brief: { version: 3, history: [], sections: [
      section("ship", "ask", "Ship today?", "The release is ready.", { ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "yes", label: "Ship" }, { id: "no", label: "Wait" }], freeText: true } } }),
      section("progress", "report", "Progress", "Home cards fold one by one. ".repeat(12)),
    ] },
  }],
};
const linked = { repositories: [{ id: 1, fullName: "acme/app", url: "https://github.com/acme/app", syncedAt: ago(1), error: null }], links: [] };
const activity = { observedAt: ago(1), repositories: [{ id: 1, fullName: "acme/app", url: "https://github.com/acme/app", defaultBranch: "main", observedAt: ago(1), stale: false,
  commits: [{ sha: "a".repeat(40), title: "Fold every Home card", author: "mori", at: ago(30), url: "https://github.com/acme/app/commit/aaaa" }],
  pulls: [{ number: 7, title: "Cards fold", author: "mori", draft: false, url: "https://github.com/acme/app/pull/7", ci: { state: "success" } }],
  runs: [{ id: 9, name: "CI", branch: "main", status: "completed", conclusion: "success", at: ago(9), url: "https://github.com/acme/app/actions/runs/9" }] }] };
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  for (const viewport of [{ name: "wide", width: 1280, height: 900, touch: false }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.EventSource = class { close() {} };
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    });
    page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
      assert.equal(url.hostname, "yuzuno-home-fold.test");
      if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: linked });
      if (method !== "GET") {
        report.writes.push({ viewport: viewport.name, method, path });
        return route.fulfill({ json: {} });
      }
      const json = {
        "/api/workspace": { workspace: { id: "ws-fold" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
        "/api/home": home, "/api/machine-load": machineLoad, "/api/projects/p1/repo-activity": activity,
        "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
        "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      }[path];
      if (json) return route.fulfill({ json });
      if (path.startsWith("/api/")) {
        report.unexpected.push(path);
        return route.fulfill({ json: {} });
      }
      const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
      assert.ok(file.startsWith(dist + "/"));
      await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" }[extname(file)] });
    });
    await page.goto("http://yuzuno-home-fold.test/");
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await page.locator(".home-repos .repo-activity-repo").waitFor();
    const folds = page.locator(".home-fold");
    const boxes = await folds.evaluateAll((all) => all.map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.getAttribute("aria-label"), width: Math.round(r.width), height: Math.round(r.height), shown: r.width > 0 && getComputedStyle(el).visibility !== "hidden" };
    }));
    const labels = boxes.map((b) => b.label);
    for (const card of ["Needs you", "Machines", "Repositories", "Ship today?", "Progress"]) assert.ok(labels.includes(card), `${viewport.name}: ${card} has a fold (${labels})`);
    const least = viewport.touch ? 36 : 22;
    assert.ok(boxes.filter((b) => b.shown).every((b) => b.width >= least && b.height >= least), JSON.stringify(boxes));
    check(`${viewport.name}: each card has a visible fold of at least ${least} px`, { folds: labels });
    await page.screenshot({ path: resolve(output, `${viewport.name}-expanded.png`), fullPage: true });

    // The Repositories fold, by keyboard, without folding the project.
    const repos = page.locator(".home-repos .home-fold");
    await repos.focus();
    await page.keyboard.press("Enter");
    assert.equal(await repos.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".home-repos .repo-activity").count(), 0);
    assert.equal(await page.locator(".home-panel").first().evaluate((el) => el.classList.contains("is-collapsed")), false);
    await page.keyboard.press(" ");
    assert.equal(await repos.getAttribute("aria-expanded"), "true");
    await page.locator(".home-repos .repo-activity-repo").waitFor();
    check(`${viewport.name}: Repositories fold on their own, with Enter and Space`);

    // Seen and the fold do not set each other off.
    const progress = page.locator('[data-section-key="progress"]');
    await progress.locator(".home-fold").click();
    assert.equal(await progress.locator(".home-section-body").isVisible(), false);
    assert.ok(await progress.locator(".home-seen").isVisible(), "Seen is still offered on a collapsed card");
    assert.deepEqual(report.writes.filter((w) => w.viewport === viewport.name), [], "folding wrote nothing");
    await progress.locator(".home-seen").click();
    await page.waitForTimeout(200);
    assert.equal(await progress.locator(".home-fold").getAttribute("aria-expanded"), "false", "Seen did not unfold it");
    assert.deepEqual(report.writes.filter((w) => w.viewport === viewport.name).map((w) => w.path), ["/api/projects/p1/brief/seen"]);
    check(`${viewport.name}: Seen on a collapsed card marks it seen and leaves it collapsed; the fold alone writes nothing`);
    await page.locator(".home-repos .home-fold").click();
    await page.locator(".home-machines .home-fold").click();
    await page.screenshot({ path: resolve(output, `${viewport.name}-collapsed.png`), fullPage: true });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
