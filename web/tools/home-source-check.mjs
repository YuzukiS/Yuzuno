// Opening an Agent's item from Home (T-85; Home replaced Catch up): an Agent
// error, an approval outside any project from the needs-you row, and an
// approval's proposed changes open the conversation at that item, focused
// and in view, with "Back to Home". Opening a source never marks the
// conversation read: no read receipt or other write reaches Core, even after
// the read dwell. An approval inside a project stays on Home.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/home-source");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-home-source.test";
const report = { checks: [], errors: [], unexpected: [], writes: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const base = {
  cwd: "/fixture",
  model: "test-model",
  settings: {},
  color: "sage",
  createdAt: "",
  updatedAt: "",
  harness: "codex",
  closedAt: null,
};
// Each Agent has unread turns, so a read receipt would be due if Home's
// navigation counted as reading.
const agents = [
  { ...base, id: "mori", name: "Mori", projectId: "p1", status: "error", error: "Codex app-server exited (code 1)", unreadCount: 2, pendingCount: 0, lastSeq: 12, reviewedSeq: 10 },
  { ...base, id: "kumo", name: "Kumo", projectId: "p1", status: "waiting", unreadCount: 1, pendingCount: 1, lastSeq: 6, reviewedSeq: 5 },
  { ...base, id: "yuki", name: "Yuki", projectId: null, status: "waiting", unreadCount: 1, pendingCount: 1, lastSeq: 4, reviewedSeq: 3 },
];
const projects = [{ id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const fileChange = {
  id: "req-7",
  agentId: "kumo",
  method: "item/fileChange/requestApproval",
  params: { itemId: "fc-1", turnId: "kumo-t2", grantRoot: "/fixture/app", reason: "Update the Home copy" },
  createdAt: iso(-9 * 60_000),
};
const command = {
  id: "req-9",
  agentId: "yuki",
  method: "item/commandExecution/requestApproval",
  params: { command: "rm -rf build", cwd: "/fixture/notes", reason: "Clean the build folder", itemId: "cmd-9", turnId: "yuki-t1" },
  createdAt: iso(-20 * 60_000),
};
// Enough earlier turns that the item is below the first screen.
const earlier = (id, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${id}-old-${i}`,
    status: "completed",
    items: [
      { id: `${id}-old-u-${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：继续整理首页。` }] },
      { id: `${id}-old-r-${i}`, type: "agentMessage", text: Array.from({ length: 4 }, (_, k) => `进度 ${k + 1}：检查面板、需要你和机器负载。`).join("\n\n") },
    ],
  }));
const details = {
  mori: { pending: [], turns: [...earlier("mori", 8), { id: "mori-t9", status: "failed", items: [{ id: "mori-u9", type: "userMessage", content: [{ type: "text", text: "跑一下测试" }] }] }] },
  kumo: {
    pending: [fileChange],
    turns: [
      ...earlier("kumo", 8),
      {
        id: "kumo-t2",
        status: "inProgress",
        items: [
          { id: "kumo-u2", type: "userMessage", content: [{ type: "text", text: "改一下首页文案" }] },
          { id: "fc-1", type: "fileChange", status: "inProgress", changes: [{ path: "/fixture/app/web/src/home/Home.tsx", kind: { type: "update" }, diff: "-Catch up\n+Home" }] },
        ],
      },
    ],
  },
  yuki: {
    pending: [command],
    turns: [
      ...earlier("yuki", 8),
      { id: "yuki-t1", status: "inProgress", items: [{ id: "yuki-u1", type: "userMessage", content: [{ type: "text", text: "清理一下" }] }, { id: "cmd-9", type: "commandExecution", status: "inProgress", command: "rm -rf build", cwd: "/fixture/notes" }] },
    ],
  },
};
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text }, children: [] } } });
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [
    { kind: "approval", projectId: "p1", agentId: "kumo", agentName: "Kumo", requestId: "req-7", title: "Update the Home copy", since: fileChange.createdAt },
    { kind: "approval", projectId: null, agentId: "yuki", agentName: "Yuki", requestId: "req-9", title: "Clean the build folder", since: command.createdAt },
  ],
  projects: [
    {
      project: { id: "p1", name: "Yuzuno app" },
      agents: { working: 0, idle: 0, waiting: 1, error: 1, offline: 0, total: 2 },
      errors: [{ agentId: "mori", agentName: "Mori", message: "Codex app-server exited (code 1)", at: iso(-5 * 60_000) }],
      pending: [{ ...fileChange, agentName: "Kumo" }],
      jobs: [],
      brief: {
        version: 2,
        history: [],
        sections: [
          {
            key: "status",
            kind: "report",
            title: "Copy changes",
            version: 1,
            owner: { agentId: "kumo", name: "Kumo", state: "active" },
            updatedAt: iso(-30 * 60_000),
            updatedTurnId: null,
            body: markdown("The Home copy is being updated."),
            attachments: [],
            refs: {},
            seen: null,
            history: false,
          },
        ],
      },
      unseen: 1,
      missing: [],
    },
  ],
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    if (!localStorage.getItem("home-source-fixture")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
      // Remembered outside the remembered project: the window starts on Home
      // and no conversation is read before the check opens one.
      localStorage.setItem("yuzuno.selected", JSON.stringify("yuki"));
      localStorage.setItem("yuzuno.projectScope.ws", JSON.stringify("project:p1"));
      localStorage.setItem("home-source-fixture", "seeded");
    }
  });
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`console: ${message.text()}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    const path = url.pathname;
    if (request.method() !== "GET" && path.startsWith("/api/")) {
      // A list read sent as a POST: the project's linked repositories.
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
      report.writes.push({ method: request.method(), path, body: request.postDataJSON() });
      return route.fulfill({ status: 409, json: { error: "This check allows no writes." } });
    }
    const agent = agents.find((a) => path === `/api/agents/${a.id}`);
    if (agent) return route.fulfill({ json: { agent, messageReceipts: [], artifacts: [], ...details[agent.id] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 2, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/home": home(),
      "/api/machine-load": {
        at: new Date().toISOString(),
        cpu: { cores: 8, totalPct: 20, jobsPct: 0, agentsPct: null, otherPct: null },
        memory: { totalMiB: 16384, usedMiB: 6000, availableMiB: 10384, jobsMiB: 0, agentsMiB: null },
        gpus: null,
        jobs: [],
      },
      "/api/updates": unmanagedUpdates,
      "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs,
      "/api/ci": noCiRuns,
      "/api/reviews": noReviews,
      "/api/backlog": { observedAt: new Date().toISOString(), agents: {} },
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] },
      "/api/models": { models: [] },
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) {
      report.unexpected.push(path);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    return route.fulfill({
      body: await readFile(file),
      contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml" }[extname(file)],
    });
  });
  await page.goto(`https://${HOST}/`);
  const panel = page.locator(".home-view #home-project-p1");
  await panel.waitFor();

  /** The opened item: focused, inside the conversation's view, and how it looks. */
  const opened = (selector) =>
    page.waitForFunction((selector) => {
      const target = document.querySelector(selector);
      const view = target?.closest(".conversation-scroll");
      if (!target || !view || document.activeElement !== target) return null;
      const box = target.getBoundingClientRect();
      const frame = view.getBoundingClientRect();
      if (!(box.top >= frame.top - 1 && box.top < frame.bottom)) return null;
      return {
        top: Math.round(box.top - frame.top),
        scrolled: Math.round(view.scrollTop),
        highlighted: target.classList.contains("source-highlight"),
        open: target instanceof HTMLDetailsElement ? target.open : null,
      };
    }, selector).then((handle) => handle.jsonValue());
  const backToHome = async (name) => {
    assert.match(await page.locator(".source-navigation").innerText(), /Back to Home/);
    // Longer than the read dwell (1.2 s): reading would have been recorded by now.
    await sleep(2000);
    assert.deepEqual(report.writes, [], `${name}: no read receipt or other write`);
    await page.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
    report.screenshots.push(`${name}.png`);
    await page.getByRole("button", { name: "Back to Home", exact: true }).click();
    await panel.waitFor();
    assert.equal(await page.locator(".conversation-header").count(), 0);
  };

  // An Agent's error, from the project's explicit team-details entry.
  await panel.locator(".home-team-details > summary").click();
  await panel.locator(".home-errors").getByRole("button", { name: "Mori", exact: true }).click();
  await page.locator(".conversation-header h1", { hasText: "Mori" }).waitFor();
  const error = await opened("#runtime-error-mori");
  assert.ok(error.scrolled > 0, "the error is below the first screen; the conversation was scrolled to it");
  await backToHome("error-from-home");
  check("an Agent error on Home opens its conversation at the error, focused and in view, and leads back to Home without a read receipt", error);

  // An approval inside a project stays on Home.
  await page.locator('[data-needs-you="approval:req-7"]').click();
  await page.waitForFunction(() => document.activeElement?.id === "home-request-req-7");
  assert.equal(await page.locator(".conversation-header").count(), 0);
  check("a project's approval in the needs-you row is shown and focused on Home, not in a conversation");

  // An approval outside any project lives in its conversation.
  await page.locator('[data-needs-you="approval:req-9"]').click();
  await page.locator(".conversation-header h1", { hasText: "Yuki" }).waitFor();
  const outside = await opened("#request-req-9");
  assert.ok(outside.highlighted, "the request is highlighted as the source");
  await backToHome("approval-outside-project");
  check("an approval of an Agent outside any project opens its conversation at the request, highlighted and focused, and leads back to Home without a read receipt", outside);

  // An approval's proposed changes, from the project panel.
  await panel.locator(".home-approval").getByRole("button", { name: /View proposed changes/ }).click();
  await page.locator(".conversation-header h1", { hasText: "Kumo" }).waitFor();
  const changes = await opened("#item-fc-1");
  assert.equal(changes.open, true, "the change itself is opened");
  await backToHome("proposed-changes-from-home");
  check("View proposed changes on Home opens the conversation at the file change, open and focused, and leads back to Home without a read receipt", changes);

  assert.deepEqual(report.writes, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
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
