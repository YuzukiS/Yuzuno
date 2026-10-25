// T-191: Runtime & versions in Settings, in Chromium, with a disposable
// fixture server (no Core): opened from Updates & about at 1280, 390 and
// 320 px; it fits, its facts and Read again are reachable, nothing is sent
// and no machine is checked, MCP services shows a Codex and a Claude Code
// Agent's last reports without asking either, and Check machines opens the
// Machines page. YUZUNO_CHECK_MODE=before
// takes the Updates & about screenshot of a build without it, with no checks.
//   YUZUNO_UI_DIST=<build> YUZUNO_BROWSER_OUTPUT=<dir> [YUZUNO_CHECK_MODE=before] node tools/runtime-settings-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "YUZUNO_UI_DIST: the web build to serve");
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "YUZUNO_BROWSER_OUTPUT: where screenshots and the report go");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
const before = process.env.YUZUNO_CHECK_MODE === "before";
await mkdir(output, { recursive: true });

const agents = [{
  id: "a", name: "Mori", cwd: "/fixture/project", model: "codex-fixture", color: "sage", harness: "codex", goal: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, status: "idle", connectionState: "connected",
  threadId: "thread-a", settings: { reasoningEffort: "low", approvalPolicy: "on-request", sandbox: "workspace-write" },
}, {
  id: "b", name: "Ume, a Claude Code Agent with a long name", cwd: "/fixture/project", model: "sonnet", color: "sage", harness: "claude", goal: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, status: "idle", connectionState: "connected",
}];
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const answers = () => ({
  "/api/updates": unmanagedUpdates,
  "/api/health": { version: "2026.10.24-core.17", releaseId: "core-20261024-c215011", apiReady: true, storageReady: true },
  "/api/workspace": { agents, runtime: { connected: true, account: "person@example.test" }, defaultCwd: "/fixture/project" },
  "/api/machines": {
    machines: [
      {
        id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture/project",
        lastCheck: {
          machineId: "local", startedAt: minutesAgo(5), checkedAt: minutesAgo(5), durationMs: 900, reachable: true,
          harnesses: [
            { harness: "codex", supported: true, found: true, version: "codex-cli 0.162.1", executable: "/usr/local/bin/codex" },
            { harness: "claude", supported: true, found: true, version: "2.1.296 (Claude Code)", signIn: { state: "signedIn", method: "claude.ai" } },
          ],
        },
      },
      {
        id: "box", name: "Build box with a long machine name", kind: "ssh", target: "builder@very-long-host-name.example.test", defaultCwd: "/srv", limitMode: "strict",
        lastCheck: {
          machineId: "box", startedAt: minutesAgo(180), checkedAt: minutesAgo(180), durationMs: 10_000, reachable: false,
          error: "ssh: connect to host very-long-host-name.example.test port 22: Connection timed out", harnesses: [],
        },
      },
    ],
  },
  "/api/jobs/budget": { machine: { name: "Core host", scope: "Only jobs managed by this Core share this budget." }, windows: { available: false, reason: "WSL interop is not available" } },
  "/api/home": { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] },
  "/api/machine-load": { at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
    memory: { totalMiB: 16384, usedMiB: 4096, availableMiB: 12288, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] },
  "/api/agents/a": { agent: agents[0], pending: [], artifacts: [], turns: [{ id: "t1", status: "completed", items: [{ id: "r1", type: "agentMessage", text: "Saved reply" }] }] },
  // Mori's startup reports, as Core keeps them; reading asks Codex nothing.
  "/api/agents/a/codex/mcp": { state: "observed", reason: "startup_reports", generation: 1, more: 0, servers: [
    { name: "files-service-with-a-very-long-configured-name-that-must-wrap-too", status: "ready", error: null, failureReason: null, observedAt: minutesAgo(3) },
    { name: "tracker", status: "failed", error: "startup timed out", failureReason: null, observedAt: minutesAgo(3) },
  ] },
  // What Ume's last read found (?cached=true); nothing asks it again here.
  "/api/agents/b/claude/mcp-status": {
    state: "ready", reason: "observed", generation: 1, sessionId: "s", checkedAt: minutesAgo(0), stale: false, freshForSeconds: 60,
    observation: { observedAt: minutesAgo(0), total: 2, truncated: false, servers: [
      { name: "docs-search-service-with-a-very-long-configured-name-that-must-wrap", status: "connected" },
      { name: "tracker", status: "failed", reason: "authentication" },
    ] },
  },
});
const calls = [];
const report = { mode: before ? "before" : "after", checks: [], screenshots: [], errors: [], console: [], requests: {} };
const check = (name) => {
  report.checks.push(name);
  console.log(name);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test");
  if (url.pathname.startsWith("/api/")) {
    for await (const _ of req);
    calls.push(`${req.method} ${url.pathname}${url.pathname.endsWith("/mcp-status") ? url.search : ""}`);
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture\n\n");
      return;
    }
    const value = answers()[url.pathname];
    // What this fixture doesn't serve, Core doesn't have here.
    res.writeHead(value === undefined ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value ?? { error: "Not served by this fixture" }));
    return;
  }
  const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  const file = path.startsWith(dist + sep) ? await readFile(path).catch(() => null) : null;
  const served = file ?? (await readFile(resolve(dist, "index.html")));
  res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" }[file ? extname(path) : ".html"] || "application/octet-stream" });
  res.end(served);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function shot(target, name) {
  await target.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  report.screenshots.push(`${name}.png`);
}
const runtimeReads = () => calls.filter((c) => /^GET \/api\/(health|machines|workspace|jobs\/budget)$/.test(c));

