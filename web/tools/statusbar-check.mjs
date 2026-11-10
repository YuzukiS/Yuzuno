// The bottom bar (T-82): background work and resources, nothing the toolbar,
// rail or conversation already shows.
// - Reviews and CI runs in progress open Jobs at their source.
// - A job, review or run that ends while the page is open is told once.
// - Job RAM reserved against its budget, and what the host has free.
// - Claude plan usage as last reported, kept while another Agent is open.
// - The open Codex Agent's plan usage from its own connection: newer reports
//   only, "last report" after five minutes, a passed reset waits, unknown is
//   not 0, a stream reset reads again; gone with another Agent open.
// - Remote machines, with those unreachable at their last check apart from
//   a reachable one's disconnected Agents, which are named (YN-61); opens
//   Machines.
// - Without room, nothing is cut in its words (YN-75): in English and
//   Chinese at 1440, 940, 820 and 390 px no painted frame spills, the notice
//   is whole at 940, and what gives way follows priority, by this check's
//   own order; at 320 px with 20 px text the least important are behind
//   "⋯", whose list says them in full and opens them.
// - Core's backlog details open whole and in the window above the bar.
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
  // Core's backlog per Agent: none until the backlog step.
  backlog: {},
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

// The Workspace this fixture's Core says it is: the Agent a window opens is
// remembered per Workspace (T-195), so Kumo is seeded under it.
const WORKSPACE = "ws-statusbar";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
/** What `locator`'s tip says (YN-44: the status bar's titles are tips), its
 * lines joined as its title's were, read the way a pointer resting on it
 * shows it. */
