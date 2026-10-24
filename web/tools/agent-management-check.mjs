// Disposable browser + fixture server. Never connects to a daily Core.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, savedDraft } from "./browser-fixtures.mjs";
const output = resolve(
  process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/agent-management/browser",
);
const dist = resolve(
  process.env.YUZUNO_UI_DIST || "../acceptance/agent-management/web-dist",
);
assert.notEqual(dist, resolve("dist"));
const baseAgent = {
  cwd: "/fixture/project",
  model: "codex-fixture",
  color: "sage",
  status: "idle",
  harness: "codex",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  settings: {
    reasoningEffort: "low",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
};
// A Claude Agent's settings as Core keeps them: no Codex effort carried
// over; its effort (none chosen yet) and mode beside the shared fields.
const claudeSettings = {
  reasoningEffort: null,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  permissionMode: "default",
};
let agents = [
  { ...baseAgent, id: "a", name: "Mori", status: "working" },
  {
    ...baseAgent,
    id: "b",
    name: "Hana",
    harness: "claude",
    model: "claude-one",
    settings: claudeSettings,
  },
  {
    ...baseAgent,
    id: "c",
    name: "Old friend",
    closedAt: "2026-10-12",
    pendingCount: 4,
    unreadCount: 3,
  },
];
const models = [
  {
    id: "codex-fixture",
    model: "codex-fixture",
    displayName: "Codex fixture",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    defaultReasoningEffort: "low",
  },
];
// Claude's catalog says per model whether it takes an effort, and which
// levels (T-23).
const claudeModels = [
  {
    id: "claude-one",
    model: "claude-one",
    displayName: "Claude native one",
    description: "Provided by native Claude Code",
    isDefault: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    id: "claude-two",
    model: "claude-two",
    displayName: "Claude native two",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];
const calls = [],
  events = new Set(),
  report = { checks: [], errors: [] };
let failClose = true,
  failDelete = true,
  failCatalog = true,
  browser,
  page;
const check = (name) => {
  report.checks.push(name);
  console.log(name);
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.test");
    if (url.pathname.startsWith("/api/")) {
      let text = "";
      for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : null;
      calls.push({
        path: url.pathname,
        search: url.search,
        method: req.method,
        body,
      });
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": fixture\n\n");
        events.add(res);
        res.on("close", () => events.delete(res));
        return;
      }
      const id = url.pathname.split("/")[3],
        agent = agents.find((a) => a.id === id);
      let result = {};
      if (url.pathname === "/api/workspace")
        result = {
          agents,
          runtime: { connected: true },
          defaultCwd: "/fixture/project",
        };
      else if (url.pathname === "/api/machines")
        result = {
          machines: [
            {
              id: "local",
              name: "Core host",
              kind: "local",
              defaultCwd: "/fixture/project",
            },
          ],
        };
      else if (
        url.pathname === "/api/models" ||
        url.pathname.endsWith("/models")
      ) {
        const claude =
          url.searchParams.get("harness") === "claude" ||
          agent?.harness === "claude";
        if (claude && failCatalog) {
          failCatalog = false;
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Native catalog temporarily unavailable" }),
          );
          return;
        }
        result = { models: claude ? claudeModels : models };
      } else if (url.pathname.endsWith("/close")) {
        if (failClose) {
          failClose = false;
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Could not confirm runtime stopped. Agent kept open.",
            }),
          );
          return;
        }
        agent.closedAt = new Date().toISOString();
        agent.status = "offline";
        result = agent;
      } else if (url.pathname.endsWith("/reopen")) {
        agent.closedAt = null;
        agent.status = "idle";
        result = agent;
      } else if (req.method === "DELETE") {
        if (failDelete) {
          failDelete = false;
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Delete could not finish. Agent kept." }));
          return;
        }
        agents = agents.filter((a) => a.id !== id);
        res.writeHead(204);
        res.end();
        return;
      } else if (url.pathname.endsWith("/settings")) {
        // As Core stores a save: the model on the Agent; Codex settings, or
        // Claude's mode and effort, in its settings.
        const { model, settings, permissionMode, effort } = body;
        if (model !== undefined) agent.model = model;
        agent.settings = {
          ...agent.settings,
          ...(settings || {}),
          ...(permissionMode !== undefined ? { permissionMode } : {}),
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        };
        result = agent;
      } else if (url.pathname === "/api/agents" && req.method === "POST") {
        result = {
          ...baseAgent,
          ...(body.harness === "claude" ? { settings: claudeSettings } : {}),
          ...body,
          id: "created",
        };
        agents.push(result);
      } else if (url.pathname === "/api/home")
        // Core leaves closed Agents out of Home (T-85): nothing needs you.
        result = {
          generatedAt: new Date().toISOString(),
          order: [],
          needsYou: [],
          projects: [],
        };
      else if (url.pathname === "/api/machine-load")
        result = {
          at: new Date().toISOString(),
          cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
          memory: { totalMiB: 16384, usedMiB: 4096, availableMiB: 12288, jobsMiB: 0, agentsMiB: null },
          gpus: null,
          jobs: [],
        };
      else if (agent)
        result = {
          agent,
          pending: [],
          artifacts: [],
          turns: [
            {
              id: `${id}-turn`,
              status: agent.status === "working" ? "inProgress" : "completed",
              items: [
                {
                  id: `${id}-reply`,
                  type: "agentMessage",
                  text: `Saved reply from ${agent.name}`,
                },
              ],
            },
          ],
        };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    const path = resolve(
      dist,
      `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
    );
    assert.ok(path.startsWith(dist + "/"));
    const content = await readFile(path);
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".woff2": "font/woff2",
        }[extname(path)] || "application/octet-stream",
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
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.goto(base);
  await page
    .getByRole("textbox", { name: "Message Mori" })
    .fill("Keep this unfinished draft 保留草稿");
  assert.equal(await page.locator(".agent-row").count(), 2);
  // The rail's Active / Closed pill counts them; the bottom bar no longer does.
  await page
    .getByRole("group", { name: "Show agents" })
    .getByRole("button", { name: "Active 2", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close agent", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Interrupt & close" }).waitFor();
  assert.match(await dialog.innerText(), /current turn will be interrupted/);
  assert.match(
    await dialog.innerText(),
    /Project files and the original Codex session remain/,
  );
  await dialog.getByRole("button", { name: "Keep agent" }).click();
  assert.equal(calls.filter((c) => c.path.endsWith("/close")).length, 0);
  check(
    "Close is discoverable, confirms working interruption, cancel has no mutation",
  );
  await page.getByRole("button", { name: "Close agent", exact: true }).click();
  await dialog.getByRole("button", { name: "Interrupt & close" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.innerText(), /Agent kept open/);
  assert.equal(agents[0].closedAt, undefined);
  await dialog.getByRole("button", { name: "Interrupt & close" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator(".closed-agent-note").waitFor();
  assert.equal(await page.locator(".composer textarea").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Closed 2", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.ok(
    await page.getByText("Saved reply from Mori", { exact: true }).count(),
  );
  assert.equal(await savedDraft(page, "a"), "Keep this unfinished draft 保留草稿");
  check(
    "Failed close preserves agent; successful close hides composer and keeps history and draft",
  );
  await page.reload();
  await page.locator(".closed-agent-note").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Closed 2", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page
    .locator(".closed-agent-note")
    .getByRole("button", { name: "Reopen", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Message Mori" }).waitFor();
  assert.equal(
    await composerDraft(page.getByRole("textbox", { name: "Message Mori" })),
    "Keep this unfinished draft 保留草稿",
  );
  assert.equal(
    calls.filter((c) => c.path === "/api/agents/a/reopen").length,
    1,
  );
  assert.equal(
    calls.filter((c) => /\/(reconnect|turns|messages)$/.test(c.path)).length,
    0,
  );
  check(
    "Closed selection survives reload; reopen restores original agent and draft without sending work",
  );
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Manage…", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Delete agent…", exact: false })
    .click();
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  assert.match(await dialog.innerText(), /cannot be undone/);
  await dialog
    .getByRole("button", { name: "Delete agent", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.innerText(), /Delete could not finish/);
  assert.ok(agents.some((a) => a.id === "a"));
  assert.equal(await savedDraft(page, "a"), "Keep this unfinished draft 保留草稿");
  await dialog
    .getByRole("button", { name: "Delete agent", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("textbox", { name: "Message Hana" }).waitFor();
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 2);
  // Nothing of the deleted Agent's draft remains.
  assert.equal((await savedDraft(page, "a")) ?? "", "");
  check(
    "Delete requires confirmation, keeps the agent and draft on failure, then removes only the target",
  );
  // Home replaced Catch up (T-85). The closed Agent's four pending requests
  // are not counted on its toolbar button, so it is named "Home" alone.
  const home = page.getByRole("button", { name: "Home", exact: true });
  assert.equal(await home.locator(".nav-count").count(), 0);
  await home.click();
  await page.locator(".home-view").getByText("Nothing needs you right now.", { exact: true }).waitFor();
  check("Closed agents do not contribute active pending counts; Home shows nothing waiting");
  await page.getByRole("button", { name: "Open Hana", exact: true }).click();
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Retry models" }).waitFor();
  await dialog.getByRole("button", { name: "Retry models" }).click();
  // Agent settings offers each choice as a row of chips.
  const chips = (name) => dialog.getByRole("radiogroup", { name, exact: true });
  const chosen = (name) =>
    chips(name).evaluate((group) => group.querySelector("input:checked")?.value);
  const pick = (name, value) => chips(name).locator(`input[value="${value}"]`).check();
  const levels = () =>
    chips("Reasoning effort").evaluate((group) =>
      [...group.querySelectorAll("input")].map((o) => o.value),
    );
  await chips("Model")
    .locator('input[value="claude-two"]')
    .waitFor({ state: "attached" });
  // Claude Code default until chosen, and the levels of the model in use.
  assert.equal(await chosen("Reasoning effort"), "");
  assert.deepEqual(await levels(), ["", "low", "medium", "high"]);
  await pick("Model", "claude-two");
  assert.equal(await chosen("Reasoning effort"), "");
  assert.deepEqual(await levels(), ["", "low", "medium", "high", "xhigh", "max"]);
  await dialog.getByText("Claude Code decides", { exact: false }).waitFor();
  // Codex's permission controls stay out of a Claude Agent's settings.
  for (const codex of ["Permissions", "Approval requests", "Access"])
    assert.equal(await dialog.getByLabel(codex, { exact: true }).count(), 0, codex);
  await pick("Approvals", "auto");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  // Claude Code default is sent as an explicit null, and no Codex settings.
  assert.deepEqual(
    calls.find((c) => c.path === "/api/agents/b/settings").body,
    { model: "claude-two", permissionMode: "auto", effort: null },
  );
  // Saved as Core keeps it, and shown so when the dialog opens again.
  await page.reload();
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await chips("Model").locator("input:checked").waitFor({ state: "attached" });
  assert.equal(await chosen("Model"), "claude-two");
  assert.equal(await chosen("Approvals"), "auto");
  assert.equal(await chosen("Reasoning effort"), "");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check(
    "Claude settings retries native catalog, offers the model's effort levels and auto mode, saves Claude Code default as effort null, and shows no Codex permissions",
  );
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  // New agent offers its choices as chips, each one click away.
  const createModels = dialog.getByRole("radiogroup", { name: "Model" });
  await dialog
    .getByRole("radiogroup", { name: "Harness" })
    .getByRole("radio", { name: "Claude Code", exact: true })
    .check();
  await createModels.locator('input[value="claude-one"]').check();
  assert.deepEqual(
    await createModels
      .locator(".choice-chip-label")
      .evaluateAll((labels) => labels.map((l) => l.textContent)),
    ["Harness default", "Claude native one", "Claude native two"],
  );
  assert.ok(
    calls.some(
      (c) => c.path === "/api/models" && c.search === "?harness=claude",
    ),
  );
  assert.equal(
    await createModels.getByText("Codex fixture").count(),
    0,
  );
  await dialog.getByLabel("Name", { exact: true }).fill("Peach");
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    calls.filter((c) => c.path === "/api/agents" && c.method === "POST").length,
    1,
  );
  assert.equal(
    calls.find((c) => c.path === "/api/agents" && c.method === "POST").body
      .model,
    "claude-one",
  );
  check(
    "Claude creation offers the native catalog as chips and sends the selected native model",
  );
  for (const theme of ["light", "dark"])
    for (const width of [1440, 940, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(
        (theme) =>
          localStorage.setItem(
            "yuzuno.appearance",
            JSON.stringify({ theme, fontSize: 20 }),
          ),
        theme,
      );
      await page.reload();
      // A narrow header keeps Close under Conversation actions.
      const direct = page.getByRole("button", { name: "Close agent", exact: true });
      await page.getByRole("button", { name: "Conversation actions", exact: true }).waitFor();
      if (await direct.isVisible()) await direct.click();
      else {
        await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Manage…", exact: true }).click();
        await dialog.getByRole("button", { name: /^Close agent/ }).click();
      }
      await dialog
        .getByRole("button", { name: "Close agent", exact: true })
        .waitFor();
      const fit = await dialog.evaluate((e) => ({
        left: e.getBoundingClientRect().left,
        right: e.getBoundingClientRect().right,
        scroll: e.scrollWidth,
        client: e.clientWidth,
        page: document.documentElement.scrollWidth,
        width: innerWidth,
      }));
      assert.ok(
        fit.left >= 0 &&
          fit.right <= width &&
          fit.scroll <= fit.client &&
          fit.page <= fit.width,
        JSON.stringify(fit),
      );
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-close.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      check(`Close confirmation fits ${theme} ${width}px at 20px font`);
      await page.getByRole("button", { name: "Agent settings", exact: true }).click();
      await pick("Model", "claude-two");
      const modelFit = await dialog.evaluate((e) => {
        const select = e
          .querySelector('[role="radiogroup"][aria-label="Model"]')
          .getBoundingClientRect();
        return {
          left: e.getBoundingClientRect().left,
          right: e.getBoundingClientRect().right,
          scroll: e.scrollWidth,
          client: e.clientWidth,
          selectLeft: select.left,
          selectRight: select.right,
        };
      });
      assert.ok(
        modelFit.left >= 0 && modelFit.right <= width &&
          modelFit.scroll <= modelFit.client && modelFit.selectLeft >= 0 &&
          modelFit.selectRight <= width,
        JSON.stringify(modelFit),
      );
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-claude-model.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      check(`Claude model picker fits ${theme} ${width}px at 20px font`);
    }
  assert.deepEqual(report.errors, []);
  report.agents = agents.map(({id,name}) => ({id,name}));
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = String(e.stack || e);
  console.error(report.failure);
  process.exitCode = 1;
  if (page)
    await page
      .screenshot({ path: resolve(output, "failure.png") })
      .catch(() => {});
} finally {
  await browser?.close();
  for (const e of events) e.end();
  await new Promise((done) => server.close(done));
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `${report.status}: ${report.checks.length} checks; ${output}/report.json`,
  );
}
