// Browser check on an isolated Core over a copy of the daily DB.
// Usage: node browser.mjs <core-binary> <label> <port> <web-dist> <agent-id> [--expand]
// Prints sizes and timings only; screenshots stay in this git-ignored folder.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
const [binary, label, port, dist, agentId, ...flags] = process.argv.slice(2);
const expand = flags.includes("--expand");
if (Number(port) < 4460 || Number(port) > 4469) throw new Error("use the isolated port range");
const origin = `http://127.0.0.1:${port}`;
const lab = path.join(here, "data", `browser-${label}`);
rmSync(lab, { recursive: true, force: true });
mkdirSync(lab, { recursive: true });
for (const name of ["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm"]) {
  const source = path.join(here, "data", "orig", name);
  if (existsSync(source)) cpSync(source, path.join(lab, name));
}
const log = openSync(path.join(lab, "core.log"), "w");
const core = spawn(binary, ["--port", port, "--data-dir", lab, "--web-dir", dist, "--codex", "/bin/false", "--cwd", lab],
  { stdio: ["ignore", log, log] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = { label, agent: agentId.slice(0, 8) };
let browser;
try {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  const turns = (await (await fetch(`${origin}/api/agents/${agentId}`)).json()).turns.length;
  browser = await chromium.launch({ executablePath: "/usr/sbin/chromium", headless: true,
    args: ["--enable-precise-memory-info"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await context.addInitScript((id) => {
    localStorage.setItem("yuzuno.selected", JSON.stringify(id));
    window.__longtasks = [];
    new PerformanceObserver((list) => window.__longtasks.push(...list.getEntries()
      .map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true });
  }, agentId);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const failed = [];
  page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const detailEntries = () => page.evaluate((id) => performance.getEntriesByType("resource")
    .filter((e) => new URL(e.name).pathname === `/api/agents/${id}`)
    .map((e) => ({ start: e.startTime, end: e.responseEnd, bytes: e.encodedBodySize })), agentId);

  await page.goto(origin);
  await page.waitForFunction((n) => document.querySelectorAll("article.turn").length === n, turns, { timeout: 120_000 });
  const rendered = await page.evaluate(() => performance.now());
  const [first] = await detailEntries();
  const longLoad = await page.evaluate((until) => window.__longtasks.filter((t) => t.start <= until)
    .reduce((sum, t) => sum + t.duration, 0), rendered);
  Object.assign(result, {
    turns,
    detailBytes: first.bytes,
    detailFetchMs: Math.round(first.end - first.start),
    renderedMs: Math.round(rendered),
    renderAfterFetchMs: Math.round(rendered - first.end),
    loadLongTasksMs: Math.round(longLoad),
    preChars: await page.evaluate(() => [...document.querySelectorAll(".tool-content pre")].reduce((n, p) => n + p.textContent.length, 0)),
    heapMB: await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1e5) / 10),
  });

  // A change notice for this Agent (Core broadcasts one when its Project is
  // set) makes the GUI refetch the detail, as runtime events do.
  const refreshes = [];
  for (let i = 0; i < 5; i++) {
    const before = (await detailEntries()).length;
    const sent = await page.evaluate(() => performance.now());
    await page.evaluate((id) => fetch(`/api/agents/${id}/project`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" }, body: JSON.stringify({ projectId: null }) }), agentId);
    await page.waitForFunction(([id, n]) => performance.getEntriesByType("resource")
      .filter((e) => new URL(e.name).pathname === `/api/agents/${id}`).length > n, [agentId, before], { timeout: 60_000 });
    await sleep(2500);
    const entry = (await detailEntries())[before];
    const busy = await page.evaluate(([from, to]) => window.__longtasks.filter((t) => t.start >= from && t.start <= to)
      .reduce((sum, t) => sum + t.duration, 0), [sent, entry.end + 2000]);
    refreshes.push({ fetch: entry.end - entry.start, longTasks: busy, bytes: entry.bytes });
  }
  // What each refresh costs the page alone: fetch plus JSON parse, in sequence.
  const fetchParse = await page.evaluate(async (id) => {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const response = await fetch(`/api/agents/${id}`);
      const fetched = performance.now();
      const text = await response.text();
      const read = performance.now();
      JSON.parse(text);
      runs.push({ total: performance.now() - start, parse: performance.now() - read, bytes: text.length, fetched: fetched - start });
    }
    return runs;
  }, agentId);
  Object.assign(result, {
    refreshFetchMs: Math.round(median(refreshes.map((r) => r.fetch))),
    refreshLongTasksMs: Math.round(median(refreshes.map((r) => r.longTasks))),
    refreshRaw: refreshes.map((r) => [Math.round(r.fetch), Math.round(r.longTasks)]),
    sequentialFetchAndParseMs: Math.round(median(fetchParse.map((r) => r.total))),
    sequentialParseMs: Math.round(median(fetchParse.map((r) => r.parse))),
  });

  if (expand) {
    // The largest trimmed command output in this record.
    const target = await page.evaluate(async (id) => {
      const detail = await (await fetch(`/api/agents/${id}`)).json();
      let best = null;
      for (const turn of detail.turns) for (const item of turn.items) {
        const bytes = item._yuzunoTruncated?.aggregatedOutput?.bytes;
        if (bytes && (!best || bytes > best.bytes)) best = { turnId: turn.id, itemId: item.id, bytes };
      }
      return best;
    }, agentId);
    const full = await page.evaluate(async ([id, t]) => (await (await fetch(
      `/api/agents/${id}/items/${encodeURIComponent(t.itemId)}/payload?field=aggregatedOutput`)).json()).fields.aggregatedOutput, [agentId, target]);
    const row = page.locator(`[id="item-${target.itemId}"]`);
    await row.evaluate((node) => { for (let el = node; el; el = el.parentElement) if (el.tagName === "DETAILS") el.open = true; });
    await row.scrollIntoViewIfNeeded();
    const previewChars = await row.locator("pre").first().evaluate((pre) => pre.textContent.length);
    await row.locator(".truncation-notice").screenshot({ path: path.join(here, `notice-${label}.png`) });
    await page.screenshot({ path: path.join(here, `page-${label}.png`) });
    const button = row.getByRole("button", { name: /^Show full output/ });
    const buttonText = await button.textContent();
    const clicked = await page.evaluate(() => performance.now());
    await button.click();
    await page.waitForFunction(([selector, length]) => document.querySelector(selector)?.querySelector("pre")?.textContent.length === length,
      [`[id="item-${target.itemId}"]`, full.length], { timeout: 60_000 });
    const shown = await page.evaluate(() => performance.now());
    const exact = (await row.locator("pre").first().textContent()) === full;
    await row.screenshot({ path: path.join(here, `expanded-${label}.png`) });
    const payload = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((e) => e.name.includes("/payload")).map((e) => ({ ms: e.responseEnd - e.startTime, bytes: e.encodedBodySize })).at(-1));

    // A refresh brings the preview again; the row stays expanded.
    const before = (await detailEntries()).length;
    await page.evaluate((id) => fetch(`/api/agents/${id}/project`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" }, body: JSON.stringify({ projectId: null }) }), agentId);
    await page.waitForFunction(([id, n]) => performance.getEntriesByType("resource")
      .filter((e) => new URL(e.name).pathname === `/api/agents/${id}`).length > n, [agentId, before], { timeout: 60_000 });
    await sleep(1500);
    const keptAfterRefresh = (await row.locator("pre").first().textContent()) === full;

    // Copy turn copies the full text of every trimmed tool field in that Turn.
    const turnCopy = page.locator(`[id="turn-${target.turnId}"] .turn-divider .copy-button`);
    const copyStart = await page.evaluate(() => performance.now());
    await turnCopy.click();
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent.includes("Copied"),
      `[id="turn-${target.turnId}"] .turn-divider .copy-button`, { timeout: 60_000 });
    const copyMs = (await page.evaluate(() => performance.now())) - copyStart;
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    const turnPayload = await page.evaluate(async ([id, t]) => (await (await fetch(`/api/agents/${id}/turns/${t.turnId}/payload`)).json()).items, [agentId, target]);
    const allFull = Object.values(turnPayload).every((entry) => Object.values(entry.fields)
      .every((value) => typeof value !== "string" || clipboard.includes(value)));
    Object.assign(result, {
      expandItem: { bytes: target.bytes, previewChars, button: buttonText.trim(), fullChars: full.length, exact,
        payloadMs: Math.round(payload.ms), payloadBytes: payload.bytes, clickToShownMs: Math.round(shown - clicked), keptAfterRefresh },
      copyTurn: { ms: Math.round(copyMs), clipboardChars: clipboard.length, containsExpandedOutput: clipboard.includes(full),
        trimmedItemsInTurn: Object.keys(turnPayload).length, allTrimmedStringsInClipboard: allFull },
    });
  }
  result.pageErrors = errors.filter((e) => !/Failed to load resource|models/.test(e)).slice(0, 5);
  result.ignoredResourceErrors = errors.length - result.pageErrors.length;
  result.failedResponses = [...new Set(failed)];
  result.ignoredMessages = errors.filter((e) => /Failed to load resource|models/.test(e)).slice(0, 3);
} finally {
  await browser?.close();
  core.kill("SIGINT");
  await new Promise((resolve) => { core.on("exit", resolve); setTimeout(() => { core.kill("SIGTERM"); resolve(); }, 15000); });
}
writeFileSync(path.join(here, `browser-${label}.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