const tipText = async (locator) => {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
  await locator.hover();
  const tip = page.locator('.tip[role="tooltip"]');
  await tip.waitFor({ timeout: 3000 });
  const text = await tip.evaluate((t) => [...t.children].map((c) => c.textContent.trim()).filter(Boolean).join("\n"));
  await page.mouse.move(2, 2);
  await tip.waitFor({ state: "detached", timeout: 3000 });
  return text;
};
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript((workspace) => {
    // Live updates open, as with a healthy Core; nothing more arrives.
    window.EventSource = class {
      constructor() {
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    if (!localStorage.getItem("statusbar-fixture")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
      localStorage.setItem(`yuzuno.selected.${workspace}`, JSON.stringify("c"));
      localStorage.setItem("statusbar-fixture", "seeded");
    }
  }, WORKSPACE);
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
          "/api/workspace": { workspace: { id: WORKSPACE }, agents, runtime: { connected: true }, defaultCwd: "/fixture" },
          "/api/updates": unmanagedUpdates,
          "/api/jobs/budget": f.budget,
          "/api/jobs/live": noLiveJobs,
          "/api/jobs": { jobs: scoped ? [] : f.jobs, liveJobs: [], hasMore: false, nextBefore: null },
          "/api/reviews": { reviews: scoped ? [] : f.reviews, hasMore: false, nextBefore: null },
          "/api/ci": { runs: scoped ? [] : f.runs, subscriptions: [], hasMore: false, nextBefore: null },
          "/api/machines": { machines: f.machines },
          "/api/backlog": { observedAt: iso(Date.now()), agents: f.backlog },
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
  assert.match(await tipText(claude), /for me@example\.com · max[\s\S]*Reported /);
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Mori" }).waitFor();
  assert.equal((await claude.innerText()).trim(), "Claude 5h 42% · 7d 18%");
  assert.match(await tipText(claude), /for me@example\.com · max/);
  check("Claude plan usage as last reported, with its account, kept while a Codex Agent is open");

  // Codex plan usage: Mori's own report, from Mori's native connection.
  const codex = bar.locator(".statusbar-codex");
  const codexText = async () => (await codex.innerText()).trim();
  const codexEvent = (detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent("yuzuno:codex-usage", { detail: d })), detail);
  const codexShows = (text) => page.waitForFunction((t) => document.querySelector(".statusbar-codex")?.textContent.trim() === t, text);
  await codexShows("Codex 5h 23% · 7d 41%");
  assert.match(await tipText(codex), /^Codex plan usage for me@work\.example · pro, from Core host\n/);
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
  // disconnected there; that is not an unreachable machine (YN-61).
  const machines = bar.getByRole("button", { name: /machine/ });
  assert.equal((await machines.innerText()).trim(), "1 machine · 1 Agent disconnected");
  assert.doesNotMatch(await machines.getAttribute("class"), /is-failed/);
  assert.match(await tipText(machines), /devbox: reachable at its last check.*Agent disconnected: Tora/s);
  await machines.click();
  // Settings › Machines (YN-8): a page of Settings, its list first.
  const machinesPage = page.locator(".modal.settings-modal");
  await machinesPage.locator("#settings-editor-machines:not([hidden]) .settings-machines").waitFor();
  await page.keyboard.press("Escape");
  await machinesPage.waitFor({ state: "detached" });
  check("remote machines: a reachable one's disconnected Agent named, not unreachable; opens Settings › Machines");
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
  // A fresh end as well, so the notice is showing through the widths below
  // (it shows 10 s) whatever the steps above took (YN-75).
  f.runs = [...f.runs, { ...f.runs[0], id: "github:1:901:1", runId: "901", status: "failed", conclusion: "failure", updatedAt: iso(Date.now()), cursor: 2 }];
  await refresh();
  await bar.getByRole("button", { name: "1 review running" }).waitFor();
  await notice.filter({ hasText: "CI run failed" }).first().waitFor();
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
  // At the narrowest every item is still there, shorter (YN-75): the bar
  // no longer drops plan usage and machines because the window is narrow.
  const narrow = sizes[390].items.filter((i) => i.visible).map((i) => i.text);
  assert.ok(narrow.some((t) => t.includes("review running")) && narrow.some((t) => t.startsWith("RAM")), JSON.stringify(narrow));
  assert.ok(sizes[940].items.some((i) => i.visible && i.text.startsWith("Codex")), JSON.stringify(sizes[940]));
  report.sizes = sizes;
  check("dark at 1440, 940 and 390 px: one line, nothing outside");

  // What gives way, in which form, in both languages and at 820 px too; no
  // painted frame on the way spills or cuts a word (YN-75). The order is
  // this check's own, from the design, not read from the page: within a
  // tier a lower number gives way first; news > work > metrics; a metric at
  // its limit or not reached is news. Every item in this fixture has a
  // shorter form, so an item that gave way means every less important one
  // did too, and one behind "⋯" means every less important one is.
  const ORDER = { machines: 101, codex: 102, claude: 103, ram: 104, ci: 201, reviews: 202, backlog: 304, stream: 305, notice: 307 };
  const RAISED = { machines: 301, codex: 302, claude: 303 };
  const read = () =>
    bar.evaluate((el) => {
      const start = el.querySelector(".statusbar-start").getBoundingClientRect();
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const left = box.left + parseFloat(style.paddingLeft) - 0.5;
      const right = box.right - parseFloat(style.paddingRight) + 0.5;
      const items = [...el.querySelectorAll(":scope > .statusbar-start [data-item], :scope > .statusbar-end > [data-item], :scope > .statusbar-end > * > [data-item]")]
        .filter((item) => !item.closest(".statusbar-overflow-list"))
        .map((item) => {
          const r = item.getBoundingClientRect();
          return {
            id: item.dataset.item,
            form: item.dataset.form,
            text: item.textContent.trim(),
            failed: item.classList.contains("is-failed"),
            cut: r.left < left || r.right > right || (!!item.closest(".statusbar-start") && r.right > start.right + 0.5) || item.scrollWidth > item.clientWidth + 1,
          };
        });
      const more = el.querySelector(".statusbar-overflow");
      return { items, more: more ? Number(more.textContent.trim()) : 0, overflow: el.scrollWidth > el.clientWidth + 1, height: Math.round(box.height) };
    });
  const rank = (item) => (item.failed && RAISED[item.id]) || ORDER[item.id];
  // `present`: the items that stay for the whole step. A notice comes and
  // goes on its own clock, so it counts only while it shows; it is never
  // behind "⋯", so a missing one has ended.
  const priority = (state, present, where) => {
    const shown = new Map(state.items.map((i) => [i.id, i]));
    const items = shown.has("notice") ? [...present, shown.get("notice")] : present;
    const forms = Object.fromEntries(items.map((p) => [p.id, shown.get(p.id)?.form ?? "hidden"]));
    const behind = Object.values(forms).filter((form) => form === "hidden").length;
    assert.equal(state.more, behind, `${where}: "⋯" counts what is behind it: ${JSON.stringify(forms)}`);
    for (const a of items)
      for (const b of items) {
        if (!(rank(a) > rank(b))) continue;
        if (forms[a.id] === "hidden") assert.equal(forms[b.id], "hidden", `${where}: ${a.id} behind "⋯" but ${b.id} not: ${JSON.stringify(forms)}`);
        if (forms[a.id] !== "full") assert.notEqual(forms[b.id], "full", `${where}: ${a.id} ${forms[a.id]} but ${b.id} full: ${JSON.stringify(forms)}`);
      }
    return forms;
  };
  let ended = 902;
  const freshEnd = async () => {
    ended++;
    f.runs = [...f.runs, { ...f.runs[0], id: `github:1:${ended}:1`, runId: String(ended), status: "failed", conclusion: "failure", updatedAt: iso(Date.now()), cursor: ended }];
    await refresh();
    await notice.first().waitFor();
  };
  // Painted frames: a rAF, then a message, then a look (a resize observer
  // may change the bar after layout; what counts is what is drawn).
  const watchFrames = () =>
    page.evaluate(() => {
      window.__barFrames = [];
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const el = document.querySelector(".statusbar");
        const start = el.querySelector(".statusbar-start").getBoundingClientRect();
        const bad = [...el.querySelectorAll(":scope > .statusbar-start [data-item], :scope > .statusbar-end [data-item]")].filter((item) => {
          if (item.closest(".statusbar-overflow-list")) return false;
          const r = item.getBoundingClientRect();
          return r.right > innerWidth || (!!item.closest(".statusbar-start") && r.right > start.right + 0.5) || item.scrollWidth > item.clientWidth + 1;
        });
        window.__barFrames.push({ overflow: el.scrollWidth > el.clientWidth + 1, bad: bad.map((b) => `${b.dataset.item}:${b.dataset.form}`) });
      };
      let n = 0;
      const tick = () => {
        channel.port2.postMessage(0);
        if (++n < 40) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const language = (choice) =>
    page.evaluate((language) => {
      localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
      window.dispatchEvent(new StorageEvent("storage", { key: "yuzuno.language" }));
    }, choice);
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshEnd();
  await page.waitForTimeout(300);
  const all = (await read()).items;
  assert.ok(all.every((i) => i.form === "full"), `1440: everything in full: ${JSON.stringify(all)}`);
  const present = all.filter((i) => i.id !== "notice");
  assert.deepEqual(present.map((i) => i.id).sort(), ["claude", "codex", "machines", "ram", "reviews"], JSON.stringify(all));
  report.fit = {};
  for (const lang of ["en", "zh-Hans"]) {
    await language(lang);
    await bar.locator('[data-item="reviews"]', { hasText: lang === "en" ? "review running" : "审查进行中" }).waitFor();
    for (const width of [1440, 940, 820, 390]) {
      // At 940 a notice must be showing: that is where it was cut.
      if (width === 940) await freshEnd();
      await watchFrames();
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => window.__barFrames.length >= 40, null, { timeout: 5000 });
      const frames = await page.evaluate(() => window.__barFrames);
      const where = `${lang} ${width}`;
      assert.ok(frames.every((fr) => !fr.overflow && !fr.bad.length), `${where}: a painted frame spilled or cut: ${JSON.stringify(frames.filter((fr) => fr.overflow || fr.bad.length))}`);
      const state = await read();
      assert.ok(!state.overflow && state.height <= 28, `${where}: ${JSON.stringify(state)}`);
      assert.ok(state.items.every((i) => !i.cut), `${where}: ${JSON.stringify(state.items)}`);
      const forms = priority(state, present, where);
      if (width === 940) assert.equal(forms.notice, "full", `${where}: the notice is whole: ${JSON.stringify(forms)}`);
      report.fit[where] = forms;
      await shot(`statusbar-fit-${lang}-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await language("en");
  await bar.getByRole("button", { name: "1 review running" }).waitFor();
  check("en and zh at 1440, 940, 820 and 390 px: one line, no word cut in any painted frame, the notice whole at 940, and what gives way follows priority");

  // Behind "⋯": at 320 px with 20 px text not even every item's shortest
  // fits. The least important go behind "⋯"; its list says them in full,
  // in the window, and each opens what it opens in the bar (YN-75).
  const appearance = (change) =>
    page.evaluate((change) => {
      const saved = JSON.parse(localStorage.getItem("yuzuno.appearance"));
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...saved, ...change }));
      window.dispatchEvent(new StorageEvent("storage", { key: "yuzuno.appearance" }));
    }, change);
  await appearance({ fontSize: 20 });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(400);
  const tight = await read();
  assert.ok(!tight.overflow && tight.items.every((i) => !i.cut), `320: ${JSON.stringify(tight)}`);
  const tightForms = priority(tight, present, "en 320 at 20 px");
  const behind = present.filter((p) => tightForms[p.id] === "hidden").map((p) => p.id);
  assert.ok(behind.includes("machines"), `the least important goes first: ${JSON.stringify(tightForms)}`);
  const moreButton = bar.getByRole("button", { name: `${behind.length} more in the status bar` });
  await moreButton.click();
  const list = page.getByRole("region", { name: "Not shown in the status bar for lack of room" });
  await list.waitFor();
  const listed = await list.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0,
      items: [...el.querySelectorAll("[data-item]")].map((i) => ({ id: i.dataset.item, form: i.dataset.form, text: i.textContent.trim() })),
    };
  });
  assert.ok(listed.inside, JSON.stringify(listed));
  assert.deepEqual(listed.items.map((i) => i.id).sort(), [...behind].sort(), JSON.stringify(listed));
  for (const item of listed.items) {
    assert.equal(item.form, "full", JSON.stringify(item));
    assert.equal(item.text, all.find((a) => a.id === item.id).text, `said in full as at 1440: ${JSON.stringify(item)}`);
  }
  await shot("statusbar-overflow-320.png");
  await page.screenshot({ path: resolve(output, "statusbar-overflow-open-320.png") });
  report.screenshots.push("statusbar-overflow-open-320.png");
  await list.getByRole("button", { name: /machine/ }).click();
  await machinesPage.locator("#settings-editor-machines:not([hidden]) .settings-machines").waitFor();
  await page.keyboard.press("Escape");
  await machinesPage.waitFor({ state: "detached" });
  // Escape closes the list and hands focus back to "⋯".
  if (!(await list.count())) await moreButton.click();
  await list.waitFor();
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  assert.equal(await moreButton.getAttribute("aria-expanded"), "false");
  assert.ok(await moreButton.evaluate((b) => b === document.activeElement), "focus back on ⋯");
  report.behind = { forms: tightForms, listed: listed.items };
  await appearance({ fontSize: 16 });
  check('320 px at 20 px text: the least important behind "⋯", listed in full in the window, opening Settings › Machines; Escape gives focus back');

  // Core's backlog: its details open above the bar, whole and in the window
  // at 1440, 940 and 390 px. The bar's clip used to hide all of them
  // (YN-75; the panel's placement is not this bar's and is not checked).
  f.backlog = { a: { generation: 1, pending: 12, oldestMs: 9000 } };
  const hint = bar.locator(".statusbar-start .core-backlog-hint");
  await page.setViewportSize({ width: 1440, height: 900 });
  // Behind in two reads in a row, five seconds apart.
  await hint.waitFor({ timeout: 20_000 });
  const details = bar.locator(".statusbar-start .core-backlog-details");
  report.backlog = {};
  for (const width of [1440, 940, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    if ((await hint.getAttribute("aria-expanded")) !== "true") await hint.click();
    await details.waitFor();
    const seen = await details.evaluate((d) => {
      const r = d.getBoundingClientRect();
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 4, r.top + 4],
        [r.right - 4, r.top + 4],
        [r.left + 4, r.bottom - 4],
        [r.right - 4, r.bottom - 4],
      ];
      return {
        box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
        hits: points.map(([x, y]) => {
          const at = document.elementFromPoint(x, y);
          return !!at && d.contains(at);
        }),
      };
    });
    report.backlog[width] = seen;
    assert.ok(seen.inside && seen.hits.every(Boolean), `backlog details at ${width}: ${JSON.stringify(seen)}`);
    await page.screenshot({ path: resolve(output, `statusbar-backlog-${width}.png`), clip: { x: 0, y: 900 - 220, width, height: 220 } });
    report.screenshots.push(`statusbar-backlog-${width}.png`);
  }
  check("Core backlog details: whole and in the window at 1440, 940 and 390 px");

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
