// Actual isolated Chromium and production assets, with an explicit API fixture.
// No native Core, daily window, real approval, or native session is accessed.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";

const dist = resolve(process.env.YUZUNO_UI_DIST || "");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "");
assert.ok(
  process.env.YUZUNO_UI_DIST && process.env.YUZUNO_BROWSER_OUTPUT,
  "Explicit isolated build and output directories required",
);
assert.ok(!dist.endsWith("/web/dist"), "Do not use the daily bundle");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:4399"; // Intercept every request; no listener needed.
const pastedBody = "\n  pasted\r\n中文\r\n".repeat(12);
let draft = "更新前写的草稿 · keep this draft" + pastedBody;
const release = (id) => ({
  releaseId: `workspace-${id}-20261013`,
  version: `2026.10.${id}`,
  gitSha: id === "A" ? "a".repeat(40) : "b".repeat(40),
  builtAt: "2026-10-13T00:00:00Z",
  platform: "linux-x86_64",
  protocol: 1,
  schema: { writes: 2, readsMin: 2, readsMax: 2 },
  records: { writes: 1, readsMin: 0, readsMax: 1 },
  bytes: 12000000,
  source: "Reviewed local release",
  notes:
    "Keep your workspace and native sessions together.\n修复更新期间的草稿与重连状态。",
});
const agent = {
  id: "a",
  name: "Mori",
  cwd: "/isolated-fixture",
  harness: "codex",
  threadId: "native-a",
  connectionState: "connected",
  status: "working",
  model: "fixture-model",
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  settings: {},
};
let status = {
  managed: true,
  current: release("A"),
  candidates: [release("B")],
  blockers: [],
  acceptingWork: true,
  storage: {
    releaseBytes: 24000000,
    backupBytes: 1000,
    retainedReleases: 2,
    keepReleases: 3,
  },
};
let servedRelease = release("A").releaseId;
let mode = "normal";
let offline = false;
let delayedRequests = [];
let sequence = 0;
const calls = [];
const report = {
  mode: "real-chromium-production-ui-with-explicit-api-fixture",
  checks: [],
  errors: [],
  screenshots: [],
  limits: [
    "Does not prove a Core switch or native session restoration",
    "Does not operate a Tauri/WebView2 daily window",
  ],
};
let browser;
let context;
let page;
let navigations = 0;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
function operation(phase, extra = {}) {
  status.operation = {
    id: `operation-${sequence}`,
    releaseId: release("B").releaseId,
    phase,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}
const check = (name) => {
  report.checks.push(name);
  console.log(`PASS ${name}`);
};
async function fixture(route) {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(url.origin, origin, "Browser must not reach another service");
  if (!url.pathname.startsWith("/api/")) {
    const path = resolve(
      dist,
      "." + (url.pathname === "/" ? "/index.html" : url.pathname),
    );
    assert.ok(path.startsWith(dist + "/"));
    let body = await readFile(path);
    if (url.pathname === "/")
      body = Buffer.from(
        body
          .toString()
          .replace(
            "</head>",
            `<meta name="yuzuno-release" content="${servedRelease}"></head>`,
          ),
      );
    return route.fulfill({
      body,
      contentType: mime[extname(path)] || "application/octet-stream",
    });
  }
  const body = request.postDataJSON();
  calls.push({ path: url.pathname, method: request.method(), body });
  if (offline) return route.abort("connectionfailed");
  const respond = (value, code = 200) =>
    route.fulfill({
      status: code,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  switch (url.pathname) {
    case "/api/updates":
      return respond(status);
    case "/api/updates/check":
      return respond(status);
    case "/api/updates/prepare":
      if (mode === "invalid")
        return respond(
          { error: "Release checksum does not match the reviewed manifest" },
          409,
        );
      if (mode === "disk-full")
        return respond(
          { error: "Not enough disk space to prepare this release" },
          409,
        );
      status.preparedReleaseId = release("B").releaseId;
      operation("prepared");
      return respond({ operationId: status.operation.id });
    case "/api/updates/apply":
      sequence++;
      operation("waiting", {
        deadline: new Date(Date.now() + 1800000).toISOString(),
      });
      status.acceptingWork = false;
      status.waitNotices = [
        { agentId: "a", name: "Mori", turnId: "turn-a", messageId: "pause-a", delivery: "delivered", active: true, idle: false },
        { agentId: "b", name: "审批中的 Agent", turnId: "turn-b", messageId: "pause-b", delivery: "uncertain", active: true, idle: false },
        { agentId: "c", name: "已保存进度的 Agent", turnId: "turn-c", messageId: "pause-c", delivery: "delivered", active: false, idle: true },
      ];
      status.blockers = [
        { agentId: "a", name: "Mori", reason: "Turn is still running" },
        {
          agentId: "b",
          name: "审批中的 Agent",
          reason: "Waiting for an approval or answer",
        },
      ];
      if (mode === "lost-receipt") return route.abort("connectionreset");
      if (mode === "timeout") {
        delayedRequests.push(route);
        return;
      }
      return respond({ operationId: status.operation.id });
    case "/api/updates/cancel":
      status.acceptingWork = true;
      operation("cancelled");
      status.blockers = [];
      return respond({ cancelled: true });
    case "/api/workspace":
      return respond({
        agents: [agent],
        runtime: { connected: true },
        defaultCwd: agent.cwd,
        workspace: { id: "updates-fixture" },
        projects: [],
        projectUsage: {},
      });
    case "/api/agents/a":
      return respond({
        agent,
        turns: [
          {
            id: "turn-a",
            status: "inProgress",
            items: [
              {
                id: "user-a",
                type: "userMessage",
                content: [{ type: "inputText", text: "Remember this turn" }],
              },
              {
                id: "reply-a",
                type: "agentMessage",
                phase: "commentary",
                text: "An earlier reply remains here while the update waits.",
              },
            ],
          },
        ],
        pending: [],
        artifacts: [],
        messageReceipts: [],
      });
    case "/api/health":
      return respond({
        product: "yuzuno",
        application: "yuzuno-next",
        workspaceId: "updates-fixture",
        releaseId: status.current.releaseId,
      });
    case "/api/models":
      return respond({ models: [] });
    case "/api/machines":
      return respond({ machines: [] });
    case "/api/catchup":
      return respond({ items: [], agents: [] });
    default:
      return respond(
        url.pathname.includes("/collaboration/")
          ? { tasks: [], messages: [], agents: [] }
          : {},
      );
  }
}
async function open() {
  await page.getByRole("button", { name: "Settings and updates" }).click();
  await page.getByRole("dialog").waitFor();
}
async function close() {
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}
async function hasText(text) {
  await page
    .getByRole("dialog")
    .getByText(text, { exact: false })
    .first()
    .waitFor();
}
async function preserved() {
  assert.equal(
    // A draft is saved under the Workspace and the Agent (T-195), and this
    // page is in one Workspace, so the key is the one naming Agent "a".
    await page.evaluate(() => {
      const prefix = "yuzuno.composer.v1:";
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(prefix)) continue;
        const identity = key.slice(prefix.length);
        let parsed;
        try {
          parsed = JSON.parse(identity);
        } catch {
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[1] !== "a") continue;
        return JSON.parse(localStorage.getItem(key))
          .parts.map((p) =>
            p.kind === "text"
              ? p.text
              : localStorage.getItem("yuzuno.paste.v1:" + identity + ":" + p.bodyId),
          )
          .join("");
      }
      return null;
    }),
    draft,
  );
  assert.equal(
    calls.filter((c) =>
      /interrupt|\/review$|\/respond$|\/messages$|\/turns$/.test(c.path),
    ).length,
    0,
  );
}
async function layout(theme, width, height, label) {
  await page.setViewportSize({ width, height });
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, theme);
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.getByRole("dialog").evaluate((el) => ({
    width: innerWidth,
    rect: el.getBoundingClientRect().toJSON(),
    scroll: el.scrollWidth,
    client: el.clientWidth,
    reading: getComputedStyle(document.documentElement)
      .getPropertyValue("--reading-size")
      .trim(),
    background: getComputedStyle(el).backgroundColor,
  }));
  assert.equal(metrics.reading, "20px");
  assert.ok(
    metrics.rect.left >= -1 && metrics.rect.right <= width + 1,
    JSON.stringify(metrics),
  );
  assert.ok(
    metrics.scroll <= metrics.client + 1,
    `Dialog overflow: ${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.rect.top >= -1 && metrics.rect.bottom <= height + 1,
    `Dialog outside viewport: ${JSON.stringify(metrics)}`,
  );
  const clipped = await page
    .locator(
      ".workspace-updates button, .updates-candidate, .updates-actions, .updates-blockers",
    )
    .evaluateAll((nodes) =>
      nodes
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.className),
    );
  assert.deepEqual(clipped, []);
  const screenshot = `${theme}-20px-${width}-${label}.png`;
  await page.screenshot({
    path: resolve(output, screenshot),
    animations: "disabled",
  });
  report.screenshots.push({ screenshot, metrics });
}
try {
  browser = await chromium.launch({
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/bin/chromium",
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.route("**/*", fixture);
  await context.addInitScript(() => {
    if (!localStorage.getItem("updates-fixture-seeded")) {
      localStorage.setItem(
        "yuzuno.appearance",
        JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }),
      );
      localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
      localStorage.setItem("updates-fixture-seeded", "yes");
    }
    window.EventSource = class {
      readyState = 1;
      addEventListener() {}
      removeEventListener() {}
      close() {}
    };
  });
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.goto(origin);
  const composer = page.locator("[data-composer-input]");
  await composer.waitFor();
  // Typed rather than seeded into storage: a draft is saved under the
  // Workspace it was written in (T-195), and only the running Core knows
  // which Workspace this is. The app saves it under the right key itself.
  await composer.press("Control+End");
  await composer.pressSequentially("更新前写的草稿 · keep this draft");
  await composer.press("Control+End");
  await composer.evaluate((el, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, pastedBody);
  await page.locator(".pasted-text-chip").waitFor();
  await open();
  await hasText(release("B").version);
  for (const theme of ["light", "dark"]) {
    await layout(theme, 1440, 1000, "available");
    await layout(theme, 940, 650, "available");
    await layout(theme, 390, 844, "available");
  }
  check("light/dark 20px layout at desktop, short and narrow sizes");
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(
        () => !!document.activeElement.closest('[role="dialog"]'),
      ),
      true,
    );
  }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await preserved();
  check(
    "keyboard focus stays in dialog and Escape closes without interrupt/read/approval",
  );
  // The root keeps pointer-events stable, so its stacking boundary must keep
  // every background control behind the full-screen portal overlay.
  const backgroundControl = page.getByRole("button", { name: "Toggle context panel", exact: true });
  const originalStyle = await backgroundControl.getAttribute("style");
  await backgroundControl.evaluate((button) => {
    button.style.cssText += ";position:fixed;left:12px;top:12px;z-index:2147483647;width:40px;height:40px";
    window.backgroundClicks = 0;
    button.addEventListener("click", () => window.backgroundClicks++);
  });
  await open();
  assert.equal(await page.evaluate(() =>
    document.elementFromPoint(24, 24)?.classList.contains("modal-overlay")), true,
    "A high-z-index background control remains behind the overlay");
  await page.mouse.click(24, 24);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.backgroundClicks), 0,
    "Dismissing by the overlay must not activate the control behind it");
  await backgroundControl.evaluate((button, style) => {
    if (style === null) button.removeAttribute("style");
    else button.setAttribute("style", style);
  }, originalStyle);
  await preserved();
  check("portal overlay blocks background controls despite their own z-index; outside click only dismisses");
  await open();
  // The page is replaced below, so find the button on the page of the moment.
  const update = () => page.getByRole("button", { name: `Update to ${release("B").version}` });
  // Each stop hands the next step back; wait until it can be taken.
  const updateReady = () =>
    page.waitForFunction((name) => {
      const button = [...document.querySelectorAll("button")].find(
        (el) => el.textContent.trim() === name,
      );
      return button && !button.disabled;
    }, `Update to ${release("B").version}`);
  mode = "invalid";
  await updateReady();
  await update().click();
  await hasText("checksum");
  assert.equal(calls.filter((c) => c.path.endsWith("/apply")).length, 0);
  mode = "disk-full";
  await updateReady();
  await update().click();
  await hasText("Not enough disk space");
  assert.equal(status.acceptingWork, true);
  assert.equal(calls.filter((c) => c.path.endsWith("/prepare")).length, 2);
  check("bad candidate and disk-full errors stop the one click once and leave the workspace available");
  mode = "normal";
  await page.evaluate(() => {
    window.savedUpdateStorageSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      // Whatever Workspace this is, this Agent's draft manifest (T-195).
      const prefix = "yuzuno.composer.v1:";
      if (key.startsWith(prefix)) {
        let parsed;
        try {
          parsed = JSON.parse(key.slice(prefix.length));
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed) && parsed[1] === "a")
          throw new Error("Draft storage is full");
      }
      return window.savedUpdateStorageSet.call(this, key, value);
    };
  });
  await close();
  await composer.press("Control+End");
  await composer.pressSequentially(" unsaved edit");
  draft += " unsaved edit";
  await open();
  await updateReady();
  await update().click();
  await hasText("Draft storage is full");
  // Preparation went ahead; Apply waits for drafts that are saved.
  assert.equal(status.preparedReleaseId, release("B").releaseId);
  assert.equal(calls.filter((c) => c.path.endsWith("/apply")).length, 0);
  assert.equal(status.acceptingWork, true);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.savedUpdateStorageSet;
    delete window.savedUpdateStorageSet;
  });
  check(
    "draft persistence failure prevents applying and keeps the draft in place",
  );
  // The visible error precedes the refresh/finally that releases the action
  // lock. Wait for the UI to accept input before testing the double click.
  await updateReady();
  await update().evaluate((el) => {
    el.click();
    el.click();
  });
  await hasText("Waiting for your agents");
  assert.equal(calls.filter((c) => c.path.endsWith("/apply")).length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith("/prepare")).length, 3, "the prepared release is reused");
  assert.equal(
    await page.locator('[aria-label="Update progress"] [aria-current="step"]').innerText(),
    "Wait for agents",
  );
  await hasText("Waiting for an approval or answer");
  await hasText("Turn is still running · Pause request delivered");
  await hasText("Waiting for an approval or answer · Pause delivery uncertain");
  assert.equal(await page.locator(".updates-blockers .is-idle").count(), 1);
  assert.match(await page.locator(".updates-blockers .is-idle").innerText(), /已保存进度的 Agent[\s\S]*Idle/);
  check("delivered and uncertain notices remain running; only actual idle has the idle marker");
  await preserved();
  for (const theme of ["light", "dark"])
    await layout(theme, 940, 650, "waiting");
  const beforeReload = navigations;
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.goto(origin);
  await open();
  await hasText("Waiting for your agents");
  await preserved();
  assert.equal(calls.filter((c) => c.path.endsWith("/apply")).length, 1);
  check(
    "one click prepares then applies once despite a double click; new tab restores durable wait and draft",
  );
  offline = true;
  await hasText("Reconnecting to Workspace service");
  await preserved();
  offline = false;
  await page.getByRole("button", { name: "Cancel update" }).waitFor();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find(
        (el) => el.textContent === "Cancel update",
      )?.disabled,
  );
  await page.getByRole("button", { name: "Cancel update" }).click();
  await hasText("Update wait cancelled");
  await hasText("Pause requests have expired. Agents that yielded stay idle");
  await preserved();
  check("disconnect/reconnect preserves wait and draft; cancel resumes work");
  mode = "lost-receipt";
  await updateReady();
  await update().click();
  await hasText("Waiting for your agents");
  await page.waitForTimeout(1700);
  assert.equal(calls.filter((c) => c.path.endsWith("/apply")).length, 2);
  await close();
  await open();
  await hasText("Waiting for your agents");
  await page.getByRole("button", { name: "Cancel update" }).click();
  await hasText("Update wait cancelled");
  check(
    "lost apply receipt reconciles the accepted operation without submitting again",
  );
  mode = "timeout";
  await updateReady();
  await update().click();
  await hasText("Waiting for your agents");
  // The wait Core shows can be cancelled while its Apply answer still hangs.
  await page.getByRole("button", { name: "Cancel update" }).click();
  await hasText("Update wait cancelled");
  for (const route of delayedRequests.splice(0))
    await route.abort().catch(() => {});
  await page.waitForTimeout(1700);
  assert.equal(calls.filter((c) => c.path.endsWith("/apply")).length, 3);
  // No choice is left, for any Workspace (T-195 keeps them per Workspace).
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("yuzuno.update-intent"))), []);
  check(
    "a hanging Apply answer leaves Cancel usable for the durable wait and is not sent again",
  );
  mode = "normal";
  status.current = release("B");
  status.candidates = [];
  status.acceptingWork = true;
  status.blockers = [];
  operation("complete");
  await close();
  await open();
  await hasText("Your workspace is up to date");
  const stableNavigations = navigations;
  assert.equal(
    await page.locator('meta[name="yuzuno-release"]').getAttribute("content"),
    release("A").releaseId,
  );
  await page.waitForTimeout(1700);
  assert.equal(navigations, stableNavigations);
  assert.ok(stableNavigations > beforeReload);
  await preserved();
  servedRelease = release("B").releaseId;
  await page.getByRole("button", { name: "Reload this window" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('meta[name="yuzuno-release"]')
      ?.content.includes("workspace-B"),
  );
  await page.locator(".pasted-text-chip").waitFor();
  assert.equal(await page.locator(".pasted-text-chip").count(), 1);
  await preserved();
  await open();
  assert.equal(
    await page.getByRole("button", { name: "Reload this window" }).count(),
    0,
  );
  check(
    "only explicit reload loads the matching new UI and preserves the draft",
  );
  operation("rolledBack", {
    error:
      "Candidate did not start; the previous compatible release is running. No database backup was restored.",
  });
  await hasText("Back on the previous version");
  await layout("dark", 390, 844, "rollback");
  operation("failed", {
    error:
      "A native session could not reconnect. Reconnect this session manually; your conversation is kept.",
  });
  await hasText("The update needs attention");
  await layout("light", 940, 650, "failed");
  await preserved();
  check(
    "rollback and partial restore failures show actionable durable reasons",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
  if (page && !page.isClosed())
    await page
      .screenshot({ path: resolve(output, "failure.png") })
      .catch(() => {});
} finally {
  for (const route of delayedRequests) await route.abort().catch(() => {});
  await context?.close();
  await browser?.close();
  report.calls = calls;
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
  if (report.error) console.error(report.error);
}
