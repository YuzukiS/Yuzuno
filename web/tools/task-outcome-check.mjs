// Real product bundle, isolated Chromium, synthetic API records only.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { outcomeFixture } from "./task-outcome-fixture.mjs";
import { idleJobsBudget, unmanagedUpdates } from "./browser-fixtures.mjs";
assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST),
  output = resolve(
    process.env.YUZUNO_BROWSER_OUTPUT || "../.validation/outcome-browser",
  );
assert.notEqual(dist, resolve("dist"));
await mkdir(output, { recursive: true });
const report = {
  checks: [],
  errors: [],
  unexpected: [],
  screenshots: [],
  writes: [],
  failures: [],
};
let activePage;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
        .map((a) => a.finished.catch(() => {})),
    );
  });
}
async function snap(page, name) {
  await settle(page);
  const bounds = await page.evaluate(() => {
    const dialog =
      document.querySelector(".outcome-drawer") ||
      document.querySelector(".modal");
    const r = dialog.getBoundingClientRect();
    return {
      page: document.documentElement.scrollWidth - innerWidth,
      inner: dialog.scrollWidth - dialog.clientWidth,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  assert.ok(
    bounds.page <= 1 &&
      bounds.inner <= 1 &&
      bounds.left >= -1 &&
      bounds.right <= bounds.width + 1 &&
      bounds.top >= -1 &&
      bounds.bottom <= bounds.height + 1,
    JSON.stringify(bounds),
  );
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
  report.checks.push({ name, bounds });
}
async function mount(width = 1440, theme = "light") {
  const fixture = outcomeFixture();
  const context = await browser.newContext({
    viewport: { width, height: width < 650 ? 844 : 960 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  activePage = page;
  await page.addInitScript(
    ({ theme }) => {
      window.EventSource = class {
        constructor() {
          window.syntheticEvents = this;
        }
        addEventListener() {}
        close() {}
      };
      localStorage.setItem(
        "yuzuno.language",
        JSON.stringify({ language: "zh-Hans" }),
      );
      localStorage.setItem(
        "yuzuno.appearance",
        JSON.stringify({ theme, palette: "garden", fontSize: 16 }),
      );
    },
    { theme },
  );
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.hostname !== "outcome.synthetic.test") {
      report.unexpected.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith("/api/")) {
      const body = request.postData() ? JSON.parse(request.postData()) : {};
      if (
        request.method() !== "GET" &&
        ![
          "task_get",
          "task_result_get",
          "task_list",
          "github_links",
          "github_refresh",
          "github_repositories",
          "delivery_get",
          "peers_list",
        ].includes(url.pathname.split("/").at(-1))
      )
        report.writes.push(url.pathname);
      if (url.pathname === "/api/jobs/budget")
        return route.fulfill({ json: idleJobsBudget });
      if (url.pathname === "/api/updates")
        return route.fulfill({ json: unmanagedUpdates });
      if (url.pathname.startsWith("/api/agents/"))
        return route.fulfill({
          json: {
            agent: fixture.agents.find((a) =>
              url.pathname.endsWith("/" + a.id),
            ),
            turns: [
              {
                id: "turn-synthetic",
                status: "completed",
                items: [
                  {
                    id: "synthetic-input",
                    type: "userMessage",
                    content: [{ type: "text", text: "Synthetic source input" }],
                  },
                  {
                    id: "synthetic-output",
                    type: "agentMessage",
                    text: "Synthetic source report",
                  },
                ],
              },
            ],
            pending: [],
            artifacts: [],
            messageReceipts: [],
          },
        });
      const data = fixture.answer(url.pathname, body);
      return route.fulfill({ status: data.error ? 500 : 200, json: data });
    }
    const file = resolve(
      dist,
      "." + (url.pathname === "/" ? "/index.html" : url.pathname),
    );
    assert.ok(file.startsWith(dist + "/"));
    return route.fulfill({
      body: await readFile(file),
      contentType:
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[extname(file)] || "application/octet-stream",
    });
  });
  await page.goto("https://outcome.synthetic.test/");
  await page.getByRole("button", { name: "任务与消息", exact: true }).click();
  await page.locator('button[data-task-id="T-1"]').click();
  await page.locator(".task-outcome").waitFor();
  await settle(page);
  return { page, fixture, context };
}
try {
  const { page, fixture, context } = await mount();
  await page.locator(".task-outcome").scrollIntoViewIfNeeded();
  await snap(page, "desktop-spacious");
  const before = await page.locator(".outcome-overview dt").allTextContents();
  await page.getByRole("button", { name: "紧凑", exact: true }).click();
  assert.deepEqual(
    await page.locator(".outcome-overview dt").allTextContents(),
    before,
  );
  await snap(page, "desktop-compact");
  await page.getByRole("button", { name: "成果与证据", exact: true }).click();
  await page.locator(".outcome-drawer .outcome-author-report").waitFor();
  await snap(page, "desktop-outcome");
  await page.getByRole("tab", { name: "逐项依据", exact: true }).click();
  await page.locator(".outcome-criterion > summary").first().click();
  await snap(page, "desktop-evidence");
  assert.match(
    await page.locator(".outcome-drawer").innerText(),
    /当前文件尚未重新读取/,
  );
  assert.match(
    await page.locator(".outcome-drawer").innerText(),
    /独立核对.*用户接受/,
  );
  await page.getByRole("tab", { name: "版本记录", exact: true }).click();
  await snap(page, "desktop-versions");
  await page
    .locator(".outcome-history article")
    .nth(1)
    .getByRole("button", { name: "逐项依据" })
    .click();
  await page
    .locator(".outcome-record-id")
    .filter({ hasText: "result-earlier" })
    .waitFor();
  await page.locator(".outcome-criterion > summary").click();
  assert.equal(await page.locator(".outcome-drawer a[download]").count(), 0);
  await snap(page, "desktop-historical-mismatch");
  await page.getByRole("button", { name: "关闭成果详情" }).click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "成果与证据",
  );
  await page.getByRole("button", { name: "更新结果", exact: true }).click();
  const draft = page.locator(".collab-result textarea").first();
  await draft.fill("不会被后台刷新抹掉的草稿");
  await draft.focus();
  fixture.tasks[0].version++;
  await page.evaluate(() =>
    window.syntheticEvents?.onmessage?.({
      data: JSON.stringify({
        type: "workspace.changed",
        scope: "collaboration",
        tasks: true,
      }),
    }),
  );
  await page.waitForTimeout(250);
  assert.equal(await draft.inputValue(), "不会被后台刷新抹掉的草稿");
  assert.equal(await draft.evaluate((e) => e === document.activeElement), true);
  report.checks.push({ name: "background refresh preserves draft and focus" });
  await page.getByRole("button", { name: "查看原始对话", exact: true }).click();
  await page
    .locator('[data-agent-id="writer"] [data-turn-id="turn-synthetic"]')
    .waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-turn-id") === "turn-synthetic",
  );
  report.checks.push({
    name: "full App source link opens the exact author and native turn",
    agentId: "writer",
    turnId: "turn-synthetic",
  });
  await settle(page);
  await page.screenshot({ path: resolve(output, "source-navigation.png") });
  report.screenshots.push("source-navigation.png");
  await context.close();
  const mobile = await mount(390);
  await mobile.page.locator(".task-outcome").scrollIntoViewIfNeeded();
  await snap(mobile.page, "mobile-outcome");
  await mobile.page
    .getByRole("button", { name: "成果与证据", exact: true })
    .click();
  await mobile.page.locator(".outcome-drawer .outcome-author-report").waitFor();
  await mobile.page.getByRole("tab", { name: "逐项依据", exact: true }).click();
  await mobile.page.locator(".outcome-criterion > summary").first().click();
  assert.equal(
    await mobile.page
      .locator(".outcome-source-details")
      .first()
      .getAttribute("open"),
    null,
    "technical identity starts folded on mobile",
  );
  assert.equal(
    await mobile.page
      .locator(".outcome-source-details code")
      .first()
      .isVisible(),
    false,
  );
  await snap(mobile.page, "mobile-evidence");
  const size = await mobile.page.locator(".outcome-drawer").boundingBox();
  assert.ok(size.width >= 388 && size.height >= 842, "mobile full screen");
  await mobile.context.close();
  const dark = await mount(1440, "dark");
  await dark.page
    .getByRole("button", { name: "成果与证据", exact: true })
    .click();
  await dark.page.locator(".outcome-drawer .outcome-author-report").waitFor();
  await snap(dark.page, "desktop-dark");
  await dark.context.close();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, []);
} catch (error) {
  report.failures.push(error.stack || String(error));
  await activePage
    ?.screenshot({ path: resolve(output, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
