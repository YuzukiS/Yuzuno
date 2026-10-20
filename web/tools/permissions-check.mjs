// Independent browser and production bundle; all API traffic stays in fixtures.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(
  process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/permissions",
);
await mkdir(output, { recursive: true });
const report = {
  mode: "isolated-browser-fixtures",
  checks: [],
  mutations: [],
  errors: [],
};
const agent = {
  id: "a",
  name: "Mori",
  status: "working",
  harness: "codex",
  cwd: "/fixture",
  model: "test-model",
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 1,
  pendingCount: 0,
  lastSeq: 8,
  reviewedSeq: 3,
  settings: {
    reasoningEffort: "high",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
};
const question = {
  id: "question",
  type: "agentMessage",
  delivery: "async",
  questions: [
    { title: "权限更新做到哪一步？", options: ["功能对齐", "配置共用"] },
  ],
};
const turn = { id: "turn-1", status: "inProgress", items: [question] };
const detail = {
  agent,
  turns: [turn],
  pending: [],
  artifacts: [],
  messageReceipts: [],
};
const permissions = {
  presets: [
    {
      id: "config",
      available: true,
      permissions: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "read-only",
        profile: null,
      },
    },
    {
      id: "ask",
      available: true,
      permissions: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        profile: null,
      },
    },
    {
      id: "auto",
      available: true,
      permissions: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        profile: null,
      },
    },
    {
      id: "full",
      available: true,
      permissions: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
        profile: null,
      },
    },
  ],
};
let uncertain = false;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  window.EventSource = class {
    close() {}
  };
});
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(url.hostname, "yuzuno-permissions.test");
  // The read receipt for the conversation on screen is not a settings write.
  if (request.method() === "POST" && url.pathname === "/api/agents/a/review")
    return route.fulfill({ json: {} });
  if (request.method() !== "GET") {
    const input = request.postDataJSON();
    report.mutations.push({ path: url.pathname, input });
    if (url.pathname === "/api/agents/a/settings") {
      agent.settings = input.settings;
      return route.fulfill({ json: agent });
    }
    assert.equal(url.pathname, "/api/agents/a/messages");
    const receipt = {
      input,
      status: uncertain ? "uncertain" : "accepted",
      turnId: uncertain ? null : "turn-2",
      error: uncertain ? "Delivery unknown; reconnect to confirm." : null,
    };
    detail.messageReceipts.push(receipt);
    return route.fulfill({ json: receipt });
  }
  if (url.pathname === "/api/workspace")
    return route.fulfill({
      json: {
        agents: [agent],
        runtime: { connected: true },
        defaultCwd: "/fixture",
      },
    });
  if (url.pathname === "/api/agents/a") return route.fulfill({ json: detail });
  if (url.pathname === "/api/agents/a/models")
    return route.fulfill({
      json: {
        models: [
          {
            id: "test-model",
            model: "test-model",
            displayName: "Test model",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "Careful reasoning" },
            ],
          },
        ],
        permissions,
      },
    });
  // Read on load by what came after this check (updates, Jobs, CI, reviews,
  // Home, machine load): nothing to show here.
  const quiet = {
    "/api/updates": unmanagedUpdates,
    "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs,
    "/api/jobs/live": noLiveJobs,
    "/api/ci": noCiRuns,
    "/api/reviews": noReviews,
    "/api/home": { generatedAt: "", order: [], needsYou: [], projects: [] },
    "/api/machine-load": {
      at: "2026-10-17T00:00:00Z",
      cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
      memory: { totalMiB: 16384, usedMiB: 4096, availableMiB: 12288, jobsMiB: 0, agentsMiB: null },
      gpus: null,
      jobs: [],
    },
  }[url.pathname];
  if (quiet) return route.fulfill({ json: quiet });
  assert.ok(
    !url.pathname.startsWith("/api/"),
    `Unexpected request ${url.pathname}`,
  );
  const file = resolve(
    dist,
    `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
  );
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".woff2": "font/woff2",
    }[extname(file)],
  });
});
page.on("pageerror", (error) => report.errors.push(error.message));
const record = (name, extra = {}) => report.checks.push({ name, ...extra });
const modal = page.getByRole("dialog");
const openSettings = async () => {
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Permissions"] input[value="auto"]')
        ?.disabled === false,
  );
};
try {
  await page.goto("https://yuzuno-permissions.test/");
  const composer = page.getByRole("textbox", { name: "Message Mori" });
  await composer.fill("保留这段还没发送的草稿。");
  await openSettings();
  // Model, reasoning effort and permissions, each a row of chips.
  const permissionChips = modal.getByRole("radiogroup", {
    name: "Permissions",
    exact: true,
  });
  assert.equal(await modal.getByRole("radiogroup").count(), 3);
  await permissionChips.locator("input:not(:disabled)").first().press("Escape");
  await modal.waitFor({ state: "detached" });
  assert.equal(report.mutations.length, 0);
  record(
    "Escape closes settings while working without Interrupt or other mutations",
  );

  for (const [preset, preview] of [
    ["auto", "Automatic review · Workspace files"],
    ["ask", "You review requests · Workspace files"],
    ["full", "No approval prompts · Full filesystem and network access"],
    ["config", "Automatic review · Read only"],
  ]) {
    await openSettings();
    await permissionChips.locator(`input[value="${preset}"]`).check();
    assert.ok(
      (await modal.locator(".permission-preview").textContent()).includes(
        preview,
      ),
    );
    assert.ok(
      (await modal.textContent()).includes(
        "The current turn and pending requests keep their existing permissions",
      ),
    );
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await modal.waitFor({ state: "detached" });
    assert.equal(
      report.mutations.at(-1).input.settings.permissionPreset,
      preset,
    );
    assert.equal(await composerDraft(composer), "保留这段还没发送的草稿。");
    record("Permission mode saved with its next-turn preview", { preset });
  }
  const full = permissions.presets.find((p) => p.id === "full");
  full.available = false;
  full.reason = "Managed policy disallows full access";
  await openSettings();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Permissions"] input[value="full"]')
        ?.disabled === true,
  );
  assert.equal(
    await permissionChips
      .locator('input[value="full"]')
      .evaluate((el) => el.disabled),
    true,
  );
  record("Managed restriction disables Full access");
  for (const theme of ["light", "dark"])
    for (const width of [1440, 940, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        localStorage.setItem(
          "yuzuno.appearance",
          JSON.stringify({ theme, fontSize: 20 }),
        );
        window.dispatchEvent(
          new StorageEvent("storage", { key: "yuzuno.appearance" }),
        );
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      await modal
        .getByRole("button", { name: "Save", exact: true })
        .scrollIntoViewIfNeeded();
      const fit = await modal.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          horizontal: el.scrollWidth <= el.clientWidth + 1,
          inViewport:
            box.left >= 0 &&
            box.right <= innerWidth + 1 &&
            box.top >= 0 &&
            box.bottom <= innerHeight + 1,
        };
      });
      assert.deepEqual(fit, { horizontal: true, inViewport: true });
      await page.screenshot({ path: `${output}/${theme}-${width}-20px.png` });
      record("Permissions layout fits at 20px", { theme, width });
    }
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "View question and answer", exact: true }).click();
  await page.getByRole("radio", { name: "功能对齐", exact: true }).check();
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Answer sent", exact: true })
    .waitFor();
  const sent = report.mutations.at(-1).input;
  assert.deepEqual(sent.question, { turnId: "turn-1", itemId: "question" });
  assert.equal(sent.expectedTurnId, "turn-1");
  assert.equal(detail.messageReceipts[0].turnId, "turn-2");
  await modal.getByRole("button", { name: "Close dialog", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  assert.equal(await composerDraft(composer), "保留这段还没发送的草稿。");
  record(
    "A stale active-turn UI accepts the Core receipt for a new turn; draft is preserved",
  );

  uncertain = true;
  question.id = "question-2";
  await page.reload();
  await page.getByRole("button", { name: "View question and answer", exact: true }).click();
  await page.getByRole("radio", { name: "功能对齐", exact: true }).check();
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  const unconfirmed = page.getByRole("button", {
    name: "Delivery unconfirmed",
    exact: true,
  });
  await unconfirmed.waitFor();
  assert.equal(await unconfirmed.isDisabled(), true);
  await page.reload();
  await page.getByRole("button", { name: "View question and answer", exact: true }).click();
  await unconfirmed.waitFor();
  assert.equal(await unconfirmed.isDisabled(), true);
  assert.equal(
    report.mutations.filter((r) => r.path.endsWith("/messages")).length,
    2,
  );
  assert.ok(
    report.mutations.every((r) => /\/(settings|messages)$/.test(r.path)),
  );
  assert.deepEqual(report.errors, []);
  record(
    "Uncertain answer delivery survives reload without automatic resend or Pending/read mutations",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  await page.screenshot({ path: `${output}/failure.png` });
  process.exitCode = 1;
} finally {
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
