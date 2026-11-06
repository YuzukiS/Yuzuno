// T-55 PR 2 in Chromium, on a production build, with every API answered by a
// fixture server here (no Core, no machine, no GPU; nothing of a daily
// Workspace is read). Through the real app, light and dark, at 1440 and
// 390 px:
//  - the Jobs panel's machine card only shows: active against Jobs at once,
//    the meters, the GPU pause; no editor. Its Edit in Settings closes Jobs
//    and opens Settings → Jobs & resources at the Core host budget;
//  - there, a new Jobs at once is saved with the budget in one POST, and the
//    number Core reads back is shown; every field fits its width at 390 px;
//  - Remote budgets lists the SSH machines only; a machine is chosen and its
//    editor fits; once, a change is saved through the machine's PUT.
// Screenshots and report.json go to YUZUNO_BROWSER_OUTPUT.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/jobs-settings-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { emptyHome, noCiRuns, noJobs, noLiveCi, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-55", checks: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

// ---------------------------------------------------------------- fixture Core
const GIB = 1073741824;
const GPU0 = "GPU-0d1e2f30-4a5b-6c7d-8e9f-a0b1c2d3e4f5";
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture/project", model: "fixture-model", projectId: null,
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const state = {
  budget: { cpuMillis: 8000, memoryMiB: 16384, swapMiB: 0 },
  maxActive: null,
  machines: [
    { id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture/project" },
    { id: "mini", name: "Mac mini", kind: "ssh", target: "mac-mini", codex: "codex", defaultCwd: "/Users/fixture/projects",
      maxJobs: 3, budget: { cpuMillis: 4000, memoryMiB: 8192 }, limitMode: "limited" },
    { id: "lab", name: "Lab box with a long synthetic machine name", kind: "ssh", target: "fixture@lab-box.example.test", codex: "codex", defaultCwd: "/srv/fixture/work" },
  ],
};
const budgetView = () => ({
  machine: { name: "Fixture workstation", memoryAvailableMiB: 9523, scope: "fixture", logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384,
    hostHeadroomMiB: 2048, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 } },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: state.budget,
  budgetBounds: { minimum: { cpuMillis: 200, memoryMiB: 128, swapMiB: 0 }, maximum: { cpuMillis: 4096000, memoryMiB: 67108864, swapMiB: 67108864 } },
  reserved: { cpuMillis: 4200, memoryMiB: 6200, swapMiB: 0 },
  activeCount: 3,
  queuedCount: 1,
  maxActive: state.maxActive ?? 4,
  maxActiveSet: state.maxActive != null,
  maxActiveDefault: 4,
  maxActiveBounds: { minimum: 1, maximum: 16 },
  disk: {
    reserveGiB: null, defaultRule: "10 GiB, or a tenth of a filesystem smaller than 100 GiB", bounds: { minGiB: 1, maxGiB: 1024 },
    observedAt: new Date().toISOString(), scope: "Checked before each new job starts, not a quota.",
    volumes: [{ device: 1, totalBytes: 1500 * GIB, availableBytes: 158 * GIB, reserveBytes: 10 * GIB, low: false, error: null,
      paths: [{ path: "/fixture/data", role: "Core data and job records" }] }],
  },
  windows: { available: true, maxJobs: 2, set: false, defaultMaxJobs: 2, activeCount: 1, sharesThisBudget: true },
  gpus: {
    devices: [{ uuid: GPU0, index: 0, name: "NVIDIA GeForce RTX 5090", memoryTotalMiB: 32607, memoryFreeMiB: 27277,
      admission: "open", closedReason: null, closedBy: null, sharing: false, headroomMiB: 1024,
      reservations: [{ jobId: "job-1", name: "Synthetic sweep", memoryMiB: 8192, mode: "exclusive" }] }],
    observedAt: new Date().toISOString(), problem: null, scope: "Admission among this Core's managed jobs by declared GPU memory.",
  },
});
const answers = {
  "/api/workspace": () => ({ workspace: { id: "ws-jobs-settings" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/fixture/project" }),
  "/api/agents/a": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
  // The open conversation's Codex MCP services, as Codex last reported them: none.
  "/api/agents/a/codex/mcp": () => ({ state: "observed", reason: "", generation: 1, servers: [], more: 0 }),
  "/api/home": () => emptyHome,
  "/api/updates": () => unmanagedUpdates,
  "/api/machines": () => ({ machines: state.machines }),
  "/api/machine-load": () => ({ at: new Date().toISOString(), cpu: { cores: 32, totalPct: 20, jobsPct: 6.5, agentsPct: null, otherPct: null },
    memory: { totalMiB: 40107, usedMiB: 20000, availableMiB: 20107, jobsMiB: 5000, agentsMiB: null }, gpus: null, jobs: [] }),
  "/api/jobs/budget": budgetView,
  "/api/jobs": () => noJobs,
  "/api/jobs/live": () => noLiveJobs,
  "/api/jobs/runs": () => ({ runs: [], hasMore: false }),
  "/api/ci": () => noCiRuns,
  "/api/ci/live": () => noLiveCi,
  "/api/reviews": () => noReviews,
  "/api/catchup": () => ({ items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } }),
};
/** The open conversation's own writes: where it was read, and that it was. */
const appOwn = (path) => /^\/api\/agents\/a\/(reading|review)$/.test(path);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.test");
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const send = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      // Reads Home makes by POST: the repositories linked to a project.
      if (req.method === "POST" && path === "/api/collaboration/github_repositories") return send(200, { repositories: [], links: [] });
      if (req.method !== "GET") {
        const body = raw ? JSON.parse(raw) : null;
        report.writes.push({ method: req.method, path, body });
        if (req.method === "POST" && path === "/api/jobs/budget") {
          state.budget = { cpuMillis: body.cpuMillis, memoryMiB: body.memoryMiB, swapMiB: body.swapMiB };
          if ("maxActive" in body) state.maxActive = body.maxActive;
          return send(200, state.budget);
        }
        const machine = path.match(/^\/api\/machines\/([\w-]+)$/);
        if (req.method === "PUT" && machine) {
          const index = state.machines.findIndex((m) => m.id === machine[1]);
          state.machines[index] = { ...state.machines[index], ...body };
          return send(200, state.machines[index]);
        }
        // Where an Agent was read, and that it was, are the app's own writes;
        // the rest is not this check's.
        if (appOwn(path)) return send(200, path.endsWith("/reading") ? { accepted: true, sourceSeq: 0 } : {});
        return send(400, { error: `Unexpected ${req.method} ${path} in this check` });
      }
      const answer = answers[path];
      if (answer) return send(200, answer());
      if (path === "/api/agents/a/reading") return send(200, { handoff: null, sourceSeq: 0 });
      report.unexpected.push(path);
      return send(200, {});
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("");
  }
});