try {
  for (const [label, width, height, phone] of [["desktop", 1280, 860, false], ["390", 390, 844, true], ["320", 320, 700, true]]) {
    calls.length = 0;
    const context = await browser.newContext({ viewport: { width, height }, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
    await page.goto(origin);
    await page.getByRole("button", { name: "Settings and updates" }).waitFor();
    await page.getByRole("button", { name: "Settings and updates" }).click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, `${label}-updates-about`);
    if (!before) {
      // In Updates & about's row of entries (T-187).
      const open = page.locator(".settings-entries").getByRole("button", { name: "Runtime", exact: true });
      await open.waitFor();
      // The app itself reads the Workspace and machines; that nothing of the
      // section is read before it opens is checked in runtime-settings-ui.
      // Requests from here on are the section's (and the app's own views').
      const opened = calls.length;
      await open.click();
      const section = page.locator("#settings-runtime");
      await section.locator(".runtime-fact").first().waitFor();
      await page.waitForTimeout(200);
      const fit = await section.evaluate((el, width) => {
        const r = el.getBoundingClientRect();
        const overflow = [...el.querySelectorAll("*")].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== "auto").map((n) => n.className);
        return { left: r.left, right: r.right, inside: r.left >= 0 && r.right <= width, overflow, page: document.documentElement.scrollWidth <= innerWidth };
      }, width);
      assert.ok(fit.inside && fit.page && fit.overflow.length === 0, `the section fits ${width} px: ${JSON.stringify(fit)}`);
      // The dialog is at most 720 px tall and only its pane scrolls: the
      // section is shot screen by screen as the pane scrolls through it.
      const pane = page.locator(".settings-pane");
      const steps = await pane.evaluate((el) => {
        const r = el.querySelector("#settings-runtime").getBoundingClientRect();
        const top = el.scrollTop + r.top - el.getBoundingClientRect().top - 8;
        const bottom = top + r.height + 8;
        const stops = [];
        for (let y = top; y < bottom; y += Math.max(1, el.clientHeight - 40)) stops.push(y);
        return stops;
      });
      assert.ok(steps.length <= 12, `the section takes ${steps.length} screens at ${width} px`);
      for (const [i, y] of steps.entries()) {
        await pane.evaluate((el, y) => (el.scrollTop = y), y);
        await page.waitForTimeout(80);
        await shot(page, `${label}-runtime-${i + 1}`);
      }
      const box = section.locator(".runtime-machine", { hasText: "Build box" });
      assert.match(await box.locator(".runtime-checked").textContent(), /older than an hour$/);
      // Keyboard: Read again and Check machines take focus.
      for (const name of ["Read again", "Check machines"]) {
        const control = section.getByRole("button", { name });
        await control.focus();
        assert.equal(await control.evaluate((el) => el === document.activeElement), true, `${name} takes focus`);
      }
      assert.ok(runtimeReads().some((c) => c.endsWith("/api/health")), "Core's version is read once it opens");
      // MCP services: Mori (Codex) first, then switched to Ume (Claude Code).
      const mcp = section.locator(".runtime-mcp");
      await mcp.locator('[aria-label="Codex MCP services"] .mcp-server-list li').nth(1).waitFor();
      await mcp.locator("select").selectOption("b");
      await mcp.locator('[aria-label="Claude MCP services"] .mcp-server-list li').nth(1).waitFor();
      await mcp.scrollIntoViewIfNeeded();
      await page.waitForTimeout(80);
      await shot(page, `${label}-runtime-mcp-claude`);
      assert.deepEqual(calls.slice(opened).filter((c) => /\/(codex\/mcp|mcp-status)/.test(c)),
        ["GET /api/agents/a/codex/mcp", "GET /api/agents/b/claude/mcp-status?cached=true"],
        "each report shown is the last one kept; nothing asks Codex or Claude Code without Refresh");
      await mcp.locator("select").selectOption("a");
      await mcp.locator('[aria-label="Codex MCP services"] .mcp-server-list li').nth(1).waitFor();
      check(`${label}: Runtime & versions opens from Updates & about, fits, marks the stale check, and its controls take focus`);
      await section.getByRole("button", { name: "Read again" }).click();
      await page.waitForTimeout(300);
      await section.getByRole("button", { name: "Check machines" }).click();
      await page.locator(".machines-page").waitFor();
      await shot(page, `${label}-machines`);
      // Every request of this window, kept before anything is asserted. The
      // app's own views (an open conversation's inspector, for one) read too;
      // the section's own requests are exactly checked in runtime-settings-ui.
      report.requests[label] = [...calls];
      const sent = calls.filter((c) => !c.startsWith("GET "));
      assert.deepEqual(sent, [], "only reads: nothing is sent");
      assert.ok(!calls.some((c) => /\/machines\/[^/]+\/check$/.test(c)), "no machine check");
      check(`${label}: Read again reads again; Check machines opens the Machines page; only GETs, no machine check`);
    }
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
