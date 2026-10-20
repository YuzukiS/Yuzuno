// UI refine 6 in a browser, on a production build with every API answered
// here: Settings keeps one size, text size and the conversation dock are
// sliders, New agent and Agent settings choose with chips, and Machines adds,
// edits and removes SSH machines. Screenshots for review; no Core, no SSH.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/ui-refine-6-browser");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], mutations: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const mini = { id: "mini", name: "Mac mini", kind: "ssh", target: "me@mac-mini", codex: "codex", defaultCwd: "/Users/me/projects",
  lastCheck: { machineId: "mini", startedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), durationMs: 900,
    reachable: true, host: { hostname: "mac-mini", platform: "Darwin", home: "/Users/me" },
    harnesses: [{ harness: "codex", supported: true, found: true, version: "codex-cli 1.0.0" }] } };
const local = { id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null };
let machines = [local, mini];
const agent = { ...base, id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6",
  settings: { reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: "workspace-write", permissionPreset: "ask" },
  connectionState: "connected", threadId: "thread-a" };
const kaze = { ...base, id: "k", name: "Kaze", status: "idle", harness: "codex", cwd: "/Users/me/projects", model: "",
  remote: { machine: { id: "mini", name: "Mac mini", target: "me@mac-mini", codex: "codex", defaultCwd: "/Users/me/projects" }, runtime: null },
  connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const efforts = ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} effort` }));
const models = [
  { id: "gpt-6", model: "gpt-6", displayName: "GPT-6", description: "The everyday model", isDefault: true, supportedReasoningEfforts: efforts, defaultReasoningEffort: "medium" },
  { id: "gpt-6-mini", model: "gpt-6-mini", displayName: "GPT-6 mini", description: "Smaller and faster", supportedReasoningEfforts: efforts, defaultReasoningEffort: "low" },
];
const permissions = { presets: [
  { id: "config", available: true, permissions: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "read-only", profile: null } },
  { id: "ask", available: true, permissions: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", profile: null } },
  { id: "auto", available: true, permissions: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", profile: null } },
  { id: "full", available: true, permissions: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access", profile: null } },
] };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const resources = { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 };
const job = (n, extra) => ({ id: `job-${n}`, requestId: `r-${n}`, name: `check ${n}`, taskRef: "T-111", agentId: "a", agent: { name: "Mori" },
  machine: { name: "Core host" }, resources, reservation: resources, argv: ["/bin/true"], cwd: "/fixture", env: {}, exclusive: false,
  status: "succeeded", reserved: false, cursor: n, createdAt: ago(60 - n), startedAt: ago(59 - n), finishedAt: ago(50 - n), reason: "success", ...extra });
const jobs = [job(1, { status: "running", reserved: true, finishedAt: null }), ...[2, 3, 4, 5, 6].map((n) => job(n))];
const run = (n) => ({ id: `github:1:${n}:1`, name: `CI ${n}`, repository: "o/yuzuno", runId: String(n), attempt: "1", headSha: "a".repeat(40),
  status: "passed", rawStatus: "completed", conclusion: "success", url: `https://github.com/o/yuzuno/actions/runs/${n}`,
  createdAt: ago(40 - n), startedAt: ago(39 - n), updatedAt: ago(30 - n), observedAt: ago(1), cursor: n });
