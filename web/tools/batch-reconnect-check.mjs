// T-184: reconnecting several Agents after Core restarted, in Chromium, with
// a disposable fixture server (no Core): five Agents offline, one of which
// fails its first reconnect. Screenshots at 1280, 390 and 320 px.
// YUZUNO_CHECK_MODE=before takes the list screenshots of a build without it
// (the Agent action menu's head), with no checks.
//   YUZUNO_UI_DIST=<build> YUZUNO_BROWSER_OUTPUT=<dir> [YUZUNO_CHECK_MODE=before] node tools/batch-reconnect-check.mjs
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
  status: "offline", connectionState: "disconnected",
};
// After a Core restart: five sessions not connected, one closed Agent that
// must stay closed, one connected.
const names = ["Mori", "Hana", "Sora", "Ren", "Yuki"];
const fresh = () => [
  ...names.map((name, i) => ({ ...base, id: String.fromCharCode(97 + i), name, threadId: `thread-${i}` })),
  { ...base, id: "z", name: "Old friend", threadId: "thread-z", closedAt: "2026-10-12" },
  { ...base, id: "k", name: "Kai", threadId: "thread-k", status: "idle", connectionState: "connected" },
];
let agents = fresh();
let failYuki = true;
const calls = [];
const flight = { now: 0, most: 0 };
const report = { mode: before ? "before" : "after", checks: [], screenshots: [], errors: [], console: [], requests: {} };
const check = (name) => {
  report.checks.push(name);
  console.log(name);
};
let current = null;
const keep = () => current && (report.requests[current] = { calls: [...calls], mostInFlight: flight.most });
function section(name) {
  keep();
  agents = fresh();
  failYuki = true;
  calls.length = 0;
  flight.most = 0;
  current = name;
}
const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.path);

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
    let status = 200;
    if (url.pathname === "/api/workspace") result = { agents, runtime: { connected: true }, defaultCwd: "/fixture/project" };
    else if (url.pathname === "/api/machines") result = { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture/project" }] };
    else if (url.pathname.endsWith("/models")) result = { models: [{ id: "codex-fixture", model: "codex-fixture", displayName: "Codex fixture", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }] };
    else if (url.pathname === "/api/home") result = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
    else if (url.pathname === "/api/machine-load")
      result = { at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
        memory: { totalMiB: 16384, usedMiB: 4096, availableMiB: 12288, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };
    else if (agent && action === "reconnect" && req.method === "POST") {
      // Long enough to see how many run at once.
      flight.now++;
      flight.most = Math.max(flight.most, flight.now);
      await new Promise((done) => setTimeout(done, 400));
      flight.now--;
      if (agent.id === "e" && failYuki) {
        failYuki = false;
        status = 503;
        result = { error: "Codex did not start in time" };
      } else {
        // As Core reports it once the same session is back.
        Object.assign(agent, { connectionState: "connected", status: "idle" });
        result = { agent };
      }
    } else if (agent && action) {
      // What this fixture doesn't serve, Core doesn't have here.
      status = 404;
      result = { error: "Not served by this fixture" };
    } else if (agent)
      result = {
        agent, pending: [], artifacts: [],
        turns: [{ id: `${id}-turn`, status: "completed",
          items: [{ id: `${id}-reply`, type: "agentMessage", text: `Saved reply from ${agent.name}` }] }],
      };
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
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
  // Animations finished: a dialog is shown as it settles, not mid-fade.
  await page.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  report.screenshots.push(`${name}.png`);
  // Never a passing step on the app's error screen.
  assert.equal(await page.locator("#app-recovery-title").count(), 0, `${name}: the app fell to its error screen: ${JSON.stringify(report.console)}`);
}
function watch(page) {
  page.on("pageerror", (error) => report.errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
}
const rows = (page) =>
  page.locator(".batch-row").evaluateAll((nodes) =>
    nodes.map((n) => `${n.querySelector(".batch-name").textContent} ${n.querySelector("input").checked ? "[x]" : "[ ]"} ${n.querySelector(".batch-state").textContent}`));
const fits = (page, selector, width) =>
  page.locator(selector).evaluate((el, width) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= width && el.scrollWidth <= el.clientWidth + 1;
  }, width);

try {
  for (const [label, width, height, phone] of [["desktop", 1280, 800, false], ["390", 390, 844, true], ["320", 320, 700, true]]) {
    section(label);
    const context = await browser.newContext({ viewport: { width, height }, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage();
    watch(page);
    await page.goto(origin);
    await page.locator('.agent-row[data-agent-id="a"]').waitFor();
    await page.waitForTimeout(300);
    await shot(page, `${label}-list`);
    if (!before) {
      const trigger = page.getByRole("button", { name: "Reconnect agents: 5 not connected" });
      await trigger.waitFor();
      assert.ok(await fits(page, ".rail-heading", width), `the rail heading fits at ${width} px`);
      const press = (locator) => (phone ? locator.tap() : locator.click());
      await press(trigger);
      await page.locator(".batch-reconnect").waitFor();
      assert.deepEqual(await rows(page), names.map((name) => `${name} [ ] Offline`), "Old friend (closed) and Kai (connected) are not listed; none chosen");
      assert.ok(await fits(page, ".batch-reconnect", width), `the dialog fits at ${width} px`);
      await shot(page, `${label}-dialog`);
      check(`${label}: the rail offers 5; the dialog lists them, closed and connected left out, none chosen`);
      await press(page.getByRole("button", { name: "Select all" }));
      await press(page.getByRole("button", { name: "Reconnect 5" }));
      await page.waitForTimeout(150);
      await shot(page, `${label}-running`);
      await page.locator(".batch-row .spin").first().waitFor({ state: "detached", timeout: 10000 });
      assert.deepEqual(await rows(page), [
        ...names.slice(0, 4).map((name) => `${name} [ ] Connected · Ready`),
        "Yuki [x] Couldn’t reconnect: Codex did not start in time",
      ]);
      assert.ok(flight.most <= 3, `at most 3 at once: ${flight.most}`);
      await shot(page, `${label}-results`);
      check(`${label}: 5 reconnects, at most ${flight.most} at once; each row says what Core answered; Yuki's failure stays chosen`);
      await press(page.locator(".batch-row", { hasText: "Yuki" }).getByRole("button", { name: "Retry" }));
      await page.locator(".batch-row", { hasText: "Yuki" }).getByText("Connected · Ready").waitFor();
      await shot(page, `${label}-retried`);
      assert.deepEqual(posts().sort(), [...names.map((_, i) => `/api/agents/${String.fromCharCode(97 + i)}/reconnect`), "/api/agents/e/reconnect"].sort());
      check(`${label}: Retry reconnects Yuki; only reconnects were sent (no message, reopen or interrupt), and none for Old friend`);
      await page.keyboard.press("Escape");
      await page.locator(".batch-reconnect").waitFor({ state: "detached" });
      await page.getByRole("button", { name: /^Reconnect agents/ }).waitFor({ state: "detached" });
      check(`${label}: Escape closes it; with every Agent connected the rail button is gone`);
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
