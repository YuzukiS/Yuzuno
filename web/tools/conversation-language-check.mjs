// T-189: a conversation's own controls in the interface language, in Chromium
// (en-US), with every API answered here (no Core; nothing is sent). Through
// the real app, on a synthetic Agent with one Turn, a running job and a CI run:
//  - in English: the conversation's tools, its job and CI dock, and a draft
//    with a folded paste block and text selected after it;
//  - the language changed in another window: the dock, the search button,
//    the composer and the paste block are Chinese; job, run and Agent names
//    and the draft as they were; the selection kept (typing replaces it);
//  - the paste block opened and the search open with a query, changed back to
//    English in another window: both stay open with their text, in English;
//  - nothing posted but the reading place, so nothing was sent.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/conversation-language-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { savedDraft, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-189", checks: [], reads: [], posts: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-conversation-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", threadId: "native-a", cwd: "/fixture", model: "gpt-6", projectId: null, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 2, reviewedSeq: 2, goal: "", connectionState: "connected" };
const turns = [{
  id: "t1", status: "completed",
  items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "Please check SearchToken in the fixture." }] },
    { id: "r1", type: "agentMessage", phase: "final_answer", text: "SearchToken checked; nothing to change." },
  ],
}];
const home = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
const now = new Date().toISOString();
const resources = { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 };
const job = { id: "job-run", requestId: "job-run", name: "Synthetic training", taskRef: "T-47", agentId: "a", agent: { name: "Mori" }, machine: { name: "Local WSL" },
  status: "running", reserved: true, reason: null, resources, reservation: resources, cursor: 1, createdAt: now, startedAt: now, finishedAt: null,
  argv: ["/bin/sh", "-c", "python train.py"], cwd: "/fixture", env: {}, outputs: [] };
const run = { id: "run-1", runId: 101, attempt: "1", name: "Synthetic CI", repository: "owner/repo", headSha: "a".repeat(40), status: "passed", rawStatus: "completed",
  conclusion: "success", url: "https://github.com/owner/repo/actions/runs/101", createdAt: now, startedAt: now, updatedAt: now, observedAt: now, cursor: 1, agentId: "a" };
const budget = {
  budget: { cpuMillis: 4000, memoryMiB: 4096, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 0,
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budgetBounds: { minimum: { cpuMillis: 200, memoryMiB: 128, swapMiB: 0 }, maximum: { cpuMillis: 64000, memoryMiB: 65536, swapMiB: 65536 } },
  machine: { name: "Local WSL", memoryAvailableMiB: 2000, logicalCpus: 8, memoryTotalMiB: 16384, swapTotalMiB: 4096, hostHeadroomMiB: 2048 },
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}${url.search}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    // A message sent, an interrupt or a draft handed to Core would be one of these.
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-conversation-language" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": budget,
    "/api/jobs": { jobs: [job], liveJobs: [job], hasMore: false, nextBefore: null },
    "/api/jobs/live": { agents: {} },
    "/api/ci": { runs: [run], subscriptions: [], hasMore: false, nextBefore: null },
    "/api/ci/live": { runs: [], subscriptions: [], hasMore: false, nextBefore: null },
    "/api/reviews": { reviews: [], hasMore: false, nextBefore: null },
  }[path];
  if (json) return route.fulfill({ json });
  if (path.startsWith("/api/")) return route.fulfill({ json: {} });
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
  } catch {
    await route.fulfill({ status: 404, body: "" });
  }
});
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
const other = await context.newPage();

