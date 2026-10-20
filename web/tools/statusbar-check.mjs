// The bottom bar (T-82): background work and resources, nothing the toolbar,
// rail or conversation already shows.
// - Reviews and CI runs in progress open Jobs at their source.
// - A job, review or run that ends while the page is open is told once.
// - Job RAM reserved against its budget, and what the host has free.
// - Claude plan usage as last reported, kept while another Agent is open.
// - The open Codex Agent's plan usage from its own connection: newer reports
//   only, "last report" after five minutes, a passed reset waits, unknown is
//   not 0, a stream reset reads again; gone with another Agent open.
// - Remote machines, with those unreachable at their last check or with a
//   disconnected Agent; opens Machines.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/statusbar");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const base = {
  cwd: "/fixture",
  model: "test-model",
  settings: {},
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
};
const devbox = { id: "devbox", name: "devbox", target: "devbox", codex: "codex", defaultCwd: "/home/me" };
const agents = [
  { ...base, id: "a", name: "Mori", status: "idle", harness: "codex", pendingCount: 1, connectionState: "connected" },
  { ...base, id: "c", name: "Kumo", status: "idle", harness: "claude", model: "sonnet" },
  { ...base, id: "r", name: "Tora", status: "offline", harness: "codex", remote: { machine: devbox }, connectionState: "disconnected" },
];
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const plan = {
  status: "allowed",
  unifiedWindows: {
    five_hour: { utilization: 0.42, resetsAt: Math.round(now / 1000) + 3600 },
    seven_day: { utilization: 0.18, resetsAt: Math.round(now / 1000) + 3 * 86400 },
  },
};
const detail = (agent) => ({
  agent,
  pending: [],
  messageReceipts: [],
  artifacts: [],
  claudeRuntime:
    agent.harness === "claude"
      ? { account: { email: "me@example.com", subscriptionType: "max" }, rateLimits: plan, rateLimitsAt: iso(now - 60_000) }
      : null,
  turns: [
    {
      id: `${agent.id}-t1`,
      status: "completed",
      items: [
        { id: `${agent.id}-u`, type: "userMessage", content: [{ type: "text", text: "看一下状态" }] },
        { id: `${agent.id}-r`, type: "agentMessage", text: `${agent.name} 在这里。` },
      ],
    },
  ],
});
// A Codex account report as Core gives it: a 5 h and a 7 d window.
const codexUsage = (revision, primary, secondary) => {
  const at = iso(Date.now());
  const window = (mins, resetsIn, extra) => ({ windowDurationMins: mins, resetsAt: Math.round(Date.now() / 1000) + resetsIn, observedAt: at, ...extra });
  return {
    revision,
    status: "ready",
    account: { type: "chatgpt", label: "me@work.example", planType: "pro" },
    accountId: "acct-1",
    source: { generation: "1", label: "Core host", machineId: null, runtimeId: null },
    checkedAt: at,
    observedAt: at,
    ordinaryUsageAllowed: true,
    error: null,
    buckets: [
      { limitId: "codex", limitName: null, planType: "pro", observedAt: at, credits: null, primary: window(300, 7200, primary), secondary: window(10080, 3 * 86400, secondary) },
    ],
  };
};
const codexReads = [];
// What Core reports, changed step by step below.
const f = {
  codex: codexUsage(5, { usedPercent: 23 }, { usedPercent: 41 }),
  budget: {
    machine: { name: "Core host", memoryAvailableMiB: 26000, scope: "fixture" },
    budget: { cpuMillis: 8000, memoryMiB: 16384, swapMiB: 0 },
    reserved: { cpuMillis: 2000, memoryMiB: 3072, swapMiB: 0 },
    activeCount: 1,
    queuedCount: 1,
  },
  jobs: [],
  reviews: [
    {
      id: "rv1", taskId: "task-1", taskRef: "T-82", taskTitle: "Fixture", linkId: "1:pull:63", repository: "me/repo",
      number: 63, url: null, round: 1, status: "running", phase: "Reviewing", conclusion: null,
      requestedHarness: "codex", requestedModel: null, actualHarness: null, actualModel: null,
      baseSha: null, headSha: null, mergeBaseSha: null, createdAt: iso(now - 120_000), finishedAt: null,
    },
  ],
  runs: [
    {
      id: "github:1:900:1", name: "CI", repository: "me/repo", runId: "900", attempt: "1", headSha: "abc",
      status: "running", rawStatus: "in_progress", conclusion: null, url: "https://github.com/me/repo/actions/runs/900",
      createdAt: iso(now - 300_000), startedAt: iso(now - 300_000), updatedAt: iso(now - 300_000), observedAt: iso(now - 10_000), cursor: 1,
    },
  ],
  machines: [
    { id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" },
    { ...devbox, kind: "ssh", lastCheck: { machineId: "devbox", startedAt: iso(now - 7_200_000), checkedAt: iso(now - 7_200_000), durationMs: 900, reachable: true, harnesses: [] } },
  ],
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    // Live updates open, as with a healthy Core; nothing more arrives.
    window.EventSource = class {
      constructor() {
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    if (!localStorage.getItem("statusbar-fixture")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
      localStorage.setItem("yuzuno.selected", JSON.stringify("c"));
      localStorage.setItem("statusbar-fixture", "seeded");
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-statusbar.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    const scoped = url.searchParams.has("agentId") || url.searchParams.has("taskId");
    // A run opened from the bar: its report, as Core gives it.
    const run = f.runs.find((r) => url.pathname === `/api/ci/${encodeURIComponent(r.id)}`);
    if (run)
      return route.fulfill({
        json: { run, details: { jobs: [], page: 1, nextPage: null, hasMore: false, pageLimitReached: false, observedAt: run.observedAt }, error: null },
      });
    const usageOf = url.pathname.match(/^\/api\/agents\/([^/]+)\/codex\/usage$/);
    if (usageOf) {
      codexReads.push(usageOf[1]);
      return route.fulfill({ json: f.codex });
    }
    const agent = agents.find((a) => url.pathname === `/api/agents/${a.id}`);
    const json = agent
      ? detail(agent)
      : {
          "/api/workspace": { agents, runtime: { connected: true }, defaultCwd: "/fixture" },
          "/api/updates": unmanagedUpdates,
          "/api/jobs/budget": f.budget,
          "/api/jobs/live": noLiveJobs,
          "/api/jobs": { jobs: scoped ? [] : f.jobs, liveJobs: [], hasMore: false, nextBefore: null },
          "/api/reviews": { reviews: scoped ? [] : f.reviews, hasMore: false, nextBefore: null },
          "/api/ci": { runs: scoped ? [] : f.runs, subscriptions: [], hasMore: false, nextBefore: null },
          "/api/machines": { machines: f.machines },
          "/api/backlog": { observedAt: iso(Date.now()), agents: {} },
          "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
        }[url.pathname];
    if (json) return route.fulfill({ json });
    if (url.pathname.startsWith("/api/")) {
      report.unexpected.push(url.pathname);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(dist + "/"));
    return route.fulfill({
      body: await readFile(file),
      contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)],
    });
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  const bar = page.locator(".statusbar");
  const shot = async (name) => {
    await bar.screenshot({ path: resolve(output, name), animations: "disabled" });
    report.screenshots.push(name);
  };
  const refresh = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh")));
  const fits = () =>
    bar.evaluate((el) => ({
      overflow: el.scrollWidth > el.clientWidth + 1,
      height: Math.round(el.getBoundingClientRect().height),
      items: [...el.querySelectorAll(".statusbar-item")].map((item) => {
        const box = item.getBoundingClientRect();
        // The left side gives way first: an item cut off there is lost.
        const start = item.closest(".statusbar-start")?.getBoundingClientRect();
        return { text: item.textContent, visible: box.width > 0, inside: box.left >= 0 && box.right <= innerWidth && (!start || box.right <= start.right + 1) };
      }),
    }));

  await page.goto("http://yuzuno-statusbar.test/");
  await bar.getByRole("button", { name: /review running/ }).waitFor();

  // Nothing repeated from the toolbar, rail or brand; health only when wrong.
  const text = await bar.innerText();
  for (const repeated of [/Core connected/, /active agents/, /pending/, /Yuzuno/, /Live updates/])
    assert.doesNotMatch(text, repeated, text);
  check("no Core connected, agent or pending counts, brand, or healthy live-update note", { text });

  // Background work, each opening Jobs at its source.
  await bar.getByRole("button", { name: "1 CI run" }).waitFor();
  const jobs = page.getByRole("dialog", { name: "Jobs" });
  const tab = (name) => jobs.getByRole("tab", { name, exact: true });
  await bar.getByRole("button", { name: "1 review running" }).click();
  await jobs.waitFor();
  assert.equal(await tab("Reviews").getAttribute("aria-selected"), "true");
  await page.keyboard.press("Escape");
  await jobs.waitFor({ state: "detached" });
  await bar.getByRole("button", { name: "1 CI run" }).click();
  await jobs.waitFor();
  assert.equal(await tab("GitHub Actions").getAttribute("aria-selected"), "true");
  await page.keyboard.press("Escape");
  await jobs.waitFor({ state: "detached" });
  check("reviews and CI runs in progress, each opening Jobs at its source");

  // Job RAM reserved against its budget, and the host's free memory.
  const meter = bar.getByRole("meter", { name: "Job RAM reserved" });
  assert.equal(await meter.getAttribute("aria-valuenow"), "19");
  assert.match(await bar.locator(".statusbar-memory").innerText(), /RAM\s*3\.0 GiB \/ 16\.0 GiB · 25\.4 GiB free/);
  check("job RAM reserved of its budget and the host's free memory");

  // Claude plan usage from Kumo's last report, kept with Mori open.
  const claude = bar.locator(".statusbar-item", { hasText: "Claude" });
  assert.equal((await claude.innerText()).trim(), "Claude 5h 42% · 7d 18%");
  // Whose plan it is stays with the report.
  assert.match(await claude.getAttribute("title"), /for me@example\.com · max[\s\S]*Reported /);
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Mori" }).waitFor();
  assert.equal((await claude.innerText()).trim(), "Claude 5h 42% · 7d 18%");
  assert.match(await claude.getAttribute("title"), /for me@example\.com · max/);
  check("Claude plan usage as last reported, with its account, kept while a Codex Agent is open");

  // Codex plan usage: Mori's own report, from Mori's native connection.
  const codex = bar.locator(".statusbar-codex");
  const codexText = async () => (await codex.innerText()).trim();
  const codexEvent = (detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent("yuzuno:codex-usage", { detail: d })), detail);
  const codexShows = (text) => page.waitForFunction((t) => document.querySelector(".statusbar-codex")?.textContent.trim() === t, text);
  await codexShows("Codex 5h 23% · 7d 41%");
  assert.match(await codex.getAttribute("title"), /^Codex plan usage for me@work\.example · pro, from Core host\n/);
  assert.equal((await claude.innerText()).trim(), "Claude 5h 42% · 7d 18%", "Claude's report stays its own");
  // A newer report shows; another Agent's, or an older one, does not.
  await codexEvent({ agentId: "a", usage: codexUsage(6, { usedPercent: 100 }, { usedPercent: 44 }) });
  await codexShows("Codex 5h 100% · 7d 44%");
  assert.match(await codex.getAttribute("class"), /is-failed/);
  await codexEvent({ agentId: "r", usage: codexUsage(9, { usedPercent: 1 }, { usedPercent: 1 }) });
  await codexEvent({ agentId: "a", usage: codexUsage(4, { usedPercent: 2 }, { usedPercent: 2 }) });
  await page.waitForTimeout(150);
  assert.equal(await codexText(), "Codex 5h 100% · 7d 44%");
  // Older than five minutes: the last report, and said so.
  const old = iso(Date.now() - 10 * 60_000);
  await codexEvent({ agentId: "a", usage: codexUsage(7, { usedPercent: 30, observedAt: old }, { usedPercent: 50, observedAt: old }) });
  await codexShows("Codex 5h 30% · 7d 50% · last report");
  assert.match(await codex.getAttribute("class"), /is-stale/);
  assert.doesNotMatch(await codex.getAttribute("class"), /is-failed/);
  // A passed reset waits for news; an unknown share is not 0.
  await codexEvent({ agentId: "a", usage: codexUsage(8, { usedPercent: 90, resetsAt: Math.round(Date.now() / 1000) - 60 }, { usedPercent: null }) });
  await codexShows("Codex 5h waiting · 7d unknown");
  // A stream reset clears it and reads again, once, even with the details
  // panel reading too; a restarted Core's lower revision is accepted.
  const before = codexReads.length;
  f.codex = codexUsage(1, { usedPercent: 12 }, { usedPercent: 41 });
  await codexEvent(null);
  await codexShows("Codex 5h 12% · 7d 41%");
  assert.equal(codexReads.length - before, 1, JSON.stringify(codexReads));
  // Another Agent open: no Codex usage, and none read for a Claude or a
  // disconnected Codex Agent; Mori again reads Mori's.
  await page.getByRole("button", { name: "Open Kumo", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Kumo" }).waitFor();
  await codex.waitFor({ state: "detached" });
  assert.equal((await claude.innerText()).trim(), "Claude 5h 42% · 7d 18%");
  await page.getByRole("button", { name: "Open Tora", exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal(await codex.count(), 0);
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await codexShows("Codex 5h 12% · 7d 41%");
  assert.ok(codexReads.every((id) => id === "a"), JSON.stringify(codexReads));
  report.codexReads = codexReads;
  check("Codex plan usage from the open Agent's own reports: newer only, last report, waiting, unknown not 0; gone for other Agents");

  // Remote machines: devbox was reachable at its check, but Tora is
  // disconnected there.
  const machines = bar.getByRole("button", { name: /machine/ });
  assert.equal((await machines.innerText()).trim(), "1 machine · 1 unreachable");
  assert.match(await machines.getAttribute("title"), /devbox: reachable at its last check.*1 Agent disconnected/s);
  await machines.click();
  const machinesPage = page.getByRole("dialog", { name: "Machines" });
  await machinesPage.waitFor();
  await page.keyboard.press("Escape");
  await machinesPage.waitFor({ state: "detached" });
  check("remote machines, with one unreachable through its disconnected Agent; opens Machines");
  await shot("statusbar-light-1440.png");

  // Ends while the page is open, each told once.
  const notice = bar.locator(".statusbar-notice .statusbar-item");
  f.budget = { ...f.budget, activeCount: 0, queuedCount: 1 };
  f.jobs = [{ id: "j1", name: "check-1", status: "succeeded", finishedAt: iso(Date.now()) }];
  await refresh();
  await notice.filter({ hasText: "Job check-1 finished" }).waitFor();
  assert.match(await notice.getAttribute("class"), /is-ok/);
  f.reviews = [{ ...f.reviews[0], status: "completed", phase: null, conclusion: "no_findings", finishedAt: iso(Date.now()) }];
  await refresh();
  await notice.filter({ hasText: "Review of PR #63: no findings" }).waitFor();
  await bar.getByRole("button", { name: /review running/ }).waitFor({ state: "detached" });
  f.runs = [{ ...f.runs[0], status: "failed", conclusion: "failure", updatedAt: iso(Date.now()) }];
  await refresh();
  await notice.filter({ hasText: "CI run failed" }).waitFor();
  assert.match(await notice.getAttribute("class"), /is-failed/);
  await bar.getByRole("button", { name: /CI run$/ }).waitFor({ state: "detached" });
  await shot("statusbar-notice-light-1440.png");
  await notice.click();
  await jobs.waitFor();
  assert.equal(await tab("GitHub Actions").getAttribute("aria-selected"), "true");
  await jobs.getByText("CI", { exact: true }).first().waitFor();
  await page.keyboard.press("Escape");
  await jobs.waitFor({ state: "detached" });
  assert.deepEqual(report.errors, [], "opening the run from the bar breaks nothing");
  await bar.waitFor();
  // Told once: the same end is not told again.
  await refresh();
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".statusbar-notice .statusbar-item", { hasText: "Job check-1" }).count(), 0);
  check("a job, review and CI run ending while open are each told once, and open Jobs");

  // Dark, and narrower windows: nothing spills out of the bar.
  f.reviews = [{ ...f.reviews[0], status: "running", phase: "Reviewing", conclusion: null, finishedAt: null }];
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("yuzuno.appearance"));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...saved, theme: "dark" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "yuzuno.appearance" }));
  });
  await refresh();
  await bar.getByRole("button", { name: "1 review running" }).waitFor();
  const sizes = {};
  for (const width of [1440, 940, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const fit = await fits();
    sizes[width] = fit;
    assert.ok(!fit.overflow && fit.height <= 28, `${width}: ${JSON.stringify(fit)}`);
    assert.ok(fit.items.every((i) => !i.visible || i.inside), `${width}: ${JSON.stringify(fit)}`);
    await shot(`statusbar-dark-${width}.png`);
  }
  // The narrowest keeps the background work and the RAM meter only.
  const narrow = sizes[390].items.filter((i) => i.visible).map((i) => i.text);
  assert.ok(narrow.some((t) => t.includes("review running")) && narrow.some((t) => t.startsWith("RAM")), JSON.stringify(narrow));
  assert.ok(!narrow.some((t) => t.startsWith("Claude") || t.startsWith("Codex") || t.includes("machine")), JSON.stringify(narrow));
  assert.ok(sizes[940].items.some((i) => i.visible && i.text.startsWith("Codex")), JSON.stringify(sizes[940]));
  report.sizes = sizes;
  check("dark at 1440, 940 and 390 px: one line, nothing outside; the narrowest keeps background work and RAM");

  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
  if (report.error) console.error(report.error);
}
