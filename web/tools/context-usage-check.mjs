// Default: headless isolated fixtures, without Core or an existing window.
// --served: GET-only verification of published assets; no browser is opened.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(
  process.env.YUZUNO_UI_DIST,
  "Set YUZUNO_UI_DIST to the staged build.",
);
const dist = await realpath(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, await realpath("dist"), "Use an isolated build.");
const output = resolve("../acceptance/context-usage");
if (process.argv.includes("--served")) {
  const base = "http://127.0.0.1:4317";
  const get = async (path) => {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.ok, true, path);
    return Buffer.from(await response.arrayBuffer());
  };
  const health = JSON.parse((await get("/api/health")).toString());
  assert.deepEqual([health.product, health.application], ["yuzuno", "yuzuno-next"]);
  assert.deepEqual(await get("/"), await readFile(resolve(dist, "index.html")));
  const manifest = JSON.parse(await readFile(resolve(dist, ".refresh-ui.json"), "utf8"));
  const assets = Object.keys(manifest.outputs).filter((path) => path.startsWith("assets/"));
  for (const path of assets) assert.deepEqual(await get(`/${path}`), await readFile(resolve(dist, path)));
  const baseline = JSON.parse(await readFile(resolve("../acceptance/multi-agent/daily-baseline.json"), "utf8"));
  const core = baseline.processes.find((p) => p.argv.includes("4317"));
  assert.ok(core, "Daily Core identity is recorded");
  const stat = await readFile(`/proc/${core.pid}/stat`, "utf8");
  assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19], core.startTicks, "Original Core process is still running");
  const report = { status: "passed", mode: "GET-only-published-assets", dist, health, assets, indexMatchesStagedBuild: true, corePid: core.pid, coreStartTicks: core.startTicks, originalCoreStillRunning: true };
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "daily-ui.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const requests = [],
  errors = [],
  streams = new Set();