// ---------------------------------------------------------------- browser
let browser;
/** Whether `box` and every control in it fit its width: nothing scrolls
 * sideways, and no field, picker or button reaches past its edges. */
const fits = (box) => box.evaluate((el) => {
  const edge = el.getBoundingClientRect();
  const wider = [...el.querySelectorAll("input, select, textarea, button")]
    .filter((c) => c.getClientRects().length)
    .filter((c) => { const r = c.getBoundingClientRect(); return r.right > edge.right + 1 || r.left < edge.left - 1; })
    .map((c) => c.getAttribute("name") || c.textContent.trim() || c.tagName);
  return { scrolls: el.scrollWidth > el.clientWidth + 1, wider };
});
/** The focused element, named for a failure message. */
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return "nothing";
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : ""}`;
});
/** Waits until focus is on the Core host editor or in it, as Settings puts it
 * when it opens there; says where focus is if it never gets there. */
async function focusInHostEditor(page) {
  const reached = await page
    .waitForFunction(() => !!document.activeElement?.closest("#settings-editor-jobs-budget"), null, { timeout: 5000 })
    .then(() => true, () => false);
  assert.ok(reached, `focus is in the Core host editor (it is on ${await focused(page)})`);
}
const dialogFits = (page) => page.locator(".modal.settings-modal").evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.left >= 0 && r.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
});
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
  const runs = [["light", 1440, 5], ["light", 390, 6], ["dark", 1440, 7], ["dark", 390, 8]];
  for (const [theme, width, slots] of runs) {
    const context = await browser.newContext({ viewport: { width, height: width > 720 ? 900 : 844 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript((theme) => {
      window.EventSource = class { close() {} };
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    }, theme);
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(`${theme} ${width}: ${error.message}`));
    const tag = `${theme}-${width}`;
    try {
      await page.goto(base);
      const before = state.maxActive ?? 4;
      // ---- The Jobs card: read only, with the way to Settings.
      await page.locator("[aria-label='Jobs']").first().click({ timeout: 10_000 });
      // The open Jobs dialog's card: a closing dialog's fading copy has no role.
      const card = page.getByRole("dialog", { name: "Jobs", exact: true }).locator(".jobs-budget");
      await card.locator(".jobs-gpu").waitFor({ timeout: 10_000 });
      assert.equal(await card.locator(".jobs-budget-counts").innerText(), `3 of ${before} active · 1 queued`, "active against Jobs at once");
      assert.equal(await card.locator("input, select, textarea, details, form").count(), 0, "the card has no editor");
      assert.ok(await card.getByRole("button", { name: "Pause GPU work", exact: true }).isVisible(), "the GPU pause stays on the card");
      assert.ok(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the card does not scroll sideways");
      await card.screenshot({ path: resolve(output, `jobs-card-${tag}.png`), animations: "disabled" });
      await card.getByRole("button", { name: "Edit in Settings", exact: true }).click();
      const settings = page.locator(".modal.settings-modal");
      const host = settings.locator("#settings-editor-jobs-budget:not([hidden])");
      await host.waitFor({ timeout: 10_000 });
      await focusInHostEditor(page);
      assert.equal(await page.getByRole("dialog", { name: "Jobs", exact: true }).count(), 0, "Jobs closed as Settings opened");
      if (width > 720) assert.equal(await settings.getByRole("tab", { name: "Jobs & resources", exact: true }).getAttribute("aria-selected"), "true");
      else assert.equal(await settings.getByRole("combobox", { name: "Settings category", exact: true }).inputValue(), "jobs");
      check(`${tag}: the Jobs card only shows, and its Edit in Settings opens the Core host budget, focused`);

      // ---- The Core host budget: a new Jobs at once, saved with the budget.
      const form = host.locator(`[aria-label="This host's Job budget"]`);
      const field = form.getByLabel("Jobs at once", { exact: true });
      await field.waitFor();
      assert.equal(await field.inputValue(), String(before), "the field shows the number in effect");
      for (const group of ["Disk reserve", "Windows jobs", "GPU 0 · NVIDIA GeForce RTX 5090"])
        assert.equal(await host.locator(`[aria-label="${group}"]`).count(), 1, `${group} is in the Core host editor`);
      const layout = await fits(host);
      assert.deepEqual(layout, { scrolls: false, wider: [] }, `every field fits at ${width} px`);
      assert.ok(await dialogFits(page), "Settings fits the window");
      await field.fill(String(slots));
      const sent = report.writes.length;
      await form.getByRole("button", { name: "Save budget", exact: true }).click();
      await form.locator(".jobs-settings-now", { hasText: `In effect: ${slots} at once.` }).waitFor({ timeout: 10_000 });
      const post = report.writes.slice(sent).find((w) => w.path === "/api/jobs/budget");
      assert.deepEqual(post?.body, { cpuMillis: 8000, memoryMiB: 16384, swapMiB: 0, maxActive: slots }, "Jobs at once goes in the budget POST");
      await form.locator(".jobs-settings-now").scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(output, `settings-jobs-budget-${tag}.png`), animations: "disabled" });
      await host.locator(`[aria-label="GPU 0 · NVIDIA GeForce RTX 5090"]`).scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(output, `settings-jobs-gpu-${tag}.png`), animations: "disabled" });
      check(`${tag}: Jobs at once ${slots} is saved with the budget and read back; every field fits`, { layout });

      // ---- Remote budgets: SSH machines only; one chosen, its editor fits.
      await settings.locator(".settings-entries").getByRole("button", { name: "Remote budgets", exact: true }).click();
      const remote = settings.locator("#settings-editor-jobs-remote:not([hidden])");
      const picker = remote.getByLabel("Machine", { exact: true });
      await picker.waitFor({ timeout: 10_000 });
      assert.deepEqual(await picker.locator("option").evaluateAll((options) => options.map((o) => o.value)), ["", "mini", "lab"], "only SSH machines, none chosen");
      await picker.selectOption(width > 720 ? "mini" : "lab");
      const editor = remote.locator(".remote-machine-editor");
      await editor.waitFor();
      const remoteLayout = await fits(remote);
      assert.deepEqual(remoteLayout, { scrolls: false, wider: [] }, `the machine editor fits at ${width} px`);
      assert.ok(await dialogFits(page), "Settings fits the window with the machine editor");
      if (theme === "light" && width > 720) {
        await editor.getByLabel("Jobs at once", { exact: true }).fill("4");
        await editor.getByRole("button", { name: "Save changes", exact: true }).click();
        await remote.locator(".jobs-settings-saved", { hasText: "Saved Mac mini." }).waitFor({ timeout: 10_000 });
        const put = report.writes.find((w) => w.method === "PUT");
        assert.deepEqual(put?.body, { name: "Mac mini", target: "mac-mini", codex: "codex", defaultCwd: "/Users/fixture/projects", maxJobs: 4 }, "only the changed Jobs setting goes in the machine PUT");
      }
      await editor.scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(output, `settings-jobs-remote-${tag}.png`), animations: "disabled" });
      check(`${tag}: Remote budgets lists SSH machines only, and the chosen machine editor fits`, { remoteLayout });
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });
    } catch (error) {
      await page.screenshot({ path: resolve(output, `fail-${tag}.png`) }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  const writes = report.writes.filter((w) => !appOwn(w.path));
  assert.equal(writes.filter((w) => w.path === "/api/jobs/budget").length, runs.length, "one budget save per run");
  assert.equal(writes.filter((w) => w.method === "PUT" && w.path === "/api/machines/mini").length, 1, "one machine save");
  assert.equal(writes.length, runs.length + 1, "nothing else was written");
  assert.deepEqual(report.errors, [], "no page errors");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await browser?.close();
  server.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
console.log(`${report.checks.length} checks; report in ${resolve(output, "report.json")}`);
