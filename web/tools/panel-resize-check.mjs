import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, unmanagedUpdates } from "./browser-fixtures.mjs";

// All requests are fulfilled in memory; this never connects to a running Core.
assert.ok(
  process.env.YUZUNO_UI_DIST,
  "Set YUZUNO_UI_DIST to an isolated build",
);
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(
  process.env.YUZUNO_RESIZE_OUTPUT || "../acceptance/panel-resize",
);
await mkdir(output, { recursive: true });
const report = {
  mode: "isolated-browser-fixture",
  checks: [],
  errors: [],
  mutations: [],
};
const agents = ["Mori", "Hana"].map((name, i) => ({
  id: String(i),
  name,
  harness: "codex",
  cwd: "/workspace/example",
  model: "test-model",
  color: "green",
  status: "working",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
}));
const turns = Array.from({ length: 18 }, (_, i) => ({
  id: `turn-${i}`,
  status: i === 17 ? "inProgress" : "completed",
  items: [
    {
      id: `user-${i}`,
      type: "userMessage",
      content: [{ type: "text", text: `Task ${i}: 检查对话和侧栏。` }],
    },
    {
      id: `reply-${i}`,
      type: "agentMessage",
      phase: "final_answer",
      text: `Reply ${i}. Keep this message in view while adjusting the panels. 调整宽度后继续阅读。\n\n${"Readable conversation text. ".repeat(20)}`,
    },
  ],
}));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addInitScript(() => {
  window.EventSource = class {
    constructor() {
      window.resizeTestEvents = this;
    }
    close() {}
  };
});
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(
    url.hostname,
    "yuzuno-resize.test",
    "Unexpected external request",
  );
  if (request.method() !== "GET") {
    report.mutations.push({ path: url.pathname, method: request.method() });
    return route.fulfill({ json: {} });
  }
  if (url.pathname === "/api/workspace")
    return route.fulfill({
      json: { agents, runtime: { connected: true }, defaultCwd: "/workspace" },
    });
  const agent = agents.find((a) => url.pathname === `/api/agents/${a.id}`);
  if (agent)
    return route.fulfill({
      json: { agent, turns, pending: [], artifacts: [] },
    });
  if (url.pathname === "/api/updates")
    return route.fulfill({ json: unmanagedUpdates });
  assert.ok(
    !url.pathname.startsWith("/api/"),
    `Unexpected fixture API ${url.pathname}`,
  );
  const path = resolve(
    dist,
    `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
  );
  assert.ok(path.startsWith(`${dist}/`));
  const contentType = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".woff2": "font/woff2",
    ".png": "image/png",
  }[extname(path)];
  return route.fulfill({ body: await readFile(path), contentType });
});
const page = await context.newPage();
page.on("pageerror", (e) => report.errors.push(e.message));
const handle = (side) =>
  page.getByRole("separator", {
    name: side === "rail" ? "Agent sidebar width" : "Context panel width",
  });
const width = async (side) =>
  Math.round(
    (await page.locator(side === "rail" ? ".rail" : ".inspector").boundingBox())
      .width,
  );
async function drag(side, target) {
  const box = await handle(side).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    x + (side === "rail" ? 1 : -1) * (target - (await width(side))),
    y,
    { steps: 12 },
  );
  await page.mouse.up();
}
async function loaded() {
  await page.locator(".final-message").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${actual} != ${expected}`);