const runs = [1, 2, 3].map(run);

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert.equal(url.hostname, "yuzuno-ui-refine-6.test");
    const path = url.pathname;
    if (method !== "GET") {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      report.mutations.push({ method, path, body });
      // Read receipts for the conversation on screen.
      if (method === "POST" && /^\/api\/agents\/[^/]+\/review$/.test(path)) return route.fulfill({ json: {} });
      if (method === "POST" && path === "/api/machines") {
        const added = { id: "studio", kind: "ssh", ...body, lastCheck: null };
        machines = [...machines, added];
        return route.fulfill({ json: added });
      }
      const id = path.match(/^\/api\/machines\/([^/]+)$/)?.[1];
      if (id && method === "PUT") {
        machines = machines.map((m) => (m.id === id ? { ...m, ...body } : m));
        return route.fulfill({ json: machines.find((m) => m.id === id) });
      }
      if (id && method === "DELETE") {
        machines = machines.filter((m) => m.id !== id);
        return route.fulfill({ json: { removed: id } });
      }
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const json = {
      "/api/workspace": { agents: [agent, kaze], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
      "/api/agents/k": { agent: kaze, pending: [], messageReceipts: [], artifacts: [], turns: [] },
      "/api/agents/a/models": { models, permissions },
      "/api/models": { models },
      "/api/machines": { machines },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": { jobs, liveJobs: [jobs[0]], hasMore: false, nextBefore: null },
      "/api/jobs/live": noLiveJobs, "/api/ci": { runs, subscriptions: [], hasMore: false, nextBefore: null }, "/api/reviews": noReviews,
      "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
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
  const shot = (name, target = page) => target.screenshot({ path: resolve(output, name), animations: "disabled" });
  const group = (label) => page.locator(`.work-dock [role="group"][aria-label="${label}"]`);
  const marks = (label) => group(label).locator(".conversation-job").count();
  const more = (label) => group(label).locator(".work-dock-more").getAttribute("aria-label");
  const fits = (locator) => locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth + 1);

  await page.goto("http://yuzuno-ui-refine-6.test/");
  await page.locator(".work-dock .conversation-job").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.work-dock [aria-label="GitHub Actions"] .conversation-job').length === 2);
  assert.equal(await marks("Local jobs"), 5);
  assert.equal(await more("Local jobs"), "Local jobs: 1 more, open the list");
  assert.equal(await more("GitHub Actions"), "GitHub Actions: 1 more, open the list");
  await shot("dock-default.png");
  check("the dock shows up to 5 local jobs and 2 GitHub Actions runs until Settings says otherwise");

  // Settings: one size whatever the category, and at any text size.
  await page.getByRole("button", { name: "Settings and updates", exact: true }).click();
  const settings = page.locator(".modal.settings-modal");
  await settings.waitFor();
  const box = () => settings.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  const sizes = {};
  for (const tab of ["updates", "appearance", "review", "appearance"]) {
    await page.locator(`#settings-tab-${tab}`).click();
    await page.waitForTimeout(150);
    sizes[tab] = await box();
  }
  const root = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const size = settings.locator('input[type="range"][name="appearance-font-size"]');
  assert.deepEqual([await size.getAttribute("min"), await size.getAttribute("max")], ["10", "24"]);
  for (const [px, adjust] of [[10, "1px"], [24, "11px"], [16, "3px"]]) {
    await size.fill(String(px));
    await page.waitForTimeout(100);
    assert.equal(await root("--reading-size"), `${px}px`);
    assert.equal(await root("--font-adjust"), adjust);
    sizes[`text ${px}`] = await box();
    if (px !== 16) await shot(`settings-text-${px}.png`);
  }
  for (const [where, value] of Object.entries(sizes)) assert.deepEqual(value, sizes.updates, `${where}: ${JSON.stringify(sizes)}`);
  await shot("settings-appearance.png");
  check("Settings keeps one size across its categories and text sizes; text size slides from 10 to 24 px", { sizes });

  // The dock's limits: 0 hides a group.
  // The first group of sliders is the Conversation dock's; Turn dock follows.
  const dock = settings.locator(".dock-limits").first();
  await dock.scrollIntoViewIfNeeded();
  await settings.locator('input[name="appearance-dock-jobs"]').fill("2");
  await settings.locator('input[name="appearance-dock-actions"]').fill("0");
  assert.deepEqual(await dock.locator("output").allTextContents(), ["2", "Hidden", "5"]);
  await shot("settings-dock-limits.png");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.querySelector('.work-dock [aria-label="GitHub Actions"]'));
  assert.equal(await marks("Local jobs"), 2);
  assert.equal(await more("Local jobs"), "Local jobs: 4 more, open the list");
  await shot("dock-limited.png");
  check("dock limits apply at once: 2 local jobs and the rest behind its link, GitHub Actions off the dock at 0");

  // New agent: every choice in view, one click each.
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radiogroup", { name: "Model" }).locator('input[value="gpt-6"]').waitFor({ state: "attached" });
  assert.equal(await dialog.locator("select").count(), 0, "no dropdowns");
  for (const name of ["Harness", "Where to work", "Project", "Model"])
    assert.equal(await dialog.getByRole("radiogroup", { name, exact: true }).count(), 1, name);
  assert.equal(await dialog.locator(".remote-create-intro").count(), 0);
  assert.ok(await fits(dialog));
  await shot("new-agent.png");
  await dialog.getByRole("radiogroup", { name: "Where to work" }).locator('input[value="mini"]').check();
  await dialog.getByLabel("Model", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Working folder").inputValue(), "/Users/me/projects");
  await shot("new-agent-ssh.png");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await dialog.getByRole("radiogroup", { name: "Where to work" }).locator('input[value="local"]').check();
  await shot("new-agent-dark.png");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.ok(await fits(dialog), "fits a phone");
  await shot("new-agent-390.png");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check("New agent shows Harness, Where to work, Project and Model as chips, with no dropdowns, light, dark and at 390px");

  // Agent settings: the same chips.
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await dialog.getByRole("radiogroup", { name: "Model" }).locator('input[value="gpt-6"]:checked').waitFor({ state: "attached" });
  assert.equal(await dialog.locator("select").count(), 0, "no dropdowns");
  for (const name of ["Model", "Reasoning effort", "Permissions"])
    assert.equal(await dialog.getByRole("radiogroup", { name, exact: true }).count(), 1, name);
  await dialog.getByRole("radiogroup", { name: "Permissions" }).locator('input[value="auto"]').check();
  assert.match(await dialog.locator(".permission-preview").textContent(), /Automatic review · Workspace files/);
  assert.ok(await fits(dialog));
  await shot("agent-settings.png");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check("Agent settings chooses model, reasoning effort and permissions with chips");

  // Machines: add, edit and remove SSH machines in place.
  await page.locator(".workspace-scope").click();
  await page.getByRole("menuitem", { name: "Machines…" }).click();
  await dialog.locator('[data-machine-id="mini"]').waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Edit Core host" }).count(), 0);
  await shot("machines.png");
  await dialog.getByRole("button", { name: "Add SSH machine" }).click();
  await dialog.getByLabel("Machine name").fill("Studio");
  await dialog.getByLabel("SSH destination").fill("me@studio");
  await dialog.getByLabel("Default working folder").fill("/Users/me/studio");
  await shot("machines-add.png");
  await dialog.getByRole("button", { name: "Save machine" }).click();
  await dialog.locator('[data-machine-id="studio"]').waitFor();
  await dialog.getByRole("button", { name: "Edit Mac mini" }).click();
  assert.equal(await dialog.getByLabel("SSH destination").inputValue(), "me@mac-mini");
  await dialog.getByLabel("Machine name").fill("Mac mini (office)");
  await dialog.locator('[data-machine-id="mini"]').scrollIntoViewIfNeeded();
  await shot("machines-edit.png");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.locator('[data-machine-id="mini"] h3', { hasText: "Mac mini (office)" }).waitFor();
  await dialog.getByRole("button", { name: "Remove Mac mini (office)" }).click();
  const refusal = dialog.locator('[data-machine-id="mini"] .machine-remove');
  assert.match(await refusal.textContent(), /Kaze still works here\. Close that agent first/);
  await refusal.scrollIntoViewIfNeeded();
  await shot("machines-remove-in-use.png");
  await refusal.getByRole("button", { name: "OK" }).click();
  await dialog.getByRole("button", { name: "Remove Studio" }).click();
  await dialog.locator('[data-machine-id="studio"] .machine-remove').scrollIntoViewIfNeeded();
  await shot("machines-remove.png");
  await dialog.getByRole("button", { name: "Remove machine" }).click();
  await dialog.locator('[data-machine-id="studio"]').waitFor({ state: "detached" });
  const changes = report.mutations.filter((m) => m.path.startsWith("/api/machines")).map((m) => `${m.method} ${m.path}`);
  assert.deepEqual(changes, ["POST /api/machines", "PUT /api/machines/mini", "DELETE /api/machines/studio"]);
  check("Machines adds, edits and removes SSH machines; one with an open agent is kept, the Core host is only checked", { changes });

  assert.deepEqual(report.errors, []);
  const unexpected = report.mutations.filter((m) => !m.path.startsWith("/api/machines") && !/\/review$/.test(m.path));
  assert.deepEqual(unexpected, [], "no other writes");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
}