const setLanguage = (language) => other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
const input = () => page.locator('.cm-content[data-composer-input="true"]');
const chip = () => page.locator(".pasted-text-chip");
const dialog = () => page.locator('[role="dialog"]');
// The conversation's own controls, by what they are.
const controls = () => page.evaluate(() => {
  const dock = document.querySelector("nav.work-dock");
  return {
    dock: dock?.getAttribute("aria-label"),
    groups: [...(dock?.querySelectorAll(".work-dock-heading") || [])].map((b) => b.getAttribute("aria-label")),
    items: [...(dock?.querySelectorAll(".work-dock-item") || [])].map((b) => b.getAttribute("aria-label")),
    search: document.querySelector(".conversation-search-trigger")?.getAttribute("aria-label"),
    composer: document.querySelector('.cm-content[data-composer-input="true"]')?.getAttribute("aria-label"),
    chip: document.querySelector(".pasted-text-chip")?.textContent,
    chipLabel: document.querySelector(".pasted-text-chip")?.getAttribute("aria-label"),
  };
});
// Fourteen lines, CRLF, with Chinese inside: folded into a block, never translated.
const PASTED = "  line\r\n\t中文 kept\r\n".repeat(7);

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator('.agent-row[data-agent-id="a"]').click();
  await input().waitFor({ timeout: 10_000 });
  await page.locator("nav.work-dock .work-dock-item").first().waitFor({ timeout: 10_000 });

  // ---- In English: a draft with a paste block, and its last word selected.
  await input().click();
  await page.keyboard.type("Draft kept ");
  await input().evaluate((el, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, PASTED);
  await chip().waitFor({ timeout: 10_000 });
  await page.keyboard.type(" and a note");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  const draft = await savedDraft(page, "a");
  assert.equal(draft, `Draft kept ${PASTED} and a note`);
  const en = await controls();
  assert.equal(en.dock, "Jobs and CI in this conversation");
  assert.ok(en.groups.every((label) => label.endsWith(": open the list")), JSON.stringify(en.groups));
  assert.ok(en.items.some((label) => label.startsWith("Synthetic training · ")), JSON.stringify(en.items));
  assert.equal(en.search, "Search conversation");
  assert.equal(en.composer, "Message Mori");
  assert.match(en.chip, / · 14 lines$/);
  const enSelection = await page.evaluate(() => getSelection().toString());
  check("in English: the dock, the search button, the composer and a draft with a paste block, 'note' selected", { en, enSelection });

  // ---- Changed to Chinese in another window.
  await setLanguage("zh-Hans");
  await page.locator('.conversation-search-trigger[aria-label="搜索会话"]').waitFor({ timeout: 10_000 });
  const zh = await controls();
  assert.equal(zh.dock, "此会话中的 Job 与 CI");
  assert.ok(zh.groups.every((label) => label.endsWith("：打开列表")), JSON.stringify(zh.groups));
  assert.ok(zh.items.some((label) => label.startsWith("Synthetic training · ")), "the job's name as it came");
  assert.equal(zh.composer, "给 Mori 发消息");
  assert.equal(zh.chip, en.chip.replace(/ · 14 lines$/, " · 14 行"), "the block's label as it came");
  assert.match(zh.chipLabel, /。查看并编辑$/);
  assert.equal(await savedDraft(page, "a"), draft, "the draft as it was");
  const zhSelection = await page.evaluate(() => getSelection().toString());
  // Typing replaces what was selected: the selection was kept.
  await page.keyboard.type("memo");
  const typed = await savedDraft(page, "a");
  assert.equal(typed, `Draft kept ${PASTED} and a memo`);
  check("in Chinese: the dock, search button, composer and paste block; names, the draft and its selection as they were", { zh, zhSelection, typed: typed.slice(-12) });

  // ---- The paste block open, then the search with a query, back in English.
  await chip().click();
  await dialog().waitFor({ timeout: 10_000 });
  assert.match(await dialog().locator("h2").textContent(), /^粘贴的文本 #1$/);
  const zhBlock = await dialog().locator("textarea").inputValue();
  // A textarea reads CRLF as LF.
  assert.equal(zhBlock.replaceAll("\r\n", "\n"), PASTED.replaceAll("\r\n", "\n"), "the pasted text as it came");
  await setLanguage("en");
  await dialog().locator("h2", { hasText: "Pasted text #1" }).waitFor({ timeout: 10_000 });
  assert.equal(await dialog().locator("textarea").inputValue(), zhBlock, "the block's text as it was");
  assert.equal(await dialog().locator(".pasted-text-dialog-actions button").allTextContents().then((t) => t.join("|")), "Remove block|Save changes");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await savedDraft(page, "a"), typed, "closing the block changed nothing");
  await setLanguage("zh-Hans");
  await page.locator('.conversation-search-trigger[aria-label="搜索会话"]').click();
  await dialog().waitFor({ timeout: 10_000 });
  await page.locator(".conversation-search-input").fill("SearchToken");
  await page.locator(".conversation-search-status", { hasText: "2 条匹配的消息" }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".conversation-search-input").getAttribute("placeholder"), "在此会话中查找…");
  await setLanguage("en");
  await page.locator(".conversation-search-status", { hasText: "2 matching messages" }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".conversation-search-input").inputValue(), "SearchToken", "the query as it was");
  const results = await page.locator(".conversation-search-meta strong").allTextContents();
  assert.deepEqual(results, ["You", "Mori · Reply"]);
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await savedDraft(page, "a"), typed, "the draft as it was");
  check("the paste block and the search stayed open with their text across a change back to English", { results });

  assert.deepEqual(report.posts, [], "nothing sent");
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
  check("nothing posted, nothing outside the fixture, no page errors", { reads: report.reads.length });
  await page.screenshot({ path: join(output, "conversation-language.png") });
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
