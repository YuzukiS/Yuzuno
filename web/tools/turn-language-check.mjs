// T-189: a turn's own display in the interface language, in Chromium (en-US),
// with every API answered here (no Core; nothing is sent). Through the real
// app, on a synthetic Agent with one finished turn: a message, a command and
// a file change, and a reply.
//  - in English: the tool activity (opened, a command expanded), the reply's
//    actions and footer, and the turn dock;
//  - changed to Chinese in another window: they are Chinese; the command,
//    its output, the path and the reply as they came; what was open stays
//    open;
//  - the file preview opened from the change, back in English in another
//    window: it stays open with the file as it came, its own words English;
//  - a Claude Agent's running background task: its card from the dock in
//    English, then Chinese in another window, still open; its command as it
//    came; no stop sent;
//  - nothing posted but the reading place.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/turn-language-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

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
const HOST = "yuzuno-turn-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", threadId: "native-a", cwd: "/fixture/mori", model: "gpt-6", projectId: null, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 2, reviewedSeq: 2, goal: "", connectionState: "connected" };
const started = Math.floor(Date.now() / 1000) - 600;
const PATH = "/fixture/mori/notes.md";
const turns = [{
  id: "t1", status: "completed", startedAt: started, completedAt: started + 65,
  items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "Run the fixture tests, please." }] },
    { id: "c1", type: "commandExecution", command: "npm test -- fixture", aggregatedOutput: "fixture output line\n", exitCode: 0, status: "completed" },
    { id: "f1", type: "fileChange", status: "completed", changes: [{ path: PATH, diff: "+fixture line" }] },
    { id: "r1", type: "agentMessage", phase: "final_answer", text: "Tests pass; notes.md updated." },
  ],
}];
const FILE = "# Notes\n\nfixture line\n";
// A Claude Agent with a shell running in the background.
const kaya = { ...agent, id: "k", name: "Kaya", harness: "claude", threadId: "native-k", cwd: "/fixture/kaya", model: "" };
const kayaTurns = [{
  id: "kt1", status: "completed", startedAt: started, completedAt: started + 30,
  items: [
    { id: "ku1", type: "userMessage", content: [{ type: "text", text: "Start the fixture watcher." }] },
    { id: "kb1", type: "claudeToolUse", name: "Bash", status: "completed", input: { command: "npm run watch -- fixture", run_in_background: true },
      output: "Started in the background.", backgroundTask: { taskId: "task-fixture", type: "local_bash", status: "running", description: "Fixture watcher", startedAt: new Date(started * 1000).toISOString() } },
    { id: "kr1", type: "agentMessage", phase: "final_answer", text: "The watcher runs in the background." },
  ],
}];
const home = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
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
  if (/^\/api\/agents\/[ak]\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    // A message sent, an interrupt or a draft handed to Core would be one of these.
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  if (path === "/api/artifact") {
    assert.equal(url.searchParams.get("path"), PATH);
    return route.fulfill({ body: FILE, contentType: "text/plain" });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-turn-language" }, agents: [agent, kaya], projects: [], runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
    "/api/agents/k": { agent: kaya, pending: [], messageReceipts: [], artifacts: [], turns: kayaTurns },
    "/api/agents/k/claude/auto-continue": { workspace: false, agent: null, enabled: false, intent: null, stopped: null },
    "/api/agents/k/claude/mcp-status": { state: "unavailable", reason: "not_observed", generation: null, sessionId: null, checkedAt: null, stale: false, freshForSeconds: 0, observation: null },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates,
    "/api/jobs": { jobs: [], liveJobs: [], hasMore: false, nextBefore: null }, "/api/jobs/live": { agents: {} },
    "/api/ci": { runs: [], subscriptions: [], hasMore: false, nextBefore: null }, "/api/ci/live": { runs: [], subscriptions: [], hasMore: false, nextBefore: null },
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
const turn = () => page.locator("#turn-t1");
const dialog = () => page.locator('[role="dialog"]');
// The turn's own words, and what came from the harness.
const shown = () => turn().evaluate((el) => {
  const activity = el.querySelector(".tool-activity");
  const command = el.querySelector(".tool-item");
  return {
    activityOpen: activity?.open,
    activity: activity?.querySelector(".tool-activity-label")?.textContent,
    counts: [...(activity?.querySelectorAll(":scope > summary .tool-overview-part") || [])].map((c) => c.textContent),
    commandOpen: command?.open,
    commandSummary: command?.querySelector("summary")?.textContent,
    output: command?.querySelector("pre")?.textContent,
    replyActions: [...el.querySelectorAll(".reply-actions .copy-button span")].map((s) => s.textContent),
    footer: el.querySelector(".turn-footer")?.textContent,
    reply: el.querySelector(".final-message")?.textContent.includes("Tests pass; notes.md updated."),
  };
});

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator('.agent-row[data-agent-id="a"]').click();
  await turn().waitFor({ timeout: 10_000 });

  // ---- In English: open the tool activity and the command.
  await turn().locator(".tool-activity > summary").click();
  await turn().locator(".tool-item > summary").first().click();
  const en = await shown();
  assert.deepEqual([en.activityOpen, en.commandOpen], [true, true]);
  assert.equal(en.activity, "Tool activity");
  assert.deepEqual(en.counts, ["2 tool steps"]);
  assert.match(en.commandSummary, /npm test -- fixture.*exit 0/);
  assert.equal(en.output, "fixture output line\n");
  assert.equal(en.replyActions[0], "Copy reply");
  assert.match(en.footer, /^Cooked for .* · done /);
  assert.equal(await page.locator("nav.turn-dock").getAttribute("aria-label"), "Conversation turns");
  check("in English: the tool activity and a command open, the reply's actions and footer, the turn dock", { en });

  // ---- Changed to Chinese in another window.
  await setLanguage("zh-Hans");
  await turn().locator(".tool-activity-label", { hasText: "工具活动" }).waitFor({ timeout: 10_000 });
  const zh = await shown();
  assert.deepEqual([zh.activityOpen, zh.commandOpen], [true, true], "what was open stays open");
  assert.deepEqual(zh.counts, ["2 个工具步骤"]);
  assert.match(zh.commandSummary, /npm test -- fixture.*退出码 0/, "the command as it came");
  assert.equal(zh.output, en.output, "the output as it came");
  // Copy link shows where message links are offered.
  assert.deepEqual(zh.replyActions, en.replyActions.map((label) => ({ "Copy reply": "复制回复", "Copy link": "复制链接" })[label] ?? label));
  assert.match(zh.footer, /^用时 .* · 完成于 /);
  assert.deepEqual([en.reply, zh.reply], [true, true], "the reply as it came");
  assert.equal(await page.locator("nav.turn-dock").getAttribute("aria-label"), "会话 Turn");
  check("in Chinese: the turn's own words; the command, output and reply as they came; open rows kept", { zh });

  // ---- The file preview from the change, then back to English.
  await turn().locator(".tool-item").nth(1).locator("summary").click();
  await turn().locator(".tool-item").nth(1).locator("button.inline-link", { hasText: PATH }).click();
  await dialog().waitFor({ timeout: 10_000 });
  await dialog().locator(".modal-footer", { hasText: "只读预览" }).waitFor({ timeout: 10_000 });
  const zhPreview = await dialog().evaluate((el) => ({
    lang: el.getAttribute("lang"),
    close: el.querySelector(".modal-heading button")?.getAttribute("aria-label"),
    contentLang: el.querySelector(".artifact-content")?.getAttribute("lang"),
    copy: el.querySelector(".copy-button span")?.textContent,
  }));
  assert.deepEqual(zhPreview, { lang: "zh-Hans", close: "关闭对话框", contentLang: "", copy: "复制内容" });
  assert.match(await dialog().locator(".artifact-content").textContent(), /fixture line/);
  await setLanguage("en");
  await dialog().locator(".modal-footer", { hasText: "Read-only preview" }).waitFor({ timeout: 10_000 });
  assert.match(await dialog().locator(".artifact-content").textContent(), /fixture line/, "the file as it came");
  assert.equal(await dialog().locator(".copy-button span").textContent(), "Copy contents");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  check("the file preview in Chinese, then English; open across the change, the file as it came", { zhPreview });

  // ---- Kaya's background task: its card in English, then Chinese.
  await page.locator('.agent-row[data-agent-id="k"]').click();
  await page.locator("#turn-kt1").waitFor({ timeout: 10_000 });
  const taskNode = page.locator('.work-dock-group[aria-label="Background tasks"] .work-dock-item');
  await taskNode.waitFor({ timeout: 10_000 });
  await taskNode.click();
  const card = page.locator(".subagent-card");
  await card.locator(".claude-task-stop button").waitFor({ timeout: 10_000 });
  const taskCard = () => card.evaluate((el) => ({
    label: el.getAttribute("aria-label"),
    facts: [...el.querySelectorAll(".claude-subagent-facts dt")].map((dt) => dt.textContent),
    command: el.querySelector(".claude-task-command")?.textContent,
    stop: el.querySelector(".claude-task-stop button")?.textContent,
    close: el.querySelector(".subagent-card-heading button:last-child")?.getAttribute("aria-label"),
  }));
  const enCard = await taskCard();
  assert.equal(enCard.stop, "Stop this task");
  assert.equal(enCard.command, "npm run watch -- fixture");
  assert.deepEqual(enCard.facts.slice(0, 2), ["Status", "Kind"]);
  await setLanguage("zh-Hans");
  await card.locator(".claude-task-stop button", { hasText: "停止此任务" }).waitFor({ timeout: 10_000 });
  const zhCard = await taskCard();
  assert.deepEqual(zhCard.facts.slice(0, 2), ["状态", "类型"]);
  assert.equal(zhCard.command, enCard.command, "the command as it came");
  assert.equal(zhCard.close, "关闭");
  assert.ok(await page.locator('.work-dock-group[aria-label="后台任务"]').count(), "the dock group in Chinese");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached", timeout: 10_000 });
  check("Kaya's background task card in English, then Chinese, still open; the command as it came; no stop sent", { enCard, zhCard });

  assert.deepEqual(report.posts, [], "nothing sent");
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
  check("nothing posted, nothing outside the fixture, no page errors", { reads: report.reads.length });
  await page.screenshot({ path: join(output, "turn-language.png") });
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
