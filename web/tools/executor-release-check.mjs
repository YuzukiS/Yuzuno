// T-34 S4: releasing an executor in the app, in Chromium. Disposable browser
// + fixture server; never connects to a daily Core. Release asks first and
// posts once; the released executor is shown closed with why, and offers no
// Reopen, before and after a reload.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";

const WORKSPACE = "ws-executor-release";
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/executor-release/browser");
const dist = resolve(process.env.YUZUNO_UI_DIST || "../acceptance/executor-release/web-dist");
assert.notEqual(dist, resolve("dist"));
const baseAgent = {
  cwd: "/fixture/project", model: "codex-fixture", color: "sage", status: "idle", harness: "codex",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  settings: { reasoningEffort: "low", approvalPolicy: "on-request", sandbox: "workspace-write" },
};
const agents = [
  { ...baseAgent, id: "s1", name: "Mori" },
  { ...baseAgent, id: "e1", name: "T-7 · Reviewer", kind: "executor" },
];
const calls = [];
const report = { checks: [], errors: [] };
const check = (name) => {
  report.checks.push(name);
  console.log(name);
};
let browser;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.test");
    if (url.pathname.startsWith("/api/")) {
      for await (const _ of req);
      calls.push({ path: url.pathname, method: req.method });
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": fixture\n\n");
        return;
      }
      const id = url.pathname.split("/")[3];
      const agent = agents.find((a) => a.id === id);
      let result = {};
      if (url.pathname === "/api/workspace")
        result = { workspace: { id: WORKSPACE }, agents, runtime: { connected: true }, defaultCwd: "/fixture/project" };
      else if (url.pathname === "/api/machines")
        result = { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture/project" }] };
      else if (url.pathname === "/api/home")
        result = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
      else if (url.pathname === "/api/machine-load")
        result = {
          at: new Date().toISOString(),
          cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
          memory: { totalMiB: 16384, usedMiB: 4096, availableMiB: 12288, jobsMiB: 0, agentsMiB: null },
          gpus: null, jobs: [],
        };
      else if (url.pathname.endsWith("/release") && req.method === "POST") {
        // As Core answers executor_release: the close's time is the release's.
        const at = new Date().toISOString();
        Object.assign(agent, { closedAt: at, releasedAt: at, releasedBy: "user", status: "offline" });
        result = { agentId: agent.id, closedAt: at, releasedAt: at, releasedBy: "user" };
      } else if (agent)
        result = {
          agent, pending: [], artifacts: [],
          turns: [{ id: `${id}-turn`, status: "completed", items: [{ id: `${id}-reply`, type: "agentMessage", text: `Saved reply from ${agent.name}` }] }],
        };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(path.startsWith(dist + "/"));
    const content = await readFile(path);
    res.writeHead(200, {
      "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" }[extname(path)]
        || "application/octet-stream",
    });
    res.end(content);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
try {
  await mkdir(output, { recursive: true });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "Open T-7 · Reviewer", exact: true }).click();
  await page.getByText("Saved reply from T-7 · Reviewer", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Release executor/ }).click();
  await dialog.getByText("Release T-7 · Reviewer?", { exact: true }).waitFor();
  assert.match(await dialog.innerText(), /can't be reopened/);
  await dialog.getByRole("button", { name: "Keep agent", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(calls.filter((c) => c.path.endsWith("/release")).length, 0);
  check("Release is offered for an executor and asks first; Keep posts nothing");

  await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage…", exact: true }).click();
  await dialog.getByRole("button", { name: /^Release executor/ }).click();
  await dialog.getByRole("button", { name: "Release executor", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const note = page.locator(".closed-agent-note");
  await note.waitFor();
  assert.match(await note.innerText(), /This executor was released and stays closed\. Dispatch its task again for new work\./);
  assert.equal(await note.getByRole("button", { name: "Reopen", exact: true }).count(), 0, "no Reopen for a released executor");
  await page.getByText("T-7 · Reviewer is released and stays in Closed.", { exact: false }).waitFor();
  assert.deepEqual(calls.filter((c) => c.path.endsWith("/release")).map((c) => c.method), ["POST"]);
  assert.equal(calls.filter((c) => c.path.endsWith("/reopen") || c.path.endsWith("/close")).length, 0);
  await page.screenshot({ path: resolve(output, "released.png") });
  check("Release posts once; the executor shows closed and released, with no Reopen");

  await page.reload();
  await note.waitFor();
  assert.match(await note.innerText(), /This executor was released and stays closed\./);
  assert.equal(await note.getByRole("button", { name: "Reopen", exact: true }).count(), 0);
  assert.equal(await page.locator(".agent-close-button").count(), 0, "nor a Reopen button in its header");
  check("After a reload, the released executor still offers no Reopen");
  assert.deepEqual(report.errors, []);
} finally {
  await browser?.close();
  server.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