const report = {
  mode: "isolated-browser-fixtures",
  dist,
  checks: [],
  browserErrors: errors,
};
const baseAgent = {
  cwd: "/fixture",
  model: "test",
  color: "green",
  status: "working",
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
  unreadCount: 2,
  pendingCount: 1,
  lastSeq: 12,
  reviewedSeq: 2,
};
const agents = [
  { ...baseAgent, id: "a", name: "Mori", goal: "Context fixture" },
  { ...baseAgent, id: "b", name: "Hana", goal: "Other context fixture" },
];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      requests.push({ method: request.method, path: url.pathname });
      assert.equal(request.method, "GET", "UI must not send mutations");
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": fixture\n\n");
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      const agent = agents.find((a) => url.pathname.endsWith(`/${a.id}`));
      const body =
        url.pathname === "/api/workspace"
          ? { agents, runtime: { connected: true }, defaultCwd: "/fixture" }
          : {
              agent,
              artifacts: [],
              turns: [
                {
                  id: "t1",
                  status: "inProgress",
                  items: [
                    {
                      id: "r1",
                      type: "agentMessage",
                      phase: "commentary",
                      text: "Still working while you read.",
                    },
                  ],
                },
              ],
              pending: [
                {
                  id: "p1",
                  agentId: agent.id,
                  method: "item/tool/requestUserInput",
                  createdAt: "2026-10-12",
                  params: {
                    isBlocking: false,
                    questions: [
                      { id: "q1", question: "Keep this pending question." },
                    ],
                  },
                },
              ],
            };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const file = resolve(
      dist,
      `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
    );
    assert.ok(file.startsWith(dist + sep));
    const contents = await readFile(file);
    response.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
        }[extname(file)] || "application/octet-stream",
    });
    response.end(contents);
  } catch (error) {
    response.writeHead(404);
    response.end(String(error));
  }
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?preview=1`);
  for (const theme of ["light", "dark"]) {
    for (const [width, fontSize] of [
      [1440, 16],
      [940, 20],
      [390, 20],
    ]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(
        ([theme, fontSize]) =>
          localStorage.setItem(
            "yuzuno.appearance",
            JSON.stringify({ theme, fontSize }),
          ),
        [theme, fontSize],
      );
      await page.goto(`${base}/?preview=1`);
      await page.locator(".context-usage-button").hover();
      const tooltip = page.getByRole("tooltip");
      await tooltip.waitFor();
      assert.match(await tooltip.innerText(), /46% used/);
      const layout = await page.evaluate(() => {
        const trigger = document
          .querySelector(".context-usage-button")
          .getBoundingClientRect();
        const card = document
          .querySelector(".context-usage-card")
          .getBoundingClientRect();
        return {
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          trigger: trigger.toJSON(),
          card: card.toJSON(),
        };
      });
      assert.equal(layout.noOverflow, true);
      for (const box of [layout.trigger, layout.card]) {
        assert.ok(
          box.x >= 0 && box.right <= width && box.y >= 0 && box.bottom <= 800,
          JSON.stringify(layout),
        );
      }
      // The card remains open when moving the pointer onto its contents.
      await tooltip.hover();
      await tooltip.waitFor();
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-${fontSize}px.png`),
        animations: "disabled",
      });
      report.checks.push({
        theme,
        width,
        fontSize,
        noOverflow: true,
        hoverable: true,
      });
      await page.keyboard.press("Escape");
      await tooltip.waitFor({ state: "detached" });
    }
    await page.setViewportSize({ width: 1440, height: 800 });
    const colors = [];
    for (const [name, percent, level] of [
      ["Mikan", 46, "low"],
      ["Mori", 78, "medium"],
      ["Hana", 94, "high"],
    ]) {
      await page.locator(".agent-row").filter({ hasText: name }).click();
      const trigger = page.locator(".context-usage-button");
      await trigger.focus();
      await page.getByRole("tooltip").waitFor();
      assert.match(
        await trigger.getAttribute("aria-label"),
        new RegExp(`${percent}% used.*sample`),
      );
      assert.equal(
        await page.locator(".context-usage").getAttribute("data-level"),
        level,
      );
      colors.push(
        await page
          .locator(".context-ring-fill")
          .evaluate((el) => getComputedStyle(el).stroke),
      );
      await page.screenshot({
        path: resolve(output, `${theme}-${level}.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
    }
    assert.equal(new Set(colors).size, 3);
    report.checks.push({ theme, sampleColors: colors });
  }
  assert.equal(requests.length, 0, "Design preview never connects to runtime");
  await page.goto(base);
  await page.locator(".pending-card").waitFor();
  const composer = page.getByRole("textbox", { name: "Message Mori" });
  await composer.fill("Keep this draft 保留草稿");
  const trigger = page.locator(".context-usage-button");
  assert.match(await trigger.getAttribute("aria-label"), /Usage unavailable/);
  for (const open of [
    () => trigger.hover(),
    () => trigger.focus(),
    () => trigger.click(),
  ]) {
    await page.mouse.move(5, 5);
    await open();
    await page.getByRole("tooltip").waitFor();
    assert.match(
      await page.getByRole("tooltip").innerText(),
      /isn't available/,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("tooltip").waitFor({ state: "detached" });
  }
  assert.equal(await composerDraft(composer), "Keep this draft 保留草稿");
  assert.equal(await page.locator(".pending-card").count(), 1);
  await trigger.click();
  await page.getByRole("tooltip").waitFor();
  await page.locator(".agent-row").filter({ hasText: "Hana" }).click();
  await page.getByRole("tooltip").waitFor({ state: "detached" });
  assert.match(await trigger.getAttribute("aria-label"), /Usage unavailable/);
  await page.locator(".agent-row").filter({ hasText: "Mori" }).click();
  await page.reload();
  await page.locator(".pending-card").waitFor();
  assert.equal(await composerDraft(composer), "Keep this draft 保留草稿");
  await trigger.hover();
  await page.getByRole("tooltip").waitFor();
  await page.screenshot({
    path: resolve(output, "live-unavailable.png"),
    animations: "disabled",
  });
  report.checks.push({
    liveUsageUnknown: true,
    escapeDoesNotInterrupt: true,
    agentSwitchResetsTooltip: true,
    draftSurvivesReload: true,
    pendingPreserved: true,
  });
  assert.equal(requests.filter((r) => r.method !== "GET").length, 0);
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  throw error;
} finally {
  await browser?.close();
  for (const response of streams) response.end();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
