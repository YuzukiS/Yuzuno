// The Tool activity capsule row (T-9) in a real browser: one capsule per
// tool, fully rounded, carrying the name the harness gave it, how many calls
// it holds and what those calls reported. Desktop and phone, light and dark.
// Production bundle, no Core; nothing is written but the report and its
// screenshots, and nothing is sent.
//   YUZUNO_UI_DIST=<isolated build> node tools/tool-capsule-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/tool-capsules");
await mkdir(output, { recursive: true });
const report = { task: "T-9", checks: [], shots: [], errors: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const agent = {
  id: "a", name: "Mori", status: "working", harness: "claude", cwd: "/fixture", model: "test-model",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  connectionState: "connected", goal: "", projectId: null,
};
const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const reply = (id, text) => ({ id, type: "agentMessage", text });
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: [
    // A finished turn: calls that returned stay neutral, one tool reports a
    // failure among its calls, and a long MCP name has to stay readable.
    { id: "done", status: "completed", items: [
      user("u1", "查一下文档里的两处说明。"),
      { id: "sh", type: "commandExecution", command: "npm test", status: "completed", exitCode: 0,
        aggregatedOutput: "$ npm test\n160 passing\n" },
      { id: "m1", type: "mcpToolCall", server: "docs", tool: "search", status: "completed" },
      { id: "m2", type: "mcpToolCall", server: "docs", tool: "search", status: "failed" },
      { id: "c1", type: "claudeToolUse", name: "mcp__claude_ai_Claude_Docs__batch", status: "completed",
        input: { container: { kind: "project" } }, output: "ok" },
      { id: "r1", type: "reasoning", summary: ["Comparing the two results"] },
      reply("a1", "两处说明一致，其中一次检索失败已重试。"),
    ] },
    // A turn that ended with a call still reported as running.
    { id: "lost", status: "completed", items: [
      user("u2", "再读一次那份清单。"),
      { id: "c2", type: "claudeToolUse", name: "mcp__yuzuno__task_get", status: "inProgress", input: { taskId: "T-9" } },
      reply("a2", "连接结束时这次调用仍在进行。"),
    ] },
    // The turn running now.
    { id: "live", status: "inProgress", items: [
      user("u3", "继续跑构建。"),
      { id: "sh2", type: "commandExecution", command: "npm run build", status: "inProgress",
        aggregatedOutput: "$ npm run build\n" },
      { id: "m3", type: "mcpToolCall", server: "yuzuno", tool: "task_get", status: "completed" },
      { id: "m4", type: "mcpToolCall", server: "yuzuno", tool: "task_get", status: "completed" },
    ] },
  ],
};

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, theme, language = "en" }) {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(([theme, language]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, [theme, language]);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), "GET", `no writes: ${url.pathname}`);
    if (url.pathname === "/api/workspace")
      return route.fulfill({ json: { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (url.pathname === "/api/agents/a") return route.fulfill({ json: detail });
    if (url.pathname === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (url.pathname === "/api/catchup")
      return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://tool-capsules.test/");
  if (touch) await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
  else await page.locator('.agent-row[data-agent-id="a"]').click();
  await page.locator("#turn-live").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

/** Every capsule of one turn, as the reader sees it on the page. */
const capsules = (page, turn) =>
  page.locator(`#turn-${turn} .tool-activity > summary .tool-count`).evaluateAll((all) =>
    all.map((capsule) => {
      const name = capsule.querySelector(".tool-count-name");
      const style = getComputedStyle(capsule);
      const box = capsule.getBoundingClientRect();
      return {
        name: name.textContent,
        number: capsule.querySelector(".tool-count-number").textContent,
        state: capsule.getAttribute("data-state"),
        said: capsule.querySelector(".tool-count-state")?.textContent.trim() ?? null,
        // A capsule: its corner is at least half its own height.
        radius: Math.round(parseFloat(style.borderTopLeftRadius)),
        height: Math.round(box.height),
        // The name is shown whole, not cut off.
        clipped: name.scrollWidth > name.clientWidth + 1,
        stateColor: capsule.querySelector(".tool-count-state") &&
          getComputedStyle(capsule.querySelector(".tool-count-state")).color,
      };
    }),
  );

try {
  for (const view of [
    { name: "desktop", width: 1280, height: 900, touch: false },
    { name: "phone", width: 390, height: 844, touch: true },
  ]) {
    for (const theme of ["light", "dark"]) {
      const { context, page } = await open({ ...view, theme });
      try {
        const done = await capsules(page, "done");
        assert.deepEqual(
          done.map((capsule) => [capsule.name, capsule.number, capsule.state, capsule.said]),
          [
            ["Shell", "×1", "returned", null],
            ["docs/search", "×2", "failed", "1 failed"],
            ["mcp__claude_ai_Claude_Docs__batch", "×1", "returned", null],
            ["Reasoning", "×1", null, null],
          ],
          `${view.name} ${theme}: ${JSON.stringify(done)}`,
        );
        for (const capsule of done) {
          assert.ok(capsule.radius * 2 >= capsule.height, `rounded: ${JSON.stringify(capsule)}`);
          assert.equal(capsule.clipped, false, `shown whole: ${JSON.stringify(capsule)}`);
        }
        const lost = await capsules(page, "lost");
        assert.deepEqual(lost.map((capsule) => [capsule.state, capsule.said]), [["unconfirmed", "not confirmed"]], JSON.stringify(lost));
        const live = await capsules(page, "live");
        assert.deepEqual(
          live.map((capsule) => [capsule.name, capsule.number, capsule.state, capsule.said]),
          [["Shell", "×1", "running", "running"], ["yuzuno/task_get", "×2", "returned", null]],
          JSON.stringify(live),
        );
        // What needs attention is not told by colour alone: each of those
        // capsules says it in words, and its words are not the plain ink.
        const neutral = done[0].stateColor;
        assert.equal(neutral, null);
        assert.notEqual(lost[0].stateColor, done[1].stateColor);
        // The row stays inside the summary at this width.
        const fits = await page.locator("#turn-done .tool-activity > summary").evaluate((el) => ({
          overflow: el.scrollWidth - el.clientWidth,
          lines: Math.round(el.getBoundingClientRect().height),
        }));
        assert.ok(fits.overflow <= 1, `${view.name}: ${JSON.stringify(fits)}`);
        record(`${view.name} ${theme}: one capsule per tool, rounded, named whole, state in words`, { done, lost, live, fits });

        // The floating Back to latest button would sit over a block in the
        // middle of the conversation; it is hidden for the pictures only.
        await page.addStyleTag({ content: ".jump-latest { visibility: hidden }" });
        for (const [turn, label] of [["done", "returned-and-failed"], ["lost", "unconfirmed"], ["live", "running"]]) {
          const shot = `${output}/capsules-${view.name}-${theme}-${label}.png`;
          await page.locator(`#turn-${turn} .tool-activity`).first().screenshot({ path: shot });
          report.shots.push(shot);
        }
        const whole = `${output}/conversation-${view.name}-${theme}.png`;
        await page.screenshot({ path: whole });
        report.shots.push(whole);

        // Keyboard: the disclosure keeps the focus, and shows it.
        if (!view.touch) {
          const focus = await page.locator("#turn-done .tool-activity > summary").evaluate((el) => {
            el.focus({ focusVisible: true });
            const style = getComputedStyle(el);
            return { focused: document.activeElement === el, outline: parseFloat(style.outlineWidth), tag: el.tagName };
          });
          assert.deepEqual([focus.focused, focus.tag], [true, "SUMMARY"], JSON.stringify(focus));
          assert.ok(focus.outline >= 2, JSON.stringify(focus));
          record(`${view.name} ${theme}: the capsule row adds no control; the disclosure shows its focus`, focus);
        }
      } finally {
        await context.close();
      }
    }
  }
  // The capsules' own words follow the interface language (T-189); the
  // tools' own names never do.
  const { context, page } = await open({ width: 1280, height: 900, touch: false, theme: "light", language: "zh-Hans" });
  try {
    const done = await capsules(page, "done");
    const live = await capsules(page, "live");
    const lost = await capsules(page, "lost");
    assert.deepEqual(done.map((capsule) => [capsule.name, capsule.said]), [
      ["Shell", null],
      ["docs/search", "1 个失败"],
      ["mcp__claude_ai_Claude_Docs__batch", null],
      ["推理", null],
    ], JSON.stringify(done));
    assert.deepEqual([live[0].said, lost[0].said], ["运行中", "未确认"], JSON.stringify({ live, lost }));
    await page.addStyleTag({ content: ".jump-latest { visibility: hidden }" });
    for (const [turn, label] of [["done", "returned-and-failed"], ["lost", "unconfirmed"], ["live", "running"]]) {
      const shot = `${output}/capsules-desktop-zh-${label}.png`;
      await page.locator(`#turn-${turn} .tool-activity`).first().screenshot({ path: shot });
      report.shots.push(shot);
    }
    record("desktop zh-Hans: the capsules' words follow the language, the tools' names do not", { done, live, lost });
  } finally {
    await context.close();
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} checks, ${report.shots.length} screenshots in ${output}`);
