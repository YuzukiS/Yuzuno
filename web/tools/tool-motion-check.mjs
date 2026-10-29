// Tool activity motion in a real browser: blocks and rows that arrive live
// unfold while the conversation follows them, counts and statuses settle in,
// the running row shimmers, and what loads with the page or opens by hand
// does not move the reader. Production bundle, no Core.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/tool-motion");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [] };
const record = (name, extra = {}) => report.checks.push({ name, ...extra });

const agent = {
  id: "a", name: "Mori", status: "working", harness: "codex", cwd: "/fixture", model: "test-model",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  workSummary: { text: "Inspect the earlier tool", kind: "result", source: "agent", turnId: "old-1", itemId: "old-tool-1" },
};
const agents = [agent, { ...agent, id: "b", name: "Hana", status: "idle" }];
const shell = (id, command, status = "inProgress", exitCode) => ({
  id, type: "commandExecution", command, status, ...(exitCode == null ? {} : { exitCode }),
  aggregatedOutput: `$ ${command}\n` + Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n"),
});
const live = {
  id: "live",
  status: "inProgress",
  items: [
    { id: "ask", type: "userMessage", content: [{ type: "text", text: "检查一下构建，再跑一遍测试。" }] },
    { id: "progress", type: "agentMessage", phase: "commentary", text: "先看构建配置。" },
    shell("tool-a", "npm run build"),
  ],
};
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `old-${i}`, status: "completed",
      items: [
        { id: `old-ask-${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
        { id: `old-tool-${i}`, type: "commandExecution", command: "git status", status: "completed", exitCode: 0 },
        { id: `old-reply-${i}`, type: "agentMessage", text: "已检查。\n\n" + "工具活动与阅读位置保持稳定。".repeat(8) },
      ],
    })),
    live,
  ],
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  window.EventSource = class { constructor() { window.testEvents = this; } close() {} };
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
});
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(route.request().method(), "GET", `no writes: ${url.pathname}`);
  if (url.pathname === "/api/workspace")
    return route.fulfill({ json: { agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
  if (/^\/api\/agents\/[ab]$/.test(url.pathname)) {
    const id = url.pathname.at(-1);
    return route.fulfill({
      json: { ...detail, agent: agents.find((a) => a.id === id), turns: id === "a" ? detail.turns : [] },
    });
  }
  if (url.pathname === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
  if (url.pathname === "/api/catchup")
    return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
  if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
  const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" }[extname(file)],
  });
});
page.on("pageerror", (error) => report.errors.push(error.message));

const refresh = () => page.evaluate(() => window.testEvents.onmessage({ data: "{}" }));
/** Animation ids (tool-motion.ts) and CSS animation names running now, by target. */
const running = () =>
  page.evaluate(() =>
    document.getAnimations()
      .filter((a) => a.playState === "running" || a.playState === "paused")
      .map((a) => ({
        name: a.id || a.animationName || "",
        target: a.effect?.target?.id || a.effect?.target?.className?.baseVal || a.effect?.target?.className || "",
      }))
      .filter((a) => /^tool-/.test(a.name)),
  );
const gap = () =>
  page.locator(".conversation-scroll").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
/** scrollTop on every frame for `ms`: following glides, it does not jump. */
const glide = (ms) =>
  page.locator(".conversation-scroll").evaluate(
    (el, ms) =>
      new Promise((done) => {
        const tops = [];
        const start = performance.now();
        const step = () => {
          tops.push(Math.round(el.scrollTop));
          if (performance.now() - start < ms) requestAnimationFrame(step);
          else done(tops);
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
const block = (n) => page.locator('[data-turn-id="live"] .tool-activity').nth(n);
const composer = page.getByRole("textbox", { name: "Message Mori" });

async function checkLiveMotion() {
  await page.locator("#item-tool-a").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  // What loads with the page is shown as it is; the running row shimmers
  // and the spinner is on.
  const loaded = await running();
  assert.deepEqual(loaded.filter((a) => a.name !== "tool-shimmer"), [], JSON.stringify(loaded));
  assert.equal(await gap(), 0);
  assert.ok(await page.locator(".conversation-scroll").evaluate((el) => el.scrollHeight > el.clientHeight * 1.5), "the conversation scrolls");
  const first = await block(0).evaluate((el) => ({
    open: el.open,
    spinner: el.querySelector(".tool-spinner")?.hasAttribute("data-on"),
    shimmer: el.querySelector("#item-tool-a > summary > span").getAnimations().map((a) => a.animationName),
    label: el.querySelector(".tool-activity-label").textContent,
  }));
  assert.deepEqual(first, { open: true, spinner: true, shimmer: ["tool-shimmer"], label: "Running tools" });
  await block(0).screenshot({ path: `${output}/running-row.png` });
  record("Loaded blocks do not move; the running row shimmers; the spinner is on", first);

  // A new row: it unfolds, the count ticks, the finished row's status
  // settles in, and the conversation glides to keep the end in view.
  live.items[2] = shell("tool-a", "npm run build", "completed", 0);
  live.items.push(shell("tool-b", "npm test"));
  await refresh();
  await page.locator("#item-tool-b").waitFor();
  const arriving = await running();
  for (const [name, target] of [["tool-unfold", "item-tool-b"], ["tool-count-tick", "tool-overview-part"], ["tool-result", "tool-result"]])
    assert.ok(arriving.some((a) => a.name === name && a.target === target), `${name} on ${target}: ${JSON.stringify(arriving)}`);
  const tops = await glide(380);
  const steps = new Set(tops).size;
  assert.ok(steps >= 4 && tops.at(-1) > tops[0], `follows in steps: ${tops}`);
  await page.waitForTimeout(100);
  assert.equal(await gap(), 0);
  assert.equal(await page.locator("#item-tool-a").evaluate((el) => el.hasAttribute("data-running")), false);
  record("A new row unfolds with the count tick and status settle; the view glides along", { tops });

  // Filmstrip of the next row, paused at fixed points.
  live.items[3] = shell("tool-b", "npm test", "completed", 0);
  live.items.push(shell("tool-c", "npm run lint"));
  await refresh();
  await page.locator("#item-tool-c").waitFor();
  const strip = [];
  for (const at of [0, 75, 150, 300]) {
    const sample = await page.evaluate((at) => {
      // Held here: paused at its end, an animation is no longer listed.
      window.strip ??= document.getAnimations().filter((a) => /^tool-(unfold|count|result)/.test(a.id));
      for (const a of window.strip) { a.pause(); a.currentTime = at; }
      const row = document.getElementById("item-tool-c");
      return { at, height: Math.round(row.getBoundingClientRect().height), opacity: Number(getComputedStyle(row).opacity).toFixed(2) };
    }, at);
    strip.push(sample);
    await block(0).screenshot({ path: `${output}/row-unfold-${at}ms.png` });
  }
  assert.ok(strip[0].height <= 1 && strip[0].opacity === "0.00", JSON.stringify(strip));
  assert.ok(strip[1].height > strip[0].height && strip[1].height < strip[3].height, JSON.stringify(strip));
  await page.evaluate(() => { for (const a of window.strip) a.finish(); });
  await page.waitForFunction(() => !document.getElementById("item-tool-c").hasAttribute("data-unfolding"));
  record("Row unfold filmstrip", { strip });

  // Commentary closes the block and tools finish: the heading fades to
  // "Tool activity" and the spinner fades out. A new block then unfolds.
  live.items[4] = shell("tool-c", "npm run lint", "completed", 0);
  live.items.push({ id: "progress-2", type: "agentMessage", phase: "commentary", text: "构建和测试都通过了，再看一眼格式。" });
  await refresh();
  await page.waitForFunction(() => document.querySelector('[data-turn-id="live"] .tool-activity')?.open === false);
  const finishing = await running();
  assert.ok(finishing.some((a) => a.name === "tool-label"), JSON.stringify(finishing));
  assert.equal(await block(0).locator(".tool-spinner").evaluate((el) => el.hasAttribute("data-on")), false);
  await page.waitForTimeout(350);
  assert.equal(await block(0).locator(".tool-spinner").evaluate((el) => getComputedStyle(el).opacity), "0");
  await page.waitForTimeout(100);
  assert.equal(await gap(), 0);
  live.items.push(shell("tool-d", "npx prettier --check ."));
  await refresh();
  await block(1).waitFor();
  const unfolding = await running();
  assert.ok(unfolding.some((a) => a.name === "tool-unfold" && /tool-activity/.test(a.target)), JSON.stringify(unfolding));
  const blockTops = await glide(380);
  assert.ok(new Set(blockTops).size >= 4, `block arrival glides: ${blockTops}`);
  await page.waitForTimeout(100);
  assert.equal(await gap(), 0);
  record("Commentary folds the block and the heading settles; a new block unfolds and the view follows", { blockTops });

  // Opening and closing by hand: the content eases open and shut and the
  // reader's row stays where they clicked it.
  const row = page.locator("#item-tool-d");
  const summaryTop = () => row.locator(":scope > summary").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await summaryTop();
  const opening = await row.evaluate(async (el) => {
    el.querySelector(":scope > summary").click();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await new Promise((done) => setTimeout(done, 60));
    const style = getComputedStyle(el, "::details-content");
    return {
      middle: Math.round(el.getBoundingClientRect().height),
      duration: style.transitionDuration.split(",")[0].trim(),
      chevron: getComputedStyle(el.querySelector(":scope > summary > svg")).transitionTimingFunction,
    };
  });
  await page.waitForTimeout(450);
  const opened = await row.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  assert.ok(opening.middle < opened, JSON.stringify({ opening, opened }));
  assert.equal(opening.duration, "0.3s");
  assert.match(opening.chevron, /cubic-bezier\(0\.34, 1\.5/);
  assert.equal(await summaryTop(), before, "the reader's row does not move");
  await row.locator(":scope > summary").hover();
  const tint = await row.locator(":scope > summary").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(tint, "rgba(0, 0, 0, 0)");
  await block(1).screenshot({ path: `${output}/row-opened-hover.png` });
  await row.locator(":scope > summary").click();
  await page.waitForFunction(() => document.getElementById("item-tool-d").open === false);
  const closing = await row.evaluate((el) => getComputedStyle(el, "::details-content").transitionDuration.split(",")[0].trim());
  assert.equal(closing, "0.22s");
  await page.waitForTimeout(300);
  await page.mouse.move(5, 400);
  record("Opening and closing by hand ease without moving the reader's row; summaries tint on hover", { opening, opened, closing });

  // Switching Agents and back draws the conversation as it is.
  await page.getByRole("button", { name: "Open Hana", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Hana" }).waitFor();
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await page.locator("#item-tool-d").waitFor();
  const back = (await running()).filter((a) => a.name !== "tool-shimmer");
  assert.deepEqual(back, []);
  record("Switching Agents back does not replay arrivals");

  // A composer that grows while the conversation follows keeps its end in
  // view rather than covering the last lines.
  await page.waitForTimeout(200);
  assert.equal(await gap(), 0);
  const pane = () => page.locator(".conversation-scroll").evaluate((el) => el.clientHeight);
  const tall = await pane();
  await composer.fill("第一行\n第二行\n第三行\n第四行\n第五行");
  await page.waitForTimeout(150);
  const short = await pane();
  assert.ok(short < tall - 40, JSON.stringify({ tall, short }));
  assert.equal(await gap(), 0);
  await composer.fill("");
  record("A growing composer keeps the end of a followed conversation in view", { tall, short });

  // Reduced motion: rows and blocks appear in place, nothing shimmers.
  await page.emulateMedia({ reducedMotion: "reduce" });
  live.items.push(shell("tool-e", "npm run format"));
  await refresh();
  await page.locator("#item-tool-e").waitFor();
  const still = await running();
  assert.deepEqual(still, [], JSON.stringify(still));
  assert.equal(await page.locator(".tool-spinner").last().evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
  await page.waitForTimeout(100);
  assert.equal(await gap(), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  record("Reduced motion: no unfold, tick or shimmer");

  // Dark theme: the running row and the hover tint read on the dark palette.
  await page.evaluate(() => {
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "dark", fontSize: 16, palette: "garden" }));
  });
  await page.reload();
  await page.locator("#item-tool-e").waitFor();
  await page.waitForTimeout(300);
  await block(1).screenshot({ path: `${output}/running-row-dark.png` });
  record("Dark theme screenshot");
}

try {
  await page.goto("https://yuzuno-tool-motion.test/");
  if (!process.argv.includes("--history-only")) await checkLiveMotion();

  // First inspection of deferred history keeps native keyboard disclosure,
  // nested state and the reading anchor, including large type and narrow panes.
  for (const theme of ["light", "dark"]) for (const width of [1440, 720]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 20, palette: "garden" }));
    }, theme);
    await page.reload();
    await page.locator('[data-turn-id="live"] .tool-item').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    assert.equal(await page.locator("html").getAttribute("data-font-size"), "20");
    assert.equal(await page.locator(".turn").count(), 7);
    assert.equal(await page.locator("#item-old-tool-0").count(), 0);
    await composer.fill("history draft A");
    const history = page.locator('[data-turn-id="old-0"] .tool-activity');
    const summary = history.locator(":scope > summary");
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    const top = await summary.evaluate((el) => el.getBoundingClientRect().top);
    await page.keyboard.press("Enter");
    const inspected = page.locator("#item-old-tool-0");
    await inspected.waitFor();
    assert.deepEqual((await running()).filter((a) => a.name === "tool-unfold"), [], "inspection does not replay tool arrivals");
    await page.waitForTimeout(400);
    assert.ok(Math.abs(await summary.evaluate((el) => el.getBoundingClientRect().top) - top) <= 2, "opening history preserves the reading anchor");
    await inspected.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await inspected.evaluate((el) => el.open), true);
    await inspected.evaluate((el) => { window.inspectedHistoryRow = el; });
    await summary.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    assert.equal(await history.evaluate((el) => el.open), false);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(350);
    assert.equal(await inspected.evaluate((el) => el === window.inspectedHistoryRow && el.open), true);
    assert.equal(await composer.textContent(), "history draft A");
    const box = await composer.boundingBox();
    assert.ok(box.width > 100 && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
    const summaryBox = await summary.boundingBox();
    assert.ok(summaryBox.x >= 0 && summaryBox.x + summaryBox.width <= width, JSON.stringify(summaryBox));
    await page.screenshot({ path: `${output}/history-${theme}-20px-${width}.png` });
    if (width === 1440) {
      assert.equal(await page.locator("#item-old-tool-1").count(), 0);
      await page.locator(".inspector-work-source").click();
      await page.waitForFunction(() => document.activeElement?.id === "item-old-tool-1", null, { timeout: 5000 });
      assert.equal(await page.locator("#item-old-tool-1").evaluate((el) => el.closest(".tool-activity").open), true);
      await page.waitForFunction(() => !document.querySelector("[data-source-jump]"));
      assert.equal(await page.locator("#item-old-tool-1").evaluate((el) =>
        getComputedStyle(el.closest(".tool-activity"), "::details-content").transitionDuration.split(",")[0].trim()), "0.3s", "manual disclosure motion resumes after the jump");
      assert.doesNotMatch(await page.locator(".source-navigation").textContent(), /unavailable/);
      assert.equal(await page.locator("#item-old-tool-1").evaluate((el) => {
        const target = el.getBoundingClientRect();
        const pane = document.querySelector(".conversation-scroll").getBoundingClientRect();
        return target.top >= pane.top && target.bottom <= pane.bottom;
      }), true, "the focused original source is visible in the reading pane");
    }
    await page.getByRole("button", { name: "Open Hana", exact: true }).click();
    const otherComposer = page.getByRole("textbox", { name: "Message Hana" });
    await otherComposer.waitFor();
    await otherComposer.fill("history draft B");
    await page.getByRole("button", { name: "Open Mori", exact: true }).click();
    await composer.waitFor();
    assert.equal(await composer.textContent(), "history draft A");
    assert.equal(await page.locator(".turn").count(), 7);
    const choices = page.locator("[data-turn-choice]");
    await choices.first().focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-turn-id") === "old-0");
    assert.equal(await composer.textContent(), "history draft A");
    record("Deferred history: keyboard inspection, retained nested state, anchor, draft and turn navigation", { theme, fontSize: 20, width, sourceNavigation: width === 1440 });
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
