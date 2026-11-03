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
async function mount(width = 1440, theme = "light", prepare) {
  const fixture = outcomeFixture();
  prepare?.(fixture);
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
/** The current result's two items cite a comparison and a negative claim. */
function citeRecords(fixture) {
  const mina = { kind: "agent", id: "writer", name: "Mina" };
  const at = "2026-10-01T14:00:00Z";
  const [desktop, mobile] = fixture.current.outcome.criteria;
  desktop.records = [
    {
      activitySeq: 14,
      version: 2,
      producer: mina,
      at,
      record: {
        kind: "research",
        type: "comparison",
        id: "widths",
        title: "桌面与手机阅读的比较",
        counts: { included: 2, excluded: 1, missing: 0, not_done: 1 },
      },
    },
  ];
  mobile.records = [
    {
      activitySeq: 12,
      version: 1,
      producer: mina,
      at,
      record: {
        kind: "research",
        type: "claim",
        id: "touch",
        title: "390 宽度下触控区域足够大",
        status: "unsupported",
      },
    },
  ];
  const answer = fixture.answer;
  fixture.answer = (path, body) => {
    const data = answer(path, body);
    if (path.endsWith("/task_result_get") && body.taskId === "T-1")
      data.records = [
        { criterionId: "desktop", activitySeq: 14, state: "missing" },
        {
          criterionId: "mobile",
          activitySeq: 12,
          state: "readable",
          revisedBy: 15,
          latestActivitySeq: 15,
        },
      ];
    return data;
  };
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
  const outcomeTrigger = page.getByRole("button", {
    name: "成果与证据",
    exact: true,
  });
  await outcomeTrigger.click();
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
  await page
    .locator(".outcome-drawer")
    .waitFor({ state: "detached", timeout: 5000 });
  await page.waitForFunction(
    (trigger) => document.activeElement === trigger,
    await outcomeTrigger.elementHandle(),
    { timeout: 5000 },
  );
  report.checks.push({
    name: "closing historical evidence restores focus to its exact trigger",
  });
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
  const sourceDetails = mobile.page.locator(".outcome-source-details").first();
  const sourceSummary = sourceDetails.locator(":scope > summary");
  const closedMarker = await sourceSummary.evaluate(
    (element) => getComputedStyle(element, "::after").content,
  );
  assert.notEqual(
    closedMarker,
    '"−"',
    "closed source does not inherit the open criterion marker",
  );
  await sourceSummary.click();
  assert.equal(
    await sourceDetails.locator("code").first().isVisible(),
    true,
    "source opens independently",
  );
  await sourceSummary.click();
  assert.equal(
    await sourceDetails.locator("code").first().isVisible(),
    false,
    "source closes independently",
  );
  report.checks.push({
    name: "nested source disclosure keeps its own closed marker and open state",
    closedMarker,
  });
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
  // Research records a criterion cites (T-17): as cited, their support apart
  // from the item's status, and where each line stands now; by keyboard,
  // readable, and inside the drawer on a phone.
  for (const [width, theme, name] of [
    [1440, "light", "records-desktop"],
    [1440, "dark", "records-dark"],
    [390, "light", "records-mobile"],
  ]) {
    const cited = await mount(width, theme, citeRecords);
    await cited.page
      .getByRole("button", { name: "成果与证据", exact: true })
      .click();
    await cited.page.locator(".outcome-drawer .outcome-author-report").waitFor();
    await cited.page.getByRole("tab", { name: "逐项依据", exact: true }).click();
    const summaries = cited.page.locator(".outcome-criterion > summary");
    for (let n = 0; n < (await summaries.count()); n++) {
      await summaries.nth(n).focus();
      await cited.page.keyboard.press("Enter");
    }
    await cited.page.locator(".outcome-record").nth(1).waitFor();
    const text = await cited.page.locator(".outcome-drawer").innerText();
    for (const expected of [
      "研究记录",
      "两者互不推导",
      "活动 12 · 第 1 版 · 作者 Mina",
      "不支持 — 记录作者对支持程度的判断",
      "较新的版本是活动 15；本结果引用的是上面这一版",
      "纳入 2 · 排除 1 · 缺失 0 · 未做 1",
      "这条记录已无法读取",
    ])
      assert.ok(text.includes(expected), `${name}: ${expected}`);
    assert.doesNotMatch(text, /verified|已验证/i);
    const low = await cited.page.evaluate(() => {
      const rgb = (t) => (t.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const behind = (el) => {
        for (let node = el; node; node = node.parentElement) {
          const c = rgb(getComputedStyle(node).backgroundColor);
          if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) return c;
        }
        return [255, 255, 255];
      };
      const rows = [];
      for (const el of document.querySelectorAll(
        ".outcome-records, .outcome-records *",
      )) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
          continue;
        const fg = lum(rgb(getComputedStyle(el).color)),
          bg = lum(behind(el));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        rows.push({ what: el.className, ratio: Math.round(ratio * 100) / 100 });
      }
      return { lowest: Math.min(...rows.map((r) => r.ratio)), rows: rows.filter((r) => r.ratio < 4.5), measured: rows.length };
    });
    assert.deepEqual(low.rows, [], `${name}: every word readable`);
    await cited.page.locator(".outcome-records").first().scrollIntoViewIfNeeded();
    await snap(cited.page, name);
    report.checks.push({
      name: `${name}: cited records by keyboard, support apart from the item's status, readable, inside the drawer`,
      lowestContrast: low.lowest,
      measured: low.measured,
    });
    await cited.context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, []);
} catch (error) {
  report.failures.push(error.stack || String(error));
  report.focusAtFailure = await activePage
    ?.evaluate(() => ({
      active: document.activeElement?.outerHTML.slice(0, 1000),
      drawerPresent: !!document.querySelector(".outcome-drawer"),
      triggers: [...document.querySelectorAll(".task-outcome button")].map(
        (button) => ({
          text: button.textContent,
          connected: button.isConnected,
        }),
      ),
    }))
    .catch(() => null);
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
