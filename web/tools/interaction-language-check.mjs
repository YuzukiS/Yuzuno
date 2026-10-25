// T-189: a conversation's request cards and mailbox notice in the interface
// language, in Chromium (en-US), with every API answered here (no Core;
// nothing is answered, allowed or denied). Through the real app, on
// synthetic Agents:
//  - Mori (Codex), waiting on a question, with a mailbox notice in its turn:
//    in English an answer is typed; changed to Chinese in another window,
//    the card and the notice are Chinese, the question and options as they
//    came, the typed answer kept;
//  - Kaya (Claude), asking to run a command: in Chinese a reason is typed;
//    back in English in another window, the card is English, the command as
//    it came, the reason kept;
//  - nothing posted but the reading place.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/interaction-language-check.mjs
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
const HOST = "yuzuno-interaction-language.test";

const now = new Date().toISOString();
const base = { status: "waiting", projectId: null, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 1,
  lastSeq: 2, reviewedSeq: 2, goal: "", connectionState: "connected", model: "" };
const mori = { ...base, id: "a", name: "Mori", harness: "codex", threadId: "native-a", cwd: "/fixture/mori" };
const kaya = { ...base, id: "k", name: "Kaya", harness: "claude", threadId: "native-k", cwd: "/fixture/kaya" };
const QUESTION = "Which fixture branch?";
const moriPending = [{ id: "req-q", agentId: "a", method: "item/tool/requestUserInput", createdAt: now,
  params: { questions: [{ id: "q1", question: QUESTION, options: [{ label: "main", description: "The main fixture" }] }] } }];
const COMMAND = "rm -rf fixture-tmp";
const kayaPending = [{ id: "req-p", agentId: "k", method: "claude/canUseTool", createdAt: now,
  params: { toolName: "Bash", input: { command: COMMAND } } }];
// A delivery from Core: one finished job, as the mailbox doorbell groups it.
const moriTurns = [{
  id: "t1", status: "completed", _yuzunoSource: "peer",
  _yuzunoMailbox: { version: 1, priority: "normal", recipientId: "a", afterSeq: 1, throughSeq: 2, messageCount: 1, count: 1,
    groups: [{ kind: "job", status: "succeeded", name: "Fixture job", count: 1 }] },
  items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "Core's note to the Agent." }] },
    { id: "r1", type: "agentMessage", phase: "final_answer", text: "Noted." },
  ],
}];
const home = { generatedAt: now, order: [], needsYou: [], projects: [] };
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
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (/^\/api\/agents\/[ak]\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    // An answer, an approval or a denial would be one of these.
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-interaction-language" }, agents: [mori, kaya], projects: [], runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent: mori, pending: moriPending, messageReceipts: [], artifacts: [], turns: moriTurns },
    "/api/agents/k": { agent: kaya, pending: kayaPending, messageReceipts: [], artifacts: [], turns: [] },
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
const card = (id) => page.locator(`#request-${id}`);
const shownCard = (id) => card(id).evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector(".pending-heading strong")?.textContent,
  tag: el.querySelector(".pending-tag")?.textContent,
  legend: el.querySelector("legend")?.textContent,
  buttons: [...el.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean),
  command: el.querySelector(".claude-permission-input")?.textContent,
}));
// The notice's own summary, not the delivery note's inside it.
const mailbox = () => page.locator(".mailbox-notice > summary").getAttribute("aria-label");

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);

  // ---- Mori in English: the question card and the mailbox notice.
  await page.locator('.agent-row[data-agent-id="a"]').click();
  await card("req-q").waitFor({ timeout: 10_000 });
  const answer = card("req-q").locator('input[type="text"]');
  await answer.fill("my fixture answer");
  const enCard = await shownCard("req-q");
  assert.equal(enCard.heading, "A quick question for you");
  assert.equal(enCard.legend, QUESTION);
  assert.equal(await answer.getAttribute("aria-label"), `Your answer: ${QUESTION}`);
  const enMail = await mailbox();
  assert.equal(enMail, "Fixture job · Job passed");
  check("Mori in English: the question card with an answer typed, and the mailbox notice", { enCard, enMail });

  // ---- Changed to Chinese in another window.
  await setLanguage("zh-Hans");
  await card("req-q").locator(".pending-heading strong", { hasText: "有个问题想问你" }).waitFor({ timeout: 10_000 });
  const zhCard = await shownCard("req-q");
  assert.deepEqual([zhCard.lang, zhCard.tag, zhCard.legend], ["zh-Hans", "需要你处理", QUESTION], "the question as it came");
  assert.ok(zhCard.buttons.includes("发送回答"), JSON.stringify(zhCard.buttons));
  assert.equal(await answer.inputValue(), "my fixture answer", "the typed answer kept");
  assert.equal(await answer.getAttribute("aria-label"), `你的回答：${QUESTION}`);
  assert.equal(await mailbox(), "Fixture job · Job 通过", "the job's name as it came");
  check("in Chinese: the card and the notice; the question, its option and the typed answer kept", { zhCard });

  // ---- Kaya's permission card, a reason typed in Chinese, then English.
  await page.locator('.agent-row[data-agent-id="k"]').click();
  await card("req-p").waitFor({ timeout: 10_000 });
  const reason = card("req-p").locator(".claude-deny-reason input");
  assert.equal(await reason.getAttribute("placeholder"), "例如：改用 git status");
  await reason.fill("fixture reason");
  const zhPermission = await shownCard("req-p");
  assert.equal(zhPermission.heading, "Claude 需要你的许可");
  assert.equal(zhPermission.command, COMMAND, "the command as it came");
  assert.ok(zhPermission.buttons.includes("允许一次") && zhPermission.buttons.includes("说明原因并拒绝"), JSON.stringify(zhPermission.buttons));
  await setLanguage("en");
  await card("req-p").locator(".pending-heading strong", { hasText: "Claude needs your permission" }).waitFor({ timeout: 10_000 });
  const enPermission = await shownCard("req-p");
  assert.equal(await reason.inputValue(), "fixture reason", "the typed reason kept");
  assert.equal(enPermission.command, COMMAND);
  assert.ok(enPermission.buttons.includes("Allow once") && enPermission.buttons.includes("Deny with reason"), JSON.stringify(enPermission.buttons));
  check("Kaya's permission card in Chinese with a reason typed, then English; the command as it came, the reason kept", { zhPermission, enPermission });

  assert.deepEqual(report.posts, [], "nothing answered, allowed or denied");
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
  check("nothing posted, nothing outside the fixture, no page errors", { reads: report.reads.length });
  await page.screenshot({ path: join(output, "interaction-language.png") });
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
