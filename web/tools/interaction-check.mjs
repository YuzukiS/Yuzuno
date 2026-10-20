// Isolated headless acceptance. --real uses only the owned 4347 lab Core.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, unmanagedUpdates } from "./browser-fixtures.mjs";

const modelCheck = process.argv.includes("--model-check");
const real = process.argv.includes("--real") || modelCheck;
const output = resolve(
  "../acceptance/interaction-settings",
  modelCheck ? "model" : real ? "real" : "browser",
);
const dist = resolve(
  process.env.YUZUNO_UI_DIST ||
    "../acceptance/interaction-settings/web-build-src/dist",
);
assert.notEqual(dist, resolve("dist"));
const report = {
  mode: real ? "real-native-codex" : "isolated-browser-fixtures",
  checks: [],
  errors: [],
};
const check = (name, details = {}) => {
  report.checks.push({ name, ...details });
  console.log(name);
};
let browser, page, server;
const requests = [];
const events = new Set();
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:4347/api${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Yuzuno-Client": "desktop",
    },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(response.ok, `${path}: ${text}`);
  return text ? JSON.parse(text) : null;
};
const wait = async (fn, message, seconds = 120) => {
  for (let i = 0; i < seconds; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out: ${message}`);
};

async function fixture() {
  const a = {
    id: "a",
    name: "Mori",
    goal: "Conversation interactions",
    cwd: "/fixture",
    model: "test",
    color: "sage",
    status: "working",
    unreadCount: 2,
    pendingCount: 0,
    lastSeq: 20,
    reviewedSeq: 0,
    createdAt: "",
    updatedAt: "",
    settings: {
      reasoningEffort: "low",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    },
  };
  const b = { ...a, id: "b", name: "Hana", status: "idle" };
  const details = {
    a: {
      agent: a,
      artifacts: [],
      pending: [],
      messageReceipts: [],
      contextUsage: {
        usedPercent: 76,
        usedTokens: 76000,
        windowTokens: 100000,
        stale: false,
        turnId: "turn",
        updatedAt: "",
      },
      turns: [
        {
          id: "turn",
          status: "inProgress",
          items: [
            {
              id: "question",
              type: "agentMessage",
              delivery: "async",
              questions: [
                { title: "Which accent color?", options: ["Yuzu", "Sage"] },
              ],
            },
            {
              id: "progress",
              type: "agentMessage",
              phase: "commentary",
              text: "I am still working while you read.",
            },
          ],
        },
      ],
    },
    b: {
      agent: b,
      artifacts: [],
      pending: [],
      turns: [],
      messageReceipts: [],
      contextUsage: null,
    },
  };
  const models = [
    {
      id: "test",
      model: "test",
      displayName: "Test",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "high", description: "More reasoning" },
      ],
    },
  ];
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        let input = "";
        for await (const chunk of req) input += chunk;
        const body = input ? JSON.parse(input) : null;
        requests.push({ path: url.pathname, method: req.method, body });
        if (url.pathname === "/api/events") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(": fixture\n\n");
          events.add(res);
          res.on("close", () => events.delete(res));
          return;
        }
        let result = {};
        const id = url.pathname.split("/")[3];
        if (url.pathname === "/api/workspace")
          result = {
            agents: [a, b],
            runtime: { connected: true },
            defaultCwd: "/fixture",
          };
        else if (url.pathname.endsWith("/models")) result = { models };
        else if (url.pathname.endsWith("/settings")) {
          Object.assign(details[id].agent, body);
          result = details[id].agent;
        } else if (url.pathname.endsWith("/messages")) {
          result = { input: body, status: "accepted", turnId: "turn" };
          details[id].messageReceipts.push(result);
          details[id].turns[0].items.push({
            id: body.clientMessageId,
            type: "userMessage",
            content: [{ type: "text", text: body.text }],
          });
        } else result = details[id] || {};
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
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  for (const theme of ["light", "dark"])
    for (const width of [1440, 940, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(
        (theme) =>
          localStorage.setItem(
            "yuzuno.appearance",
            JSON.stringify({ theme, fontSize: 20 }),
          ),
        theme,
      );
      await page.goto(base);
      await page.locator(".context-usage-button").hover();
      await page.getByRole("tooltip").waitFor();
      assert.match(await page.getByRole("tooltip").innerText(), /76% used/);
      const layout = await page.evaluate(() => {
        const row = document
          .querySelector(".turn-activity")
          .getBoundingClientRect();
        const card = document
          .querySelector(".context-usage-card")
          .getBoundingClientRect();
        return {
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          workingHeight: row.height,
          tooltipInView:
            card.x >= 0 &&
            card.right <= innerWidth &&
            card.bottom <= innerHeight,
        };
      });
      assert.equal(layout.noOverflow, true);
      assert.equal(layout.tooltipInView, true);
      assert.ok(layout.workingHeight <= 30);
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-context.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Agent settings", exact: true })
        .click();
      const modal = page.getByRole("dialog");
      await modal.getByRole("button", { name: "Save", exact: true }).waitFor();
      const box = await modal.boundingBox();
      assert.ok(
        box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 844,
      );
      assert.equal(
        await modal.evaluate((e) => e.scrollWidth <= e.clientWidth),
        true,
      );
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-settings.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      check("20px working/context/settings fit", { theme, width, ...layout });
    }
  assert.equal(requests.filter((r) => r.method === "POST").length, 0);
  await page.setViewportSize({ width: 1440, height: 960 });
  const composer = page.getByRole("textbox", { name: "Message Mori" });
  await composer.fill("Keep my unfinished draft 保留草稿");
  await page.getByRole("radio", { name: "Sage", exact: true }).check();
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Answer sent", exact: true })
    .waitFor();
  assert.equal(
    await composerDraft(composer),
    "Keep my unfinished draft 保留草稿",
  );
  const answer = requests.filter((r) => r.path.endsWith("/messages"));
  assert.equal(answer.length, 1);
  assert.equal(answer[0].body.expectedTurnId, "turn");
  check("direct question answer preserves draft and targets active turn");
  await page.getByRole("button", { name: "Send while working" }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-composer-input] .cm-line")]
        .map((line) => {
          const copy = line.cloneNode(true);
          copy.querySelectorAll(".cm-placeholder").forEach((node) => node.remove());
          return copy.textContent;
        })
        .join("") === "",
  );
  assert.equal(requests.filter((r) => r.path.endsWith("/messages")).length, 2);
  await page.locator(".agent-row").filter({ hasText: "Hana" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".context-usage-button")
      ?.getAttribute("aria-label")
      .includes("unavailable"),
  );
  assert.equal(
    requests.filter((r) => /interrupt|review|respond/.test(r.path)).length,
    0,
  );
  check("working send, agent switch, no interrupt/read/pending mutations");
}

async function native() {
  // Refuse an unrelated service even on the fixed lab port.
  const process = JSON.parse(
    await readFile(resolve(output, "../core-process.json"), "utf8"),
  );
  assert.equal(process.baseUrl, "http://127.0.0.1:4347");
  assert.ok(process.argv.includes(resolve(output, "../core-data")));
  const { models } = await api("/models");
  const selected = models.find((m) => m.isDefault) || models[0];
  assert.ok(selected);
  const goal =
    "Bounded Yuzuno UI acceptance. Work only in this task folder. Never change source, services, configuration, or credentials. Do not delegate.";
  const agent = await api("/agents", {
    name: `Interaction acceptance ${Date.now().toString(36)}`,
    goal,
    cwd: resolve(output, "../tasks/local-alpha"),
    model: selected.model || selected.id,
  });
  report.agentId = agent.id;
  const path = `/agents/${agent.id}`;
  await wait(
    async () => (await api(path)).agent.connectionState === "connected",
    "native connection",
  );
  await page.goto("http://127.0.0.1:4347");
  await page.locator(".agent-row").filter({ hasText: agent.name }).click();
  const composer = page.getByRole("textbox", { name: `Message ${agent.name}` });
  const send = page.locator(".send-button");
  const settings = page.getByRole("button", {
    name: "Agent settings",
    exact: true,
  });
  await settings.click();
  const modal = page.getByRole("dialog");
  await modal
    .getByLabel("Reasoning effort", { exact: false })
    .selectOption("low");
  await modal.getByLabel("Access", { exact: false }).selectOption("read-only");
  await modal
    .getByLabel("Approval requests", { exact: false })
    .selectOption("never");
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  assert.equal((await api(path)).agent.settings.sandbox, "read-only");
  check("real runtime catalog and saved read-only/never/low settings", {
    model: selected.model || selected.id,
  });
  await composer.fill(
    "This is a bounded interaction test. Say a short progress sentence, then execute exactly sleep 20 in the shell (no other commands), then reply with the latest acceptance code I send while you wait. If no code arrives, reply MISSING. Do not read or write any files.",
  );
  await send.click();
  let detail = await wait(async () => {
    const d = await api(path);
    return (
      d.turns.some(
        (t) =>
          t.status === "inProgress" &&
          t.items.some((i) => i.type === "commandExecution"),
      ) && d
    );
  }, "real shell sleep");
  const turnId = detail.turns.at(-1).id;
  report.turnId = turnId;
  await composer.fill(
    "Latest acceptance code: YUZUNO-STEER-4347. Include this exact code in your final response.",
  );
  await page.getByRole("button", { name: "Send while working" }).click();
  await wait(
    async () =>
      (await api(path)).messageReceipts.filter((r) => r.status === "accepted")
        .length >= 2,
    "steering acceptance",
  );
  await settings.click();
  await modal
    .getByLabel("Reasoning effort", { exact: false })
    .selectOption("high");
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  assert.equal((await api(path)).turns.at(-1).id, turnId);
  detail = await wait(async () => {
    const d = await api(path);
    return d.turns.at(-1).status !== "inProgress" && d;
  }, "steered final reply");
  assert.equal(detail.turns.length, 1);
  assert.match(
    detail.turns[0].items
      .filter((i) => i.type === "agentMessage")
      .map((i) => i.text)
      .join("\n"),
    /YUZUNO-STEER-4347/,
  );
  assert.equal(
    detail.turns[0].items.filter((i) => i.type === "userMessage").length,
    2,
  );
  assert.ok(detail.contextUsage?.usedPercent > 0);
  assert.equal(detail.agent.reviewedSeq, 0);
  check(
    "real steer stays in one turn, final uses extra input, context is native",
    {
      context: detail.contextUsage,
      receiptStatuses: detail.messageReceipts.map((r) => r.status),
    },
  );
  await page.locator(".context-usage-button").hover();
  await page.getByRole("tooltip").waitFor();
  await page.screenshot({
    path: resolve(output, "native-context.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await composer.fill(
    "Use the native functions.request_user_input_async tool now to ask exactly 'Which accent color should this acceptance use?' with options ['Yuzu', 'Sage']. Then execute sleep 25 once while waiting. My answer will arrive directly. After that, briefly confirm my chosen color. Do not change files. This is bounded acceptance.",
  );
  await send.click();
  await page.locator(".async-question").waitFor({ timeout: 120000 });
  await composer.fill("This unfinished draft must survive the direct answer.");
  await page.getByRole("radio", { name: "Sage", exact: true }).check();
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Answer sent", exact: true })
    .waitFor();
  assert.equal(
    await composerDraft(composer),
    "This unfinished draft must survive the direct answer.",
  );
  await page.screenshot({
    path: resolve(output, "direct-answer.png"),
    animations: "disabled",
  });
  detail = await wait(async () => {
    const d = await api(path);
    return d.turns.length === 2 && d.turns.at(-1).status !== "inProgress" && d;
  }, "native question answer final");
  assert.match(
    detail.turns[1].items
      .filter((i) => i.type === "agentMessage")
      .map((i) => i.text)
      .join("\n"),
    /Sage/i,
  );
  assert.equal(
    detail.messageReceipts.filter(
      (r) => r.input.question && r.status === "accepted",
    ).length,
    1,
  );
  assert.equal(detail.agent.reviewedSeq, 0);
  check(
    "real async question directly answered during work; draft intact and final confirms Sage",
  );
  await page.reload();
  await composer.waitFor();
  await page
    .getByRole("button", { name: "Answer sent", exact: true })
    .waitFor();
  assert.equal(
    await composerDraft(composer),
    "This unfinished draft must survive the direct answer.",
  );
  await settings.click();
  assert.equal(
    await modal.getByLabel("Reasoning effort", { exact: false }).inputValue(),
    "high",
  );
  await page.keyboard.press("Escape");
  await writeFile(
    resolve(output, "agent-detail.json"),
    JSON.stringify(detail, null, 2),
  );
  check("reload retains answered state, draft and next-turn settings");
}

async function changeModel() {
  const previous = JSON.parse(await readFile(resolve(output, "../real/report.json"), "utf8"));
  assert.equal(previous.status, "passed");
  const path = `/agents/${previous.agentId}`;
  const before = await api(path);
  assert.equal(before.agent.status, "idle");
  const { models } = await api(`${path}/models`);
  const alternative = models.find((m) => (m.model || m.id) !== before.agent.model && m.supportedReasoningEfforts.some((e) => e.reasoningEffort === "low"));
  assert.ok(alternative, "A second available native model is needed for this acceptance");
  const model = alternative.model || alternative.id;
  await page.goto("http://127.0.0.1:4347");
  await page.locator(".agent-row").filter({ hasText: before.agent.name }).click();
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Model", { exact: true }).selectOption(model);
  await modal.getByLabel("Reasoning effort", { exact: false }).selectOption("low");
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  assert.equal((await api(path)).agent.model, model);
  const composer = page.getByRole("textbox", { name: `Message ${before.agent.name}` });
  await composer.fill("Reply with exactly MODEL-SWITCH-4347. Do not use tools or change files.");
  await page.locator(".send-button").click();
  let after = await wait(async () => {
    const d = await api(path);
    return d.turns.length === before.turns.length + 1 && d.turns.at(-1).status !== "inProgress" && d;
  }, "new model final reply");
  assert.match(after.turns.at(-1).items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n"), /MODEL-SWITCH-4347/);
  assert.equal(after.agent.reviewedSeq, before.agent.reviewedSeq);
  await api(`${path}/reconnect`, {});
  after = await api(path);
  assert.equal(after.agent.model, model);
  assert.equal(after.agent.settings.reasoningEffort, "low");
  assert.equal(after.messageReceipts.filter((r) => r.status === "accepted").length, 5);
  await page.reload();
  await composer.waitFor();
  await page.screenshot({ path: resolve(output, "model-changed.png"), animations: "disabled" });
  await writeFile(resolve(output, "agent-detail.json"), JSON.stringify(after, null, 2));
  check("native model changed through settings; next turn completed and reconnect retained settings", { from: before.agent.model, to: model, threadId: after.agent.threadId, turnId: after.turns.at(-1).id });
}

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (e) => report.errors.push(e.message));
  await (modelCheck ? changeModel() : real ? native() : fixture());
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = String(e.stack || e);
  console.error(report.failure);
  if (page)
    await page
      .screenshot({ path: resolve(output, "failure.png") })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const client of events) client.end();
  if (server) await new Promise((done) => server.close(done));
  report.finishedAt = new Date().toISOString();
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `${report.status}: ${report.checks.length} checks; ${output}/report.json`,
  );
}
