// T-184: an Agent's action menu and the offline Reconnect, in Chromium, with
// a disposable fixture server (no Core): screenshots at 1280, 390 and 320 px.
// YUZUNO_CHECK_MODE=before takes the same screenshots of a build without the
// menu (main), with no checks; otherwise every step is checked too.
//   YUZUNO_UI_DIST=<build> YUZUNO_BROWSER_OUTPUT=<dir> [YUZUNO_CHECK_MODE=before] node tools/agent-actions-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST, "YUZUNO_UI_DIST: the web build to serve");
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "YUZUNO_BROWSER_OUTPUT: where screenshots and the report go");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
const before = process.env.YUZUNO_CHECK_MODE === "before";
await mkdir(output, { recursive: true });

const base = {
  cwd: "/fixture/project", model: "codex-fixture", color: "sage", harness: "codex", goal: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  settings: { reasoningEffort: "low", approvalPolicy: "on-request", sandbox: "workspace-write" },
};
// Mori's session is offline after a Core restart, its last turn finished;
// Hana is working; Old friend is closed.
const fresh = () => [
  { ...base, id: "a", name: "Mori", status: "offline", connectionState: "disconnected", threadId: "thread-a" },
  { ...base, id: "b", name: "Hana", status: "working", connectionState: "connected", threadId: "thread-b" },
  { ...base, id: "c", name: "Old friend", status: "offline", connectionState: "disconnected", threadId: "thread-c", closedAt: "2026-10-12" },
];
let agents = fresh();
const calls = [];
const report = { mode: before ? "before" : "after", checks: [], screenshots: [], errors: [], console: [], requests: {} };
const check = (name) => {
  report.checks.push(name);
  console.log(name);
};
// Each window starts with fresh Agents and its own request list.
let current = null;
const keep = () => current && (report.requests[current] = [...calls]);
function section(name) {
  keep();
  agents = fresh();
  calls.length = 0;
  current = name;
}
const posts = (path) => calls.filter((c) => c.method === "POST" && c.path === path).length;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test");
  if (url.pathname.startsWith("/api/")) {
    for await (const _ of req);
    calls.push({ method: req.method, path: url.pathname, ...(url.search ? { search: url.search } : {}) });
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture\n\n");
      return;
    }
    const [, , kind, id, action] = url.pathname.split("/");
    const agent = kind === "agents" ? agents.find((a) => a.id === id) : undefined;
    let result = {};
    // What this fixture doesn't serve, Core doesn't have here.
    let missing = false;
    if (url.pathname === "/api/workspace") result = { agents, runtime: { connected: true }, defaultCwd: "/fixture/project" };
    else if (url.pathname === "/api/machines") result = { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture/project" }] };
    else if (url.pathname.endsWith("/models")) result = { models: [{ id: "codex-fixture", model: "codex-fixture", displayName: "Codex fixture", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }] };
    else if (url.pathname === "/api/home") result = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
    else if (url.pathname === "/api/machine-load")
      result = { at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
        memory: { totalMiB: 16384, usedMiB: 4096, availableMiB: 12288, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };
    else if (agent && action === "reconnect" && req.method === "POST") {
      // As Core reports it once the same session is back.
      Object.assign(agent, { connectionState: "connected", status: "idle" });
    } else if (agent && action === "interrupt" && req.method === "POST") {
      Object.assign(agent, { status: "idle" });
    } else if (agent && action) missing = true;
    else if (agent)
      result = {
        agent, pending: [], artifacts: [],
        turns: [{ id: `${id}-turn`, status: agent.status === "working" ? "inProgress" : "completed",
          items: [{ id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: "Please review the layout." }] },
            { id: `${id}-reply`, type: "agentMessage", text: `Saved reply from ${agent.name}` }] }],
      };
    res.writeHead(missing ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(missing ? { error: "Not served by this fixture" } : result));
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
async function shot(page, name) {
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
  // Never a passing step on the app's error screen.
  assert.equal(await page.locator("#app-recovery-title").count(), 0, `${name}: the app fell to its error screen: ${JSON.stringify(report.console)}`);
}
function watch(page) {
  page.on("pageerror", (error) => report.errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
}
const menu = (page) => page.locator('[role="menu"]');
const row = (page, id) => page.locator(`.agent-row[data-agent-id="${id}"]`);
const hint = (page) => page.locator(".composer-bottom > .composer-hint");

try {
  // Desktop.
  {
    section("desktop");
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    watch(page);
    await page.goto(origin);
    await row(page, "a").waitFor();
    await row(page, "a").locator(".agent-select").click();
    await page.locator(".composer-bottom").waitFor();
    if (before) {
      await page.waitForTimeout(500);
      await shot(page, "desktop-offline");
    } else {
      await page.locator(".recovery-notice button", { hasText: "Reconnect" }).waitFor();
      assert.equal(await hint(page).textContent(), "Reconnect above, or send a message to resume this session");
      await shot(page, "desktop-offline");
      check("Offline Mori shows Reconnect in its notice, and the composer points to it");
      await row(page, "b").click({ button: "right", position: { x: 60, y: 18 } });
      await menu(page).waitFor();
      assert.deepEqual(await menu(page).locator('[role="menuitem"]').allTextContents(),
        ["Interrupt current turn", "Agent settings…", "Manage…"]);
      await shot(page, "desktop-row-menu");
      await page.keyboard.press("Escape");
      await menu(page).waitFor({ state: "detached" });
      assert.equal(posts("/api/agents/b/interrupt"), 0);
      check("A right-click on Hana opens her menu; Escape closes it and interrupts nothing");
      await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
      await menu(page).waitFor();
      assert.deepEqual(await menu(page).locator('[role="menuitem"]').allTextContents(),
        ["Reconnect", "Agent settings…", "Manage…"]);
      await shot(page, "desktop-header-menu");
      await page.keyboard.press("Escape");
      check("The header's Conversation actions is the same menu, for Mori");
      await page.locator(".recovery-notice button", { hasText: "Reconnect" }).click();
      await page.locator(".recovery-notice").waitFor({ state: "detached" });
      // Still Mori's conversation, as Core now reports her: connected, idle.
      await page.getByRole("textbox", { name: "Message Mori" }).waitFor();
      assert.equal(await hint(page).getAttribute("data-notice"), null, "no offline hint once connected");
      assert.equal(posts("/api/agents/a/reconnect"), 1);
      assert.equal(calls.filter((c) => c.path.includes("/messages")).length, 0);
      await shot(page, "desktop-after-reconnect");
      check("Reconnect sent one request and no message; Core's answer took the notice away");
      // Hana is working: Escape in her menu does not interrupt; its entry does, once.
      await row(page, "b").locator(".agent-select").click();
      await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
      await menu(page).waitFor();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      assert.equal(posts("/api/agents/b/interrupt"), 0);
      await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
      await menu(page).getByRole("menuitem", { name: "Interrupt current turn" }).click();
      await page.waitForTimeout(300);
      assert.equal(posts("/api/agents/b/interrupt"), 1);
      check("Working Hana: Escape in the menu interrupts nothing; Interrupt current turn sends one request");
    }
    await context.close();
  }
  // Phones.
  for (const [width, height] of [[390, 844], [320, 700]]) {
    section(`${width}`);
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    watch(page);
    await page.goto(origin);
    await row(page, "b").waitFor();
    await page.waitForTimeout(300);
    await shot(page, `${width}-list`);
    if (!before) {
      const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
      report[`coarse${width}`] = coarse;
      const box = await row(page, "b").boundingBox();
      const press = (type) => row(page, "b").dispatchEvent(type, { pointerType: "touch", isPrimary: true, pointerId: 3, clientX: box.x + 60, clientY: box.y + 18, bubbles: true });
      // A touch the browser cancels (a scroll) opens nothing.
      await press("pointerdown");
      await press("pointercancel");
      await page.waitForTimeout(700);
      assert.equal(await menu(page).count(), 0);
      await press("pointerdown");
      await page.waitForTimeout(700);
      await menu(page).waitFor();
      const shown = await menu(page).boundingBox();
      assert.ok(shown.x >= 0 && shown.x + shown.width <= width && shown.y + shown.height <= height, `the menu fits ${width} px: ${JSON.stringify(shown)}`);
      if (coarse) {
        const item = await menu(page).locator('[role="menuitem"]').first().boundingBox();
        assert.ok(item.height >= 44, `a menu entry is a 44 px touch target: ${item.height}`);
      }
      await shot(page, `${width}-long-press-menu`);
      await press("pointerup");
      await page.keyboard.press("Escape");
      await menu(page).waitFor({ state: "detached" });
      assert.equal(posts("/api/agents/b/interrupt"), 0);
      check(`${width} px: a long-press opens Hana's menu inside the screen; a cancelled touch opens nothing${coarse ? "; its entries are 44 px" : ""}`);
      await row(page, "a").getByRole("button", { name: "Actions for Mori" }).tap();
      await menu(page).waitFor();
      assert.deepEqual(await menu(page).locator('[role="menuitem"]').allTextContents(),
        ["Reconnect", "Agent settings…", "Manage…"]);
      await shot(page, `${width}-row-menu`);
      await page.keyboard.press("Escape");
      await menu(page).waitFor({ state: "detached" });
      check(`${width} px: Mori's visible "…" opens the same menu, with Reconnect`);
    }
    // Mori's conversation, offline.
    await row(page, "a").locator(".agent-select").tap();
    await page.locator(".composer-bottom").waitFor();
    await page.waitForTimeout(500);
    await shot(page, `${width}-offline`);
    if (!before) {
      const notice = await page.locator(".recovery-notice").boundingBox();
      assert.ok(notice.x >= 0 && notice.x + notice.width <= width, `the notice fits ${width} px: ${JSON.stringify(notice)}`);
      await page.getByRole("button", { name: "Conversation actions", exact: true }).tap();
      await menu(page).waitFor();
      await shot(page, `${width}-header-menu`);
      await menu(page).getByRole("menuitem", { name: "Reconnect" }).tap();
      await page.locator(".recovery-notice").waitFor({ state: "detached" });
      await page.getByRole("textbox", { name: "Message Mori" }).waitFor();
      assert.equal(posts("/api/agents/a/reconnect"), 1);
      assert.equal(calls.filter((c) => c.path.includes("/messages")).length, 0);
      await shot(page, `${width}-after-reconnect`);
      check(`${width} px: the conversation's actions reconnect Mori with one request and no message`);
    }
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  keep();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
