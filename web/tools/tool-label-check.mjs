// T-9: a Codex MCP call's row in a real browser layout, light and dark, at a
// desktop width and a phone's (393 px). Its row names the server and tool as
// its group's summary does; a long name is cut short only on screen, whole in
// its title; the status stays in view and nothing scrolls sideways.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Name where the screenshots go");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], shots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const agent = {
  id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model",
  settings: {}, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
};
const long = { server: "a-very-long-mcp-server-name-for-checking", tool: "an_extremely_long_tool_name_that_does_not_fit_in_one_row" };
const turn = {
  id: "t1", status: "completed",
  items: [
    { id: "u", type: "userMessage", content: [{ type: "text", text: "Read T-1 and T-2, then list the files." }] },
    { id: "m1", type: "mcpToolCall", server: "yuzuno", tool: "task_get", status: "completed", arguments: { taskId: "T-1" },
      result: { content: [{ type: "text", text: "T-1 is in review." }] } },
    { id: "m2", type: "mcpToolCall", server: "yuzuno", tool: "task_get", status: "completed", arguments: { taskId: "T-2" } },
    { id: "m3", type: "mcpToolCall", server: "yuzuno", status: "failed" },
    { id: "m4", type: "mcpToolCall", ...long, status: "completed" },
    { id: "ls", type: "commandExecution", command: "ls", aggregatedOutput: "Cargo.toml\n", status: "completed", exitCode: 0 },
    { id: "r", type: "agentMessage", phase: "final_answer", text: "T-1 is in review; T-2 is open." },
  ],
};
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [], turns: [turn],
  conversation: {
    index: [{ id: turn.id, status: turn.status, number: 1, itemCount: turn.items.length }], questions: [], nativeClientIds: [],
    start: JSON.stringify([turn.id, "u"]), end: JSON.stringify([turn.id, "r"]), hasBefore: false, hasAfter: false, totalItems: turn.items.length,
  },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
let page;
try {
  for (const theme of ["light", "dark"]) for (const [width, height] of [[1360, 900], [393, 852]]) {
    const name = `${theme}-${width}`;
    page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
    await page.addInitScript((theme) => {
      window.EventSource = class { close() {} };
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 18, palette: "garden" }));
      localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    }, theme);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.hostname, "yuzuno-tool-label.test");
      assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
      const json = {
        "/api/agents/a": detail,
        "/api/workspace": { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/updates": unmanagedUpdates,
        "/api/jobs/budget": idleJobsBudget,
        "/api/jobs": noJobs,
        "/api/jobs/live": noLiveJobs,
        "/api/ci": noCiRuns,
        "/api/reviews": noReviews,
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
      }[url.pathname];
      if (json) return route.fulfill({ json });
      if (url.pathname.startsWith("/api/")) {
        report.unexpected.push(url.pathname);
        return route.fulfill({ json: {} });
      }
      const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
      assert.ok(file.startsWith(dist + "/"));
      return route.fulfill({
        body: await readFile(file),
        contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)],
      });
    });
    page.on("pageerror", (error) => report.errors.push(`${name}: ${error.message}`));
    await page.goto("http://yuzuno-tool-label.test/");
    const group = page.locator(".tool-activity").first();
    await group.waitFor({ state: "attached" });
    if (!(await group.evaluate((node) => node.open))) await group.locator(":scope > summary").click();
    await page.locator('[id="item-m4"]').waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, `${name}: the ${theme} theme is applied`);
    const rows = await page.evaluate(() => Object.fromEntries(["m1", "m3", "m4", "ls"].map((id) => {
      const row = document.querySelector(`[id="item-${id}"]`);
      const summary = row.querySelector(":scope > summary");
      const label = summary.querySelector(":scope > span:first-of-type");
      const result = summary.querySelector(":scope > .tool-result");
      const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
      return [id, { text: label.textContent, title: label.getAttribute("title"), strong: !!label.querySelector("strong"),
        cut: label.scrollWidth > label.clientWidth, result: result.textContent, label: box(label), status: box(result), summary: box(summary) }];
    })));
    const counts = await page.locator(".tool-activity .tool-count").allTextContents();
    const overflow = await page.evaluate(() => {
      const pane = document.querySelector(".conversation-scroll");
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, pane: pane ? pane.scrollWidth - pane.clientWidth : null };
    });
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    report.shots.push({ name, rows, counts, overflow, background });

    assert.equal(rows.m1.text, "yuzuno/task_get");
    assert.ok(rows.m1.strong && rows.m1.title === "yuzuno/task_get");
    assert.equal(rows.m1.result, "completed");
    assert.deepEqual(counts, ["yuzuno/task_get×2", "MCP tool×1", `${long.server}/${long.tool}×1`, "Shell×1"]);
    check(`${name}: the row and the summary name the server and tool`);
    assert.equal(rows.m4.text, `${long.server}/${long.tool}`);
    assert.equal(rows.m4.title, rows.m4.text);
    check(`${name}: a long name is whole in its text and title${rows.m4.cut ? ", cut short on screen" : ""}`, { cut: rows.m4.cut });
    for (const id of ["m1", "m3", "m4", "ls"]) {
      const { status, summary, label } = rows[id];
      assert.ok(status.width > 0 && status.right <= summary.right + 1 && status.left >= label.right - 1, `${name}: ${id}'s status is in view`);
    }
    check(`${name}: every row's status stays in view beside its label`);
    assert.equal(rows.m3.text, "MCP tool");
    assert.ok(!rows.m3.strong && rows.m3.title === null && rows.m3.result === "failed");
    assert.equal(rows.ls.text, "ls");
    check(`${name}: a call naming no tool and a command keep their own labels`);
    assert.ok(overflow.page <= 0 && (overflow.pane === null || overflow.pane <= 0), `${name}: nothing scrolls sideways ${JSON.stringify(overflow)}`);
    check(`${name}: nothing scrolls sideways`);
    const file = resolve(output, `${name}.png`);
    await page.locator('[id="turn-t1"]').screenshot({ path: file });
    await page.close();
    page = undefined;
  }
  for (const width of [1360, 393]) {
    const [light, dark] = ["light", "dark"].map((theme) => report.shots.find((shot) => shot.name === `${theme}-${width}`).background);
    assert.notEqual(light, dark, `${width}: light and dark look different`);
  }
  check("light and dark render with different backgrounds");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected.filter((path) => !/^\/api\/agents\/a\//.test(path)), []);
  check("no page errors, and no API read outside the fixture but the Agent's own");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  if (page) await page.screenshot({ path: resolve(output, "failed.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