try {
  await page.goto("http://yuzuno-resize.test/");
  await loaded();
  await page
    .getByRole("textbox", { name: "Message Mori" })
    .fill("侧栏测试草稿 — keep me");
  await page.locator(".conversation-scroll").evaluate((el) => {
    el.scrollTop = 600;
  });
  await drag("rail", 320);
  await drag("inspector", 340);
  near(await width("rail"), 320);
  near(await width("inspector"), 340);
  assert.equal(
    await composerDraft(page.getByRole("textbox", { name: "Message Mori" })),
    "侧栏测试草稿 — keep me",
  );
  await page.evaluate(() =>
    window.resizeTestEvents.onmessage?.({ data: "update" }),
  );
  await page.waitForTimeout(250);
  assert.ok(
    await page
      .locator(".conversation-scroll")
      .evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight > 1000,
      ),
  );
  report.checks.push(
    "Both panels drag independently; draft and history reading survive a new execution event",
  );

  await page.reload();
  await loaded();
  near(await width("rail"), 320);
  near(await width("inspector"), 340);
  assert.equal(
    await composerDraft(page.getByRole("textbox", { name: "Message Mori" })),
    "侧栏测试草稿 — keep me",
  );
  await page.locator(".agent-select").filter({ hasText: "Hana" }).click();
  await page.getByRole("textbox", { name: "Message Hana" }).waitFor();
  near(await width("rail"), 320);
  near(await width("inspector"), 340);
  await page.getByRole("button", { name: "Hide agent sidebar" }).click();
  assert.equal(await handle("rail").count(), 0);
  await page.getByRole("button", { name: "Show agent sidebar" }).click();
  near(await width("rail"), 320);
  await page.getByRole("button", { name: "Close context panel" }).click();
  assert.equal(await handle("inspector").count(), 0);
  await page.getByRole("button", { name: "Toggle context panel" }).click();
  near(await width("inspector"), 340);
  report.checks.push("Widths survive reload, Agent switch and panel hide/show");

  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      localStorage.setItem(
        "yuzuno.appearance",
        JSON.stringify({ theme, fontSize: 20 }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "yuzuno.appearance" }),
      );
    }, theme);
    for (const viewport of [1600, 1440, 1101, 940, 721, 600, 521, 390]) {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.waitForTimeout(50);
      const layout = await page.evaluate(() => {
        const title = document
          .querySelector(".conversation-title")
          .getBoundingClientRect();
        const actions = document
          .querySelector(".conversation-actions")
          .getBoundingClientRect();
        return {
          main: document.querySelector(".main-panel").getBoundingClientRect()
            .width,
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          controlsFit:
            (title.right <= actions.left || title.bottom <= actions.top) &&
            actions.right <= innerWidth,
          font: document.documentElement.dataset.fontSize,
        };
      });
      assert.equal(layout.font, "20");
      assert.ok(layout.noOverflow, `Overflow at ${viewport}`);
      assert.ok(layout.controlsFit, `Header overlap at ${viewport}`);
      assert.equal(await handle("rail").count(), viewport > 520 ? 1 : 0);
      assert.equal(await handle("inspector").count(), viewport > 1100 ? 1 : 0);
      if ([1440, 940, 390].includes(viewport))
        await page.screenshot({
          path: `${output}/${theme}-${viewport}-20px.png`,
        });
      report.checks.push({ theme, viewport, ...layout });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(50);
  near(await width("rail"), 320);
  near(await width("inspector"), 340);
  report.checks.push(
    "Window resizing preserves preferred widths across responsive breakpoints",
  );

  for (const side of ["rail", "inspector"]) {
    const before = await width(side);
    await handle(side).focus();
    await page.keyboard.press(side === "rail" ? "ArrowRight" : "ArrowLeft");
    near(await width(side), before + 8);
    await page.keyboard.press("Home");
    near(await width(side), side === "rail" ? 180 : 240);
    await page.keyboard.press("End");
    near(
      await width(side),
      Number(await handle(side).getAttribute("aria-valuemax")),
    );
    assert.ok((await page.locator(".main-panel").boundingBox()).width >= 560);
    await page.keyboard.press("Escape");
    await handle(side).dblclick();
    near(await width(side), side === "rail" ? 244 : 272);
    await drag(side, 20);
    near(await width(side), side === "rail" ? 180 : 240);
    await drag(side, 900);
    near(
      await width(side),
      Number(await handle(side).getAttribute("aria-valuemax")),
    );
    await handle(side).focus();
    await page.keyboard.press("Enter");
  }
  const box = await handle("rail").boundingBox();
  await page.mouse.move(box.x + 4, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 64, box.y + 100);
  // While dragging, the whole page shows the resize cursor and selects no
  // text; this is a root class now, not an .app:has() rule (T-18).
  const dragStyle = () =>
    page.locator(".final-message").first().evaluate((el) => ({
      root: document.documentElement.classList.contains("is-resizing-panels"),
      cursor: getComputedStyle(el).cursor,
      select: getComputedStyle(el).userSelect,
    }));
  assert.deepEqual(await dragStyle(), { root: true, cursor: "col-resize", select: "none" });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  near(await width("rail"), 244);
  assert.equal(await page.locator(".is-resizing").count(), 0);
  assert.equal((await dragStyle()).root, false);
  assert.notEqual((await dragStyle()).cursor, "col-resize");
  const hidingBox = await handle("inspector").boundingBox();
  await page.mouse.move(hidingBox.x + 4, hidingBox.y + 100);
  await page.mouse.down();
  await page.setViewportSize({ width: 940, height: 900 });
  await page.mouse.up();
  await page.setViewportSize({ width: 1440, height: 900 });
  await handle("inspector").waitFor();
  assert.equal(await page.locator(".is-resizing").count(), 0);
  assert.equal((await dragStyle()).root, false);
  near(await width("inspector"), 272);
  await page.locator(".inspector-content").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const rightBox = await handle("inspector").boundingBox();
  const inspectorBox = await page.locator(".inspector").boundingBox();
  near(rightBox.y, inspectorBox.y);
  near(rightBox.height, inspectorBox.height);
  report.checks.push(
    "Pointer/keyboard limits, reset, Escape cancellation, and fixed handle during right-panel scrolling",
  );
  assert.deepEqual(report.mutations, []);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  await page.screenshot({ path: `${output}/failure.png` });
  throw e;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}
console.log(
  `Passed ${report.checks.length} checks; no Core connections or mutations. ${output}/report.json`,
);
